"""NinjaAPI 单例 — 独立模块，供 urls.py 和 urls_deferred.py 共享。

将 api 对象提取到独立模块的目的：
- urls_deferred.py 可以在 urls.py 加载之前导入 api 对象并注册延迟路由
- 避免 urls.py ↔ urls_deferred.py 循环导入
"""

from django.conf import settings as django_settings
from ninja import NinjaAPI
from ninja.errors import ConfigError
from apps.users.auth.permissions import JWTAuth

api = NinjaAPI(
    title="Tabtin API",
    description="""
    ## TabTin 核心 API 服务

    TabTin 是人与 AI Agent 团队协作的统一工作平台，提供 Table、Docs、Design、Browser 等多种 App 的后端支撑。

    ### 🔐 用户认证服务
    - 用户注册/登录（支持邮箱、手机号、验证码登录）
    - 密码重置（邮件/短信验证码）
    - 用户资料管理
    - JWT Token 认证

    ### 📊 Table & 数据处理服务
    - 多维表格 CRUD（行、列、视图、字段）
    - Skill 字段能力执行
    - AI 驱动的 HTML 结构分析与 Schema 生成
    - 异步任务处理

    ### 🎨 Design 服务
    - 设计项目管理（PPT、海报、小红书笔记）
    - Agent 创建与编辑

    ### 📝 Docs 服务
    - 文档创建、编辑、搜索
    - Agent 文档读写

    ### 🤖 Agent & 多智能体服务
    - 跨 App 工具注册与调用
    - Skills 管理
    - 会话与执行编排

    ### 📧 通信服务
    - 邮件发送（支持腾讯企业邮箱）
    - 短信发送（支持阿里云短信）
    - 验证码发送

    ### 📁 文件存储服务
    - 阿里云 OSS 文件上传
    - 文件管理和访问

    ### 🔌 Open API（外部集成）
    - 路径前缀: `/api/open/v1`
    - 认证: Bearer Token（JWT 或 API Token `ttn_xxx`）
    - Space 级入口：`/api/open/v1/spaces/{space_id}/data/...`
    - 结构化查询（filter / sort / 分页 / 增量同步）
    - 批量读写、Upsert（去重写入）
    - Webhook 事件订阅（数据变更自动通知）
    - 只读 PostgreSQL 数据库连接管理
    - 支持 `Idempotency-Key` 幂等写入
    - 支持 `ETag` / `If-None-Match` 增量缓存

    ### 🛡️ 安全特性
    - JWT 认证保护
    - 频率限制（API Token 独立限速）
    - 数据验证
    - 错误处理
    """,
    version="1.0.0",
    docs_url="/docs" if django_settings.DEBUG else None,
    openapi_url="/openapi.json" if django_settings.DEBUG else None,
    servers=[
        {"url": "http://localhost:6060", "description": "开发环境"},
        {"url": "https://api.example.com", "description": "生产环境"},
    ],
    auth=JWTAuth(),
)


def _safe_add_router(prefix, router, **kwargs):
    """防止热重载时重复注册路由导致 ConfigError。"""
    try:
        api.add_router(prefix, router, **kwargs)
    except ConfigError as exc:
        if 'already been attached' in str(exc):
            return
        raise
