"""
Celery Beat 定时任务

reconcile_context_items: 周期性修复 ContextItem 与实际资源之间的不一致。
cleanup_stale_online_devices: 清理因 TCP 半开连接等原因导致的假在线设备。
compensate_missing_default_organization: 补偿因 signal 异常导致缺少默认组织的用户。
"""
import logging
from apps.services.common.db_router import postgres_app_db_alias
from celery import shared_task
from celery.schedules import crontab

logger = logging.getLogger(__name__)


@shared_task(
    bind=True,
    name="tabtinspace.restore_organization_member_im_access",
    ignore_result=True,
    max_retries=12,
    time_limit=150,
    soft_time_limit=140,
)
def restore_organization_member_im_access_task(
    self,
    organization_id: str,
    user_id: str,
):
    """Retry the one-way Organization → IM membership restore notification."""
    from apps.tabtinspace.services.organization_member_im_sync import (
        IMOrganizationMemberRestoreUnavailable,
        restore_organization_member_im_access,
    )

    try:
        restore_organization_member_im_access(
            organization_id=organization_id,
            user_id=user_id,
        )
    except IMOrganizationMemberRestoreUnavailable as exc:
        raise self.retry(exc=exc, countdown=min(300, 5 * (2 ** self.request.retries)))


TABTINSPACE_BEAT_SCHEDULE = {
    "reconcile-context-items": {
        "task": "tabtinspace.reconcile_context_items",
        "schedule": 3600,
        "options": {"expires": 3000},
    },
    "cleanup-stale-online-devices": {
        "task": "tabtinspace.cleanup_stale_online_devices",
        "schedule": 120,
        "options": {"expires": 100},
    },
    "compensate-missing-default-organization": {
        "task": "tabtinspace.compensate_missing_default_organization",
        "schedule": 1800,
        "options": {"expires": 1500},
    },
    "cleanup-expired-invitations": {
        "task": "tabtinspace.cleanup_expired_invitations",
        "schedule": 3600,
        "options": {"expires": 3000},
    },
    "cleanup-expired-trashed-resources": {
        "task": "tabtinspace.cleanup_expired_trashed_resources",
        "schedule": 86400,
        "options": {"expires": 82800},
    },
    "notify-trash-expiry-warning": {
        "task": "tabtinspace.notify_trash_expiry_warning",
        "schedule": 86400,
        "options": {"expires": 82800},
    },
    "cleanup-old-organization-activity": {
        "task": "tabtinspace.cleanup_old_organization_activity",
        "schedule": crontab(hour=5, minute=10),
        "options": {"expires": 3600},
    },
    "cleanup-dead-letter-file-usages": {
        "task": "tabtinspace.cleanup_dead_letter_file_usages",
        "schedule": crontab(hour=4, minute=30),
        "options": {"expires": 3600},
    },
    "repurge-stuck-deleting-organizations": {
        "task": "tabtinspace.repurge_stuck_deleting_organizations",
        "schedule": 300,
        "options": {"expires": 240},
    },
}


@shared_task(
    name="tabtinspace.execute_project_task_run",
    ignore_result=True,
    time_limit=1900,
    soft_time_limit=1850,
)
def execute_project_task_run(run_id: str):
    """执行责任人已经确认绑定的 Project Task。"""
    from apps.tabtinspace.services.project_task_runtime import execute_project_task_run as execute

    execute(run_id)


@shared_task(
    name="tabtinspace.revoke_stale_daemon_jtis",
    ignore_result=True,
    bind=True,
    max_retries=3,
    default_retry_delay=10,
    time_limit=30,
    soft_time_limit=25,
)
def revoke_stale_daemon_jtis(self, device_fingerprint: str, issued_before: float):
    """Token 续期后延迟吊销旧 jti。

    由 renew_daemon_token 通过 apply_async(countdown=60) 调度，
    给客户端 60s 宽限期应用新 token。
    使用 issued_before 时间戳过滤，只吊销在该时间戳之前注册的 jti，
    避免快速连续续期时误吊销后续签发的有效 token。
    """
    try:
        from apps.tabtinspace.services.daemon_token_service import _revoke_jtis_before
        count = _revoke_jtis_before(device_fingerprint, issued_before)
        logger.info(
            "[DaemonToken] delayed revocation: device=%s revoked=%d issued_before=%.3f",
            device_fingerprint, count, issued_before,
        )
        return {"revoked": count, "device_fingerprint": device_fingerprint}
    except Exception as exc:
        logger.error(
            "[DaemonToken] delayed revocation failed: device=%s: %s",
            device_fingerprint, exc,
        )
        raise self.retry(exc=exc)


