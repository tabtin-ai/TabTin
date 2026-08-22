"""
Celery Worker 健康检查、告警通知和外部探针支持

定期检查 Celery Worker 状态，发现问题时通过 webhook 告警，
并写入健康状态文件供外部探针脚本检测。
"""
import json
import logging
import os
import time
from datetime import timedelta
from django.utils import timezone
from celery import current_app
from celery.app.control import Inspect

logger = logging.getLogger(__name__)

_ALERT_COOLDOWN_SECONDS = 300
_last_alert_time = 0.0

HEALTH_STATUS_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "logs",
)
HEALTH_STATUS_FILE = os.path.join(HEALTH_STATUS_DIR, "celery_health_status.json")


def _known_queue_names(settings) -> list[str]:
    tracker_agent_queue = getattr(settings, 'TRACKER_AGENT_QUEUE', 'tracker_agent')
    pptx_import_oss_queue = getattr(
        settings,
        'PPTX_IMPORT_OSS_QUEUE',
        'pptx_import_oss',
    )
    return list(dict.fromkeys([
        'critical',
        'default',
        'realtime_delivery',
        'search_indexing',
        'rag_indexing',
        'doc_merge',
        'heavy',
        'media',
        'docparse',
        'tabdata_conversion',
        tracker_agent_queue,
        'low_priority',
        pptx_import_oss_queue,
    ]))


def _send_health_alert(issues: list, report: dict) -> bool:
    """通过 webhook 发送健康告警，带冷却期防止告警风暴。"""
    global _last_alert_time

    now = time.monotonic()
    if now - _last_alert_time < _ALERT_COOLDOWN_SECONDS:
        logger.debug("告警冷却期内，跳过 webhook 通知")
        return False

    from django.conf import settings
    webhook_url = getattr(settings, "CELERY_HEALTH_ALERT_WEBHOOK_URL", "")
    if not webhook_url:
        logger.debug("CELERY_HEALTH_ALERT_WEBHOOK_URL 未配置，跳过 webhook 告警")
        return False

    try:
        from apps.extensions.delivery import deliver_webhook_once
        payload = {
            "event": "celery.health_check.unhealthy",
            "source": "celery_health_checker",
            "timestamp": report.get("timestamp", timezone.now().isoformat()),
            "data": {
                "issues": issues,
                "workers": report.get("workers", {}).get("workers", []),
                "queues": report.get("queues", {}).get("queues", {}),
            },
        }
        result = deliver_webhook_once(
            url=webhook_url,
            payload=payload,
            event_type="celery.health_check.unhealthy",
            timeout=10,
        )
        _last_alert_time = now
        if result.get("ok"):
            logger.info("健康告警 webhook 发送成功")
        else:
            logger.warning("健康告警 webhook 返回失败: %s", result.get("error"))
        return result.get("ok", False)
    except Exception as e:
        logger.error("健康告警 webhook 发送异常: %s", e)
        _last_alert_time = now
        return False


def _write_health_status_file(report: dict) -> None:
    """将健康状态写入文件，供外部探针脚本读取。

    使用唯一临时文件 + os.replace 实现原子写入，
    避免多进程并发写同一 .tmp 文件导致 ENOENT 竞态。
    """
    import tempfile

    tmp_fd = None
    tmp_path = None
    try:
        os.makedirs(HEALTH_STATUS_DIR, exist_ok=True)
        status = {
            "healthy": report.get("healthy", False),
            "timestamp": report.get("timestamp", timezone.now().isoformat()),
            "epoch": int(time.time()),
            "workers": report.get("workers", {}).get("workers", []),
            "issues": report.get("summary", {}).get("issues", []),
            "queues": report.get("queues", {}).get("queues", {}),
        }
        tmp_fd, tmp_path = tempfile.mkstemp(
            prefix="celery_health_", suffix=".tmp", dir=HEALTH_STATUS_DIR,
        )
        with os.fdopen(tmp_fd, "w") as f:
            tmp_fd = None
            json.dump(status, f, ensure_ascii=False)
        os.replace(tmp_path, HEALTH_STATUS_FILE)
        tmp_path = None
    except Exception as e:
        logger.error("写入健康状态文件失败: %s", e)
    finally:
        if tmp_fd is not None:
            os.close(tmp_fd)
        if tmp_path is not None:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


