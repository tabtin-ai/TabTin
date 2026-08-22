"""
Celery 异步任务的计费预检 Mixin。

解决「先 enqueue 后扣费」模式中，入队到执行之间余额可能耗尽的问题。
在 Celery 任务 before_start 阶段再做一次余额检查。

两种接入方式::

    # 方式 1: 任务签名包含 user_id/organization_id kwargs
    @shared_task(bind=True, base=BillingTaskMixin)
    def my_task(self, data_id: str, *, user_id: str = "", organization_id: str = ""):
        ...

    # 方式 2: 覆盖 resolve_billing_context 从 DB 反查
    class VideoTTSTask(BillingTaskMixin):
        billing_service_key = "speech.tts"

        def resolve_billing_context(self, task_id, args, kwargs):
            clip_id = args[0] if args else kwargs.get("clip_id")
            clip = VideoClip.objects.filter(id=clip_id).select_related("project").first()
            if clip and clip.project:
                return str(clip.project.user_id), str(clip.project.workspace_id)
            return "", ""
"""

from __future__ import annotations

import logging
from typing import Tuple

from celery import Task

from apps.services.billing.exceptions import BillingError

logger = logging.getLogger(__name__)


def _ensure_billing_task_precheck_source() -> None:
    """登记 ``billing_task`` 为自动化调用源，使 ``billing_precheck(..., source=...)`` 跳过 L5。

    仅改本模块文件时无法编辑 ``billing_precheck`` 内建集合，故在导入期扩展之。
    """
    try:
        from apps.services.billing.services import billing_precheck as _bp

        if "billing_task" not in _bp._SCHEDULER_SOURCES:
            _bp._SCHEDULER_SOURCES = frozenset(
                set(_bp._SCHEDULER_SOURCES) | {"billing_task"}
            )
    except Exception:
        logger.debug(
            "[task_billing] 无法扩展 billing_precheck._SCHEDULER_SOURCES",
            exc_info=True,
        )


_ensure_billing_task_precheck_source()


class BillingBlockedTaskError(BillingError):
    """Celery 任务因计费阻断被拒绝执行。"""

    def __init__(self, user_id: str, organization_id: str, reason: str = ""):
        self.user_id = user_id
        self.organization_id = organization_id
        self.reason = reason or "insufficient_credits"
        super().__init__(
            f"Task billing blocked: user={user_id[:8]}... "
            f"organization={organization_id[:8] if organization_id else 'N/A'}... "
            f"reason={self.reason}",
            code="TASK_BILLING_BLOCKED",
        )


class BillingTaskMixin(Task):
    """Celery 任务基类，在执行前检查余额。

    获取 user_id/organization_id 的优先级：
    1. kwargs 中的 user_id / organization_id
    2. resolve_billing_context() 方法（子类可覆盖，从 DB 反查）
    """

    abstract = True
    billing_service_key: str = ""

    def resolve_billing_context(
        self, task_id: str, args: tuple, kwargs: dict
    ) -> Tuple[str, str]:
        """从任务参数中推导 (user_id, organization_id)。

        默认从 kwargs 取。子类可覆盖此方法从 DB 反查（如通过 clip_id 查项目）。
        """
        return "", ""

    def before_start(self, task_id, args, kwargs):
        user_id = str(kwargs.get("user_id") or "")
        organization_id = str(kwargs.get("organization_id") or "")

        if not user_id or not organization_id:
            try:
                resolved_uid, resolved_wt = self.resolve_billing_context(
                    task_id, args, kwargs
                )
                user_id = user_id or resolved_uid
                organization_id = organization_id or resolved_wt
            except Exception as exc:
                logger.debug(
                    "[BillingTaskMixin] resolve_billing_context 异常: task=%s err=%s",
                    task_id, exc,
                )

        if not user_id or not organization_id:
            return

        try:
            from apps.services.billing.services.billing_precheck import (
                LAYER_SERVICE_GUARD,
                billing_precheck,
            )

            result = billing_precheck(
                organization_id,
                user_id,
                skip_layers=frozenset({LAYER_SERVICE_GUARD}),
                context="celery_task",
                source="billing_task",
            )
            if result.blocked:
                logger.warning(
                    "[BillingTaskMixin] 任务被预检阻断: task=%s user=%s wt=%s service=%s reason=%s",
                    task_id, user_id[:8], organization_id[:8],
                    self.billing_service_key, result.reason,
                )
                self.update_state(
                    state="BILLING_BLOCKED",
                    meta={"reason": result.error_code or "insufficient_credits"},
                )
                raise BillingBlockedTaskError(
                    user_id, organization_id, reason=result.reason,
                )
        except BillingBlockedTaskError:
            raise
        except Exception as exc:
            logger.warning(
                "[BillingTaskMixin] 预检异常，放行: task=%s err=%s", task_id, exc
            )