@shared_task(name="tabtinspace.cleanup_expired_invitations", ignore_result=True, time_limit=120, soft_time_limit=100)
def cleanup_expired_invitations():
    """将超过 expires_at 的 pending 邀请标记为 expired。"""
    from apps.tabtinspace.services.invitation_service import InvitationService
    count = InvitationService.cleanup_expired_invitations()
    return {"expired": count}


@shared_task(name="tabtinspace.cleanup_stale_online_devices", ignore_result=True, time_limit=60, soft_time_limit=45)
def cleanup_stale_online_devices():
    """清理超过 5 分钟未收到心跳的假在线设备。"""
    from apps.tabtinspace.services.device_service import DeviceService
    count = DeviceService.cleanup_stale_online_devices(timeout_minutes=5)
    return {"cleaned": count}


# G-040: Lua 脚本原子检查 grace key + 连接计数，消除两次 Redis 查询间的 TOCTOU 窗口。
# 返回值: 0 = 可以标记 offline, -1 = grace cleared, -2 = stale task, -3 = active connections
_GRACE_CHECK_LUA = """
local grace_val = redis.call('GET', KEYS[1])
if grace_val == false then return -1 end
if grace_val ~= ARGV[1] then return -2 end
local conn_val = redis.call('GET', KEYS[2])
if conn_val and tonumber(conn_val) > 0 then
    redis.call('DEL', KEYS[1])
    return -3
end
return 0
"""

_GRACE_CHECK_REASONS = {
    -1: "grace_cleared",
    -2: "stale_task",
    -3: "active_connections",
}


@shared_task(name="tabtinspace.mark_device_offline_after_grace", ignore_result=True, time_limit=30, soft_time_limit=25)
def mark_device_offline_after_grace(fingerprint: str, user_id: str, disconnect_ts: float):
    """WS 断开宽限期到期后，检查设备是否已重连，未重连则标记 offline。

    由 GatewayConsumer._schedule_disconnect_grace() 调度，
    countdown = DISCONNECT_GRACE_SECONDS（默认 30 秒）。

    G-040: 使用 Lua 脚本原子检查 grace key + 连接计数，
    消除分步查询之间的 TOCTOU 窗口。

    检查逻辑（Lua 原子执行）：
      1. grace key 不存在 → 设备已重连（auth handler 删除了 key），跳过
      2. grace key 的 disconnect_ts 不匹配 → 更新的断开已调度新任务，跳过
      3. Redis 设备连接计数 > 0 → 设备有活跃连接，删除 grace key 并跳过
      4. 以上均不满足 → 标记 offline 并广播
    """
    from django.core.cache import cache

    from apps.services.common.ws.gateway import DISCONNECT_GRACE_KEY_PREFIX, DEVICE_CONN_KEY_PREFIX
    grace_key = f"{DISCONNECT_GRACE_KEY_PREFIX}{fingerprint}"
    conn_key = f"{DEVICE_CONN_KEY_PREFIX}{fingerprint}"

    try:
        from django_redis import get_redis_connection
        redis_client = get_redis_connection("default")
        result = redis_client.eval(
            _GRACE_CHECK_LUA, 2,
            grace_key, conn_key,
            str(disconnect_ts),
        )
        result = int(result)
    except Exception as exc:
        logger.warning("[GraceOffline] Lua check failed, falling back to non-atomic: %s", exc)
        result = _grace_check_fallback(grace_key, conn_key, fingerprint, disconnect_ts)

    if result != 0:
        reason = _GRACE_CHECK_REASONS.get(result, f"unknown_{result}")
        logger.info("[GraceOffline] device=%s skipped (%s)", fingerprint, reason)
        return {"skipped": True, "reason": reason}

    try:
        from apps.tabtinspace.models import Device
        from apps.tabtinspace.services.device_service import DeviceService

        heartbeat_device = Device.objects.filter(
            fingerprint=fingerprint,
            user_id=user_id,
        ).only("last_heartbeat_at").first()
        if heartbeat_device and heartbeat_device.last_heartbeat_at:
            heartbeat_ts = heartbeat_device.last_heartbeat_at.timestamp()
            if heartbeat_ts >= float(disconnect_ts):
                cache.delete(grace_key)
                logger.info(
                    "[GraceOffline] device=%s skipped (fresh heartbeat after disconnect)",
                    fingerprint,
                )
                return {"skipped": True, "reason": "fresh_heartbeat"}

        device = DeviceService().update_device_status(fingerprint, 'offline', user_id=user_id)
        if device and device.organization_id and getattr(device, "_status_changed", True):
            from apps.services.common.ws.device_broadcast import _broadcast_device_status
            _broadcast_device_status(device, 'offline')
        cache.delete(grace_key)
        logger.info("[GraceOffline] device=%s marked offline after grace period", fingerprint)
    except Exception as exc:
        logger.error("[GraceOffline] failed to mark device=%s offline: %s", fingerprint, exc)

    return {"marked_offline": fingerprint}


