"""
Project 动态流服务（ 终态过渡：team_space Space 与新 Project 真表并存期）。

写入侧：``record_team_space_activity`` 供各业务落点（成员变更、资产、Agent 任务、
设置变更）调用，best-effort——动态流是可观测性副产品，写入失败绝不能影响
主业务流程，只打 warning 日志。

读取侧：``list_activities`` 供项目页「动态」Tab 分页拉取，viewer 权限即可读。

事件不可变（append-only），详见模型 ``SpaceActivityEvent`` 的说明。
"""
import logging
from typing import Any, Dict, Optional
from uuid import UUID

from apps.tabtinspace.models import Space, SpaceActivityEvent
from .base import BaseService, ServiceError

logger = logging.getLogger(__name__)

MAX_ACTIVITY_PAGE_SIZE = 100
DEFAULT_ACTIVITY_PAGE_SIZE = 20


def resolve_user_display_name(user: Any) -> str:
    """从 User 对象提取展示名快照（事件必须在用户离队后仍可展示）。"""
    if user is None:
        return ''
    getter = getattr(user, 'get_display_name', None)
    if callable(getter):
        try:
            return str(getter())[:100]
        except Exception:
            pass
    for attr in ('nickname', 'username', 'phone'):
        value = getattr(user, attr, '') or ''
        if value:
            return str(value)[:100]
    return ''


def _is_project_container(target: Any) -> bool:
    """接受 :class:`Space(team_space)` 或 :class:`Project` 实例。

    过渡期：team_space Space 与 Project 并存，两者 id 复用；写入端点以
    ``(id, organization_id)`` 为最小契约，鸭式判断。
    """
    if target is None:
        return False
    # Space(team_space)
    if hasattr(target, 'SpaceType') and hasattr(target, 'type'):
        try:
            return target.type == target.SpaceType.TEAM_SPACE
        except Exception:
            return False
    # Project 真表：直接类名判定，避免 Project → Space 反向 import。
    return target.__class__.__name__ == 'Project'


def record_team_space_activity(
    container: Any,
    event_type: str,
    *,
    actor_user: Any = None,
    actor_user_id: str = '',
    actor_name: str = '',
    target_type: str = '',
    target_id: str = '',
    target_name: str = '',
    metadata: Optional[Dict[str, Any]] = None,
) -> Optional[SpaceActivityEvent]:
    """向 Project / team_space Space 动态流追加一条事件（best-effort，永不抛出）。"""
    try:
        if not _is_project_container(container):
            return None
        if event_type not in SpaceActivityEvent.EventType.values:
            logger.warning(
                "[ProjectActivity] 未知事件类型被拒绝: %s (container=%s)",
                event_type, getattr(container, 'id', None),
            )
            return None

        if actor_user is not None:
            if not actor_user_id:
                actor_user_id = str(getattr(actor_user, 'id', '') or '')
            if not actor_name:
                actor_name = resolve_user_display_name(actor_user)

        return SpaceActivityEvent.objects.create(
            space_id=container.id,
            organization_id=container.organization_id,
            event_type=event_type,
            actor_user_id=(actor_user_id or '')[:64],
            actor_name=(actor_name or '')[:100],
            target_type=(target_type or '')[:30],
            target_id=(target_id or '')[:64],
            target_name=(target_name or '')[:255],
            metadata=metadata or {},
        )
    except Exception:
        logger.warning(
            "[ProjectActivity] 记录动态事件失败（不影响主流程）: container=%s event=%s",
            getattr(container, 'id', None), event_type, exc_info=True,
        )
        return None


class SpaceActivityService(BaseService):
    """动态流读取服务（权限校验在此层收口）。"""

    def list_activities(
        self,
        space_id: UUID,
        page: int = 1,
        limit: int = DEFAULT_ACTIVITY_PAGE_SIZE,
    ) -> Dict[str, Any]:
        if not self.check_space_permission(str(space_id), 'viewer'):
            raise ServiceError('PERMISSION_DENIED', '无权查看该 Space 的动态', 403)

        page = max(1, page)
        limit = min(max(1, limit), MAX_ACTIVITY_PAGE_SIZE)

        # ProjectTaskService 曾在任务入队时提前写一条 task 级 started，runtime
        # 随后又写真实 agent_run started，导致同一次执行在动态流出现两次。
        # 事件表是 append-only，不改写历史；读取模型过滤这批已废弃的 task 级
        # started，只保留能打开真实执行线程的 runtime 事件。
        qs = SpaceActivityEvent.objects.filter(space_id=space_id).exclude(
            event_type=SpaceActivityEvent.EventType.AGENT_RUN_STARTED,
            target_type='task',
        )
        total = qs.count()
        offset = (page - 1) * limit
        events = qs.order_by('-created_at', '-id')[offset:offset + limit]

        items = [
            {
                'id': str(event.id),
                'event_type': event.event_type,
                'actor_user_id': event.actor_user_id,
                'actor_name': event.actor_name,
                'target_type': event.target_type,
                'target_id': event.target_id,
                'target_name': event.target_name,
                'metadata': event.metadata,
                'created_at': event.created_at.isoformat(),
            }
            for event in events
        ]
        return {'items': items, 'total': total, 'page': page, 'limit': limit}
