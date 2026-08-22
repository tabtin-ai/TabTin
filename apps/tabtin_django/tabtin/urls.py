"""
URL configuration for tabtin project.

路由分层设计：
- 核心路由（auth/chat/tabtinspace/membership/wallet/i18n/health）在此文件静态导入
- 非核心路由（~45 个）由 DeferredRouterMiddleware 在首次请求时从 urls_deferred.py 延迟注册
- api 对象和 _safe_add_router 位于 api_instance.py，供两边共享
"""

import os

from django.conf import settings as django_settings
from django.contrib import admin
from django.urls import path, include

from .api_instance import api, _safe_add_router  # noqa: F401 — urls_deferred 也用

# ── 核心 router（首屏/高频/登录必需，保留静态导入）──
from apps.users.auth.api import router as auth_router
from apps.chat.conversation.api import router as chat_router
from apps.tabtinspace.routers import router as tabtinspace_router
from apps.users.membership.api import router as membership_router
from apps.users.wallet.api import router as wallet_router
from apps.i18n.api import router as i18n_router
from apps.tabdata.api_health import router as health_router
from apps.services.daemon_control.api import query_device_presence


# ── 内联 API 端点（直接定义在 api 对象上）──────────────────

@api.get("/", auth=None)
def api_root(request):
    """API根路径，返回API信息"""
    return {
        "message": "Tabtin API Service",
        "version": "1.0.0",
        "docs": "/api/docs",
        "endpoints": {
            "extract_health": "/api/extract/health",
            "extract_service_status": "/api/extract/service-status",
            "generate_schema": "/api/extract/generate-schema",
            "generate_schema_async": "/api/extract/generate-schema-async",
            "sms_health": "/api/services/sms/health",
            "send_sms": "/api/services/sms/send-sms",
            "send_verification_code": "/api/services/sms/send-code",
            "email_health": "/api/services/email/health",
            "send_email": "/api/services/email/send-email",
            "send_verification_email": "/api/services/email/send-code",
            "oss_health": "/api/services/oss/health",
            "oss_upload": "/api/services/oss/upload",
            "oss_files": "/api/services/oss/files",
            "oss_bucket_info": "/api/services/oss/bucket/info",
            "auth_register": "/api/auth/register",
            "auth_login": "/api/auth/login",
            "auth_profile": "/api/auth/profile",
            "auth_health": "/api/auth/health"
        }
    }

@api.get("/auth/docs", auth=None)
def auth_docs(request):
    """认证API文档，专门为开发工具提供"""
    return {
        "title": "Tabtin 认证API文档",
        "version": "1.0.0",
        "base_url": "http://localhost:6060/api/auth",
        "authentication": "JWT Bearer Token",
        "endpoints": {
            "register": {
                "method": "POST",
                "path": "/api/auth/register",
                "description": "用户注册（需要验证码）",
                "auth_required": False,
                "example": {
                    "request": {
                        "email": "user@example.com",
                        "password": "MyPassword123!",
                        "verification_code": "123456"
                    }
                }
            },
            "login": {
                "method": "POST",
                "path": "/api/auth/login",
                "description": "用户登录",
                "auth_required": False,
                "example": {
                    "request": {
                        "username": "user@example.com",
                        "password": "MyPassword123!"
                    }
                }
            },
            "send_verification_code": {
                "method": "POST",
                "path": "/api/auth/send-verification-code",
                "description": "发送验证码",
                "auth_required": False,
                "example": {
                    "request": {
                        "username": "user@example.com",
                        "code_type": "register"
                    }
                }
            },
            "forgot_password": {
                "method": "POST",
                "path": "/api/auth/forgot-password",
                "description": "忘记密码",
                "auth_required": False,
                "example": {
                    "request": {
                        "username": "user@example.com"
                    }
                }
            },
            "reset_password": {
                "method": "POST",
                "path": "/api/auth/reset-password",
                "description": "重置密码",
                "auth_required": False,
                "example": {
                    "request": {
                        "username": "user@example.com",
                        "verification_code": "123456",
                        "new_password": "NewPassword123!"
                    }
                }
            },
            "profile": {
                "method": "GET",
                "path": "/api/auth/profile",
                "description": "获取用户资料",
                "auth_required": True,
                "headers": {
                    "Authorization": "Bearer <access_token>"
                }
            },
            "update_profile": {
                "method": "PUT",
                "path": "/api/auth/profile",
                "description": "更新用户资料",
                "auth_required": True,
                "example": {
                    "request": {
                        "nickname": "新昵称",
                        "bio": "个人简介"
                    }
                }
            },
            "change_password": {
                "method": "POST",
                "path": "/api/auth/change-password",
                "description": "修改密码",
                "auth_required": True,
                "example": {
                    "request": {
                        "old_password": "OldPassword123!",
                        "new_password": "NewPassword123!"
                    }
                }
            },
            "logout": {
                "method": "POST",
                "path": "/api/auth/logout",
                "description": "用户登出",
                "auth_required": True
            }
        },
        "schemas": {
            "jwt_token_format": "Bearer <access_token>",
            "error_response": {
                "success": False,
                "message": "错误描述",
                "data": None,
                "code": 400
            }
        },
        "documentation_links": {
            "full_swagger": "http://localhost:6060/api/docs",
            "openapi_json": "http://localhost:6060/api/openapi.json",
            "auth_reference": "AUTH_API_REFERENCE.md"
        }
    }