def _grace_check_fallback(grace_key: str, conn_key: str, fingerprint: str, disconnect_ts: float) -> int:
    """Non-atomic fallback when Lua eval fails (e.g., Redis cluster mode)."""
    from django.core.cache import cache
    cached_val = cache.get(grace_key)
    if cached_val is None:
        return -1
    if str(cached_val) != str(disconnect_ts):
        return -2
    try:
        from django_redis import get_redis_connection
        rc = get_redis_connection("default")
        remaining = rc.get(conn_key)
        if remaining and int(remaining) > 0:
            cache.delete(grace_key)
            return -3
    except Exception:
        pass
    return 0


@shared_task(name="tabtinspace.compensate_missing_default_organization", ignore_result=True, time_limit=300, soft_time_limit=270)
def compensate_missing_default_organization():
    """补偿因 post_save 信号异常而缺少默认组织的用户。

    复用 OrganizationService.provision_organization_defaults 保证与 signal
    创建逻辑一致。使用 cache.add 做任务级互斥锁，防止多 worker 并发。
    """
    from django.core.cache import cache as django_cache
    from django.contrib.auth import get_user_model
    from django.db import transaction
    from apps.tabtinspace.models import Organization
    from apps.tabtinspace.services.organization_service import OrganizationService

    LOCK_KEY = "compensate_missing_default_organization_lock"
    LOCK_TTL = 1400

    try:
        acquired = django_cache.add(LOCK_KEY, "1", LOCK_TTL)
    except Exception:
        logger.warning("[Compensate] Redis 不可用，跳过本次执行")
        return {"skipped": True, "reason": "redis_unavailable"}

    if not acquired:
        logger.info("[Compensate] 已有实例在执行，跳过本次调度")
        return {"skipped": True}

    try:
        return _do_compensate(get_user_model(), Organization, OrganizationService, transaction)
    finally:
        try:
            django_cache.delete(LOCK_KEY)
        except Exception:
            logger.warning("[Compensate] 锁释放失败，将等待 TTL 自然过期")


def _do_compensate(User, Organization, OrganizationService, transaction):
    """实际补偿逻辑，从锁中分离便于测试。

    只扫描缺 personal organization 的用户，避免漏掉
    “已有 team owner 但没有 personal”的真实脏数据。
    """
    stats = {"checked": 0, "compensated": 0, "failed": 0}

    personal_owner_ids = list(
        Organization.objects.filter(type=Organization.OrganizationType.PERSONAL).values_list('owner_id', flat=True).distinct()
    )

    candidates = list(
        User.objects
        .exclude(id__in=personal_owner_ids)
        .order_by('-date_joined')
        .values_list('id', flat=True)[:100]
    )

    for user_id in candidates:
        stats["checked"] += 1
        try:
            user = User.objects.get(id=user_id)
            _, created_now = OrganizationService.ensure_personal_organization(
                user,
                extra_settings={'compensated': True},
            )
            if not created_now:
                continue

            stats["compensated"] += 1
            logger.info("[Compensate] 为用户 %s 补偿创建默认组织", user_id)
        except Exception as exc:
            stats["failed"] += 1
            logger.error("[Compensate] 用户 %s 补偿失败: %s", user_id, exc, exc_info=True)

    if stats["compensated"] or stats["failed"]:
        logger.info("[Compensate] completed: %s", stats)
    return stats


@shared_task(
    name="tabtinspace.retry_provision_billing",
    ignore_result=True,
    bind=True,
    max_retries=5,
    default_retry_delay=60,
    time_limit=60,
    soft_time_limit=45,
)
def retry_provision_billing(self, organization_id: str):
    """provision_billing 失败后的补偿任务。

    由 create_default_organization 信号在 provision_billing 异常时调度。
    使用指数退避重试，最多 5 次（约 60s → 120s → 240s → 480s → 960s）。
    """
    from apps.tabtinspace.services.organization_service import OrganizationService
    from apps.tabtinspace.models import Organization

    if not Organization.objects.filter(id=organization_id).exists():
        logger.warning("[RetryBilling] organization=%s 不存在，放弃重试", organization_id)
        return {"skipped": True, "reason": "organization_not_found"}

    return _do_retry_provision_billing(self, organization_id, OrganizationService)


