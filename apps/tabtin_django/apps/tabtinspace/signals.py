"""
Tabtin Space 信号处理器

负责默认组织/智能体空间创建、成员与智能体空间统计更新。
同时定义跨 App 资源变更信号 resource_changed。
"""

import django.dispatch
from django.db import transaction
from django.db.models import F
from django.db.models.functions import Greatest
from django.db.models.signals import post_save, post_delete, pre_save
from django.dispatch import receiver
from django.contrib.auth import get_user_model
import logging


# ── 跨 App 自定义信号 ──

# 资源变更信号：由 ResourceBridge 在资源创建/更新/归档/删除后发射。
# 任何 App 都可以监听此信号来响应跨模块事件。
#
# 传递的关键字参数：
#   resource      — 资源模型实例（实现了 ContextSyncMixin）
#   action        — 动作类型: 'created' | 'updated' | 'archived' | 'deleted'
#   resource_type — 资源类型标识: 'tabdata' | 'tabdoc' | 'tabslide' | ...
#   space_id      — 所属智能体空间 ID（UUID）
#   organization_id   — 所属组织 ID（UUID）
#   user          — 操作用户（可为 None）
#
# 用法示例（监听方）：
#   from apps.tabtinspace.signals import resource_changed
#   from django.dispatch import receiver
#
#   @receiver(resource_changed)
#   def on_resource_changed(sender, resource, action, resource_type, space_id, **kwargs):
#       if resource_type == 'tabdata' and action == 'updated':
#           # 表格更新时刷新关联文档的引用
#           ...
resource_changed = django.dispatch.Signal()

from .models import (
    Organization,
    OrganizationMember,
    Agent,
    Device,
    SpaceMembership,
    ContextItem,
    Workspace,
    Project,
    MCPConnection,
    OrganizationAppInstall,
    SpaceAppSettings,
)
from apps.skills.models import AgentSkillLink, UserSkillPreference
from apps.tabmemo.models import MemoRecordStyle

User = get_user_model()
logger = logging.getLogger(__name__)


def _schedule_host_state_invalidation(fingerprints, *, reason: str) -> None:
    """事务提交后只发失效提示，Host 随后从只读 API 拉取权威状态。"""
    values = tuple(sorted({str(value) for value in fingerprints if value}))
    if not values:
        return

    def publish() -> None:
        from apps.tabtinspace.services.host_state_invalidation import (
            publish_host_state_invalidated,
        )

        publish_host_state_invalidated(values, reason=reason)

    transaction.on_commit(publish)


@receiver(pre_save, sender=Workspace)
def track_workspace_device_change(sender, instance, **kwargs):
    """只跟踪执行设备改绑，避免普通 Workspace 更新废弃执行快照。"""
    update_fields = kwargs.get('update_fields')
    if update_fields is not None and not {'device', 'device_id'}.intersection(update_fields):
        instance._execution_binding_changed = False
        instance._previous_execution_device_fingerprint = None
        return
    previous_device_id = None
    previous_fingerprint = None
    if instance.pk:
        previous = Workspace.objects.filter(pk=instance.pk).values(
            'device_id', 'device__fingerprint',
        ).first()
        if previous:
            previous_device_id = previous['device_id']
            previous_fingerprint = previous['device__fingerprint']
    instance._execution_binding_changed = (
        instance.pk is not None and previous_device_id != instance.device_id
    )
    instance._previous_execution_device_fingerprint = (
        previous_fingerprint if instance._execution_binding_changed else None
    )


@receiver(post_save, sender=Organization)
def invalidate_hosts_after_organization_change(sender, instance, **kwargs):
    fingerprints = Workspace.objects.filter(
        organization_id=instance.id,
    ).values_list("device__fingerprint", flat=True)
    _schedule_host_state_invalidation(fingerprints, reason="organization_changed")


@receiver(post_save, sender=Agent)
@receiver(post_delete, sender=Agent)
def invalidate_hosts_after_agent_change(sender, instance, **kwargs):
    owner_user_id = getattr(instance, "owner_user_id", None)
    if not owner_user_id:
        return
    fingerprints = Workspace.objects.filter(
        organization_id=instance.organization_id,
        device__user_id=owner_user_id,
    ).values_list("device__fingerprint", flat=True)
    _schedule_host_state_invalidation(fingerprints, reason="agent_changed")


