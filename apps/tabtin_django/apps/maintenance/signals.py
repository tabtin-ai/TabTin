"""
全局 Celery 任务失败信号处理器。

监听 task_failure 信号，通过 TaskFailureHandler 链将符合条件的最终失败
写入 FailedTaskRecord（DLQ 兜底）。采用黑名单排除 + 按 task_name 限速，避免
维护白名单遗漏与大面积失败冲垮 MySQL。
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod

from celery.signals import task_failure
from django.core.cache import cache

logger = logging.getLogger('celery.dlq')


class TaskFailureHandler(ABC):
    """可扩展的任务失败处理单元，由 handle_task_failure 顺序调用。"""

    @abstractmethod
    def should_handle(self, task_name: str) -> bool:
        """若返回 True，则对本 task_name 调用 handle。"""

    @abstractmethod
    def handle(
        self,
        task_id,
        task_name: str,
        exception,
        args,
        kwargs,
        einfo,
        *,
        sender=None,
    ) -> None:
        """处理一次失败；sender 为 Celery 任务对象，可选，用于读取 retries 等。"""


class RateLimitedDLQHandler(TaskFailureHandler):
    """将失败写入 FailedTaskRecord，排除噪声任务并对同一 task_name 限速。"""

    EXCLUDED_PREFIXES = ('apps.maintenance.', 'apps.i18n.', 'celery.')
    RATE_LIMIT = 10
    RATE_WINDOW = 300  # 秒，5 分钟

    def should_handle(self, task_name: str) -> bool:
        return not any(task_name.startswith(p) for p in self.EXCLUDED_PREFIXES)

    def handle(
        self,
        task_id,
        task_name: str,
        exception,
        args,
        kwargs,
        einfo,
        *,
        sender=None,
    ) -> None:
        from apps.maintenance.models import FailedTaskRecord

        rate_key = f'dlq:rate:{task_name}'
        try:
            count = cache.incr(rate_key)
        except ValueError:
            cache.set(rate_key, 1, timeout=self.RATE_WINDOW)
            count = 1
        if count > self.RATE_LIMIT:
            logger.warning('[DLQ] Rate limited, skipping: %s', task_name)
            return

        retries = 0
        if sender is not None and hasattr(sender, 'request'):
            retries = getattr(sender.request, 'retries', 0)

        FailedTaskRecord.objects.create(
            task_id=str(task_id),
            task_name=task_name,
            args=list(args) if args else [],
            kwargs=dict(kwargs) if kwargs else {},
            exception=str(exception),
            traceback=str(einfo) if einfo else '',
            retries=retries,
        )
        logger.error(
            '[DLQ] Task failed (recorded): %s id=%s exc=%s',
            task_name,
            task_id,
            exception,
        )


class UserNotificationHandler(TaskFailureHandler):
    """对用户可见的异步任务失败向对应 Space 推送 WS 结构化通知。"""

    USER_FACING_PREFIXES = (
        'apps.tabdata.tasks.import_export',
        'apps.rag.tasks.index_',
    )

    def should_handle(self, task_name: str) -> bool:
        return any(task_name.startswith(p) for p in self.USER_FACING_PREFIXES)

    def handle(
        self,
        task_id,
        task_name: str,
        exception,
        args,
        kwargs,
        einfo,
        *,
        sender=None,
    ) -> None:
        try:
            kw = dict(kwargs) if kwargs else {}
            space_key: str | None = None
            raw_space = kw.get('space_id')
            if raw_space is not None:
                space_key = str(raw_space)
            else:
                table_id = kw.get('table_id')
                if table_id is not None:
                    from apps.tabdata.constants import TABDATA_DB_ALIAS
                    from apps.tabdata.models import Table

                    resolved = (
                        Table.objects.using(TABDATA_DB_ALIAS)
                        .filter(pk=table_id)
                        .values_list('space_id', flat=True)
                        .first()
                    )
                    if resolved is not None:
                        space_key = str(resolved)
            if not space_key:
                return

            from apps.services.common.ws.bus import publish_ws_event

            topic = f'space.notifications.{space_key}'
            envelope = {
                'task_id': str(task_id),
                'task_type': task_name.split('.')[-1],
                'error': str(exception)[:200],
                'retryable': False,
            }
            publish_ws_event(topic, envelope)
        except Exception:
            logger.exception(
                '[UserNotify] task failure notification failed: %s id=%s',
                task_name,
                task_id,
            )


_handlers: list[TaskFailureHandler] = [
    UserNotificationHandler(),
    RateLimitedDLQHandler(),
]


@task_failure.connect
def handle_task_failure(sender, task_id, exception, args, kwargs, traceback, einfo, **kw):
    task_name = sender.name if sender else 'unknown'

    if not any(h.should_handle(task_name) for h in _handlers):
        logger.warning('Task failed: %s id=%s exc=%s', task_name, task_id, exception)
        return

    for handler in _handlers:
        if not handler.should_handle(task_name):
            continue
        try:
            handler.handle(
                task_id,
                task_name,
                exception,
                args,
                kwargs,
                einfo,
                sender=sender,
            )
        except Exception:
            logger.exception('DLQ handler %s failed', type(handler).__name__)