def _do_retry_provision_billing(task_self, organization_id: str, OrganizationService):
    """实际 billing 重试逻辑，从 Celery task 包装器中分离便于测试。"""
    try:
        OrganizationService.provision_billing(organization_id)
        logger.info("[RetryBilling] organization=%s 补偿成功", organization_id)
        return {"success": True, "organization_id": organization_id}
    except Exception as exc:
        from django.core.exceptions import ImproperlyConfigured

        if isinstance(exc, ImproperlyConfigured):
            logger.error(
                "[RetryBilling] organization=%s 命中硬失败，不再重试: %s",
                organization_id, exc, exc_info=True,
            )
            raise
        retries = getattr(task_self.request, 'retries', 0)
        logger.error(
            "[RetryBilling] organization=%s 第 %d 次重试失败: %s",
            organization_id, retries + 1, exc, exc_info=True,
        )
        raise task_self.retry(exc=exc, countdown=60 * (2**retries))


@shared_task(name="tabtinspace.reconcile_context_items", ignore_result=True, time_limit=1800, soft_time_limit=1740)
def reconcile_context_items():
    """
    每小时运行一次，扫描并修复以下不一致：

    1. 孤儿 ContextItem：对应的实际资源已不存在 → 标记归档
    2. 缺失 ContextItem：实际资源存在但 ContextItem 缺失 → 补充创建
    3. 搜索向量缺失：search_vector 为 NULL 的 ContextItem → 补充计算
    """
    from apps.tabtinspace.models import ContextItem
    from apps.tabtinspace.services.resource_bridge import ResourceBridge

    stats = {"orphan_archived": 0, "missing_created": 0, "vector_updated": 0}

    # 单根契约（docs/single-root-space-prd.md §2.7）：tabcode 资源类型已废弃，
    # 不再 reconcile CodeProject ↔ ContextItem 链路。
    RECONCILE_APPS = [
        ("apps.tabdata.models", "Table", "tabdata"),
        ("apps.tabdoc.models", "Document", "tabdoc"),
        ("apps.tabslide.models", "SlideProject", "tabslide"),
        ("apps.tabmemo.models", "Memo", "tabmemo"),
    ]

    from importlib import import_module
    for module_path, model_name, item_type in RECONCILE_APPS:
        try:
            mod = import_module(module_path)
            model_cls = getattr(mod, model_name)
            _reconcile_app(ContextItem, model_cls, item_type, stats)
        except Exception as exc:
            logger.warning("[Reconcile] %s (%s) reconcile failed: %s", model_name, item_type, exc)

    try:
        from django.db import connections
        if connections[postgres_app_db_alias()].vendor == 'postgresql':
            from django.contrib.postgres.search import SearchVector
            null_vector_count = ContextItem.objects.filter(search_vector__isnull=True).count()
            if null_vector_count > 0:
                ContextItem.objects.filter(search_vector__isnull=True).update(
                    search_vector=(
                        SearchVector('title', weight='A', config='simple') +
                        SearchVector('preview', weight='B', config='simple')
                    )
                )
                stats["vector_updated"] = null_vector_count
    except Exception as exc:
        logger.warning("[Reconcile] search_vector backfill failed: %s", exc)

    # ── 4. 修正 Organization.member_count 偏差（单条 SQL，含零成员修正）──
    try:
        from django.db import connections
        with connections[postgres_app_db_alias()].cursor() as cursor:
            cursor.execute("""
                UPDATE tabtinspace_organization w
                SET    member_count = sub.real_count
                FROM (
                    SELECT organization_id, COUNT(*) AS real_count
                    FROM   tabtinspace_organization_member
                    GROUP  BY organization_id
                ) sub
                WHERE  w.id = sub.organization_id
                  AND  w.member_count != sub.real_count
            """)
            fixed = cursor.rowcount

            cursor.execute("""
                UPDATE tabtinspace_organization
                SET    member_count = 0
                WHERE  member_count > 0
                  AND  id NOT IN (
                      SELECT DISTINCT organization_id
                      FROM   tabtinspace_organization_member
                  )
            """)
            fixed += cursor.rowcount
        if fixed:
            stats["member_count_fixed"] = fixed
    except Exception as exc:
        logger.warning("[Reconcile] member_count reconcile failed: %s", exc)

    # ── 5. 修正 Organization.space_count 偏差 ──
    # ：Space 表已 DROP；口径与 signals 一致 = Workspace 行数 + Project 行数。
    try:
        from django.db import connections
        with connections[postgres_app_db_alias()].cursor() as cursor:
            cursor.execute("""
                UPDATE tabtinspace_organization org
                SET    space_count = COALESCE(sub.real_count, 0)
                FROM (
                    SELECT organization_id, SUM(cnt) AS real_count
                    FROM (
                        SELECT organization_id, COUNT(*)::bigint AS cnt
                        FROM   tabtinspace_workspace
                        GROUP  BY organization_id
                        UNION ALL
                        SELECT organization_id, COUNT(*)::bigint AS cnt
                        FROM   tabtinspace_project
                        GROUP  BY organization_id
                    ) parts
                    GROUP BY organization_id
                ) sub
                WHERE  org.id = sub.organization_id
                  AND  org.space_count != sub.real_count
            """)
            fixed_as = cursor.rowcount

            cursor.execute("""
                UPDATE tabtinspace_organization
                SET    space_count = 0
                WHERE  space_count > 0
                  AND  id NOT IN (
                      SELECT organization_id FROM tabtinspace_workspace
                      UNION
                      SELECT organization_id FROM tabtinspace_project
                  )
            """)
            fixed_as += cursor.rowcount
        if fixed_as:
            stats["space_count_fixed"] = fixed_as
    except Exception as exc:
        logger.warning("[Reconcile] space_count reconcile failed: %s", exc)

    logger.info("[Reconcile] completed: %s", stats)
    return stats


