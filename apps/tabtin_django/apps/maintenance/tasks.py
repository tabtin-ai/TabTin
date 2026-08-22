"""
系统维护任务
"""

from celery import shared_task
from celery.schedules import crontab
from django.utils import timezone
from datetime import timedelta
import logging

logger = logging.getLogger(__name__)


@shared_task(bind=True, ignore_result=True, time_limit=120, soft_time_limit=100)
def cleanup_expired_sessions(self):
    """清理过期的用户会话"""
    try:
        from apps.users.auth.session_manager import SessionManager
        cleaned_count = SessionManager.cleanup_expired_sessions()
        logger.info(f"清理了 {cleaned_count} 个过期会话")
        return {"success": True, "cleaned_sessions": cleaned_count}
    except Exception as e:
        logger.error(f"清理过期会话失败: {e}", exc_info=True)
        return {"success": False, "error": str(e)}


@shared_task(bind=True, ignore_result=True, time_limit=300, soft_time_limit=270)
def cleanup_celery_results(self, batch_size=1000):
    """清理过期的 Celery 任务结果（分批删除，避免长事务锁竞争）"""
    try:
        from django_celery_results.models import TaskResult
        cutoff_date = timezone.now() - timedelta(days=7)
        total_deleted = 0

        while True:
            batch_ids = list(
                TaskResult.objects
                .filter(date_done__lt=cutoff_date)
                .values_list('id', flat=True)[:batch_size]
            )
            if not batch_ids:
                break
            deleted_count, _ = TaskResult.objects.filter(id__in=batch_ids).delete()
            total_deleted += deleted_count
            logger.debug("清理 TaskResult 批次: %d 条", deleted_count)

        logger.info("清理了 %d 个过期的 Celery 任务结果", total_deleted)
        return {"success": True, "cleaned_results": total_deleted}
    except Exception as e:
        logger.error("清理 Celery 任务结果失败: %s", e, exc_info=True)
        return {"success": False, "error": str(e)}


@shared_task(bind=True, ignore_result=True, time_limit=120, soft_time_limit=100)
def cleanup_verification_codes(self):
    """清理过期的验证码缓存"""
    try:
        from django_redis import get_redis_connection
        conn = get_redis_connection("default")

        expired_count = 0
        for key in conn.scan_iter(match="vc:*", count=200):
            ttl = conn.ttl(key)
            if ttl == -1:
                conn.delete(key)
                expired_count += 1

        logger.info(f"清理了 {expired_count} 个异常的验证码缓存")
        return {"success": True, "cleaned_codes": expired_count}
    except Exception as e:
        logger.error(f"清理验证码缓存失败: {e}", exc_info=True)
        return {"success": False, "error": str(e)}


@shared_task(bind=True, ignore_result=True, time_limit=60, soft_time_limit=45)
def system_health_check(self):
    """系统健康检查"""
    try:
        from django_redis import get_redis_connection
        from django.db import connections

        health_status = {
            "timestamp": timezone.now().isoformat(),
            "redis": False,
            "database": False,
            "database_pg": False,
            "services": []
        }

        # 检查Redis连接
        try:
            conn = get_redis_connection("default")
            conn.ping()
            health_status["redis"] = True
        except Exception as e:
            logger.error(f"Redis连接检查失败: {e}")

        # 检查 MySQL（default）连接
        try:
            with connections['default'].cursor() as cursor:
                cursor.execute("SELECT 1")
            health_status["database"] = True
        except Exception as e:
            logger.error(f"MySQL 连接检查失败: {e}")

        # 检查 PostgreSQL 连接（承载 tabdata/tabdoc/rag/multiagent 等核心业务）
        try:
            with connections['postgresql'].cursor() as cursor:
                cursor.execute("SELECT 1")
            health_status["database_pg"] = True
        except Exception as e:
            logger.error(f"PostgreSQL 连接检查失败: {e}")

        logger.info(
            "系统健康检查完成: Redis=%s, MySQL=%s, PostgreSQL=%s",
            health_status['redis'], health_status['database'], health_status['database_pg'],
        )
        return health_status
    except Exception as e:
        logger.error(f"系统健康检查失败: {e}", exc_info=True)
        return {"success": False, "error": str(e)}


@shared_task(bind=True, ignore_result=True, time_limit=300, soft_time_limit=270)
def cleanup_failed_task_records(self):
    """清理 90 天以上已 resolved 的 FailedTaskRecord。"""
    try:
        from apps.maintenance.models import FailedTaskRecord

        cutoff = timezone.now() - timedelta(days=90)
        deleted, _ = FailedTaskRecord.objects.filter(
            resolved=True,
            resolved_at__lt=cutoff,
        ).delete()
        logger.info('cleanup_failed_task_records: deleted %s rows', deleted)
        return {'success': True, 'deleted': deleted}
    except Exception as e:
        logger.error('cleanup_failed_task_records failed: %s', e, exc_info=True)
        return {'success': False, 'error': str(e)}


@shared_task(bind=True, ignore_result=True, time_limit=300, soft_time_limit=270)
def cleanup_webhook_delivery_failures(self):
    """清理 90 天以上的 WebhookDeliveryFailure。"""
    try:
        from apps.tabdata.models_webhook import WebhookDeliveryFailure

        cutoff = timezone.now() - timedelta(days=90)
        deleted, _ = WebhookDeliveryFailure.objects.filter(
            created_at__lt=cutoff,
        ).delete()
        logger.info('cleanup_webhook_delivery_failures: deleted %s rows', deleted)
        return {'success': True, 'deleted': deleted}
    except Exception as e:
        logger.error('cleanup_webhook_delivery_failures failed: %s', e, exc_info=True)
        return {'success': False, 'error': str(e)}


# 定期任务配置
MAINTENANCE_SCHEDULE = {
    'cleanup-expired-sessions': {
        'task': 'apps.maintenance.tasks.cleanup_expired_sessions',
        'schedule': crontab(hour=2, minute=0),
        'options': {'expires': 3600},
    },
    'cleanup-celery-results': {
        'task': 'apps.maintenance.tasks.cleanup_celery_results',
        'schedule': crontab(hour='*/6', minute=30),
        'options': {'expires': 3600},
    },
    'cleanup-verification-codes': {
        'task': 'apps.maintenance.tasks.cleanup_verification_codes',
        'schedule': crontab(hour=1, minute=30),
        'options': {'expires': 3600},
    },
    'system-health-check': {
        'task': 'apps.maintenance.tasks.system_health_check',
        'schedule': crontab(minute='*/30'),
        'options': {'expires': 1500},
    },
    'cleanup-failed-task-records': {
        'task': 'apps.maintenance.tasks.cleanup_failed_task_records',
        'schedule': crontab(hour=3, minute=15),
        'options': {'expires': 3600},
    },
    'cleanup-webhook-delivery-failures': {
        'task': 'apps.maintenance.tasks.cleanup_webhook_delivery_failures',
        'schedule': crontab(hour=3, minute=45),
        'options': {'expires': 3600},
    },
}