@receiver(post_save, sender=Workspace)
@receiver(post_delete, sender=Workspace)
def invalidate_host_after_workspace_change(sender, instance, **kwargs):
    fingerprint = getattr(getattr(instance, "device", None), "fingerprint", None)
    if fingerprint is None and getattr(instance, "device_id", None):
        fingerprint = Device.objects.filter(id=instance.device_id).values_list(
            "fingerprint", flat=True
        ).first()
    is_delete = kwargs.get('signal') is post_delete
    reason = (
        'workspace_binding_changed'
        if is_delete or getattr(instance, '_execution_binding_changed', False)
        else 'workspace_changed'
    )
    fingerprints = [fingerprint]
    if reason == 'workspace_binding_changed':
        fingerprints.append(getattr(
            instance,
            '_previous_execution_device_fingerprint',
            None,
        ))
    _schedule_host_state_invalidation(fingerprints, reason=reason)


@receiver(post_save, sender=SpaceAppSettings)
@receiver(post_delete, sender=SpaceAppSettings)
def invalidate_host_after_app_settings_change(sender, instance, **kwargs):
    fingerprints = Workspace.objects.filter(
        id=instance.workspace_id,
        device__user_id=instance.user_id,
    ).values_list("device__fingerprint", flat=True)
    _schedule_host_state_invalidation(fingerprints, reason="app_settings_changed")


@receiver(post_save, sender=OrganizationAppInstall)
@receiver(post_delete, sender=OrganizationAppInstall)
def invalidate_hosts_after_organization_app_change(sender, instance, **kwargs):
    fingerprints = Workspace.objects.filter(
        organization_id=instance.organization_id,
    ).values_list("device__fingerprint", flat=True)
    _schedule_host_state_invalidation(fingerprints, reason="organization_apps_changed")


@receiver(post_save, sender=MemoRecordStyle)
@receiver(post_delete, sender=MemoRecordStyle)
def invalidate_hosts_after_memory_preference_change(sender, instance, **kwargs):
    fingerprints = Workspace.objects.filter(
        organization_id=instance.organization_id,
        device__user_id=instance.user_id,
    ).values_list("device__fingerprint", flat=True)
    _schedule_host_state_invalidation(fingerprints, reason="memory_preference_changed")


@receiver(post_save, sender=AgentSkillLink)
@receiver(post_delete, sender=AgentSkillLink)
def invalidate_hosts_after_agent_skill_change(sender, instance, **kwargs):
    agent_scope = Agent.objects.filter(id=instance.agent_id).values(
        "organization_id", "owner_user_id"
    ).first()
    if agent_scope is None:
        return
    fingerprints = Workspace.objects.filter(
        organization_id=agent_scope["organization_id"],
        device__user_id=agent_scope["owner_user_id"],
    ).values_list("device__fingerprint", flat=True)
    _schedule_host_state_invalidation(fingerprints, reason="agent_skills_changed")


@receiver(post_save, sender=UserSkillPreference)
@receiver(post_delete, sender=UserSkillPreference)
def invalidate_hosts_after_skill_preference_change(sender, instance, **kwargs):
    fingerprints = Workspace.objects.filter(
        device__user_id=instance.user_id,
    ).values_list("device__fingerprint", flat=True)
    _schedule_host_state_invalidation(fingerprints, reason="skill_preference_changed")


@receiver(post_save, sender=MCPConnection)
@receiver(post_delete, sender=MCPConnection)
def invalidate_hosts_after_mcp_change(sender, instance, **kwargs):
    if instance.device_id:
        fingerprint = Device.objects.filter(id=instance.device_id).values_list(
            "fingerprint", flat=True
        ).first()
        _schedule_host_state_invalidation([fingerprint], reason="mcp_changed")
        return
    fingerprints = Workspace.objects.filter(
        organization_id=instance.organization_id,
    ).values_list("device__fingerprint", flat=True)
    _schedule_host_state_invalidation(fingerprints, reason="mcp_changed")

# force_delete_organization 在删除 organization 前将其 id 加入此集合，
# CASCADE 触发的 post_delete signal 检测到后直接跳过无意义的计数 UPDATE。
# 使用方式：见 OrganizationService.force_delete_organization。
_deleting_organization_ids: set = set()


from apps.services.common.db_router import postgres_app_db_alias


@receiver(post_save, sender=User)
def create_default_organization(sender, instance, created, **kwargs):
    """
    用户注册时自动创建个人组织和默认 Agent；Workspace 在设备就绪后供给。
    """
    if not created:
        return

    if Organization.objects.filter(owner=instance, type=Organization.OrganizationType.PERSONAL).exists():
        logger.info("用户 %s 已有个人身份，跳过创建", instance.id)
        return

    try:
        from apps.tabtinspace.services.organization_service import OrganizationService
        organization, created_now = OrganizationService.ensure_personal_organization(instance)
        if not created_now:
            logger.info("用户 %s 的个人身份已由并发链路补齐，跳过重复创建", instance.id)
            return

        logger.info(
            "为用户 %s 创建默认组织(%s)与默认 Agent",
            instance.get_display_name(),
            organization.id,
        )
    except Exception as exc:
        logger.error("创建默认组织失败: %s", str(exc), exc_info=True)
        try:
            from apps.tabtinspace.tasks import compensate_missing_default_organization
            compensate_missing_default_organization.delay()
        except Exception:
            logger.error("默认组织补偿任务调度失败: user=%s", instance.id, exc_info=True)


