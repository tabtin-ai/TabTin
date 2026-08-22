"""
API Key 上下文清理中间件 (P0-10)

在每次请求前后重置 ContextVar，防止线程池复用时约束泄漏到后续请求。
"""

from django.http import HttpRequest, HttpResponse

from .api_key_context import _api_key_organization_var


class ApiKeyContextMiddleware:
    """重置 API Key organization 约束 ContextVar 的请求生命周期管理。"""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request: HttpRequest) -> HttpResponse:
        token = _api_key_organization_var.set('')
        try:
            return self.get_response(request)
        finally:
            _api_key_organization_var.reset(token)
