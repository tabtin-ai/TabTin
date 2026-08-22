"""
I18n 中间件

职责：
- 自动检测请求语言
- 设置线程本地语言
- 清理资源
"""

from django.utils.deprecation import MiddlewareMixin
from .language import get_user_language, set_user_language, clear_user_language


class I18nMiddleware(MiddlewareMixin):
    """国际化中间件"""

    def process_request(self, request):
        """处理请求，设置语言"""
        # 获取用户对象（如果已认证）
        user = request.user if hasattr(request, 'user') and request.user.is_authenticated else None

        # 检测并设置语言
        language = get_user_language(request, user)
        set_user_language(language)

        # 将语言附加到请求对象，方便后续使用
        request.language = language

    def process_response(self, request, response):
        """处理响应，清理资源"""
        clear_user_language()
        return response

