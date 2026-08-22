"""WeChat iLink QR-code login service.

Manages the full QR login lifecycle:
1. Request a QR code from iLink
2. Poll scan status (wait → scanned → confirmed → expired)
3. On confirmation, store bot_token + base_url in ChannelAccount.config
4. Update ChannelRuntimeStatus with QR data and status
"""

from __future__ import annotations

import logging
from typing import Any, Dict, Optional

from asgiref.sync import sync_to_async
from django.utils import timezone

from apps.channel_gateway.models import ChannelAccount, ChannelRuntimeStatus

logger = logging.getLogger(__name__)


class WeixinAuthService:
    """Stateless service for WeChat iLink QR login flow."""

    @staticmethod
    async def start_qr_login(
        account: ChannelAccount,
    ) -> Dict[str, Any]:
        """Request a new QR code and update ChannelRuntimeStatus."""
        from apps.channel_gateway.services.ilink_client import get_qr_code

        config = account.config or {}
        base_url = (config.get("base_url") or "https://ilinkai.weixin.qq.com").strip()

        result = await get_qr_code(base_url=base_url)

        qr_payload = result.get("qrcode", "")
        qr_url = result.get("qr_url", "")

        await sync_to_async(ChannelRuntimeStatus.objects.update_or_create, thread_sensitive=True)(
            channel="weixin_personal",
            account_id=account.account_id,
            organization_id=account.organization_id,
            defaults={
                "status": "waiting_scan",
                "qr": qr_url or qr_payload,
                "last_error": None,
                "details": {
                    "qrcode": qr_payload,
                    "qr_url": qr_url,
                    "qr_requested_at": timezone.now().isoformat(),
                },
            },
        )

        return {
            "qrcode": qr_payload,
            "qr_url": qr_url,
            "status": "waiting_scan",
        }

    @staticmethod
    async def poll_qr_status(
        account: ChannelAccount,
    ) -> Dict[str, Any]:
        """Poll iLink for QR scan status and handle state transitions."""
        from apps.channel_gateway.services.ilink_client import poll_qr_status as ilink_poll

        config = account.config or {}
        base_url = (config.get("base_url") or "https://ilinkai.weixin.qq.com").strip()

        status_obj = await sync_to_async(
            ChannelRuntimeStatus.objects.filter(
                channel="weixin_personal",
                account_id=account.account_id,
                organization_id=account.organization_id,
            ).first,
            thread_sensitive=True,
        )()

        if not status_obj or not status_obj.details:
            return {"state": "expired", "error": "No pending QR login"}

        qr_payload = status_obj.details.get("qrcode", "")
        if not qr_payload:
            return {"state": "expired", "error": "No QR code payload"}

        result = await ilink_poll(base_url=base_url, qrcode=qr_payload)
        state = result.get("state", "wait")

        if state == "scanned":
            await _save_status(status_obj, "scanned")

        elif state == "confirmed":
            bot_token = result.get("bot_token", "")
            bot_base_url = result.get("baseurl", base_url)
            ilink_bot_id = result.get("ilink_bot_id", "")

            new_config = dict(config)
            new_config["bot_token"] = bot_token
            new_config["base_url"] = bot_base_url
            if ilink_bot_id:
                new_config["ilink_bot_id"] = ilink_bot_id

            await _save_account_config(account, new_config)

            status_obj.status = "running"
            status_obj.qr = None
            status_obj.last_error = None
            status_obj.details = {
                "ilink_bot_id": ilink_bot_id,
                "logged_in_at": timezone.now().isoformat(),
            }
            await _save_status_fields(
                status_obj, ["status", "qr", "last_error", "details", "updated_at"]
            )

            logger.info(
                "[WeixinAuth] QR login confirmed for account %s (organization %s)",
                account.account_id,
                account.organization_id,
            )

        elif state == "expired":
            status_obj.status = "disconnected"
            status_obj.qr = None
            status_obj.last_error = "QR 码已过期，请重新扫码"
            await _save_status_fields(
                status_obj, ["status", "qr", "last_error", "updated_at"]
            )

        return {
            "state": state,
            "bot_token": result.get("bot_token"),
            "ilink_bot_id": result.get("ilink_bot_id"),
        }

    @staticmethod
    def mark_session_expired(account: ChannelAccount) -> None:
        """Mark account as session-expired (errcode -14) — called by longpoll.

        Uses ``auth_expired`` status (not ``error``) so the frontend can
        show the "re-scan QR" button instead of a generic error badge.
        """
        account.enabled = False
        account.save(update_fields=["enabled", "updated_at"])

        ChannelRuntimeStatus.objects.update_or_create(
            channel="weixin_personal",
            account_id=account.account_id,
            organization_id=account.organization_id,
            defaults={
                "status": "auth_expired",
                "last_error": "bot_token 已过期，请重新扫码登录",
                "qr": None,
            },
        )

        logger.warning(
            "[WeixinAuth] Session expired for account %s (organization %s)",
            account.account_id,
            account.organization_id,
        )

        try:
            from apps.services.common.ws.bus import publish_ws_event
            from apps.services.common.ws.protocol import build_envelope, new_event_id

            event_id = new_event_id()
            envelope = build_envelope(
                "channel.status",
                event_id,
                {
                    "channel": "weixin_personal",
                    "account_id": account.account_id,
                    "status": "auth_expired",
                    "last_error": "bot_token 已过期，请重新扫码登录",
                },
                event_id=event_id,
                organization_id=account.organization_id,
            )
            publish_ws_event("channel.status", envelope)
        except Exception:
            logger.debug("[WeixinAuth] Failed to publish session-expired WS event", exc_info=True)


# ------------------------------------------------------------------
# sync_to_async ORM helpers
# ------------------------------------------------------------------

@sync_to_async(thread_sensitive=True)
def _save_status(status_obj: ChannelRuntimeStatus, new_status: str) -> None:
    status_obj.status = new_status
    status_obj.save(update_fields=["status", "updated_at"])


@sync_to_async(thread_sensitive=True)
def _save_status_fields(status_obj: ChannelRuntimeStatus, fields: list) -> None:
    status_obj.save(update_fields=fields)


@sync_to_async(thread_sensitive=True)
def _save_account_config(account: ChannelAccount, new_config: dict) -> None:
    account.config = new_config
    account.enabled = True
    account.save(update_fields=["config", "enabled", "updated_at"])
