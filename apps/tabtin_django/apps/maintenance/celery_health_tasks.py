"""
Celery 健康检查定时任务
"""
import logging
from celery import shared_task

logger = logging.getLogger(__name__)


@shared_task(bind=True, ignore_result=True, time_limit=60, soft_time_limit=50)
def celery_health_check(self):
    """每5分钟执行一次轻量 Worker 和队列检查。"""
    from apps.maintenance.celery_health import health_checker

    try:
        report = health_checker.quick_check()
        return {
            "status": "healthy" if report["healthy"] else "unhealthy",
            "issues_count": report['summary']['total_issues'],
            "workers_count": len(report['workers'].get('workers', [])),
        }
    except Exception as e:
        logger.error("健康检查执行失败: %s", e)
        return {"status": "error", "error": str(e)}


# 定时任务配置
CELERY_HEALTH_CHECK_SCHEDULE = {
    # 每5分钟执行一次健康检查
    "celery-health-check": {
        "task": "apps.maintenance.celery_health_tasks.celery_health_check",
        "schedule": 300.0,  # 5分钟
        "options": {
            "expires": 240,  # 4分钟后过期
            "queue": "critical",
        },
    },
}