class CeleryHealthChecker:
    """Celery 健康检查器"""

    def __init__(self):
        self.inspect = Inspect(app=current_app, timeout=5.0)

    def check_workers(self):
        """
        检查 Worker 状态

        Returns:
            dict: {
                "healthy": bool,
                "workers": list,
                "issues": list
            }
        """
        issues = []
        workers = []

        try:
            active_workers = self.inspect.active()
            if not active_workers:
                issues.append("没有活跃的 Worker")
                return {
                    "healthy": False,
                    "workers": [],
                    "issues": issues
                }

            workers = list(active_workers.keys())
            logger.debug("发现 %d 个活跃 Worker: %s", len(workers), workers)

            ping_result = self.inspect.ping()
            if not ping_result:
                issues.append("Worker 无法响应 ping")

            registered = self.inspect.registered()
            if registered:
                for worker, tasks in registered.items():
                    if worker.startswith('celery@') and len(tasks) == 0:
                        issues.append(f"主 Worker {worker} 未注册任何任务")

            now = timezone.now()
            for worker, tasks in active_workers.items():
                for task in tasks:
                    time_start = task.get('time_start')
                    if time_start:
                        import datetime as _dt
                        start_time = timezone.datetime.fromtimestamp(
                            time_start, tz=_dt.timezone.utc
                        )
                        duration = now - start_time
                        if duration > timedelta(minutes=15):
                            issues.append(
                                f"Worker {worker} 有长时间运行的任务: "
                                f"{task.get('name')} (运行 {duration.total_seconds()/60:.1f} 分钟)"
                            )

            return {
                "healthy": len(issues) == 0,
                "workers": workers,
                "issues": issues,
                "active_tasks_count": sum(len(tasks) for tasks in active_workers.values()),
            }

        except Exception as e:
            logger.error("健康检查失败: %s", e)
            return {
                "healthy": False,
                "workers": [],
                "issues": [f"健康检查异常: {str(e)}"]
            }

    def check_workers_quick(self):
        """轻量 Worker 检查：只 ping，不做 active/registered 深度 inspect。"""
        try:
            ping_result = self.inspect.ping()
            if not ping_result:
                return {
                    "healthy": False,
                    "workers": [],
                    "issues": ["Worker 无法响应 ping"],
                    "active_tasks_count": None,
                }
            workers = list(ping_result.keys())
            logger.debug("Celery quick health ping ok: workers=%d", len(workers))
            return {
                "healthy": True,
                "workers": workers,
                "issues": [],
                "active_tasks_count": None,
            }
        except Exception as e:
            logger.error("轻量 Worker 健康检查失败: %s", e)
            return {
                "healthy": False,
                "workers": [],
                "issues": [f"轻量 Worker 健康检查异常: {str(e)}"],
                "active_tasks_count": None,
            }

    def check_queue_health(self):
        """
        检查队列健康状态

        Returns:
            dict: {
                "healthy": bool,
                "queues": dict,
                "issues": list
            }
        """
        issues = []

        try:
            import redis
            from django.conf import settings

            r = redis.from_url(settings.CELERY_BROKER_URL)
            queues = {queue_name: r.llen(queue_name) for queue_name in _known_queue_names(settings)}

            for queue_name, length in queues.items():
                if length > 100:
                    issues.append(f"队列 {queue_name} 堆积严重: {length} 个任务")
                elif length > 50:
                    logger.warning("队列 %s 有 %d 个待处理任务", queue_name, length)

            return {
                "healthy": len(issues) == 0,
                "queues": queues,
                "issues": issues
            }

        except Exception as e:
            logger.error("队列检查失败: %s", e)
            return {
                "healthy": False,
                "queues": {},
                "issues": [f"队列检查异常: {str(e)}"]
            }

    def full_check(self):
        """
        完整健康检查

        Returns:
            dict: 完整的健康报告
        """
        worker_health = self.check_workers()
        queue_health = self.check_queue_health()

        all_healthy = (
            worker_health["healthy"] and
            queue_health["healthy"]
        )

        all_issues = (
            worker_health.get("issues", []) +
            queue_health.get("issues", [])
        )

        report = {
            "timestamp": timezone.now().isoformat(),
            "healthy": all_healthy,
            "workers": worker_health,
            "queues": queue_health,
            "summary": {
                "total_issues": len(all_issues),
                "issues": all_issues
            }
        }

        if not all_healthy:
            logger.warning(
                "Celery 健康检查发现 %d 个问题: %s",
                len(all_issues), "; ".join(all_issues),
            )
            _send_health_alert(all_issues, report)

        _write_health_status_file(report)

        return report

    def quick_check(self):
        """周期任务使用的轻量健康检查，避免 critical worker 上跑重型 inspect。"""
        worker_health = self.check_workers_quick()
        queue_health = self.check_queue_health()

        all_healthy = (
            worker_health["healthy"] and
            queue_health["healthy"]
        )

        all_issues = (
            worker_health.get("issues", []) +
            queue_health.get("issues", [])
        )

        report = {
            "timestamp": timezone.now().isoformat(),
            "healthy": all_healthy,
            "workers": worker_health,
            "queues": queue_health,
            "summary": {
                "total_issues": len(all_issues),
                "issues": all_issues
            }
        }

        if not all_healthy:
            logger.warning(
                "Celery 轻量健康检查发现 %d 个问题: %s",
                len(all_issues), "; ".join(all_issues),
            )
            _send_health_alert(all_issues, report)

        _write_health_status_file(report)

        return report


# 全局实例
health_checker = CeleryHealthChecker()
