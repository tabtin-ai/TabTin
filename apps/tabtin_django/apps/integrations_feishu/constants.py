"""飞书多维表集成常量。"""

from django.conf import settings

# OAuth state 缓存 TTL（秒）
OAUTH_STATE_TTL_SECONDS = 600

# OAuth scope：只读多维表 + 云文档只读（搜索/枚举）+ 文档正文 Markdown + 知识库/画板浏览 + 离线刷新
# drive:drive:readonly 是 drive 列目录与读取资源所需，缺了会 99991679
# drive:drive.metadata:readonly 是 root_folder/meta（我的空间根 token）所需；仅有 drive:drive:readonly 不够
# search:docs:read 用于 Search v2，并以 is_cross_tenant 限定授权应用所在企业
# docs:document.content:read 用于 GET /docs/v1/content 导出 Docx Markdown
# docx:document:readonly 用于列 Docx blocks（Markdown 导出会丢图片，须从 Image Block 取 token）
# 知识库：get_node / list nodes 官方要求 wiki:node:read 或 wiki:wiki:readonly（缺了 99991679）
# wiki:space:retrieve / wiki:node:retrieve 为空间列表等新命名 scope
# board:whiteboard:node:read 用于读取 Docx 内嵌画板的节点与连线
# 改 scope 后已授权用户须断开并重新授权才会带上新权限
OAUTH_SCOPES = (
    "bitable:app:readonly drive:drive:readonly "
    "drive:drive.metadata:readonly "
    "search:docs:read "
    "docs:document.content:read "
    "docx:document:readonly "
    "wiki:wiki:readonly wiki:node:read "
    "wiki:space:retrieve wiki:node:retrieve "
    "board:whiteboard:node:read "
    "offline_access"
)

# Wiki 个人文档库（spaces.list 不返回，须用字面 space_id）
WIKI_SPACE_MY_LIBRARY = "my_library"

# 单张表仍限制导入行数；资源数量不设业务上限，由异步任务逐项处理。
MAX_ROWS_PER_TABLE = 2000

# 资源类型（同通道列表）
RESOURCE_KIND_BITABLE = "bitable"
RESOURCE_KIND_DOCX = "docx"

# 附件导入上限（单文件 / 单格件数）；超出记 issues，不整单失败
MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024  # 20 MiB
MAX_ATTACHMENTS_PER_CELL = 20

# 文档图片转存上限（单篇）；超出记 issues，已转存的仍写入正文
MAX_DOC_IMAGES_PER_DOCUMENT = 50
# 飞书 Image Block
DOCX_BLOCK_TYPE_IMAGE = 27
# 飞书 File Block（TabDoc 当前无一等文件附件节点）
DOCX_BLOCK_TYPE_FILE = 23

# 飞书 records/search 单页上限
FEISHU_RECORD_PAGE_SIZE = 500

# Token 提前刷新窗口
TOKEN_REFRESH_SKEW_SECONDS = 120

# Cache key 前缀
OAUTH_STATE_CACHE_PREFIX = "feishu_oauth_state:"

STATUS_CONNECTED = "connected"
STATUS_REVOKED = "revoked"
STATUS_REAUTHORIZATION_REQUIRED = "reauthorization_required"

IMPORT_STATUS_PENDING = "pending"
IMPORT_STATUS_RUNNING = "running"
IMPORT_STATUS_SUCCESS = "success"
IMPORT_STATUS_FAILED = "failed"

IMPORT_INTERRUPTED_REASON_PROVIDER_REAUTHENTICATED = "provider_reauthenticated"
IMPORT_INTERRUPTED_BY_PROVIDER_REAUTHENTICATION = (
    "组织飞书企业应用已重新认证，导入任务已终止"
)


def get_feishu_oauth_app_id() -> str:
    """返回过渡期实例级 App ID，仅用于兼容未迁移的旧连接。"""
    return getattr(settings, "FEISHU_OAUTH_APP_ID", "") or ""


def get_feishu_oauth_app_secret() -> str:
    """返回过渡期实例级 Secret，禁止输出到 API 或日志。"""
    return getattr(settings, "FEISHU_OAUTH_APP_SECRET", "") or ""


def get_feishu_oauth_redirect_uri() -> str:
    return getattr(
        settings,
        "FEISHU_OAUTH_REDIRECT_URI",
        # 本机开发默认 localhost（飞书后台对 127.0.0.1 常判不合法）
        "http://localhost:6060/api/integrations/feishu/oauth/callback",
    )


def get_feishu_oauth_success_redirect() -> str:
    return getattr(
        settings,
        "FEISHU_OAUTH_SUCCESS_REDIRECT",
        # 默认走 Django 落地页（唤起桌面端），不依赖本机 tabtin-web :5176
        "http://localhost:6060/api/integrations/feishu/oauth/done",
    )


def get_feishu_api_base() -> str:
    return getattr(settings, "FEISHU_API_BASE", "https://open.feishu.cn").rstrip("/")


def get_feishu_accounts_base() -> str:
    return getattr(settings, "FEISHU_ACCOUNTS_BASE", "https://accounts.feishu.cn").rstrip("/")
