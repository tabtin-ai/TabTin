"""
健康检查 API
"""
from ninja import Router
from django.http import HttpRequest
from apps.users.auth.permissions import JWTAuth
from apps.tabdata.api_helpers import success_response
from apps.maintenance.celery_health import health_checker

router = Router(tags=["Health"])
jwt_auth = JWTAuth()


@router.get(
    "/health/celery",
    response={200: dict},
    auth=jwt_auth,
    summary="Celery 健康检查"
)
def celery_health(request: HttpRequest):
    """
    检查 Celery Worker 和队列健康状态

    返回：
    - workers: Worker 状态
    - queues: 队列状态
    - summary: 问题汇总
    """
    report = health_checker.full_check()
    return success_response(report)
