"""
信号处理器
"""
import logging
import uuid as _uuid

from django.db import transaction
from django.db.models.signals import pre_save, post_save, pre_delete
from django.dispatch import receiver
from django.contrib.auth import get_user_model
from django.core.cache import cache
from apps.services.common.db_router import postgres_app_db_alias

from .models import UserProfile, UserActionLog

User = get_user_model()
logger = logging.getLogger(__name__)


def _write_cleanup_audit_log(user_id: str, display_name: str, *, success: bool,
                             result_payload: dict | None = None,
                             error_message: str = ''):
    """写入用户删除跨库清理的审计日志（委托 AuditService.log，best-effort）。"""
    try:
        from apps.tabtinspace.services.audit_service import AuditService
        AuditService.log(
            'user_delete_cleanup',
            'user',
            _uuid.UUID(user_id),
            operator_id='system',
            operator_name='pre_delete signal',
            success=success,
            message=f"用户 {display_name}({user_id}) 跨库清理{'成功' if success else '失败'}",
            error_message=error_message,
            result_payload=result_payload,
        )
    except Exception as audit_exc:
        logger.warning("[UserCleanup] 审计日志写入失败: %s", audit_exc)


@receiver(pre_save, sender=User)
def capture_previous_is_active(sender, instance, **kwargs):
    """保存前记录旧的 is_active 值，供 post_save 检测变更（SDI-014 兜底）。"""
    if instance.pk:
        try:
            instance._previous_is_active = (
                User.objects.filter(pk=instance.pk)
                .values_list('is_active', flat=True)
                .first()
            )
        except Exception:
            instance._previous_is_active = None
    else:
        instance._previous_is_active = None


@receiver(post_save, sender=User)
def handle_user_deactivation(sender, instance, created, **kwargs):
    """用户被禁用时自动清除全部活跃会话（SDI-014 系统性兜底）。

    覆盖所有 ORM 写入路径：Django Admin、Celery 任务、管理脚本等。
    """
    if created:
        return
    was_active = getattr(instance, '_previous_is_active', None)
    if was_active is True and not instance.is_active:
        from .session_manager import SessionManager
        count = SessionManager.invalidate_all_user_sessions(str(instance.id))
        if count:
            logger.info(
                "[Signal] 用户 %s 被禁用，已清除 %d 个活跃会话",
                instance.id, count,
            )


@receiver(post_save, sender=User)
def create_user_profile(sender, instance, created, **kwargs):
    """用户创建时自动创建用户配置"""
    if created:
        try:
            UserProfile.objects.get_or_create(user=instance)
        except Exception:
            pass


@receiver(post_save, sender=User)
def save_user_profile(sender, instance, **kwargs):
    """用户保存时同时保存用户配置。

    当 update_fields 被指定时（如仅更新 is_active），说明调用方只修改了
    User 模型的特定字段，不需要级联保存 profile，跳过以避免写放大和额外
    SELECT 查询。
    """
    if kwargs.get('update_fields') is not None:
        return
    try:
        if instance.profile:
            instance.profile.save()
    except (UserProfile.DoesNotExist, AttributeError):
        pass


@receiver(post_save, sender=User)
def clear_user_cache(sender, instance, **kwargs):
    """用户信息变更时清除相关缓存"""
    cache_keys = [
        f"user:{instance.id}",
        f"user_profile:{instance.id}",
        f"user_permissions:{instance.id}",
    ]
    cache.delete_many(cache_keys)


@receiver(pre_delete, sender=User)
def cleanup_user_data(sender, instance, **kwargs):
    """用户删除前清理跨库关联数据（PostgreSQL 侧）和缓存。

    核心清理逻辑委托 OrganizationService.cleanup_user_postgresql_data()，
    PostgreSQL 清理失败时 raise CrossDatabaseCleanupError 阻止 User 删除。
    """
    cache.delete_many([
        f"user:{instance.id}",
        f"user_profile:{instance.id}",
        f"user_permissions:{instance.id}",
    ])

    user_id = str(instance.id)
    display_name = instance.get_display_name()
    try:
        from apps.tabtinspace.services.organization_service import OrganizationService

        with transaction.atomic(using=postgres_app_db_alias()):
            cleanup_stats = OrganizationService.cleanup_user_postgresql_data(user_id)

        if cleanup_stats.get('owned_organizations') or cleanup_stats.get('memberships'):
            logger.info(
                "[UserCleanup] 用户 %s 删除：清理 %d 个组织、%d 条成员关系",
                user_id, cleanup_stats['owned_organizations'], cleanup_stats['memberships'],
            )
        _write_cleanup_audit_log(
            user_id, display_name,
            success=True, result_payload=cleanup_stats,
        )
    except Exception as exc:
        logger.error(
            "[UserCleanup] 清理用户 %s 的 PostgreSQL 关联数据失败: %s",
            user_id, exc, exc_info=True,
        )
        _write_cleanup_audit_log(
            user_id, display_name,
            success=False, error_message=str(exc),
        )
        from apps.tabtinspace.exceptions import CrossDatabaseCleanupError
        raise CrossDatabaseCleanupError(
            f"PostgreSQL 侧数据清理失败，User {user_id} 删除被中止。"
            f"请检查 PostgreSQL 连接后重试。原始异常: {exc}"
        ) from exc