@api.get("/auth/openapi.json", auth=None)
def auth_openapi(request):
    """认证模块专用的OpenAPI文档，只包含认证相关接口"""
    return {
        "openapi": "3.1.0",
        "info": {
            "title": "Tabtin 认证API",
            "version": "1.0.0",
            "description": "Tabtin用户认证模块API文档，包含注册、登录、密码管理等功能"
        },
        "servers": [
            {"url": "http://localhost:6060", "description": "开发环境"},
            {"url": "https://api.example.com", "description": "生产环境"}
        ],
        "paths": {
            "/api/auth/register": {
                "post": {
                    "tags": ["认证"],
                    "summary": "用户注册",
                    "description": "用户注册需要先获取验证码，然后提交注册信息完成注册",
                    "requestBody": {
                        "required": True,
                        "content": {
                            "application/json": {
                                "schema": {"$ref": "#/components/schemas/UserRegisterRequest"},
                                "example": {
                                    "email": "user@example.com",
                                    "password": "MyPassword123!",
                                    "verification_code": "123456",
                                    "nickname": "小明",
                                    "username": "xiaoming123"
                                }
                            }
                        }
                    },
                    "responses": {
                        "200": {
                            "description": "注册成功",
                            "content": {
                                "application/json": {
                                    "schema": {"$ref": "#/components/schemas/ApiResponse"},
                                    "example": {
                                        "success": True,
                                        "message": "注册成功",
                                        "data": {"user_id": "550e8400-e29b-41d4-a716-446655440000"},
                                        "code": 200
                                    }
                                }
                            }
                        }
                    }
                }
            },
            "/api/auth/login": {
                "post": {
                    "tags": ["认证"],
                    "summary": "用户登录",
                    "description": "支持邮箱、手机号、用户名登录",
                    "requestBody": {
                        "required": True,
                        "content": {
                            "application/json": {
                                "schema": {"$ref": "#/components/schemas/UserLoginRequest"},
                                "example": {
                                    "username": "user@example.com",
                                    "password": "MyPassword123!",
                                    "remember_me": False
                                }
                            }
                        }
                    },
                    "responses": {
                        "200": {
                            "description": "登录成功",
                            "content": {
                                "application/json": {
                                    "schema": {"$ref": "#/components/schemas/LoginResponse"},
                                    "example": {
                                        "access_token": "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9...",
                                        "refresh_token": "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9...",
                                        "token_type": "Bearer",
                                        "expires_in": 86400,
                                        "user": {
                                            "id": "550e8400-e29b-41d4-a716-446655440000",
                                            "username": "xiaoming123",
                                            "email": "u***@example.com",
                                            "nickname": "小明"
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            },
            "/api/auth/send-verification-code": {
                "post": {
                    "tags": ["认证"],
                    "summary": "发送验证码",
                    "description": "发送不同类型的验证码到用户邮箱或手机",
                    "requestBody": {
                        "required": True,
                        "content": {
                            "application/json": {
                                "schema": {"$ref": "#/components/schemas/SendVerificationCodeRequest"},
                                "example": {
                                    "username": "user@example.com",
                                    "code_type": "register"
                                }
                            }
                        }
                    },
                    "responses": {
                        "200": {
                            "description": "验证码发送成功",
                            "content": {
                                "application/json": {
                                    "schema": {"$ref": "#/components/schemas/ApiResponse"}
                                }
                            }
                        }
                    }
                }
            },
            "/api/auth/forgot-password": {
                "post": {
                    "tags": ["密码管理"],
                    "summary": "忘记密码",
                    "description": "发送密码重置验证码",
                    "requestBody": {
                        "required": True,
                        "content": {
                            "application/json": {
                                "schema": {"$ref": "#/components/schemas/ForgotPasswordRequest"},
                                "example": {
                                    "username": "user@example.com"
                                }
                            }
                        }
                    },
                    "responses": {
                        "200": {
                            "description": "重置验证码发送成功",
                            "content": {
                                "application/json": {
                                    "schema": {"$ref": "#/components/schemas/ApiResponse"}
                                }
                            }
                        }
                    }
                }
            },
            "/api/auth/reset-password": {
                "post": {
                    "tags": ["密码管理"],
                    "summary": "重置密码",
                    "description": "使用验证码重置密码",
                    "requestBody": {
                        "required": True,
                        "content": {
                            "application/json": {
                                "schema": {"$ref": "#/components/schemas/ResetPasswordRequest"},
                                "example": {
                                    "username": "user@example.com",
                                    "verification_code": "123456",
                                    "new_password": "NewPassword123!"
                                }
                            }
                        }
                    },
                    "responses": {
                        "200": {
                            "description": "密码重置成功",
                            "content": {
                                "application/json": {
                                    "schema": {"$ref": "#/components/schemas/ApiResponse"}
                                }
                            }
                        }
                    }
                }
            },
            "/api/auth/profile": {
                "get": {
                    "tags": ["用户管理"],
                    "summary": "获取用户资料",
                    "description": "获取当前登录用户的详细资料",
                    "security": [{"BearerAuth": []}],
                    "responses": {
                        "200": {
                            "description": "获取成功",
                            "content": {
                                "application/json": {
                                    "schema": {"$ref": "#/components/schemas/UserProfile"}
                                }
                            }
                        }
                    }
                },
                "put": {
                    "tags": ["用户管理"],
                    "summary": "更新用户资料",
                    "description": "更新当前登录用户的资料信息",
                    "security": [{"BearerAuth": []}],
                    "requestBody": {
                        "required": True,
                        "content": {
                            "application/json": {
                                "schema": {"$ref": "#/components/schemas/UpdateProfileRequest"},
                                "example": {
                                    "nickname": "新昵称",
                                    "bio": "个人简介"
                                }
                            }
                        }
                    },
                    "responses": {
                        "200": {
                            "description": "更新成功",
                            "content": {
                                "application/json": {
                                    "schema": {"$ref": "#/components/schemas/ApiResponse"}
                                }
                            }
                        }
                    }
                }
            },
            "/api/auth/logout": {
                "post": {
                    "tags": ["认证"],
                    "summary": "用户登出",
                    "description": "登出当前用户，使Token失效",
                    "security": [{"BearerAuth": []}],
                    "responses": {
                        "200": {
                            "description": "登出成功",
                            "content": {
                                "application/json": {
                                    "schema": {"$ref": "#/components/schemas/ApiResponse"}
                                }
                            }
                        }
                    }
                }
            }
        },
        "components": {
            "securitySchemes": {
                "BearerAuth": {
                    "type": "http",
                    "scheme": "bearer",
                    "bearerFormat": "JWT",
                    "description": "JWT Token认证，格式：Bearer <token>"
                }
            },
            "schemas": {
                "UserRegisterRequest": {
                    "type": "object",
                    "required": ["password", "verification_code"],
                    "properties": {
                        "email": {"type": "string", "format": "email", "description": "邮箱地址"},
                        "phone": {"type": "string", "description": "手机号", "pattern": "^\\+?[1-9]\\d{6,14}$"},
                        "password": {"type": "string", "minLength": 8, "description": "密码"},
                        "verification_code": {"type": "string", "minLength": 6, "maxLength": 6, "description": "6位验证码"},
                        "nickname": {"type": "string", "description": "昵称"},
                        "username": {"type": "string", "description": "用户名"}
                    }
                },
                "UserLoginRequest": {
                    "type": "object",
                    "required": ["username", "password"],
                    "properties": {
                        "username": {"type": "string", "description": "用户名/邮箱/手机号"},
                        "password": {"type": "string", "description": "密码"},
                        "remember_me": {"type": "boolean", "description": "记住我", "default": False}
                    }
                },
                "SendVerificationCodeRequest": {
                    "type": "object",
                    "required": ["username"],
                    "properties": {
                        "username": {"type": "string", "description": "邮箱或手机号"},
                        "code_type": {"type": "string", "enum": ["register", "login", "reset_password"], "description": "验证码类型"}
                    }
                },
                "ForgotPasswordRequest": {
                    "type": "object",
                    "required": ["username"],
                    "properties": {
                        "username": {"type": "string", "description": "邮箱或手机号"}
                    }
                },
                "ResetPasswordRequest": {
                    "type": "object",
                    "required": ["username", "verification_code", "new_password"],
                    "properties": {
                        "username": {"type": "string", "description": "邮箱或手机号"},
                        "verification_code": {"type": "string", "minLength": 6, "maxLength": 6, "description": "验证码"},
                        "new_password": {"type": "string", "minLength": 8, "description": "新密码"}
                    }
                },
                "UpdateProfileRequest": {
                    "type": "object",
                    "properties": {
                        "nickname": {"type": "string", "description": "昵称"},
                        "bio": {"type": "string", "description": "个人简介"},
                        "avatar": {"type": "string", "description": "头像URL"}
                    }
                },
                "ApiResponse": {
                    "type": "object",
                    "properties": {
                        "success": {"type": "boolean", "description": "是否成功"},
                        "message": {"type": "string", "description": "响应消息"},
                        "data": {"type": "object", "description": "响应数据"},
                        "code": {"type": "integer", "description": "状态码"}
                    }
                },
                "LoginResponse": {
                    "type": "object",
                    "properties": {
                        "access_token": {"type": "string", "description": "访问令牌"},
                        "refresh_token": {"type": "string", "description": "刷新令牌"},
                        "token_type": {"type": "string", "description": "令牌类型"},
                        "expires_in": {"type": "integer", "description": "过期时间(秒)"},
                        "user": {"$ref": "#/components/schemas/UserProfile"}
                    }
                },
                "UserProfile": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "string", "description": "用户ID"},
                        "username": {"type": "string", "description": "用户名"},
                        "email": {"type": "string", "description": "邮箱"},
                        "phone": {"type": "string", "description": "手机号"},
                        "nickname": {"type": "string", "description": "昵称"},
                        "avatar": {"type": "string", "description": "头像URL"},
                        "bio": {"type": "string", "description": "个人简介"},
                        "is_verified_email": {"type": "boolean", "description": "邮箱是否已验证"},
                        "is_verified_phone": {"type": "boolean", "description": "手机号是否已验证"},
                        "date_joined": {"type": "string", "format": "date-time", "description": "注册时间"},
                        "last_login": {"type": "string", "format": "date-time", "description": "最后登录时间"}
                    }
                }
            }
        },
        "tags": [
            {"name": "认证", "description": "用户注册、登录、登出相关接口"},
            {"name": "密码管理", "description": "密码重置、修改相关接口"},
            {"name": "用户管理", "description": "用户资料管理相关接口"}
        ]
    }


# ── 核心路由注册 ───────────────────────────────────────────

_safe_add_router("/auth", auth_router)
_safe_add_router("/chat", chat_router)
_safe_add_router("/context", tabtinspace_router, tags=["Tabtin Space"])
try:
    from apps.agent.api import router as agent_identity_router
    _safe_add_router("/agents", agent_identity_router, tags=["Agent"])
except Exception as _e:
    import logging as _log
    _log.getLogger(__name__).warning("[urls] Agent identity router registration failed: %s", _e)
_safe_add_router("/i18n", i18n_router, tags=["I18n"])
_safe_add_router("/membership", membership_router)
_safe_add_router("/wallet", wallet_router)
_safe_add_router("/health", health_router)

# Marketplace 公共配置（PRD §5.4 B3 / N5）：
# AppDiscovery URL patterns 聚合（manifest 驱动的动态发现）。
# auth=None on endpoint 级，让 Electron renderer 启动期可在登录前推送 patterns。
try:
    from apps.tabtinspace.marketplace_api import router as marketplace_router
    _safe_add_router("/marketplace", marketplace_router, tags=["Marketplace"])
except Exception as _e:
    import logging as _log
    _log.getLogger(__name__).warning("[urls] Marketplace router registration failed: %s", _e)

# FTS 统一搜索（Wave 2）
try:
    from apps.fts.api import router as fts_router
    _safe_add_router("/search", fts_router, tags=["Unified Search"])
except Exception as _e:
    import logging as _log
    _log.getLogger(__name__).warning("[urls] FTS search router registration failed: %s", _e)

# Skills & Capabilities（从 deferred 提升为 eager，因为 Daemon CLI 需要它们）
try:
    from apps.skills.api import router as skills_router
    _safe_add_router("/skills", skills_router, tags=["Skills"])
    import logging as _log
    _log.getLogger(__name__).info("[urls] Skills router registered eagerly (%d ops)", len(skills_router.path_operations))
except ImportError as _e:
    import logging as _log
    _log.getLogger(__name__).warning("[urls] Skills import failed: %s", _e)
except Exception as _e:
    import logging as _log
    _log.getLogger(__name__).warning("[urls] Skills registration failed: %s", _e)

# 注册全局异常处理器
from apps.users.auth.exceptions import register_exception_handlers  # noqa: E402
register_exception_handlers(api)


# ── URL patterns ───────────────────────────────────────────

# 在 urlpatterns 定义之前注册延迟路由，确保 api.urls 求值时包含全部路由。
# Celery worker / manage.py 不加载 urls.py，不受影响。
from tabtin.urls_deferred import register_deferred_routers  # noqa: E402
register_deferred_routers()


def _lazy_metrics_view(request):
    from apps.services.common.ws.metrics import metrics_view
    return metrics_view(request)


_ADMIN_PATH = 'admin/' if django_settings.DEBUG else os.getenv('DJANGO_ADMIN_PATH', 'tabtin-mgmt/')
urlpatterns = [
    path(_ADMIN_PATH, admin.site.urls),
    path(
        'internal/daemon-control/v1/device-presence/query',
        query_device_presence,
    ),
    path('api/', api.urls),
    path('api/channel-gateway/', include('apps.channel_gateway.urls')),
    path('api/extensions/', include('apps.extensions.urls')),
    # LLM Admin API (migrated to Ninja Router, see llm_admin_router above)
    # Prometheus metrics (access restricted by IP/token, see metrics.py)
    path('metrics/', _lazy_metrics_view),
]

from apps.tabsite.views import site_access  # noqa: E402
from apps.analytics.views import download_redirect  # noqa: E402

urlpatterns += [
    path('s/<slug:slug>/', site_access, name='site_access'),
    path('dl/<slug:slug>', download_redirect, name='analytics_download_redirect'),
]