def _reconcile_app(context_item_model, resource_model, item_type: str, stats: dict):
    """
    通用 App 补偿逻辑。

    Args:
        context_item_model: ContextItem 模型类
        resource_model: App 资源模型类（Table, Document 等）
        item_type: 对应的 ContextItem.item_type
        stats: 统计字典
    """
    # 孤儿检测：ContextItem 存在但资源已不存在
    ci_ids_with_resource_ids = list(
        context_item_model.objects
        .filter(item_type=item_type, is_archived=False)
        .values_list('id', 'resource_id')
    )
    if not ci_ids_with_resource_ids:
        return

    resource_id_to_ci_id = {}
    for ci_id, resource_id in ci_ids_with_resource_ids:
        resource_id_to_ci_id[resource_id] = ci_id

    existing_resource_ids = set(
        str(rid) for rid in
        resource_model.objects.filter(
            id__in=[r for r in resource_id_to_ci_id.keys() if r]
        ).values_list('id', flat=True)
    )

    orphan_ci_ids = [
        ci_id for resource_id, ci_id in resource_id_to_ci_id.items()
        if resource_id and resource_id not in existing_resource_ids
    ]
    if orphan_ci_ids:
        updated = context_item_model.objects.filter(id__in=orphan_ci_ids).update(is_archived=True)
        stats["orphan_archived"] += updated

    # 缺失检测：资源存在但 ContextItem 缺失
    all_context_resource_ids = set(
        context_item_model.objects
        .filter(item_type=item_type)
        .values_list('resource_id', flat=True)
    )

    if hasattr(resource_model, 'space_id'):
        qs = resource_model.objects.exclude(
            id__in=[r for r in all_context_resource_ids if r]
        ).exclude(space_id__isnull=True)
        if hasattr(resource_model, 'is_archived'):
            qs = qs.filter(is_archived=False)
        elif hasattr(resource_model, 'status'):
            qs = qs.exclude(status='archived')
        missing_resources = qs[:200]

        from apps.tabtinspace.services.resource_bridge import ResourceBridge
        for resource in missing_resources:
            try:
                if hasattr(resource, 'get_context_type'):
                    ResourceBridge.on_create(resource)
                    stats["missing_created"] += 1
            except Exception:
                pass


@shared_task(name="tabtinspace.cleanup_expired_trashed_resources", ignore_result=True, time_limit=1800, soft_time_limit=1740)
def cleanup_expired_trashed_resources():
    """
    每天执行一次：永久删除回收站中超过保留期的资源。

    根据 Organization 所属会员等级的 trash_retention_days 确定保留期，
    免费用户默认 30 天，付费用户可享更长保留期。
    """
    from datetime import timedelta
    from django.utils import timezone
    from django.db.models import Q
    from apps.tabtinspace.models import ContextItem
    from apps.tabtinspace.services.trash_cleaner import TrashCleaner

    DEFAULT_RETENTION_DAYS = 30
    now = timezone.now()
    stats = {"total_deleted": 0, "organizations_processed": 0}

    # ：Space 壳表已 DROP；回收站仅清理 ContextItem（挂 workspace/project）。
    ci_organization_ids = list(
        ContextItem.objects
        .filter(trashed_at__isnull=False)
        .values_list('workspace__organization_id', flat=True)
        .distinct()
    )
    ci_organization_ids += list(
        ContextItem.objects
        .filter(trashed_at__isnull=False, workspace__isnull=True)
        .values_list('project__organization_id', flat=True)
        .distinct()
    )
    ci_organization_ids = [oid for oid in dict.fromkeys(ci_organization_ids) if oid]

    all_ws_ids = list(set(str(w) for w in ci_organization_ids))
    retention_map = _build_retention_days_map(all_ws_ids, DEFAULT_RETENTION_DAYS)

    for organization_id in ci_organization_ids:
        retention_days = retention_map.get(str(organization_id), DEFAULT_RETENTION_DAYS)
        cutoff = now - timedelta(days=retention_days)

        expired_items = ContextItem.objects.filter(
            trashed_at__isnull=False,
            trashed_at__lt=cutoff,
        ).filter(
            Q(workspace__organization_id=organization_id)
            | Q(project__organization_id=organization_id)
        )

        count = expired_items.count()
        if count > 0:
            logger.info(
                "[TrashCleanup] organization=%s retention=%d days, expired=%d",
                organization_id, retention_days, count,
            )
            TrashCleaner.permanent_delete_trashed_items(expired_items)
            stats["total_deleted"] += count
            stats["organizations_processed"] += 1

    if stats["total_deleted"]:
        logger.info("[TrashCleanup] completed: %s", stats)
    else:
        logger.info("[TrashCleanup] 无过期回收站资源")

    return stats


