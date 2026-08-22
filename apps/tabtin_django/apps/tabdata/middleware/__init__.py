"""
TabData 中间件
"""

from django.http import HttpRequest, HttpResponse
from django.utils.deprecation import MiddlewareMixin

from apps.tabdata.request_context import (
    clear_request_context,
    is_embedded_access_verification_unavailable,
    set_current_parent_document_id,
    set_current_table_share_grant,
    set_current_table_share_password,
    set_current_window_id,
)


class TabDataRequestContextMiddleware(MiddlewareMixin):
    """
    把请求头中的 X-Window-Id 写入线程上下文，供 service/signals 读取。
    """

    def process_request(self, request: HttpRequest) -> None:
        clear_request_context()
        window_id = (
            request.headers.get("X-Window-Id")
            or request.headers.get("x-window-id")
            or request.META.get("HTTP_X_WINDOW_ID")
        )
        set_current_window_id(window_id)
        parent_document_id = (
            request.headers.get("X-TabTin-Parent-Document-Id")
            or request.headers.get("x-tabtin-parent-document-id")
            or request.META.get("HTTP_X_TABTIN_PARENT_DOCUMENT_ID")
        )
        set_current_parent_document_id(parent_document_id)
        share_id = (
            request.headers.get("X-Table-Share-Id")
            or request.headers.get("x-table-share-id")
            or request.META.get("HTTP_X_TABLE_SHARE_ID")
        )
        share_password = (
            request.headers.get("X-Table-Share-Password")
            or request.headers.get("x-table-share-password")
            or request.META.get("HTTP_X_TABLE_SHARE_PASSWORD")
        )
        set_current_table_share_password(share_password)
        if not share_id:
            set_current_table_share_grant(None)
            return

        try:
            from apps.tabdata.services.share_service import TableShareService

            share = TableShareService.get_share_by_id(str(share_id).strip())
            if getattr(share, "share_type", None) not in {"data", "organization"}:
                share = None
            elif getattr(share, "permission", None) != "edit":
                share = None
            set_current_table_share_grant(share)
        except Exception:
            set_current_table_share_grant(None)

    def process_response(self, request: HttpRequest, response: HttpResponse) -> HttpResponse:
        if response.status_code == 403 and is_embedded_access_verification_unavailable():
            response["X-TabTin-Embedded-Access-Unavailable"] = "1"
        clear_request_context()
        return response

    def process_exception(self, request: HttpRequest, exception: Exception) -> None:
        clear_request_context()


# Re-export for backwards compatibility
from apps.tabdata.middleware.api_logging import OpenApiLoggingMiddleware  # noqa: E402, F401