@receiver(post_save, sender=OrganizationMember)
def update_organization_member_count(sender, instance, created, **kwargs):
    """成员加入时更新计数并失效用户权限缓存。"""
    if not created:
        # SS-016: 成员关系更新（如角色变更/权限收窄）时也需要失效缓存，
        # 防止更新后的权限状态在 60s TTL 内未生效。
        _invalidate_rag_accessible_cache(instance.user_id)
        return

    organization = getattr(instance, 'organization', None)

    # ── 块 1: 计数更新（高可靠） ──
    try:
        if organization:
            Organization.objects.filter(id=organization.id).update(
                member_count=F('member_count') + 1
            )
    except Exception as exc:
        logger.error("[Signal:member_count] 增量失败: organization=%s user=%s: %s",
                     instance.organization_id, instance.user_id, exc, exc_info=True)

    if organization is None:
        logger.error("[Signal:agent_sync] organization 引用无效，跳过 Agent 同步: organization_id=%s user=%s",
                     instance.organization_id, instance.user_id)
        return

def _invalidate_rag_accessible_cache(user_id) -> None:
    """SC-006：主动失效 RAG 可访问 organization 列表缓存。

    与 unified_search_service._get_user_accessible_organizations 使用相同的 key，
    确保成员权限变更后缓存立即失效，消除最长 60s 的权限不一致窗口。
    """
    try:
        from django.core.cache import cache
        cache_key = f"rag:accessible_organizations:{user_id}"
        cache.delete(cache_key)
    except Exception as exc:
        logger.warning("[Signal:rag_cache_invalidate] 缓存失效失败: user_id=%s: %s", user_id, exc)


@receiver(post_delete, sender=OrganizationMember)
def decrease_organization_member_count(sender, instance, **kwargs):
    """成员移除时递减计数 + 异步失活 Agent/Membership/Conversation（COM-12 修复）。

    organization 整体删除（force_delete_organization）时跳过，
    避免对即将被删除的 organization 做无意义的 UPDATE。

    重操作（SpaceMembership 失活、Conversation 清理、Centrifugo 通知）
    委托给 async_deactivate_member_resources Celery 任务，避免阻塞删除事务。
    """
    organization_id = instance.organization_id
    if organization_id in _deleting_organization_ids:
        return

    try:
        Organization.objects.filter(id=organization_id).update(
            member_count=Greatest(F('member_count') - 1, 0)
        )
    except Exception as exc:
        logger.error("[Signal:member_count] 递减失败: organization=%s user=%s: %s",
                     organization_id, instance.user_id, exc, exc_info=True)
        return

    # SC-006: 成员被移除时立即失效 RAG accessible organization 缓存，
    # 防止被踢出的用户在缓存 TTL 内仍能检索已无权访问的 organization 数据。
    _invalidate_rag_accessible_cache(instance.user_id)

    try:
        from apps.tabtinspace.tasks import async_deactivate_member_resources
        wt_id_str = str(organization_id)
        user_id_str = str(instance.user_id)
        transaction.on_commit(
            lambda: async_deactivate_member_resources.delay(wt_id_str, user_id_str),
            using=postgres_app_db_alias(),
        )
    except Exception as exc:
        logger.error("[Signal:agent_deactivate] 异步任务调度失败: organization=%s user=%s: %s",
                     organization_id, instance.user_id, exc, exc_info=True)

    # ── Wave 5 §7 + ：离队级联失活 Permission + 云资源 owner 转交组织 Owner ──
    # 与 async_deactivate_member_resources（SpaceMembership/Conversation 失活）
    # 并行：那个 Celery 任务只清理 Space/Agent 资源，对 DocumentPermission/TablePermission
    # 与资源 owner_id 转交不可见。这里在事务提交后同步跑，让通知与 admin 删人几乎同时生效。
    try:
        from apps.tabtinspace.services.cascade_service import (
            cascade_deactivate_resource_permissions,
            cascade_reassign_owned_resources,
        )
        wt_id_str = str(organization_id)
        user_id_str = str(instance.user_id)
        org_owner_id = (
            Organization.objects.filter(id=organization_id)
            .values_list("owner_id", flat=True)
            .first()
        )
        org_owner_id_str = str(org_owner_id) if org_owner_id else ""

        transaction.on_commit(
            lambda: cascade_deactivate_resource_permissions(wt_id_str, user_id_str),
            using=postgres_app_db_alias(),
        )
        # ：离队者创建的组织云资源默认挂组织 Owner（不转个人 Space）。
        if org_owner_id_str and org_owner_id_str != user_id_str:
            transaction.on_commit(
                lambda: cascade_reassign_owned_resources(
                    wt_id_str, user_id_str, org_owner_id_str,
                ),
                using=postgres_app_db_alias(),
            )
    except Exception as exc:
        logger.error(
            "[Signal:cascade_resource_perms] 调度失败: organization=%s user=%s: %s",
            organization_id, instance.user_id, exc, exc_info=True,
        )