def _build_retention_days_map(organization_ids, default: int = 30) -> dict:
    """批量查询多个 organization 的回收站保留天数，返回 {organization_id: retention_days} 映射。"""
    from apps.users.membership.models import OrganizationMembership

    result = {}
    try:
        memberships = (
            OrganizationMembership.objects
            .filter(organization_id__in=organization_ids, status='active')
            .select_related('tier')
        )
        for m in memberships:
            if m.tier:
                result[str(m.organization_id)] = getattr(m.tier, 'trash_retention_days', default)

        for wt_id in organization_ids:
            if str(wt_id) not in result:
                result[str(wt_id)] = default
    except Exception:
        pass

    return result


def _get_organization_retention_days(organization_id: str, default: int = 30) -> int:
    """单 organization 保留天数查询（兼容已有调用）。"""
    m = _build_retention_days_map([organization_id], default)
    return m.get(str(organization_id), default)


@shared_task(name="tabtinspace.notify_trash_expiry_warning", ignore_result=True, time_limit=300, soft_time_limit=270)
def notify_trash_expiry_warning():
    """每天执行一次：对即将过期的回收站资源发送预警通知。"""
    from django.utils import timezone
    sent = _send_trash_expiry_warnings(timezone.now())
    logger.info("[TrashExpiry] 发送了 %d 条过期预警通知", sent)
    return {"sent": sent}


def _send_trash_expiry_warnings(now) -> int:
    """对即将在 3 天内过期的回收站资源，向 Organization owner 发送预警通知。"""
    from datetime import timedelta
    from apps.tabtinspace.models import ContextItem, Organization

    WARNING_DAYS_BEFORE = 3
    DEFAULT_RETENTION_DAYS = 30
    sent_count = 0

    from django.db.models import Q

    organization_ids = list({
        *ContextItem.objects.filter(
            trashed_at__isnull=False,
            workspace__organization_id__isnull=False,
        ).values_list('workspace__organization_id', flat=True),
        *ContextItem.objects.filter(
            trashed_at__isnull=False,
            project__organization_id__isnull=False,
        ).values_list('project__organization_id', flat=True),
    })

    retention_map = _build_retention_days_map(
        [str(w) for w in organization_ids], DEFAULT_RETENTION_DAYS
    )

    for organization_id in organization_ids:
        retention_days = retention_map.get(str(organization_id), DEFAULT_RETENTION_DAYS)
        warning_cutoff = now - timedelta(days=retention_days - WARNING_DAYS_BEFORE)
        expiry_cutoff = now - timedelta(days=retention_days)

        expiring_items = ContextItem.objects.filter(
            Q(workspace__organization_id=organization_id)
            | Q(project__organization_id=organization_id),
            trashed_at__isnull=False,
            trashed_at__lt=warning_cutoff,
            trashed_at__gte=expiry_cutoff,
        )

        count = expiring_items.count()
        if count == 0:
            continue

        try:
            organization = Organization.objects.filter(id=organization_id).only('owner_id', 'name').first()
            if not organization or not organization.owner_id:
                continue

            from apps.services.notification.services.notification_service import NotificationService

            titles = list(expiring_items.values_list('title', flat=True)[:5])
            preview = "、".join(t or "无标题" for t in titles)
            if count > 5:
                preview += f" 等共 {count} 个"

            NotificationService.notify(
                user_id=str(organization.owner_id),
                type='trash_expiry_warning',
                title=f'回收站资源即将过期',
                body=f'以下资源将在 {WARNING_DAYS_BEFORE} 天内被永久删除：{preview}。如需保留请尽快恢复。',
                organization_id=str(organization_id),
                metadata={
                    'expiring_count': count,
                    'retention_days': retention_days,
                    'category': 'trash',
                },
            )
            sent_count += 1
        except Exception as exc:
            logger.warning(
                "[TrashCleanup] organization=%s 发送过期预警失败: %s",
                organization_id, exc,
            )

    return sent_count


