"""Long-poll daemon for channels that use persistent polling (e.g. WeChat iLink).

Usage:
    python manage.py run_longpoll

Architecture:
- Runs as a long-lived asyncio process (like Celery Worker, managed by Supervisor)
- Queries ChannelAccount for all polling-mode accounts
- Maintains one asyncio coroutine per account
- Each coroutine does a 25-second long-poll, dispatches messages to Celery
- Periodically reloads account list to pick up new/disabled accounts
- Signal handler for graceful shutdown (SIGINT/SIGTERM)
"""

from __future__ import annotations

import asyncio
import logging
import signal
import time
from typing import Any, Dict, Set

from asgiref.sync import sync_to_async
from django.core.management.base import BaseCommand

logger = logging.getLogger(__name__)

ACCOUNT_RELOAD_INTERVAL_S = 10
SESSION_GUARD_PAUSE_S = 3600
POLL_TIMEOUT_S = 25
ERROR_BACKOFF_S = 3
MAX_ERROR_BACKOFF_S = 60


class Command(BaseCommand):
    help = "Long-poll daemon for WeChat iLink and other polling-mode channels"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._shutdown = False
        self._active_tasks: Dict[str, asyncio.Task] = {}
        self._paused_accounts: Dict[str, float] = {}

    def handle(self, **options):
        self.stdout.write(self.style.SUCCESS("[run_longpoll] Starting long-poll daemon..."))
        try:
            asyncio.run(self._run_forever())
        except KeyboardInterrupt:
            self.stdout.write("[run_longpoll] Interrupted.")

    async def _run_forever(self):
        loop = asyncio.get_running_loop()
        # Windows ProactorEventLoop 不支持 add_signal_handler；回退到默认
        # SIGINT→KeyboardInterrupt，进程仍可 Ctrl+C / 任务管理器停止。
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(sig, self._handle_signal)
            except (NotImplementedError, RuntimeError, AttributeError):
                logger.info(
                    "[run_longpoll] signal handler unavailable for %s on this platform; "
                    "relying on KeyboardInterrupt / process kill",
                    sig.name if hasattr(sig, "name") else sig,
                )

        while not self._shutdown:
            try:
                active_keys = await self._sync_accounts()
                self._cleanup_stale_tasks(active_keys)
            except Exception:
                logger.error("[run_longpoll] Account sync error", exc_info=True)

            await asyncio.sleep(ACCOUNT_RELOAD_INTERVAL_S)

        await self._shutdown_all_tasks()
        self.stdout.write(self.style.SUCCESS("[run_longpoll] Shutdown complete."))

    def _handle_signal(self):
        self.stdout.write("[run_longpoll] Shutdown signal received...")
        self._shutdown = True

    async def _sync_accounts(self) -> Set[str]:
        """Load polling-mode accounts and start/stop tasks as needed."""
        from apps.channel_gateway.adapters.registry import ChannelAdapterRegistry

        polling_adapters = {
            a.id for a in ChannelAdapterRegistry.list_all()
            if a.capabilities.supports_polling and not a.capabilities.supports_webhook
        }

        if not polling_adapters:
            return set()

        accounts = await self._query_enabled_accounts(polling_adapters)

        active_keys: Set[str] = set()
        now = time.time()

        for account_id_uuid, channel, account_id, organization_id, updated_at in accounts:
            task_key = f"{channel}:{account_id}:{organization_id}"
            active_keys.add(task_key)

            paused_until = self._paused_accounts.get(task_key, 0)
            if now < paused_until:
                pause_set_at = paused_until - SESSION_GUARD_PAUSE_S
                if updated_at and updated_at.timestamp() > pause_set_at:
                    self._paused_accounts.pop(task_key, None)
                    logger.info("[run_longpoll] %s re-enabled after pause, resuming", task_key)
                else:
                    continue

            if task_key in self._active_tasks:
                task = self._active_tasks[task_key]
                if not task.done():
                    continue
                exc = task.exception() if not task.cancelled() else None
                if exc:
                    logger.warning(
                        "[run_longpoll] Task %s died: %s, restarting",
                        task_key, exc,
                    )

            self._active_tasks[task_key] = asyncio.create_task(
                self._poll_loop(str(account_id_uuid), channel, account_id, organization_id),
                name=f"longpoll:{task_key}",
            )

        return active_keys

    def _cleanup_stale_tasks(self, active_keys: Set[str]) -> None:
        """Cancel tasks for accounts that are no longer active."""
        stale = [k for k in self._active_tasks if k not in active_keys]
        for key in stale:
            task = self._active_tasks.pop(key)
            self._paused_accounts.pop(key, None)
            if not task.done():
                task.cancel()
                logger.info("[run_longpoll] Cancelled task for removed account %s", key)

    async def _shutdown_all_tasks(self) -> None:
        """Cancel all running tasks on shutdown."""
        for key, task in self._active_tasks.items():
            if not task.done():
                task.cancel()
        if self._active_tasks:
            await asyncio.gather(*self._active_tasks.values(), return_exceptions=True)
        self._active_tasks.clear()

    async def _poll_loop(
        self,
        account_uuid: str,
        channel: str,
        account_id: str,
        organization_id: str,
    ) -> None:
        """Main polling loop for a single account."""
        from apps.channel_gateway.adapters.registry import ChannelAdapterRegistry
        from apps.channel_gateway.tasks import process_inbound_message
        from apps.channel_gateway.services.ilink_client import ILinkSessionExpiredError

        task_key = f"{channel}:{account_id}:{organization_id}"
        adapter = ChannelAdapterRegistry.get(channel)
        if not adapter:
            logger.error("[run_longpoll] No adapter for channel %s", channel)
            return

        lock_key = f"longpoll:lock:{task_key}"
        if not await self._try_acquire_lock(lock_key):
            logger.info("[run_longpoll] %s locked by another instance, skipping", task_key)
            return

        offset = await self._load_offset(channel, account_id, organization_id)
        consecutive_errors = 0

        logger.info("[run_longpoll] Starting poll loop for %s", task_key)
        await self._update_runtime_status(channel, account_id, organization_id, "running")

        try:
            while not self._shutdown:
                try:
                    await self._renew_lock(lock_key)

                    account = await self._get_account(account_uuid)
                    if not account:
                        logger.info("[run_longpoll] Account %s disabled or removed", task_key)
                        break

                    messages, new_offset = await adapter.poll_updates(
                        account, offset=offset, timeout=POLL_TIMEOUT_S,
                    )

                    if new_offset != offset:
                        offset = new_offset
                        await self._save_offset(channel, account_id, organization_id, offset)

                    for msg in messages:
                        process_inbound_message.delay(msg.model_dump())

                    consecutive_errors = 0

                except ILinkSessionExpiredError:
                    logger.warning("[run_longpoll] Session expired for %s", task_key)
                    await self._handle_session_expired(account_uuid)
                    self._paused_accounts[task_key] = time.time() + SESSION_GUARD_PAUSE_S
                    break

                except asyncio.CancelledError:
                    break

                except Exception:
                    consecutive_errors += 1
                    backoff = min(ERROR_BACKOFF_S * (2 ** (consecutive_errors - 1)), MAX_ERROR_BACKOFF_S)
                    logger.error(
                        "[run_longpoll] Error in %s (attempt %d, backoff %.0fs)",
                        task_key, consecutive_errors, backoff, exc_info=True,
                    )
                    await self._update_runtime_status(
                        channel, account_id, organization_id, "error",
                        last_error=f"轮询出错（第 {consecutive_errors} 次）",
                    )
                    await asyncio.sleep(backoff)
        finally:
            await self._release_lock(lock_key)

        await self._update_runtime_status(channel, account_id, organization_id, "stopped")
        logger.info("[run_longpoll] Stopped poll loop for %s", task_key)

    # ------------------------------------------------------------------
    # ORM helpers — all wrapped with sync_to_async
    # ------------------------------------------------------------------

    @staticmethod
    @sync_to_async(thread_sensitive=True)
    def _query_enabled_accounts(polling_adapters: set) -> list:
        from apps.channel_gateway.models import ChannelAccount
        return list(
            ChannelAccount.objects.filter(
                channel__in=polling_adapters,
                enabled=True,
            ).values_list("id", "channel", "account_id", "organization_id", "updated_at", flat=False)
        )

    @staticmethod
    @sync_to_async(thread_sensitive=True)
    def _get_account(account_uuid: str):
        from apps.channel_gateway.models import ChannelAccount
        return ChannelAccount.objects.filter(id=account_uuid, enabled=True).first()

    @staticmethod
    @sync_to_async(thread_sensitive=True)
    def _load_offset(channel: str, account_id: str, organization_id: str) -> Any:
        from apps.channel_gateway.models import ChannelRuntimeStatus
        status = ChannelRuntimeStatus.objects.filter(
            channel=channel,
            account_id=account_id,
            organization_id=organization_id,
        ).first()
        if status and status.details:
            return status.details.get("poll_offset", "")
        return ""

    @staticmethod
    @sync_to_async(thread_sensitive=True)
    def _save_offset(channel: str, account_id: str, organization_id: str, offset: Any) -> None:
        from apps.channel_gateway.models import ChannelRuntimeStatus
        status, _ = ChannelRuntimeStatus.objects.get_or_create(
            channel=channel,
            account_id=account_id,
            organization_id=organization_id,
            defaults={"status": "running", "details": {}},
        )
        details = dict(status.details or {})
        details["poll_offset"] = offset
        status.details = details
        status.save(update_fields=["details", "updated_at"])

    @staticmethod
    @sync_to_async(thread_sensitive=True)
    def _update_runtime_status(
        channel: str,
        account_id: str,
        organization_id: str,
        status: str,
        *,
        last_error: str | None = None,
    ) -> None:
        from apps.channel_gateway.models import ChannelRuntimeStatus
        defaults: Dict[str, Any] = {"status": status}
        if last_error is not None:
            defaults["last_error"] = last_error
        elif status == "running":
            defaults["last_error"] = None
        ChannelRuntimeStatus.objects.update_or_create(
            channel=channel,
            account_id=account_id,
            organization_id=organization_id,
            defaults=defaults,
        )

    @staticmethod
    @sync_to_async(thread_sensitive=True)
    def _handle_session_expired(account_uuid: str) -> None:
        from apps.channel_gateway.models import ChannelAccount
        from apps.channel_gateway.services.weixin_auth_service import WeixinAuthService
        account_obj = ChannelAccount.objects.filter(id=account_uuid).first()
        if account_obj:
            WeixinAuthService.mark_session_expired(account_obj)

    # ------------------------------------------------------------------
    # Redis distributed lock (P1-10)
    # ------------------------------------------------------------------

    @staticmethod
    async def _try_acquire_lock(lock_key: str) -> bool:
        try:
            from django_redis import get_redis_connection
            redis_client = get_redis_connection("default")
            return bool(redis_client.set(lock_key, "1", nx=True, ex=POLL_TIMEOUT_S + 15))
        except Exception:
            return True

    @staticmethod
    async def _renew_lock(lock_key: str) -> None:
        try:
            from django_redis import get_redis_connection
            redis_client = get_redis_connection("default")
            redis_client.expire(lock_key, POLL_TIMEOUT_S + 15)
        except Exception:
            pass

    @staticmethod
    async def _release_lock(lock_key: str) -> None:
        try:
            from django_redis import get_redis_connection
            redis_client = get_redis_connection("default")
            redis_client.delete(lock_key)
        except Exception:
            pass
