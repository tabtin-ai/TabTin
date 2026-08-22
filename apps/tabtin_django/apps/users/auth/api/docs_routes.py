"""文档与系统路由。"""

import logging

from django.http import HttpRequest
from ninja import Router

from apps.i18n import _
from apps.services.common.runtime_build import get_server_build

from ._shared import ApiResponseSchema

logger = logging.getLogger(__name__)
router = Router()


@router.get("/docs/swagger", auth=None, tags=["文档"])
def get_auth_swagger_doc(request: HttpRequest):
    """
    获取 API 文档（OpenAPI 3.1 格式）

    返回 contracts/openapi/tabtin-api.yaml 中定义的 OpenAPI 规范。
    此端点取代了旧的 Swagger 2.0 文档。
    """
    import os
    import yaml
    from django.http import JsonResponse

    project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(__file__)))))))
    spec_path = os.path.join(project_root, 'contracts', 'openapi', 'tabtin-api.yaml')

    try:
        with open(spec_path, 'r', encoding='utf-8') as f:
            spec_content = yaml.safe_load(f)
        return JsonResponse(spec_content, json_dumps_params={'ensure_ascii': False, 'indent': 2})
    except FileNotFoundError:
        return JsonResponse({
            'error': _("auth.openapi_not_found"),
            'message': "Please ensure contracts/openapi/tabtin-api.yaml exists"
        }, status=404)
    except Exception:
        logger.exception("get_auth_swagger_doc 文档读取异常")
        return JsonResponse({
            'error': _("auth.doc_read_failed"),
            'message': "操作失败，请稍后重试"
        }, status=500)


@router.get("/docs/yaml", auth=None, tags=["文档"])
def get_auth_swagger_yaml(request: HttpRequest):
    """
    获取 API 文档原始 YAML（OpenAPI 3.1 格式）

    返回 contracts/openapi/tabtin-api.yaml 的原始 YAML 内容。
    """
    import os
    from django.http import HttpResponse

    project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(__file__)))))))
    spec_path = os.path.join(project_root, 'contracts', 'openapi', 'tabtin-api.yaml')

    try:
        with open(spec_path, 'r', encoding='utf-8') as f:
            yaml_content = f.read()
        response = HttpResponse(yaml_content, content_type='text/yaml; charset=utf-8')
        response['Content-Disposition'] = 'attachment; filename="tabtin-api.yaml"'
        return response
    except FileNotFoundError:
        return HttpResponse(_("auth.openapi_not_found"), status=404)
    except Exception:
        logger.exception("get_auth_swagger_yaml 文档读取异常")
        return HttpResponse(_("auth.doc_read_failed"), status=500)


@router.get("/docs/info", response=ApiResponseSchema, auth=None, tags=["文档"])
def get_auth_api_info(request: HttpRequest):
    """
    获取认证API文档信息

    ## 功能说明
    返回认证API的基本信息和文档访问链接。

    ## 返回信息
    - API版本和描述
    - 文档访问链接
    - 接口统计信息
    """
    current_host = request.get_host()
    protocol = 'https' if request.is_secure() else 'http'
    base_url = f"{protocol}://{current_host}"

    return ApiResponseSchema(
        success=True,
        message="Auth API Documentation",
        data={
            "api_info": {
                "title": "TabTin REST API",
                "version": "1.0.0",
                "description": "TabTin 平台 REST API，规范定义于 contracts/openapi/tabtin-api.yaml",
                "spec_format": "OpenAPI 3.1"
            },
            "documentation_links": {
                "openapi_json": f"{base_url}/api/auth/docs/swagger",
                "openapi_yaml": f"{base_url}/api/auth/docs/yaml",
                "swagger_ui": f"{base_url}/api/docs#tag/认证",
                "api_info": f"{base_url}/api/auth/docs/info"
            },
            "endpoints_summary": {
                "authentication": [
                    "POST /register - 用户注册",
                    "POST /login - 密码登录",
                    "POST /login/verification-code - 验证码登录",
                    "POST /logout - 用户登出"
                ],
                "verification": [
                    "POST /send-verification-code - 发送验证码",
                    "POST /verify-email - 邮箱验证",
                    "POST /verify-phone - 手机验证"
                ],
                "password_management": [
                    "POST /forgot-password - 忘记密码",
                    "POST /reset-password - 重置密码",
                    "POST /change-password - 修改密码"
                ],
                "user_management": [
                    "GET /profile - 获取用户资料",
                    "PUT /profile - 更新用户资料",
                    "GET /sessions - 获取会话列表",
                    "DELETE /sessions/{id} - 删除会话"
                ],
                "tools": [
                    "GET /password-strength - 密码强度检查",
                    "GET /health - 健康检查"
                ]
            },
            "usage_for_ai": {
                "recommended_url": f"{base_url}/api/auth/docs/swagger",
                "description": "推荐将此URL发送给AI工具进行API分析，包含 Auth/Chat/Context 完整接口定义",
                "format": "OpenAPI 3.1 JSON",
                "source": "contracts/openapi/tabtin-api.yaml"
            }
        }
    )


@router.get("/health", response=ApiResponseSchema, auth=None, tags=["系统"])
def health_check(request: HttpRequest):
    """健康检查"""
    return ApiResponseSchema(
        success=True,
        message=_("auth.health_ok"),
        data=get_server_build().as_dict(),
    )