_ACTIVITY_BATCH_SIZE = 2000
_ACTIVITY_RETENTION_DAYS = 90


@shared_task(
    name="tabtinspace.cleanup_old_organization_activity",
    ignore_result=True,
    time_limit=600,
    soft_time_limit=560,
)
def cleanup_old_organization_activity(retention_days: int = _ACTIVITY_RETENTION_DAYS):
    """清理超过保留期的 OrganizationActivity 记录。

    每天执行一次，分批删除防止锁表。
    """
    from datetime import timedelta
    from django.utils import timezone
    from apps.tabtinspace.models import OrganizationActivity

    cutoff = timezone.now() - timedelta(days=retention_days)
    total_deleted = 0

    while True:
        batch_ids = list(
            OrganizationActivity.objects.using(postgres_app_db_alias())
            .filter(created_at__lt=cutoff)
            .values_list("id", flat=True)[:_ACTIVITY_BATCH_SIZE]
        )
        if not batch_ids:
            break
        deleted, _ = OrganizationActivity.objects.using(postgres_app_db_alias()).filter(id__in=batch_ids).delete()
        total_deleted += deleted

    if total_deleted:
        logger.info(
            "[OrganizationActivity] cleanup: deleted=%d retention=%d days",
            total_deleted, retention_days,
        )


@shared_task(
    name="tabtinspace.cleanup_dead_letter_file_usages",
    ignore_result=True,
    time_limit=600,
    soft_time_limit=560,
)
def cleanup_dead_letter_file_usages():
    """每天扫描死信条目（cleanup_fail_count >= MAX），尝试释放 OSS FileUsage。

    死信条目的永久删除因各种原因持续失败，但 FileUsage 释放可独立执行。
    此补偿任务确保即使永久删除卡住，OSS 存储也不会永久泄漏（DEL-3 修复）。
    """
    from django.core.cache import cache as django_cache

    LOCK_KEY = "cleanup_dead_letter_file_usages_lock"
    LOCK_TTL = 550

    try:
        acquired = django_cache.add(LOCK_KEY, "1", LOCK_TTL)
    except Exception:
        logger.warning("[DeadLetter] Redis 不可用，跳过本次执行")
        return {"skipped": True, "reason": "redis_unavailable"}

    if not acquired:
        logger.info("[DeadLetter] 已有实例在执行，跳过")
        return {"skipped": True}

    try:
        from apps.tabtinspace.services.trash_cleaner import TrashCleaner
        return TrashCleaner.retry_dead_letter_file_usages()
    finally:
        try:
            django_cache.delete(LOCK_KEY)
        except Exception:
            logger.warning("[DeadLetter] 锁释放失败，将等待 TTL 自然过期")