# ──  终态：Workspace/Project 计数信号（Space 表退役中）──
#
# space_count 统计口径：Organization.space_count 现指该组织下的 Workspace + Project
# 两个终态容器数量之和；Space 壳仅在 DROP Space 迁移前作为存量数据存在，不再计入。
# Space post_save/post_delete 已经 no-op，全部由 Workspace/Project 信号承接。


@receiver(post_save, sender=Workspace)
def update_organization_workspace_count(sender, instance, created, **kwargs):
    """Workspace 创建时递增组织的 space_count（个人执行现场纳入统计）。"""
    if not created:
        return

    organization_id = instance.organization_id
    if organization_id in _deleting_organization_ids:
        return

    try:
        Organization.objects.filter(id=organization_id).update(
            space_count=F('space_count') + 1,
        )
    except Exception as exc:
        logger.error(
            "[Signal:workspace_count] 增量失败: organization=%s workspace=%s: %s",
            organization_id, instance.id, exc, exc_info=True,
        )


@receiver(post_delete, sender=Workspace)
def decrease_organization_workspace_count(sender, instance, **kwargs):
    """Workspace 删除时递减组织的 space_count。"""
    organization_id = instance.organization_id
    if organization_id in _deleting_organization_ids:
        return

    try:
        Organization.objects.filter(id=organization_id).update(
            space_count=Greatest(F('space_count') - 1, 0),
        )
    except Exception as exc:
        logger.error(
            "[Signal:workspace_count] 递减失败: organization=%s workspace=%s: %s",
            organization_id, instance.id, exc, exc_info=True,
        )

    # ：删除 Workspace 不再失活 Agent（身份与现场生命周期独立）。


@receiver(post_save, sender=Project)
def update_organization_project_count(sender, instance, created, **kwargs):
    """Project 创建时递增组织的 space_count（团队协作房间纳入统计）。"""
    if not created:
        return

    organization_id = instance.organization_id
    if organization_id in _deleting_organization_ids:
        return

    try:
        Organization.objects.filter(id=organization_id).update(
            space_count=F('space_count') + 1,
        )
    except Exception as exc:
        logger.error(
            "[Signal:project_count] 增量失败: organization=%s project=%s: %s",
            organization_id, instance.id, exc, exc_info=True,
        )


@receiver(post_delete, sender=Project)
def decrease_organization_project_count(sender, instance, **kwargs):
    """Project 删除时递减组织的 space_count。"""
    organization_id = instance.organization_id
    if organization_id in _deleting_organization_ids:
        return

    try:
        Organization.objects.filter(id=organization_id).update(
            space_count=Greatest(F('space_count') - 1, 0),
        )
    except Exception as exc:
        logger.error(
            "[Signal:project_count] 递减失败: organization=%s project=%s: %s",
            organization_id, instance.id, exc, exc_info=True,
        )


# ================================================================
# resource_changed 信号消费者
# ================================================================

@receiver(resource_changed)
def update_workspace_table_count(sender, resource, action, resource_type, space_id=None, **kwargs):
    """#3266：Space.table_count 已随表 DROP；本 receiver 保留为 no-op 兼容。"""
    return


@receiver(resource_changed)
def touch_host_last_activity(sender, action, space_id=None, **kwargs):
    """资源变更时刷新宿主的 last_activity_at（Workspace / Project 双通道）。"""
    sid = space_id
    if not sid:
        return
    try:
        from django.utils import timezone
        now = timezone.now()
        # 个人域 Workspace：暂不承载 last_activity_at 字段（PR2b 后规划）。
        # 团队 Project 直接更新 last_activity_at。
        Project.objects.filter(id=sid).update(last_activity_at=now)
    except Exception as exc:
        logger.warning("[Signal:last_activity] id=%s 更新失败: %s", sid, exc)
