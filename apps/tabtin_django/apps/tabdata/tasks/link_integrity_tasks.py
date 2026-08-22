"""
Link 数据完整性 Celery 定期任务

定期执行 Link 字段的数据完整性检查与修复：
- 清理孤儿 LinkRecord
- 修复 JSONB 缓存与 LinkRecord 不一致
- 修复对称字段 LinkRecord 不对称
"""

import logging

from celery import shared_task
from celery.schedules import crontab

logger = logging.getLogger(__name__)


@shared_task(bind=True, max_retries=1, default_retry_delay=300, time_limit=1800, soft_time_limit=1740)
def check_link_integrity(self):
    """
    定期完整性检查任务（每天凌晨 4:00 执行）。

    执行修复模式（dry_run=False），自动修复发现的问题。
    """
    from apps.tabdata.services.link_integrity_service import LinkIntegrityService

    logger.info("开始 Link 完整性检查任务...")
    try:
        report = LinkIntegrityService.run_full_check(dry_run=False)
        total_issues = report.get('total_issues_found', 0)
        total_fixed = report.get('total_issues_fixed', 0)
        elapsed = report.get('elapsed_seconds', 0)

        if total_issues > 0:
            logger.warning(
                "Link 完整性检查完成: 发现 %d 个问题, 修复 %d 个, 耗时 %.2fs",
                total_issues, total_fixed, elapsed,
            )
        else:
            logger.info(
                "Link 完整性检查完成: 无异常, 耗时 %.2fs", elapsed,
            )

        return {
            'status': 'completed',
            'issues_found': total_issues,
            'issues_fixed': total_fixed,
            'elapsed_seconds': elapsed,
        }
    except Exception as exc:
        logger.error("Link 完整性检查失败: %s", exc, exc_info=True)
        raise self.retry(exc=exc)


@shared_task(bind=True, time_limit=1800, soft_time_limit=1740)
def check_link_integrity_dry_run(self, table_id=None):
    """
    手动触发的 dry-run 检查（不修复，仅生成报告）。

    Args:
        table_id: 可选，指定检查特定表
    """
    from apps.tabdata.services.link_integrity_service import LinkIntegrityService

    logger.info("开始 Link 完整性检查 (dry-run, table=%s)...", table_id or 'all')
    try:
        report = LinkIntegrityService.run_full_check(
            dry_run=True,
            table_id=table_id,
        )
        return report
    except Exception as exc:
        logger.error("Link 完整性检查 (dry-run) 失败: %s", exc, exc_info=True)
        raise


# ── Beat Schedule ──

LINK_INTEGRITY_BEAT_SCHEDULE = {
    'check-link-integrity-daily': {
        'task': 'apps.tabdata.tasks.link_integrity_tasks.check_link_integrity',
        'schedule': crontab(hour=4, minute=0),
        'options': {'expires': 3600},  # 1 小时过期
    },
}