@shared_task(
    name="tabtinspace.async_deactivate_member_resources",
    ignore_result=True,
    time_limit=120,
    soft_time_limit=100,
)
def async_deactivate_member_resources(organization_id: str, user_id: str):
    """成员移除后异步失活 SpaceMembership/ConversationMember（COM-12 修复）。

    从信号处理器中拆出，避免在 post_delete 事务中阻塞做大量 DB 写入和外部 HTTP 调用。
    """
    from django.db.models import Count

    from apps.tabtinspace.models import SpaceMembership

    try:
        SpaceMembership.objects.filter(
            workspace__organization_id=organization_id,
            user_id=user_id,
        ).update(is_active=False)
    except Exception as exc:
        logger.error(
            "[AsyncDeactivate] SpaceMembership 失活失败: organization=%s user=%s: %s",
            organization_id, user_id, exc, exc_info=True,
        )

    try:
        from apps.tabchat.constants import ConversationType, IMEventType, MemberRole
        from apps.tabchat.models import Conversation, ConversationMember
        from apps.tabchat.services.centrifugo_service import get_centrifugo_service

        affected_members = list(
            ConversationMember.objects.filter(
                conversation__organization_id=organization_id,
                user_id=user_id,
            ).values('conversation_id', 'role', 'conversation__type')
        )
        affected_conversation_ids = [item['conversation_id'] for item in affected_members]
        if not affected_conversation_ids:
            return

        ConversationMember.objects.filter(
            conversation__organization_id=organization_id,
            user_id=user_id,
        ).delete()

        remaining_counts = {
            str(item['conversation_id']): item['count']
            for item in ConversationMember.objects.filter(
                conversation_id__in=affected_conversation_ids,
            ).values('conversation_id').annotate(count=Count('id'))
        }
        for conversation_id in affected_conversation_ids:
            Conversation.objects.filter(id=conversation_id).update(
                member_count=remaining_counts.get(str(conversation_id), 0),
            )

        for item in affected_members:
            conversation_id = item['conversation_id']
            if (
                item['conversation__type'] == ConversationType.GROUP
                and item['role'] >= MemberRole.ADMIN
                and not ConversationMember.objects.filter(
                    conversation_id=conversation_id,
                    role__gte=MemberRole.ADMIN,
                ).exists()
            ):
                successor = (
                    ConversationMember.objects.filter(conversation_id=conversation_id)
                    .order_by('joined_at', 'id')
                    .first()
                )
                if successor:
                    successor.role = MemberRole.OWNER
                    successor.save(update_fields=['role'])

        try:
            centrifugo = get_centrifugo_service()
            for conversation_id in affected_conversation_ids:
                centrifugo.unsubscribe(user_id, f"chat:{conversation_id}")
                centrifugo.publish(
                    f"chat:{conversation_id}",
                    {
                        "type": IMEventType.MEMBER_LEFT,
                        "data": {
                            "conversation_id": str(conversation_id),
                            "user_id": user_id,
                            "member_count": remaining_counts.get(str(conversation_id), 0),
                        },
                    },
                )
        except Exception as exc:
            logger.warning(
                "[AsyncDeactivate] Centrifugo 通知失败: organization=%s user=%s: %s",
                organization_id, user_id, exc,
            )

    except Exception as exc:
        logger.error(
            "[AsyncDeactivate] Conversation 清理失败: organization=%s user=%s: %s",
            organization_id, user_id, exc, exc_info=True,
        )


@shared_task(
    name="tabtinspace.purge_organization",
    ignore_result=True,
    bind=True,
    max_retries=3,
    default_retry_delay=60,
    time_limit=1800,
    soft_time_limit=1740,
)
def purge_organization(self, organization_id: str):
    """后台物理清理已标记 deleting 的组织。

    交互式删除（delete_organization）只标记 deleting 并即时返回，重清理在此完成，
    避免大型团队同步删除超过客户端 30s IPC 超时。

    用 cache.add 做 organization 级互斥锁，防止同一团队被定时兜底任务重复并发清理。
    """
    from django.core.cache import cache as django_cache
    from apps.tabtinspace.services.organization_service import OrganizationService

    lock_key = f"purge_organization_lock:{organization_id}"
    try:
        acquired = django_cache.add(lock_key, "1", 1800)
    except Exception:
        acquired = True  # Redis 不可用时不阻塞清理

    if not acquired:
        logger.info("[OrganizationPurge] organization=%s 已有清理在执行，跳过", organization_id)
        return {"skipped": True, "reason": "locked"}

    try:
        purged = OrganizationService.purge_organization_by_id(organization_id)
        logger.info("[OrganizationPurge] organization=%s 清理完成 purged=%s", organization_id, purged)
        return {"purged": purged, "organization_id": organization_id}
    except Exception as exc:
        logger.error("[OrganizationPurge] organization=%s 清理失败: %s", organization_id, exc, exc_info=True)
        raise self.retry(exc=exc)
    finally:
        try:
            django_cache.delete(lock_key)
        except Exception:
            pass


_DELETING_STUCK_MINUTES = 10


@shared_task(
    name="tabtinspace.repurge_stuck_deleting_organizations",
    ignore_result=True,
    time_limit=120,
    soft_time_limit=100,
)
def repurge_stuck_deleting_organizations():
    """兜底重扫：把卡在 deleting 状态超过阈值的组织重新入队 purge。

    覆盖「发起删除时 broker 不可用 / purge 任务中途崩溃」两类残留。
    阈值大于典型 purge 耗时，避免与在途清理重复触发；purge_organization 内的
    cache 锁进一步防并发。
    """
    from datetime import timedelta
    from django.utils import timezone
    from apps.tabtinspace.models import Organization

    cutoff = timezone.now() - timedelta(minutes=_DELETING_STUCK_MINUTES)
    stuck_ids = list(
        Organization.objects.using(postgres_app_db_alias())
        .filter(status=Organization.Status.DELETING, updated_at__lt=cutoff)
        .values_list('id', flat=True)[:100]
    )
    for organization_id in stuck_ids:
        purge_organization.delay(str(organization_id))

    if stuck_ids:
        logger.info("[OrganizationPurge] 兜底重入队 %d 个卡死 deleting 团队", len(stuck_ids))
    return {"re_enqueued": len(stuck_ids)}
