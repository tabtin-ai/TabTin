"""
Django settings for tabtin project.
"""

import os
import re
import sys
from pathlib import Path
from dotenv import load_dotenv
from django.core.exceptions import ImproperlyConfigured

from tabtin.edition import TabTinEdition, resolve_edition_configuration
from tabtin.startup_policy import resolve_endpoint_setting, resolve_startup_policy
from tabtin.community_secrets import resolve_secret_setting

# Build paths inside the project like this: BASE_DIR / 'subdir'.
BASE_DIR = Path(__file__).resolve().parent.parent
PROJECT_ROOT = BASE_DIR.parent.parent

# 开发环境变量：仓库根 .env 为单文件 SSoT（Electron / AdminDash / Django 共用）。
# 个人本地覆盖用根 .env.local（gitignore，不进 git）；不再使用 apps/tabtin_django/.env。
_PROCESS_COMMUNITY_EDITION = (
    os.environ.get('TABTIN_EDITION', '').strip().lower() == 'community'
)
if not _PROCESS_COMMUNITY_EDITION:
    load_dotenv(PROJECT_ROOT / '.env')
    _root_env_local = PROJECT_ROOT / '.env.local'
    if _root_env_local.is_file():
        load_dotenv(_root_env_local, override=True)

# 命名 env 叠加（opt-in）：``TABTIN_ENV=<name>`` 时再叠加 ``.env.<name>``（最高优先级）。
# 优先根目录，遗留文件可在 apps/tabtin_django/ 下（如 .env.dual）。
_env_name = os.environ.get('TABTIN_ENV', '').strip()
if _env_name and not _PROCESS_COMMUNITY_EDITION:
    for _named_env in (PROJECT_ROOT / f'.env.{_env_name}', BASE_DIR / f'.env.{_env_name}'):
        if _named_env.is_file():
            load_dotenv(_named_env, override=True)
            break

try:
    TABTIN_EDITION_CONFIGURATION = resolve_edition_configuration(os.environ)
except ValueError as exc:
    raise ImproperlyConfigured(str(exc)) from exc
TABTIN_EDITION = TABTIN_EDITION_CONFIGURATION.edition.value
TABTIN_STARTUP_POLICY = resolve_startup_policy(os.environ)
IS_COMMUNITY_EDITION = TABTIN_EDITION_CONFIGURATION.edition is TabTinEdition.COMMUNITY


def _edition_endpoint(
    key: str,
    *,
    saas_default: str,
    community_default: str = '',
) -> str:
    try:
        return resolve_endpoint_setting(
            os.environ,
            key,
            saas_default=saas_default,
            community_default=community_default,
        )
    except ValueError as exc:
        raise ImproperlyConfigured(str(exc)) from exc


# ── R5-21 修复：Prometheus multi-process 准备 ──────────────────
# 生产 gunicorn 是 multi-worker（典型 16-32 个），prometheus-client 默认
# 拿当前进程的全局 REGISTRY → /metrics 端点每次只返回 1/N 真实数据 → SLO 失真。
#
# 启用条件：env 注入 `PROMETHEUS_MULTIPROC_DIR=/tmp/prometheus_multiproc`
#   - 生产 K8s manifest / systemd EnvironmentFile 注入
#   - gunicorn `when_ready` 钩子负责清理 + mkdir
#   - apps/services/common/ws/metrics.py 的 metrics_view 检测此变量自动用
#     MultiProcessCollector 聚合
#
# 开发 / 测试默认不设此变量 → 走单进程 REGISTRY（不受影响）
#
# 注意：所有 Gauge 必须显式声明 `multiprocess_mode`（livesum/max/min/sum），
# 否则 multi-process 模式下 `Gauge(...)` 实例化时直接 raise ValueError。
# fts/metrics.py 已合规；ws/metrics.py 历史代码已补齐（同 commit）。
_PROM_MULTIPROC_DIR = os.environ.get('PROMETHEUS_MULTIPROC_DIR', '').strip()
if _PROM_MULTIPROC_DIR:
    # 容错：目录不存在时尝试创建（gunicorn when_ready 钩子是主路径）
    try:
        os.makedirs(_PROM_MULTIPROC_DIR, exist_ok=True)
    except OSError:
        # 权限问题等 → 让 prometheus_client 启动时自己报错（更明确）
        pass


def _env_bool(key: str, default: bool = False) -> bool:
    raw = os.getenv(key)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


# SECURITY WARNING: don't run with debug turned on in production!
DEBUG = os.getenv('DEBUG', 'False').lower() == 'true'

# Registration invite gate. Default off for SaaS/Web/AdminDash self-service signup;
# private/internal deployments can opt in with TABTIN_REQUIRE_INVITE_CODE=1.
TABTIN_REQUIRE_INVITE_CODE = _env_bool('TABTIN_REQUIRE_INVITE_CODE', False)
REQUIRE_INVITE_CODE = TABTIN_REQUIRE_INVITE_CODE

# CLI OAuth Device Authorization Flow：用户确认授权的前端页面地址。
# 默认指向本地 Electron/Web dev 端口，生产环境按部署域名覆盖。
TABTIN_DEVICE_VERIFY_URL = os.getenv('TABTIN_DEVICE_VERIFY_URL', 'http://localhost:5175/device')
TABTIN_RELEASE_VERSION = os.getenv('TABTIN_RELEASE_VERSION', os.getenv('TABTIN_IMAGE_TAG', '')).strip()
TABTIN_SERVER_VERSION = os.getenv('TABTIN_SERVER_VERSION', '').strip()
TABTIN_GIT_SHA = os.getenv('TABTIN_SOURCE_SHA', os.getenv('TABTIN_GIT_SHA', '')).strip()


def _env_bool(key: str, default: bool = False) -> bool:
    raw = os.getenv(key)
    if raw is None:
        return default
    return raw.strip().lower() not in {'0', 'false', 'no', 'off'}


def _env_bool(key: str, default: bool = False) -> bool:
    raw = os.getenv(key)
    if raw is None:
        return default
    return raw.strip().lower() not in {'0', 'false', 'no', 'off'}


def _env_bool(key: str, default: bool = False) -> bool:
    raw = os.getenv(key)
    if raw is None:
        return default
    return raw.strip().lower() not in {'0', 'false', 'no', 'off'}


def _env_bool(key: str, default: bool = False) -> bool:
    raw = os.getenv(key)
    if raw is None:
        return default
    return raw.strip().lower() not in {'0', 'false', 'no', 'off'}


def _require_env(key: str, default_for_debug: str = '') -> str:
    """生产环境必须配置的环境变量；DEBUG 模式允许缺省。"""
    val = os.getenv(key)
    if val:
        return val
    if DEBUG:
        return default_for_debug
    raise ImproperlyConfigured(f"生产环境必须配置环境变量: {key}")


def _secret_env_or_file(
    key: str,
    default_for_debug: str = '',
    *,
    required: bool = True,
) -> str:
    """Resolve a secret from ``KEY`` or ``KEY_FILE`` without ambiguity."""
    environment = os.environ
    file_key = f'{key}_FILE'
    if os.environ.get(file_key):
        # File secrets are the stronger installation boundary and must not be
        # shadowed by the tracked development .env loaded above.
        environment = dict(os.environ)
        environment.pop(key, None)
    try:
        value = resolve_secret_setting(key, environment, required=False)
    except ValueError as exc:
        raise ImproperlyConfigured(str(exc)) from exc
    if value:
        return value
    if DEBUG or not required:
        return default_for_debug
    raise ImproperlyConfigured(f"生产环境必须配置 secret: {key} 或 {key}_FILE")


# SECURITY WARNING: keep the secret key used in production secret!
SECRET_KEY = _secret_env_or_file('SECRET_KEY', 'django-insecure-change-me-in-production')

def _split_csv_env(value: str) -> list[str]:
    return [item.strip() for item in value.split(',') if item.strip()]


ALLOWED_HOSTS = _split_csv_env(
    os.getenv(
        'ALLOWED_HOSTS',
        'localhost,127.0.0.1,dev.example.com,www.example.com,example.com',
    )
)

CSRF_TRUSTED_ORIGINS = _split_csv_env(
    os.getenv('CSRF_TRUSTED_ORIGINS', 'https://www.example.com,https://example.com')
)

# 本地调试时允许局域网设备访问（默认关闭，需显式设置 ALLOW_LAN_HOSTS_IN_DEBUG=True）。
# BI-11: 默认 False，防止 DEBUG=True 误推至测试/预发布环境时 ALLOWED_HOSTS 被放开为 ['*']。
ALLOW_LAN_HOSTS_IN_DEBUG = os.getenv('ALLOW_LAN_HOSTS_IN_DEBUG', 'False').lower() == 'true'
if DEBUG and ALLOW_LAN_HOSTS_IN_DEBUG and '*' not in ALLOWED_HOSTS:
    ALLOWED_HOSTS.append('*')

# Channel Gateway service token (server-to-server)
CHANNEL_GATEWAY_TOKEN = os.getenv('CHANNEL_GATEWAY_TOKEN', '')
CHANNEL_GATEWAY_DM_POLICY = os.getenv('CHANNEL_GATEWAY_DM_POLICY', 'pairing')
CHANNEL_GATEWAY_GROUP_POLICY = os.getenv('CHANNEL_GATEWAY_GROUP_POLICY', 'allowlist')
CHANNEL_GATEWAY_PAIRING_TTL_SECONDS = int(os.getenv('CHANNEL_GATEWAY_PAIRING_TTL_SECONDS', '3600'))
CHANNEL_GATEWAY_PAIRING_MAX_PENDING = int(os.getenv('CHANNEL_GATEWAY_PAIRING_MAX_PENDING', '3'))
CHANNEL_GATEWAY_OUTBOUND_MAX_ATTEMPTS = int(os.getenv('CHANNEL_GATEWAY_OUTBOUND_MAX_ATTEMPTS', '5'))
CHANNEL_GATEWAY_OUTBOUND_RETRY_BASE_SECONDS = int(os.getenv('CHANNEL_GATEWAY_OUTBOUND_RETRY_BASE_SECONDS', '30'))

# ── 飞书多维表 OAuth（integrations_feishu；与 Channel Gateway Bot 凭证分离）──
# 过渡期保留实例级凭证：旧客户端和升级前已有连接在组织 Provider
# 尚未配置时仍可继续使用。新授权在 Provider 配置后自动切换到组织凭证。
FEISHU_OAUTH_APP_ID = os.getenv('FEISHU_OAUTH_APP_ID', '')
FEISHU_OAUTH_APP_SECRET = os.getenv('FEISHU_OAUTH_APP_SECRET', '')
FEISHU_OAUTH_REDIRECT_URI = os.getenv(
    'FEISHU_OAUTH_REDIRECT_URI',
    'http://localhost:6060/api/integrations/feishu/oauth/callback',
)
FEISHU_OAUTH_SUCCESS_REDIRECT = os.getenv(
    'FEISHU_OAUTH_SUCCESS_REDIRECT',
    'http://localhost:6060/api/integrations/feishu/oauth/done',
)
FEISHU_API_BASE = os.getenv('FEISHU_API_BASE', 'https://open.feishu.cn')
FEISHU_ACCOUNTS_BASE = os.getenv('FEISHU_ACCOUNTS_BASE', 'https://accounts.feishu.cn')
# 单表行数上限见 apps.integrations_feishu.constants（MAX_ROWS_PER_TABLE）

# ── iOS 原生远程推送：Apple Push Notification service ──
# `.p8` 私钥只放部署环境变量或外部密钥文件，禁止提交。
# 任一凭据缺省时推送整体关闭（静默降级为 WS-only）。
APNS_TEAM_ID = os.getenv('APNS_TEAM_ID', '')
APNS_KEY_ID = os.getenv('APNS_KEY_ID', '')
APNS_PRIVATE_KEY = os.getenv('APNS_PRIVATE_KEY', '')
APNS_PRIVATE_KEY_PATH = os.getenv('APNS_PRIVATE_KEY_PATH', '')
APNS_BUNDLE_ID = os.getenv('APNS_BUNDLE_ID', 'com.example.tabtin')

# ── GitHub OAuth（integrations_github；MCP 连接器平台代理，保管 client_secret）──
GITHUB_OAUTH_CLIENT_ID = os.getenv('GITHUB_OAUTH_CLIENT_ID', '')
GITHUB_OAUTH_CLIENT_SECRET = os.getenv('GITHUB_OAUTH_CLIENT_SECRET', '')
GITHUB_OAUTH_REDIRECT_URI = os.getenv(
    'GITHUB_OAUTH_REDIRECT_URI',
    'http://localhost:6060/api/integrations/github/oauth/callback',
)
GITHUB_OAUTH_SUCCESS_REDIRECT = os.getenv(
    'GITHUB_OAUTH_SUCCESS_REDIRECT',
    'http://localhost:6060/api/integrations/github/oauth/done',
)

# Runtime Operations Console sampling flags. All default to off and must be
# explicitly enabled per environment to avoid unexpected Redis write volume.
WS_RUNTIME_SNAPSHOT_ENABLED = _env_bool('WS_RUNTIME_SNAPSHOT_ENABLED', False)
WS_EVENT_SAMPLE_ENABLED = _env_bool('WS_EVENT_SAMPLE_ENABLED', False)
CENTRIFUGO_PUBLISH_EVENT_SAMPLE_ENABLED = _env_bool('CENTRIFUGO_PUBLISH_EVENT_SAMPLE_ENABLED', False)
COLLAB_RUNTIME_SNAPSHOT_ENABLED = _env_bool('COLLAB_RUNTIME_SNAPSHOT_ENABLED', False)
COLLAB_EVENT_SAMPLE_ENABLED = _env_bool('COLLAB_EVENT_SAMPLE_ENABLED', False)
OPS_RUNTIME_ACTIONS_ENABLED = _env_bool('OPS_RUNTIME_ACTIONS_ENABLED', False)

# Application definition
DJANGO_APPS = [
    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',
]

THIRD_PARTY_APPS = [
    'ninja',
    'django_celery_beat',
    'django_celery_results',
    'channels',
]

# ── 核心 App ────────────────────────────────────────
_CREATION_APPS = [
    'apps.collab.apps.CollabConfig',                        # Collab 统一协作与版本管理基础设施
    'apps.tabdata',                                        # TabData 多维表格
    'apps.tabdoc.apps.TabdocConfig',                     # TabDoc 文档
    'apps.tabslide.apps.TabslideConfig',                    # TabSlide 演示文稿
    'apps.tabcode.apps.TabcodeConfig',                      # TabCode 代码项目
    'apps.tabmemo.apps.TabmemoConfig',                     # TabMemo 碎片笔记
    'apps.agent_memory.apps.AgentMemoryConfig',            # Agent 记忆独立领域（agent_memory_entry）
    'apps.user_portrait.apps.UserPortraitConfig',          # User 用户画像（USER 层）
    'apps.tabsite.apps.TabsiteConfig',
    'apps.tabchat.apps.TabchatConfig',                          # TabChat 即时通讯
]

# ── AI / Agent ────────────────────────────────────────
# Wave 11（2026-04-17）彻底删除 orchestration app 后，所有 Agent 运行时职责
# 统一归属 AgentEngineConfig：运行时回调注入、TinAgent 注册、Beat Schedule 自动发现、
# 7 个 Agent 运行期 model 的 migrations 宿主（app_label='agent_engine'）。
_AI_APPS = [
    'apps.agent.apps.AgentConfig',                              # Agent 领域模型（身份 / 规则 / 配置；表 agent_agent）
    'apps.services.agent_engine.apps.AgentEngineConfig',        # Agent 执行引擎（运行时回调注入 / TinAgent 注册 / Beat Schedule 发现入口 / Models 宿主）
    'apps.chat.conversation',                               # Chat 对话管理
    'apps.rag',                                             # RAG 向量检索
    'apps.skills.apps.SkillsConfig',                        # Skills 模块
]

# ── 用户 & 商业化 ────────────────────────────────────
_USER_APPS = [
    'apps.users.auth',                                      # 用户认证
    'apps.users.membership',                                # 会员体系
    'apps.users.wallet',                                    # 钱包系统
    'apps.services.payment',                                # 支付服务
    'apps.services.billing',                                # 计费服务
]

# ── 平台基础服务 ──────────────────────────────────────
_INFRA_APPS = [
    'apps.tabtinspace.apps.TabtinspaceConfig',              # Tabtin Space 核心
    'apps.channel_gateway.apps.ChannelGatewayConfig',       # Channel Gateway
    'apps.tracker.apps.TrackerConfig',                      # Tracker 派活引擎（含 table_event 表事件触发）
    'apps.services.llm',                                    # LLM 服务
    'apps.services.search.apps.SearchConfig',               # Search 服务（Web 搜索代理：Bocha 等）
    'apps.fts.apps.FtsConfig',                              # Full-Text Search（阿里云 ES 统一搜索，PRD 2026-04-16）
    'apps.services.sms',                                    # 短信服务
    'apps.services.email',                                  # 邮件服务
    'apps.services.oss',                                    # 对象存储
    'apps.services.docparse',                               # DocParse 文档解析
    'apps.services.speech.apps.SpeechConfig',               # Speech (ASR/TTS)
    'apps.services.music.apps.MusicConfig',                 # Music (BGM 生成)
    'apps.services.sound_effects.apps.SoundEffectsConfig',  # Sound Effects (Freesound)
    'apps.services.media_generation.apps.MediaGenerationConfig',  # 媒体生成（图片/视频）
    'apps.services.notification',                           # 团队通知
    'apps.extensions.apps.ExtensionsConfig',                # Extension 框架（通用扩展协议）
    'apps.capabilities.apps.CapabilitiesConfig',            # Capabilities 工具中心 + 能力管理
    'apps.tins.apps.TinsConfig',                            # Tins 智能微应用
    'apps.credential_vault.apps.CredentialVaultConfig',       # Credential Vault 凭据管理
    'apps.login_relay.apps.LoginRelayConfig',               # 短期登录态接力包
    'apps.integrations_feishu.apps.IntegrationsFeishuConfig',  # 飞书多维表 OAuth / 一次性导入
    'apps.integrations_github.apps.IntegrationsGithubConfig',  # GitHub OAuth（MCP 连接器平台代理）
    # v3.1（2026-04-19）：app_connect 已删除（Connect 模型作废，见 PRD-v3.1-方向锚）
    'apps.i18n',                                            # 国际化
    'apps.maintenance',                                     # 系统维护
    'apps.platform_config.apps.PlatformConfigConfig',        # 平台公共配置 / 产品限制
    'apps.updater',                                         # 应用更新
    'apps.client_errors.apps.ClientErrorsConfig',            # 客户端错误监控
    'apps.diagnostics.apps.DiagnosticsConfig',                # 客户端诊断包
    'apps.analytics.apps.AnalyticsConfig',                   # 通用埋点与获客分析
    'apps.services.package_registry.apps.PackageRegistryConfig',  # Package Registry 包管理
    'apps.services.migration_guard.apps.MigrationGuardConfig',  # Migration Guard 跨库迁移守卫
    # dev_only：进宝 Echo Bot。`apps.py.ready()` 内根据 ENABLE_JINBAO_BOT 决定
    # 是否注册 signals；关闭时 zero overhead（不需要从 INSTALLED_APPS 摘除）。
    'apps.services.jinbao.apps.JinbaoConfig',
]

LOCAL_APPS = (
    _CREATION_APPS
    + _AI_APPS
    + _USER_APPS
    + _INFRA_APPS
)

INSTALLED_APPS = DJANGO_APPS + THIRD_PARTY_APPS + LOCAL_APPS

MIDDLEWARE = [
    'apps.services.common.middleware.HealthCheckMiddleware',  # 负载均衡探活 /health /ping
    'tabtin.middleware.DeferredRouterMiddleware',  # 非核心路由延迟注册（首次请求时触发）
    # Wave 1 D3 — X-Request-Id 跨进程透传：尽早注入 request.request_id，
    # 让后续 middleware（包括 RateLimit / Auth）即使提前 short-circuit
    # 返回 4xx/5xx，trace_id 也已写入响应头，main 端能反读对齐
    'apps.services.common.middleware.RequestIdMiddleware',
    'django.middleware.security.SecurityMiddleware',
    'apps.services.common.middleware.CORSMiddleware',  # CORS 预检与跨域头
    # 本地开发弱网模拟：仅 DEBUG 生效，非 DEBUG 时中间件自摘除（MiddlewareNotUsed）。
    # 放在 CORS 之后，避免延迟 OPTIONS 预检（预检由 CORS 提前短路）；
    # HealthCheck 已在最前短路探活，故此处只延迟真实业务请求。
    'apps.services.common.middleware.DevLatencyMiddleware',
    'apps.services.common.middleware.SensitivePathBlockMiddleware',  # 拦截对敏感隐藏文件/目录的探测
    'django.contrib.sessions.middleware.SessionMiddleware',
    'apps.services.common.middleware.APITrailingSlashMiddleware',
    'django.middleware.common.CommonMiddleware',
    'apps.services.common.middleware.UnicodeNormalizationMiddleware',  # Unicode NFC 规范化 + 不可见字符检测
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'apps.services.common.middleware.RateLimitMiddleware',  # 限流（需在认证之后，按 user_id/IP 分桶）
    'apps.users.auth.invite_gate_middleware.InviteGateMiddleware',  # 邀请码后置准入：未兑换用户禁止访问核心 API
    'apps.users.auth.api_key_middleware.ApiKeyContextMiddleware',  # P0-10: API Key organization 约束上下文生命周期
    'apps.services.common.middleware.AgentRunContextMiddleware',  # TD-1/H-2: 还原 Agent CLI 请求的 run/session 上下文
    'apps.tabdata.middleware.TabDataRequestContextMiddleware',  # TabData 请求上下文（X-Window-Id）
    'apps.tabdata.middleware.api_logging.OpenApiLoggingMiddleware',  # Open API 请求日志采集
    'django.contrib.messages.middleware.MessageMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
    'apps.services.common.middleware.SecurityHeadersMiddleware',  # 补充安全HTTP响应头
    # REMOVED: 'apps.crawl.middleware.APILoggingMiddleware' — crawl module deleted
    'apps.i18n.middleware.I18nMiddleware',  # 国际化语言解析
]

ROOT_URLCONF = 'tabtin.urls'

TEMPLATES = [
    {
        'BACKEND': 'django.template.backends.django.DjangoTemplates',
        'DIRS': [BASE_DIR / 'templates'],
        'APP_DIRS': True,
        'OPTIONS': {
            'context_processors': [
                'django.template.context_processors.debug',
                'django.template.context_processors.request',
                'django.contrib.auth.context_processors.auth',
                'django.contrib.messages.context_processors.messages',
            ],
        },
    },
]

WSGI_APPLICATION = 'tabtin.wsgi.application'
ASGI_APPLICATION = 'tabtin.asgi.application'

RUNNING_TESTS = 'test' in sys.argv or 'pytest' in sys.modules


def _postgres_database_config() -> dict:
    """Build the PostgreSQL config used by the single relational database."""
    # Web/API 默认硬超时，避免 idle-in-transaction / 无超时语句拖死连接与 ASGI worker。
    # Celery 长任务可按环境变量放宽；设为 0 表示不追加对应 GUC。
    statement_timeout_ms = os.getenv('PG_STATEMENT_TIMEOUT_MS', '60000')
    lock_timeout_ms = os.getenv('PG_LOCK_TIMEOUT_MS', '5000')
    idle_in_tx_ms = os.getenv('PG_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS', '60000')
    pg_options = ['-c search_path=public']
    if statement_timeout_ms and statement_timeout_ms != '0':
        pg_options.append(f'-c statement_timeout={int(statement_timeout_ms)}')
    if lock_timeout_ms and lock_timeout_ms != '0':
        pg_options.append(f'-c lock_timeout={int(lock_timeout_ms)}')
    if idle_in_tx_ms and idle_in_tx_ms != '0':
        pg_options.append(f'-c idle_in_transaction_session_timeout={int(idle_in_tx_ms)}')

    return {
        'ENGINE': 'django.db.backends.postgresql',
        'NAME': os.getenv(
            'PG_DB_NAME',
            'tabtin' if IS_COMMUNITY_EDITION else 'tabtin_single',
        ),
        'USER': os.getenv(
            'PG_DB_USER',
            'tabtin_runtime' if IS_COMMUNITY_EDITION else 'tabtin_single',
        ),
        'PASSWORD': _secret_env_or_file('PG_DB_PASSWORD'),
        'HOST': os.getenv('PG_DB_HOST', '127.0.0.1'),
        'PORT': os.getenv('PG_DB_PORT', '5432'),
        # ASGI (Daphne) 下建议设 0，避免异步协程囤积连接；
        # 生产环境通过 PgBouncer 连接池实现复用，无需持久连接。
        'CONN_MAX_AGE': int(os.getenv('PG_CONN_MAX_AGE', '0')),
        'CONN_HEALTH_CHECKS': os.getenv('PG_CONN_HEALTH_CHECKS', 'True').lower() == 'true',
        'OPTIONS': {
            'options': ' '.join(pg_options),
            'connect_timeout': 10,
            'gssencmode': 'disable',
        },
    }


def _legacy_mysql_database_config() -> dict:
    """Legacy MySQL config, used only for explicit import/backup flows."""
    return {
        'ENGINE': 'django.db.backends.mysql',
        'NAME': os.getenv('LEGACY_MYSQL_DB_NAME', os.getenv('DB_NAME', 'tabtinmysql')),
        'USER': os.getenv('LEGACY_MYSQL_DB_USER', os.getenv('DB_USER', 'tabtinmysql')),
        'PASSWORD': os.getenv('LEGACY_MYSQL_DB_PASSWORD', os.getenv('DB_PASSWORD', '')),
        'HOST': os.getenv('LEGACY_MYSQL_DB_HOST', os.getenv('DB_HOST', '127.0.0.1')),
        'PORT': os.getenv('LEGACY_MYSQL_DB_PORT', os.getenv('DB_PORT', '3306')),
        'CONN_MAX_AGE': int(os.getenv('LEGACY_MYSQL_CONN_MAX_AGE', '0')),
        'CONN_HEALTH_CHECKS': os.getenv('LEGACY_MYSQL_CONN_HEALTH_CHECKS', 'True').lower() == 'true',
        'OPTIONS': {
            'charset': 'utf8mb4',
            'collation': 'utf8mb4_unicode_ci',
            'init_command': "SET sql_mode='STRICT_TRANS_TABLES'",
            'connect_timeout': 10,
            'read_timeout': 30,
            'write_timeout': 30,
            **({
                'unix_socket': os.getenv('LEGACY_MYSQL_DB_SOCKET', os.getenv('DB_SOCKET'))
            } if os.getenv('LEGACY_MYSQL_DB_SOCKET', os.getenv('DB_SOCKET', '')) else {}),
        },
    }


# Database
# 单库目标态：`default` 是唯一业务关系库（PostgreSQL）。`postgresql` alias
# 镜像 `default` 仅用于过渡期兼容历史 `.using("postgresql")` 调用。
TABTIN_DATABASE_MODE = os.getenv('TABTIN_DATABASE_MODE', 'single_pg').lower()
_SINGLE_PG_DATABASE_MODES = {
    'single_pg', 'single-postgres', 'single_postgres', 'postgres', 'postgresql',
}
_DUAL_DATABASE_MODES = {'dual', 'dual_db', 'mysql_pg', 'mysql-postgres'}
if TABTIN_DATABASE_MODE not in _SINGLE_PG_DATABASE_MODES | _DUAL_DATABASE_MODES:
    raise ImproperlyConfigured(
        "TABTIN_DATABASE_MODE must be one of "
        f"{sorted(_SINGLE_PG_DATABASE_MODES | _DUAL_DATABASE_MODES)}, "
        f"got {TABTIN_DATABASE_MODE!r}"
    )
TABTIN_SINGLE_DATABASE_MODE = TABTIN_DATABASE_MODE in _SINGLE_PG_DATABASE_MODES

if TABTIN_SINGLE_DATABASE_MODE:
    _PG_DATABASE = _postgres_database_config()
    DATABASES = {
        'default': _PG_DATABASE,
        'postgresql': {
            **_PG_DATABASE,
            'TEST': {'MIRROR': 'default'},
        },
    }
    TABTIN_MIGRATION_DATABASE_ALIASES = ['default']
    if os.getenv('TABTIN_ENABLE_LEGACY_MYSQL', 'False').lower() == 'true':
        DATABASES['legacy_mysql'] = _legacy_mysql_database_config()
else:
    DATABASES = {
        # 旧双库模式，仅作为应急回退/旧分支兼容；新开发不应依赖。
        'default': _legacy_mysql_database_config(),
        'postgresql': _postgres_database_config(),
    }
    TABTIN_MIGRATION_DATABASE_ALIASES = ['default', 'postgresql']

# Django tests default to the local PostgreSQL test database. SQLite is now an
# explicit opt-in compatibility path because production and dev both run on
# single PostgreSQL, and many migrations intentionally use PG-only features.
if RUNNING_TESTS and os.getenv('USE_SQLITE_FOR_TESTS', '0') == '1':
    DATABASES['default'] = {
        'ENGINE': 'django.db.backends.sqlite3',
        'NAME': BASE_DIR / 'test_default.sqlite3',
    }
    if TABTIN_SINGLE_DATABASE_MODE:
        DATABASES['postgresql'] = {
            'ENGINE': 'django.db.backends.sqlite3',
            'NAME': BASE_DIR / 'test_default.sqlite3',
            'TEST': {'MIRROR': 'default'},
        }
        DATABASES.pop('legacy_mysql', None)
        TABTIN_MIGRATION_DATABASE_ALIASES = ['default']
    else:
        DATABASES['postgresql'] = {
            'ENGINE': 'django.db.backends.sqlite3',
            'NAME': BASE_DIR / 'test_postgresql.sqlite3',
        }

# 数据库路由器：将 Schema、TabData 和 RAG 模块路由到 PostgreSQL
# 注意：路由器顺序很重要！每个路由器的 allow_migrate 需要正确返回 None 而不是 False
DATABASE_ROUTERS = [
    # FTS 双栈路由器（ADR-04）必须在最前：FtsOutbox(MySQL) + FtsOutboxPg(PG)
    # 同 app 内按 model_name 分发，需抢在 DefaultDatabaseRouter 之前决策
    'apps.fts.db_router.FtsRouter',
    # v3.1（2026-04-19）：AppConnectRouter 已删除（Connect 模型作废，见 PRD-v3.1-方向锚）
    'apps.tabtinspace.db_router.TabtinspaceRouter',  # Tabtin Space 核心模块
    'apps.tabdoc.db_router.TabdocRouter',  # TabDoc 文档模块
    'apps.tracker.db_router.TrackerRouter',  # ✅ Tracker 派活引擎（PostgreSQL）
    'apps.tabdata.db_router.TabdataRouter',  # TabData 多维表格
    'apps.rag.db_router.RagRouter',  # RAG 向量检索
    'apps.services.agent_engine.db_router.AgentEngineRouter',  # Agent 引擎运行时 model（Wave 11, 2026-04-17）
    'apps.tabslide.db_router.SlideRouter',  # TabSlide 演示文稿模块
    'apps.tabcode.db_router.TabcodeRouter',  # TabCode 代码项目模块
    'apps.tabmemo.db_router.TabmemoRouter',  # TabMemo 碎片笔记
    'apps.agent_memory.db_router.AgentMemoryRouter',  # Agent 记忆领域（与 TabMemo 同库）
    'apps.user_portrait.db_router.UserPortraitRouter',  # User 用户画像（USER 层）
    'apps.services.speech.db_router.SpeechRouter',  # Speech Services (ASR/TTS)
    'apps.extensions.db_router.ExtensionsRouter',  # Extension 框架
    'apps.tabchat.db_router.TabchatRouter',  # TabChat 即时通讯
    'apps.collab.db_router.CollabRouter',  # Collab 统一协作与版本管理
    'apps.services.notification.db_router.NotificationRouter',  # 团队通知
    'apps.capabilities.db_router.CapabilitiesRouter',  # Capabilities 工具中心
    'apps.client_errors.db_router.ClientErrorsRouter',  # 客户端错误监控
    'apps.tins.db_router.TinsRouter',  # Tins 智能微应用
    # ⚠️ DEPRECATED: 以下路由器已合并到 SchemaRouter
    # 'apps.schema_market.db_router.SchemaMarketRouter',
    # (已废弃) schema_discovery 路由器已合并到 SchemaRouter
    'apps.services.package_registry.db_router.PackageRegistryRouter',  # Package Registry 包管理
    'apps.skills.db_router.SkillsRouter',  # Skills（Wave 1, 2026-05-02 — PRD V3.3 §11.1）
    'apps.services.llm.db_router.LlmRouter',  # services_llm（v0.1 宪法, 2026-05-05）
    # browser_env router 随 app 一起退役（2026-05-01）。
    # ⬇️ 兜底路由器，必须放在最后
    'apps.tabsite.db_router.TabsiteRouter',
    'apps.services.common.db_router.DefaultDatabaseRouter',
]

# Cache Configuration
REDIS_DB = int(os.getenv('REDIS_DB', '0'))

CACHES = {
    'default': {
        'BACKEND': 'django_redis.cache.RedisCache',
        'LOCATION': os.getenv('REDIS_CACHE_URL', os.getenv('REDIS_URL', f'redis://localhost:6379/{REDIS_DB + 1}')),
        'OPTIONS': {
            'CLIENT_CLASS': 'django_redis.client.DefaultClient',
            'CONNECTION_POOL_KWARGS': {
                'max_connections': int(os.getenv('REDIS_MAX_CONNECTIONS', '50')),
            },
        }
    }
}

if RUNNING_TESTS and os.getenv('USE_IN_MEMORY_CACHE', '1') == '1':
    CACHES['default'] = {
        'BACKEND': 'django.core.cache.backends.locmem.LocMemCache',
        'LOCATION': 'tabtin-tests',
    }

CHANNEL_LAYERS = {
    'default': {
        'BACKEND': 'channels_redis.core.RedisChannelLayer',
        'CONFIG': {
            'hosts': [os.getenv('REDIS_CHANNEL_URL', os.getenv('REDIS_URL', f'redis://localhost:6379/{REDIS_DB + 2}'))],
            'capacity': 1500,
            'expiry': 60,
        },
    },
}

if RUNNING_TESTS and os.getenv('USE_IN_MEMORY_CHANNEL_LAYER', '1') == '1':
    CHANNEL_LAYERS = {
        'default': {
            'BACKEND': 'channels.layers.InMemoryChannelLayer',
        }
    }

# Internationalization
LANGUAGE_CODE = 'zh-hans'
TIME_ZONE = 'Asia/Shanghai'
USE_I18N = True
USE_TZ = True

# Static files (CSS, JavaScript, Images)
STATIC_URL = '/static/'
STATIC_ROOT = BASE_DIR / 'staticfiles'

# 上传限制（PPTX/图片等大文件场景）
DATA_UPLOAD_MAX_MEMORY_SIZE = 100 * 1024 * 1024   # 100 MB（JSON body）
FILE_UPLOAD_MAX_MEMORY_SIZE = 100 * 1024 * 1024    # 100 MB（文件上传）

# Default primary key field type
DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'

# 自定义用户模型
AUTH_USER_MODEL = 'users_auth.User'

# 认证后端
AUTHENTICATION_BACKENDS = [
    'apps.users.auth.authentication.MultiFieldAuthBackend',
    'django.contrib.auth.backends.ModelBackend',
]

# JWT配置
_jwt_env = _secret_env_or_file('JWT_SECRET_KEY', required=False)
if not DEBUG and not RUNNING_TESTS and not _jwt_env:
    raise ImproperlyConfigured(
        "JWT_SECRET_KEY 环境变量未配置。生产环境必须设置独立的 JWT 签名密钥，"
        "不得与 Django SECRET_KEY 共用。"
    )
if not DEBUG and not RUNNING_TESTS and _jwt_env and _jwt_env == SECRET_KEY:
    raise ImproperlyConfigured(
        "JWT_SECRET_KEY 不得与 Django SECRET_KEY 相同。"
        "请配置独立的 JWT 签名密钥以实现密钥隔离。"
    )
JWT_SECRET_KEY = _jwt_env or SECRET_KEY


def _normalize_credential_fernet_key_env(value: str, *, env_var_name: str) -> str:
    """校验 Fernet 密钥；开发/测试下对占位符清空，交给 fields 从 SECRET_KEY 派生。"""
    if not value:
        return ''
    try:
        from cryptography.fernet import Fernet

        Fernet(value.encode('utf-8'))
        return value
    except Exception as exc:
        if DEBUG or RUNNING_TESTS:
            import logging

            logging.getLogger(__name__).warning(
                '%s 不是合法的 Fernet 密钥（占位符或未按 url-safe Base64 编码），已忽略；'
                '凭据加密将使用 SECRET_KEY 派生。生成密钥: '
                'python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"',
                env_var_name,
            )
            return ''
        raise ImproperlyConfigured(
            f'{env_var_name} 无效：须为 cryptography Fernet 密钥（32 字节经 url-safe Base64 编码）。'
            '在部署主机执行：python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"'
        ) from exc


CREDENTIAL_ENCRYPTION_KEY = _secret_env_or_file(
    'CREDENTIAL_ENCRYPTION_KEY',
    required=False,
)
if not DEBUG and not RUNNING_TESTS and not CREDENTIAL_ENCRYPTION_KEY:
    raise ImproperlyConfigured(
        "生产环境必须配置独立的 CREDENTIAL_ENCRYPTION_KEY，"
        "不得与 Django SECRET_KEY 共用。凭据加密密钥泄露将影响所有用户凭据安全。"
    )
if not DEBUG and not RUNNING_TESTS and CREDENTIAL_ENCRYPTION_KEY and CREDENTIAL_ENCRYPTION_KEY == SECRET_KEY:
    raise ImproperlyConfigured(
        "CREDENTIAL_ENCRYPTION_KEY 不得与 Django SECRET_KEY 相同。"
        "请配置独立的凭据加密密钥以实现密钥隔离。"
    )

CREDENTIAL_ENCRYPTION_KEY = _normalize_credential_fernet_key_env(
    CREDENTIAL_ENCRYPTION_KEY, env_var_name='CREDENTIAL_ENCRYPTION_KEY'
)

_ssh_fernet_raw = os.getenv('SSH_CREDENTIAL_ENCRYPTION_KEY', '')
if _ssh_fernet_raw:
    _ssh_fernet_raw = _normalize_credential_fernet_key_env(
        _ssh_fernet_raw, env_var_name='SSH_CREDENTIAL_ENCRYPTION_KEY'
    )
SSH_CREDENTIAL_ENCRYPTION_KEY = _ssh_fernet_raw or CREDENTIAL_ENCRYPTION_KEY
DAEMON_TOKEN_SECRET = os.getenv('DAEMON_TOKEN_SECRET', '')

# 反向代理层数：get_client_ip 从 X-Forwarded-For 右起第 N 个 IP 提取客户端真实 IP
# 0 = 忽略 XFF，仅用 REMOTE_ADDR；生产环境有 Nginx 代理时至少设为 1
TRUSTED_PROXY_COUNT = int(os.getenv('TRUSTED_PROXY_COUNT', '0'))

# Unicode 输入规范化中间件开关
UNICODE_NORMALIZATION_ENABLED = os.getenv('UNICODE_NORMALIZATION_ENABLED', 'true').lower() not in ('0', 'false', 'no')

# Daemon 连接地址（写入 install token，Daemon 初始化时使用）
DAEMON_SERVER_URL = _edition_endpoint(
    'DAEMON_SERVER_URL', saas_default='https://api.example.com'
)
DAEMON_WS_URL = _edition_endpoint(
    'DAEMON_WS_URL', saas_default='wss://ws.example.com'
)
JWT_ACCESS_TOKEN_LIFETIME = int(os.getenv('JWT_ACCESS_TOKEN_LIFETIME', '3600'))  # 1小时
JWT_REFRESH_TOKEN_LIFETIME = int(os.getenv('JWT_REFRESH_TOKEN_LIFETIME', '604800'))  # 7天

# 密码验证配置
AUTH_PASSWORD_VALIDATORS = [
    {
        'NAME': 'django.contrib.auth.password_validation.UserAttributeSimilarityValidator',
    },
    {
        'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator',
        'OPTIONS': {
            'min_length': 8,
        }
    },
    {
        'NAME': 'django.contrib.auth.password_validation.CommonPasswordValidator',
    },
    {
        'NAME': 'django.contrib.auth.password_validation.NumericPasswordValidator',
    },
]

# 登录安全配置
LOGIN_ATTEMPT_LIMIT = int(os.getenv('LOGIN_ATTEMPT_LIMIT', '5'))
ACCOUNT_LOCKOUT_DURATION = int(os.getenv('ACCOUNT_LOCKOUT_DURATION', '1800'))  # 30分钟
SESSION_COOKIE_AGE = int(os.getenv('SESSION_COOKIE_AGE', '86400'))  # 24小时
SESSION_ENGINE = 'django.contrib.sessions.backends.cache'
SESSION_CACHE_ALIAS = 'default'

# ── A3 update-by-filter confirm_token HMAC 配置 ──────────────────
TABDATA_CONFIRM_TOKEN_SECRET = os.getenv('TABDATA_CONFIRM_TOKEN_SECRET', '')
TABDATA_CONFIRM_TOKEN_TTL_SECONDS = int(os.getenv('TABDATA_CONFIRM_TOKEN_TTL_SECONDS', '300'))
TABDATA_CONFIRM_TOKEN_NONCE_RESERVE_TTL_SECONDS = int(os.getenv('TABDATA_CONFIRM_TOKEN_NONCE_RESERVE_TTL_SECONDS', '420'))
TABDATA_CONFIRM_TOKEN_DRIFT_TOLERANCE = float(os.getenv('TABDATA_CONFIRM_TOKEN_DRIFT_TOLERANCE', '0.10'))
TABDATA_CONFIRM_TOKEN_DRIFT_REJECT_THRESHOLD = float(os.getenv('TABDATA_CONFIRM_TOKEN_DRIFT_REJECT_THRESHOLD', '0.50'))
TABDATA_A3_HARD_LIMIT = int(os.getenv('TABDATA_A3_HARD_LIMIT', '10000'))
TABDATA_A3_THRESHOLD_REQUIRE_CHECKPOINT_HINT = int(os.getenv('TABDATA_A3_THRESHOLD_REQUIRE_CHECKPOINT_HINT', '200'))
TABDATA_A3_THRESHOLD_AUTO_CHECKPOINT = int(os.getenv('TABDATA_A3_THRESHOLD_AUTO_CHECKPOINT', '1000'))
TABDATA_A3_AGENT_FORCE_CHECKPOINT = os.getenv('TABDATA_A3_AGENT_FORCE_CHECKPOINT', 'True').lower() == 'true'

# ── W3.0 / D27：bulk_update on_commit 异步化 ────────────────────
# True：on_commit 后的 VersionHistory + ChangeLog 写入走 Celery，
#       让 RecordService.bulk_update_records 函数返回时不再被 ~2s 阻塞。
# False：回退到同步路径（W2 行为），灰度退路。
TABDATA_BULK_UPDATE_ASYNC_COLLAB = os.getenv(
    'TABDATA_BULK_UPDATE_ASYNC_COLLAB', 'True'
).lower() == 'true'
# Spin-wait pending changelog 计数器到 0 的最大耗时；超时仍创建 Checkpoint
# 但打 warning（version_refs 可能漏收本次 turn 的 table）。
TABDATA_PENDING_CHANGELOG_WAIT_TIMEOUT_MS = int(
    os.getenv('TABDATA_PENDING_CHANGELOG_WAIT_TIMEOUT_MS', '5000')
)

# ── W3.0c / G1.a：A2 batch_update raw SQL 路径独立开关 ─────────
# True（默认）：走 W2.perf 一条 ``UPDATE ... FROM (VALUES ...)`` raw SQL，
#   绕开 Django ORM N 次 record 加载，500 行 p95 < 2s。
# False：跳过 raw SQL 直接走 ``_orm_bulk_update_fallback``（Django ORM
#   ``bulk_update``）。用于 raw SQL 路径自身（``_RecordStub`` /
#   ``_build_set_clause`` 等）出现数据偏差时不经 git revert 即热回退。
# 灰度退路对应 wave3-rollback-rehearsal.md G1.a。
TABDATA_BULK_UPDATE_USE_RAW_SQL = os.getenv(
    'TABDATA_BULK_UPDATE_USE_RAW_SQL', 'True'
).lower() == 'true'

# ── W3.0c / G3：A3 update-by-filter 整体一键关闭开关 ───────────
# True（默认）：A3 preflight + commit 路由可用。
# False：preflight + commit 入口立即返回 503 +
#   ``a3.feature_disabled`` i18n 文案，路由仍可达但拒绝执行。
# 用途：遇到 A3 SQL 注入 / 权限绕过类 P0 紧急情况，可在 < 5 min
# export env 后让所有 A3 调用拒绝执行（比 ``TABDATA_A3_HARD_LIMIT=0``
# 软回退语义更彻底，含 ``matched_total=0`` 边界）。
# 对应 wave3-rollback-rehearsal.md §5.1 G3。
TABDATA_A3_ENABLED = os.getenv('TABDATA_A3_ENABLED', 'True').lower() == 'true'

# ── W3.0c / G4：C1 复杂字段 restore 按字段类型禁用 ─────────────
# 逗号分隔字段类型字符串。空（默认）= 不禁用任何类型，所有 15 种
# 可撤销类型走原有 restore 路径。
# 例：``link,attachment`` = Link / Attachment 字段的 ``restore_field``
# 入口直接返回不可撤销（``can_restore_field_type`` 返回 False，前端
# 引导用户走「版本时间线」面板）。
# 用途：Link / Lookup / Formula 等复杂字段 restore 出现数据丢失类
# P0 时，按字段类型细粒度禁用（无需 git revert 整体 W2 C1 能力）。
# 对应 wave3-rollback-rehearsal.md §3.3.5 + §5.1 G4。
TABDATA_C1_COMPLEX_RESTORE_DISABLED_TYPES = os.getenv(
    'TABDATA_C1_COMPLEX_RESTORE_DISABLED_TYPES', ''
)

# ── W3.0c / G6：D1-Checkpoint Rollback Saga 状态机配置 ─────────
# 对照源：``docs/planning/tabdata/checkpoint-saga-statemachine.md``
# §11.3 + §12.1 完整清单。Wave 3 D1 启用前必须就位，否则无法灰度。
#
# 主开关：False（默认）→ 走旧 ``_legacy_restore_space_checkpoint``，
# True → 走 saga 5 步状态机（prepare/pause_outbox/restore_data/
# mark_collab/cleanup）。生产灰度按 §11.3 S1→S4 阶段推进。
TABDATA_SAGA_ENABLED = os.getenv('TABDATA_SAGA_ENABLED', 'False').lower() == 'true'

# 生产 allowlist：逗号分隔 organization_id；空字符串 = 跟随 TABDATA_SAGA_ENABLED。
# 用于 §11.3 S2 阶段把 ≤ 5 个内部 staff organization 加入灰度。
# 入口：``saga.is_enabled_for(organization_id)`` 解析。
TABDATA_SAGA_ORGANIZATION_ALLOWLIST = [
    wid.strip()
    for wid in os.getenv('TABDATA_SAGA_ORGANIZATION_ALLOWLIST', '').split(',')
    if wid.strip()
]

# 每 step 最大重试次数（exhausted → 升 manual_intervention）。
# 默认 prepare/pause_outbox/restore_data/mark_collab 各 3 次，cleanup 5 次
# （cleanup 失败造成的"残留 paused"需要更高韧性）。
TABDATA_SAGA_STEP_RETRY_LIMITS = {
    'prepare': int(os.getenv('TABDATA_SAGA_RETRY_PREPARE', '3')),
    'pause_outbox': int(os.getenv('TABDATA_SAGA_RETRY_PAUSE_OUTBOX', '3')),
    'restore_data': int(os.getenv('TABDATA_SAGA_RETRY_RESTORE_DATA', '3')),
    'mark_collab': int(os.getenv('TABDATA_SAGA_RETRY_MARK_COLLAB', '3')),
    'cleanup': int(os.getenv('TABDATA_SAGA_RETRY_CLEANUP', '5')),
}

# 指数退避上限（秒）。每 step retry 第 N 次等
# ``min(2**N, TABDATA_SAGA_STEP_RETRY_BACKOFF_MAX)`` 秒后再试。
TABDATA_SAGA_STEP_RETRY_BACKOFF_MAX = int(
    os.getenv('TABDATA_SAGA_STEP_RETRY_BACKOFF_MAX', '30')
)

# pause_outbox step 等待 in-flight Outbox 任务进入终态的超时（秒）。
# 默认 300s（5 min）；超时升 manual_intervention（P1 报警）。
# 对应 §12.3 报警 ``tabdata_saga_processing_wait_seconds P95 > 240s``。
TABDATA_SAGA_PAUSE_OUTBOX_TIMEOUT_SECONDS = int(
    os.getenv('TABDATA_SAGA_PAUSE_OUTBOX_TIMEOUT_SECONDS', '300')
)

# Celery beat 对账周期（分钟）。每 N 分钟扫一次 in_progress 超时 saga，
# 推进或升 manual_intervention。SLO § 12.4：5 分钟一致性窗口达标率 ≥ 99%。
TABDATA_SAGA_RECONCILE_INTERVAL_MINUTES = int(
    os.getenv('TABDATA_SAGA_RECONCILE_INTERVAL_MINUTES', '5')
)

# 单次对账任务最大 saga 数（防"对账风暴"）。超出的下个周期再处理。
TABDATA_SAGA_RECONCILE_BATCH_SIZE = int(
    os.getenv('TABDATA_SAGA_RECONCILE_BATCH_SIZE', '100')
)

# manual_intervention 状态 saga 保留天数（事后审计）。
# 超出 → 归档表 ``tabdata_saga_payload_archive`` + 主表清理。
TABDATA_SAGA_MANUAL_INTERVENTION_RETENTION_DAYS = int(
    os.getenv('TABDATA_SAGA_MANUAL_INTERVENTION_RETENTION_DAYS', '90')
)

# succeeded 状态 saga 归档 / 清理周期（天）。
TABDATA_SAGA_SUCCEEDED_RETENTION_DAYS = int(
    os.getenv('TABDATA_SAGA_SUCCEEDED_RETENTION_DAYS', '30')
)

# step_payload 行内存储上限（字节）；超出 → cleanup 阶段同步归档到
# ``tabdata_saga_payload_archive``，主表只留 8KB 摘要。
TABDATA_SAGA_PAYLOAD_INLINE_LIMIT_BYTES = int(
    os.getenv('TABDATA_SAGA_PAYLOAD_INLINE_LIMIT_BYTES', '8192')
)

# 归档表保留天数（超出 → 物理删除）。比上面"主表保留"略宽松，
# 给"已归档但仍有合规审计需求"的场景留窗口。
TABDATA_SAGA_ARCHIVE_TTL_DAYS = int(
    os.getenv('TABDATA_SAGA_ARCHIVE_TTL_DAYS', '90')
)

# ── D2 / C1 兜底：字段回收站保留天数 ──
# 软删除的 TableField 超过此天数后由 beat 任务物理删除（native 列 + ORM）。
TABDATA_FIELD_RECYCLE_BIN_TTL_DAYS = int(
    os.getenv('TABDATA_FIELD_RECYCLE_BIN_TTL_DAYS', '30')
)

# 认证限流配置（统一管理验证码/密码重置）
AUTH_RATE_LIMITS = {
    "verification_code": {
        "per_identifier_hour": int(os.getenv('AUTH_VERIFICATION_PER_IDENTIFIER_HOUR', '10')),
        "per_identifier_day": int(os.getenv('AUTH_VERIFICATION_PER_IDENTIFIER_DAY', '50')),
        "per_ip_hour": int(os.getenv('AUTH_VERIFICATION_PER_IP_HOUR', '30')),
        "per_ip_day": int(os.getenv('AUTH_VERIFICATION_PER_IP_DAY', '200')),
        "per_pair_hour": int(os.getenv('AUTH_VERIFICATION_PER_PAIR_HOUR', '10')),
        "per_pair_day": int(os.getenv('AUTH_VERIFICATION_PER_PAIR_DAY', '50')),
    },
    "password_reset": {
        "per_identifier_hour": int(os.getenv('AUTH_PASSWORD_RESET_PER_IDENTIFIER_HOUR', '5')),
        "per_identifier_day": int(os.getenv('AUTH_PASSWORD_RESET_PER_IDENTIFIER_DAY', '20')),
        "per_ip_hour": int(os.getenv('AUTH_PASSWORD_RESET_PER_IP_HOUR', '20')),
        "per_ip_day": int(os.getenv('AUTH_PASSWORD_RESET_PER_IP_DAY', '100')),
        "per_pair_hour": int(os.getenv('AUTH_PASSWORD_RESET_PER_PAIR_HOUR', '5')),
        "per_pair_day": int(os.getenv('AUTH_PASSWORD_RESET_PER_PAIR_DAY', '20')),
    },
}

# ===================================================================
# 验证码固定值后门（仅 preprod / 内部测试使用）
# -------------------------------------------------------------------
# 设置 AUTH_FIXED_VERIFICATION_CODE 后：
#   - VerificationCodeManager.send_code() 跳过真实短信/邮件发送
#   - 验证码恒定为该值，缓存到 Redis（verify 路径完全不变）
#   - 每次发送会打 WARNING 级别审计日志
# 启动时若检测到生产域名（含 example.com/*.example.com）出现在 ALLOWED_HOSTS 中，
# 配置存在即 fail-fast，避免误把 preprod .env 模板带到生产部署。
# ===================================================================
AUTH_FIXED_VERIFICATION_CODE = os.getenv('AUTH_FIXED_VERIFICATION_CODE', '').strip()
if AUTH_FIXED_VERIFICATION_CODE:
    _PRODUCTION_DOMAIN_MARKERS = ('example.com',)
    for _h in ALLOWED_HOSTS:
        _h_lower = _h.lower().lstrip('*.')
        for _marker in _PRODUCTION_DOMAIN_MARKERS:
            if _h_lower == _marker or _h_lower.endswith('.' + _marker):
                raise ImproperlyConfigured(
                    f"AUTH_FIXED_VERIFICATION_CODE 已设置（值会作为所有用户的固定验证码），"
                    f"但 ALLOWED_HOSTS 中检测到生产域名 '{_h}'。"
                    f"为避免生产环境意外启用验证码后门，已强制 fail-fast。"
                    f"请在生产 .env 中删除 AUTH_FIXED_VERIFICATION_CODE。"
                )

# Centrifugo 实时传输层
CENTRIFUGO_API_URL = os.getenv("CENTRIFUGO_API_URL", "http://127.0.0.1:8100/api")
CENTRIFUGO_API_KEY = _secret_env_or_file(
    "CENTRIFUGO_API_KEY",
    "tabtin-centrifugo-dev-api-key",
)
_centrifugo_token_secret_env = _secret_env_or_file(
    "CENTRIFUGO_TOKEN_SECRET",
    required=False,
)
if not _centrifugo_token_secret_env:
    if not DEBUG:
        from django.core.exceptions import ImproperlyConfigured
        raise ImproperlyConfigured(
            "CENTRIFUGO_TOKEN_SECRET 未设置。"
            "生产环境必须使用独立密钥，禁止与 JWT_SECRET_KEY 共用。"
        )
CENTRIFUGO_TOKEN_SECRET = _centrifugo_token_secret_env or JWT_SECRET_KEY
CENTRIFUGO_PROXY_SECRET = _secret_env_or_file(
    "CENTRIFUGO_PROXY_SECRET",
    "tabtin-centrifugo-proxy-dev-secret",
)
CENTRIFUGO_TOKEN_TTL = int(os.getenv("CENTRIFUGO_TOKEN_TTL", "86400"))
CENTRIFUGO_USER_CONNECTION_LIMIT = int(os.getenv("CENTRIFUGO_USER_CONNECTION_LIMIT", "10"))
CENTRIFUGO_ALLOWED_PROXY_IPS = _split_csv_env(
    os.getenv(
        "CENTRIFUGO_ALLOWED_PROXY_IPS",
        "127.0.0.1,::1,172.16.0.0/12,10.0.0.0/8,192.168.0.0/16" if DEBUG
        else "127.0.0.1,::1",
    )
)
CENTRIFUGO_TRUSTED_PROXIES = _split_csv_env(
    os.getenv("CENTRIFUGO_TRUSTED_PROXIES", "")
)

# 历史内部服务鉴权：部分 Django 对内接口仍读取该令牌。
DAEMON_CONTROL_ENABLED = _env_bool("DAEMON_CONTROL_ENABLED", False)
DAEMON_CONTROL_HTTP_ADDR = os.getenv(
    "DAEMON_CONTROL_HTTP_ADDR", "127.0.0.1:6080"
).strip()
DAEMON_CONTROL_INTERNAL_SERVICE_TOKEN = os.getenv(
    "DAEMON_CONTROL_INTERNAL_SERVICE_TOKEN", ""
).strip()

_CENTRIFUGO_DEV_DEFAULTS = {
    "tabtin-centrifugo-dev-secret-change-in-production",
    "tabtin-centrifugo-proxy-dev-secret",
    "tabtin-centrifugo-dev-api-key",
}
if not DEBUG:
    for _name, _val in [
        ("CENTRIFUGO_TOKEN_SECRET", CENTRIFUGO_TOKEN_SECRET),
        ("CENTRIFUGO_PROXY_SECRET", CENTRIFUGO_PROXY_SECRET),
        ("CENTRIFUGO_API_KEY", CENTRIFUGO_API_KEY),
    ]:
        if _val in _CENTRIFUGO_DEV_DEFAULTS:
            raise ImproperlyConfigured(
                f"生产环境禁止使用 Centrifugo 默认开发密钥: {_name}"
            )

# Celery Configuration
from kombu import Queue

CELERY_BROKER_URL = os.getenv('CELERY_BROKER_URL', os.getenv('REDIS_URL', f'redis://localhost:6379/{REDIS_DB}'))
CELERY_RESULT_BACKEND = 'django-db'
CELERY_CACHE_BACKEND = 'django-cache'
CELERY_ACCEPT_CONTENT = ['json']
CELERY_TASK_SERIALIZER = 'json'
CELERY_RESULT_SERIALIZER = 'json'
CELERY_TIMEZONE = TIME_ZONE
CELERY_TASK_TRACK_STARTED = True
CELERY_TASK_TIME_LIMIT = 30 * 60  # 30分钟超时
CELERY_TASK_SOFT_TIME_LIMIT = 25 * 60  # 25分钟软超时
CELERY_TASK_ACKS_LATE = True
CELERY_TASK_REJECT_ON_WORKER_LOST = True
CELERY_BROKER_CONNECTION_RETRY_ON_STARTUP = True
# Celery's default is already 300s.  Keep it explicit because the project
# Redis transport uses the same safety window for the physical pidbox reply
# list.  The longest project inspect timeout is 5s and Mingle uses 1s, so this
# leaves 60x headroom for slow/many worker replies and network jitter.
CELERY_CONTROL_QUEUE_TTL = 300.0
CELERY_CONTROL_QUEUE_EXPIRES = 10.0
CELERY_BROKER_TRANSPORT = 'tabtin.celery_redis_transport:Transport'


def _build_socket_keepalive_options():
    """构建跨平台 TCP keepalive 选项。
    Linux 使用 TCP_KEEPIDLE/TCP_KEEPINTVL/TCP_KEEPCNT；
    macOS 使用 TCP_KEEPALIVE（无 IDLE）+ TCP_KEEPINTVL + TCP_KEEPCNT。
    """
    import socket as _sock
    opts = {}
    idle_attr = 'TCP_KEEPIDLE' if hasattr(_sock, 'TCP_KEEPIDLE') else 'TCP_KEEPALIVE'
    if hasattr(_sock, idle_attr):
        opts[getattr(_sock, idle_attr)] = 10
    if hasattr(_sock, 'TCP_KEEPINTVL'):
        opts[_sock.TCP_KEEPINTVL] = 10
    if hasattr(_sock, 'TCP_KEEPCNT'):
        opts[_sock.TCP_KEEPCNT] = 3
    return opts


CELERY_BROKER_TRANSPORT_OPTIONS = {
    'visibility_timeout': 7200,
    'pidbox_reply_ttl': int(CELERY_CONTROL_QUEUE_TTL),
    'socket_connect_timeout': 10,
    'socket_timeout': 30,
    'socket_keepalive': True,
    'socket_keepalive_options': _build_socket_keepalive_options(),
}
CELERY_RESULT_EXPIRES = 86400 * 7
# django-db backend 连接池由 Django DATABASES.CONN_MAX_AGE 管理，无需额外配置；
# MAX_RETRIES 确保 DB 瞬断时结果存储有重试保护（django-celery-results 2.5+ 默认 10）
CELERY_RESULT_BACKEND_MAX_RETRIES = 10

CELERY_BEAT_SCHEDULER = 'django_celery_beat.schedulers:DatabaseScheduler'

BILLING_INVOICE_COLLECTION_ENABLED = os.getenv('BILLING_INVOICE_COLLECTION_ENABLED', 'False').lower() == 'true'
BILLING_LEGACY_NON_LLM_CONSUME_ENABLED = os.getenv('BILLING_LEGACY_NON_LLM_CONSUME_ENABLED', 'False').lower() == 'true'
BILLING_LEGACY_NON_LLM_USAGE_CHARGE_ENABLED = os.getenv('BILLING_LEGACY_NON_LLM_USAGE_CHARGE_ENABLED', 'False').lower() == 'true'

# Model Gateway projection writes are an operator-only, fail-closed capability.
# It is intentionally independent of DEBUG/environment inference and unused by
# runtime request paths.
MODEL_GATEWAY_PROJECTION_WRITE_ENABLED = False
AI_SCENE_POLICY_SHADOW_ENABLED = os.getenv(
    'AI_SCENE_POLICY_SHADOW_ENABLED',
    'False',
).lower() == 'true'
PROVIDER_CREDIT_FUNDING_ENABLED = os.getenv('PROVIDER_CREDIT_FUNDING_ENABLED', 'False').lower() == 'true'
PROVIDER_CREDIT_UI_ENABLED = os.getenv('PROVIDER_CREDIT_UI_ENABLED', 'False').lower() == 'true'
# 团队预算百分比告警（横幅 / toast / WS budget_*）软下线；团队计费管理重做前默认关闭。
BILLING_BUDGET_ALERTS_ENABLED = os.getenv('BILLING_BUDGET_ALERTS_ENABLED', 'False').lower() == 'true'
MEMBERSHIP_LIFECYCLE_CLASSIFIER_ENABLED = os.getenv(
    'MEMBERSHIP_LIFECYCLE_CLASSIFIER_ENABLED',
    'False',
).lower() == 'true'
MEMBERSHIP_UPGRADE_QUOTE_ENABLED = os.getenv(
    'MEMBERSHIP_UPGRADE_QUOTE_ENABLED',
    'False',
).lower() == 'true'
MEMBERSHIP_UPGRADE_QUOTE_TTL_SECONDS = int(
    os.getenv('MEMBERSHIP_UPGRADE_QUOTE_TTL_SECONDS', '600')
)
MEMBERSHIP_UPGRADE_PAYMENT_ENABLED = os.getenv(
    'MEMBERSHIP_UPGRADE_PAYMENT_ENABLED',
    'False',
).lower() == 'true'
MEMBERSHIP_UPGRADE_WALLET_PAYMENT_ENABLED = os.getenv(
    'MEMBERSHIP_UPGRADE_WALLET_PAYMENT_ENABLED',
    'False',
).lower() == 'true'
MEMBERSHIP_DOWNGRADE_ENABLED = os.getenv(
    'MEMBERSHIP_DOWNGRADE_ENABLED',
    'False',
).lower() == 'true'
MEMBERSHIP_SWITCH_ENABLED = os.getenv(
    'MEMBERSHIP_SWITCH_ENABLED',
    'False',
).lower() == 'true'
MEMBERSHIP_MANUAL_RENEWAL_ENABLED = os.getenv(
    'MEMBERSHIP_MANUAL_RENEWAL_ENABLED',
    'False',
).lower() == 'true'
MEMBERSHIP_GRACE_PERIOD_ENABLED = os.getenv(
    'MEMBERSHIP_GRACE_PERIOD_ENABLED',
    'False',
).lower() == 'true'
MEMBERSHIP_LIFECYCLE_TASKS_ENABLED = os.getenv(
    'MEMBERSHIP_LIFECYCLE_TASKS_ENABLED',
    'False',
).lower() == 'true'
MEMBERSHIP_GRACE_PERIOD_DAYS = int(os.getenv('MEMBERSHIP_GRACE_PERIOD_DAYS', '7'))
MEMBERSHIP_EXPIRE_TO_FREE_ENABLED = os.getenv(
    'MEMBERSHIP_EXPIRE_TO_FREE_ENABLED',
    'True',
).lower() == 'true'

def _default_tracker_agent_queue() -> str:
    explicit_queue = os.getenv('TRACKER_AGENT_QUEUE', '').strip()
    if explicit_queue:
        return explicit_queue

    explicit_isolation = os.getenv('TRACKER_AGENT_ISOLATE_LOCAL_QUEUE', '').strip().lower()
    if explicit_isolation in {'1', 'true', 'yes', 'on'}:
        should_isolate = True
    elif explicit_isolation in {'0', 'false', 'no', 'off'}:
        should_isolate = False
    else:
        # 本地 remote 调试必须与 ACK 的共享 Redis 队列隔离，且不能只覆盖 Windows：
        # macOS / 本地 Docker worker 同样会抢消费。Kubernetes 内 producer/worker
        # 继续共用 canonical queue，避免按 Pod 主机名分叉。
        should_isolate = (
            os.getenv('TABTIN_INFRA_MODE', '').strip().lower() == 'remote'
            and not os.getenv('KUBERNETES_SERVICE_HOST', '').strip()
        )

    if should_isolate:
        raw_suffix = (
            os.getenv('TABTIN_QUEUE_SUFFIX')
            or os.getenv('COMPUTERNAME')
            or os.getenv('HOSTNAME')
            or os.getenv('USERNAME')
            or 'local'
        )
        safe_suffix = re.sub(r'[^A-Za-z0-9_]+', '_', raw_suffix).strip('_').lower()
        return f"tracker_agent_{safe_suffix or 'local'}"
    return 'tracker_agent'


TRACKER_AGENT_QUEUE = _default_tracker_agent_queue()
PPTX_IMPORT_OSS_QUEUE = 'pptx_import_oss'


CELERY_TASK_DEFAULT_QUEUE = 'default'

from tabtin.runtime.registry import (  # noqa: E402
    QUEUE_REGISTRY as RUNTIME_QUEUE_REGISTRY,
    RUNTIME_FEATURE_FLAGS,
    build_registry_task_routes,
)


for _flag_name, _default_value in RUNTIME_FEATURE_FLAGS.items():
    globals()[_flag_name] = os.getenv(_flag_name, str(_default_value)).lower() == 'true'


_RUNTIME_QUEUE_NAMES = tuple(RUNTIME_QUEUE_REGISTRY.keys())
_EXTRA_QUEUE_NAMES = tuple(
    name
    for name in (TRACKER_AGENT_QUEUE, PPTX_IMPORT_OSS_QUEUE)
    if name not in RUNTIME_QUEUE_REGISTRY
)
CELERY_TASK_QUEUES = tuple(
    Queue(name) for name in (_RUNTIME_QUEUE_NAMES + _EXTRA_QUEUE_NAMES)
)


# ── 队列路由（fnmatch 模式匹配） ──────────────────────────────
# critical  — 财务 / 认证 / 会员，不可被重任务饿死
# heavy     — 长耗时 / 重 I/O 任务，独立 worker 运行
# default   — 其余轻量任务（未命中规则的默认队列）
_CRITICAL_QUEUE = {'queue': 'critical'}
_HEAVY_QUEUE = {'queue': 'heavy'}
_MEDIA_QUEUE = {'queue': 'media'}
_DOCPARSE_QUEUE = {'queue': 'docparse'}
_PPTX_IMPORT_OSS_QUEUE = {'queue': PPTX_IMPORT_OSS_QUEUE}
# P0 emergency：Memory/摘要/日记 LLM 从 heavy 隔离到独立 AI Background worker
_AI_BACKGROUND_QUEUE = {'queue': 'ai_background'}

CELERY_TASK_ROUTES = {
    # ── ai_background: Memory LLM / 摘要 / 日记蒸馏（P0 从 heavy 隔离）──
    'apps.services.agent_engine.tasks.memory.capture.extract_memories_task': _AI_BACKGROUND_QUEUE,
    'apps.services.agent_engine.tasks.memory.compaction.compact_memories_task': _AI_BACKGROUND_QUEUE,
    'apps.services.agent_engine.tasks.memory.task_summary.generate_task_summary_task': _AI_BACKGROUND_QUEUE,
    'apps.services.agent_engine.tasks.memory.idle_settlement.settle_idle_session_task': _AI_BACKGROUND_QUEUE,
    'agent_engine.distill_daily_diary': _AI_BACKGROUND_QUEUE,

    # ── heavy: billing 长耗时维护任务（精确匹配优先于通配符）(FIN-8) ──
    'apps.services.billing.tasks.cleanup_old_usage_events': _HEAVY_QUEUE,

    # ── critical: 计费 / 支付 / 会员 / 钱包 / 短信 ──
    'apps.services.billing.tasks.*': _CRITICAL_QUEUE,
    'apps.services.billing.task_billing.*': _CRITICAL_QUEUE,
    'apps.services.payment.tasks.*': _CRITICAL_QUEUE,
    'apps.users.membership.tasks.*': _CRITICAL_QUEUE,
    'apps.users.wallet.tasks.*': _CRITICAL_QUEUE,
    'wallet.*': _CRITICAL_QUEUE,
    'apps.services.sms.tasks.send_sms_async': _CRITICAL_QUEUE,
    'apps.services.sms.tasks.send_verification_code_async': _CRITICAL_QUEUE,
    'apps.services.sms.tasks.send_batch_sms_async': _CRITICAL_QUEUE,

    # ── docparse: 文档解析 ──
    'docparse.execute_document_import_job': _DOCPARSE_QUEUE,
    'docparse.parse_document': _DOCPARSE_QUEUE,
    'docparse.trigger_rag_index': {'queue': 'rag_indexing'},

    # ── heavy: OSS 上传 / 下载 ──
    'apps.services.oss.tasks.upload_file_async': _HEAVY_QUEUE,
    'apps.services.oss.tasks.batch_process_staged_files': _HEAVY_QUEUE,
    'apps.services.oss.tasks.download_and_upload_from_url': _HEAVY_QUEUE,
    'apps.services.oss.tasks.batch_download_and_upload_from_urls': _HEAVY_QUEUE,

    # ── heavy: LLM 请求 ──
    'apps.services.llm.tasks.llm_tasks.process_llm_request_async': _HEAVY_QUEUE,
    'apps.services.llm.tasks.llm_tasks.process_vision_request_async': _HEAVY_QUEUE,
    'apps.services.llm.tasks.llm_tasks.batch_process_llm_requests': _HEAVY_QUEUE,

    # ── RAG 索引：由 registry 覆盖到 rag_indexing，这里保留 legacy 注释上下文 ──

    # ── media: 媒体生成产物转存 / 轮询 ──
    'apps.services.media_generation.tasks.storage.store_media_results': _MEDIA_QUEUE,
    'apps.services.media_generation.tasks.storage._upload_single_to_oss': _MEDIA_QUEUE,
    'apps.services.media_generation.tasks.polling.poll_media_task': _MEDIA_QUEUE,
    'apps.services.media_generation.tasks.execution.execute_media_generation': _MEDIA_QUEUE,

    # ── Channel Gateway 非实时任务：避免被实时投递路由误读 ──
    'channel_gateway.process_inbound': {'queue': 'realtime_delivery'},
    'channel_gateway.flush_debounce': {'queue': 'realtime_delivery'},
    'channel_gateway.dispatch_agent_reply': _HEAVY_QUEUE,
    'channel_gateway.cleanup_old_records': {'queue': 'low_priority'},
    'channel_gateway.probe_longpoll_accounts': {'queue': 'low_priority'},

    # run_subagent_task 已移除（子 Agent 改为 ThreadPool 执行）

    # ── heavy: TabData 导入 / 导出（各 30min） ──
    'tabdata.async_import_data': _HEAVY_QUEUE,
    'tabdata.async_export_data': _HEAVY_QUEUE,

    # ── heavy: TabTinSpace 重型清理 / 对账（各 30min） ──
    'tabtinspace.reconcile_context_items': _HEAVY_QUEUE,
    'tabtinspace.cleanup_expired_trashed_resources': _HEAVY_QUEUE,

    # ── heavy: TabSlide (CRT-02) ──
    'tabslide.pregenerate_pptx': _HEAVY_QUEUE,
    'tabslide.import_pptx_task': _HEAVY_QUEUE,
    'tabslide.import_pptx_oss_task': _PPTX_IMPORT_OSS_QUEUE,
    'tabslide.create_slide_history': _HEAVY_QUEUE,
    'tabslide.cleanup_slide_history': _HEAVY_QUEUE,
    'tabslide.migrate_fonts_to_oss': _HEAVY_QUEUE,
    'tabslide.cleanup_element_changes': _HEAVY_QUEUE,

    # ── TabDoc：merge / embedding 由 registry 覆盖到 doc_merge / rag_indexing ──
    'tabdoc.fix_missing_binary': _HEAVY_QUEUE,
    'tabdoc.cleanup_expired_history': _HEAVY_QUEUE,

    # ── heavy: TabData 数据完整性 / 清理 Beat 任务 (DATA-35) ──
    'apps.tabdata.tasks.link_integrity_tasks.check_link_integrity': _HEAVY_QUEUE,
    'tabdata.cleanup_record_history': _HEAVY_QUEUE,
    'tabdata.backfill_history_ttl': _HEAVY_QUEUE,
    'tabdata.cleanup_field_execution_records': _HEAVY_QUEUE,
    'tabdata.aggregate_api_usage': _HEAVY_QUEUE,
    'tabdata.aggregate_daily_api_usage': _HEAVY_QUEUE,
    'tabdata.cleanup_old_api_logs': _HEAVY_QUEUE,

    # ── 已有专用队列 ──
    'tabdata.convert_field_type': {'queue': 'tabdata_conversion'},
    # ── FTS 统一搜索索引同步（ADR-03 要求 ignore_result=True + 专用队列） ──
    'apps.fts.tasks.*': {'queue': 'search_indexing'},
    'apps.tracker.tasks.execute_tracker': {'queue': TRACKER_AGENT_QUEUE},
    'apps.tracker.tasks.tracker_health_check': {'queue': TRACKER_AGENT_QUEUE},
}


def build_celery_task_routes():
    routes = dict(CELERY_TASK_ROUTES)
    routes.update(build_registry_task_routes())
    return routes


CELERY_TASK_ROUTES = build_celery_task_routes()

# LLM Service Configuration
LLM_SERVICE = os.getenv('LLM_SERVICE', 'openai')

# 默认 LLM 模型
DEFAULT_LLM_MODEL = os.getenv('DEFAULT_LLM_MODEL', 'kimi-k2.6')

# OpenAI Configuration (支持GPT-4o)
OPENAI_API_KEY = os.getenv('OPENAI_API_KEY', '').strip()
OPENAI_BASE_URL = _edition_endpoint(
    'OPENAI_BASE_URL', saas_default='https://gptapi.xmov.ai/v1'
)
OPENAI_MODEL = os.getenv('OPENAI_MODEL', 'gpt-4o')

# Qwen Configuration (支持Coder Flash)
QWEN_API_KEY = os.getenv('QWEN_API_KEY') or os.getenv('DASHSCOPE_API_KEY')
QWEN_BASE_URL = _edition_endpoint(
    'QWEN_BASE_URL',
    saas_default='https://dashscope.aliyuncs.com/compatible-mode/v1',
)
QWEN_MODEL = os.getenv('QWEN_MODEL', 'qwen3-coder-flash')

# Claude / Anthropic Configuration
CLAUDE_API_KEY = os.getenv('CLAUDE_API_KEY', '') or os.getenv('ANTHROPIC_API_KEY', '')
CLAUDE_BASE_URL = os.getenv('CLAUDE_BASE_URL', '') or os.getenv('ANTHROPIC_BASE_URL', '')
CLAUDE_MODEL = os.getenv('CLAUDE_MODEL', '')

# Gemini / Google Configuration
GEMINI_API_KEY = os.getenv('GEMINI_API_KEY', '') or os.getenv('GOOGLE_API_KEY', '')
GEMINI_BASE_URL = os.getenv('GEMINI_BASE_URL', '')
GEMINI_MODEL = os.getenv('GEMINI_MODEL', '')

# Moonshot / Kimi Configuration
MOONSHOT_API_KEY = os.getenv('MOONSHOT_API_KEY', '')
MOONSHOT_BASE_URL = os.getenv('MOONSHOT_BASE_URL', '')
MOONSHOT_MODEL = os.getenv('MOONSHOT_MODEL', '')

# Volcengine Ark / Doubao Configuration（OpenAI 兼容）
ARK_API_KEY = os.getenv('ARK_API_KEY', '') or os.getenv('VOLCENGINE_API_KEY', '')
_ARK_CONFIGURED_BASE_URL = (
    os.getenv('ARK_BASE_URL', '') or os.getenv('VOLCENGINE_BASE_URL', '')
)
if IS_COMMUNITY_EDITION and _ARK_CONFIGURED_BASE_URL.strip():
    _ark_endpoint_environment = dict(os.environ)
    _ark_endpoint_environment['ARK_BASE_URL'] = _ARK_CONFIGURED_BASE_URL.strip()
    try:
        ARK_BASE_URL = resolve_endpoint_setting(
            _ark_endpoint_environment,
            'ARK_BASE_URL',
            saas_default='',
        )
    except ValueError as exc:
        raise ImproperlyConfigured(str(exc)) from exc
elif IS_COMMUNITY_EDITION:
    ARK_BASE_URL = ''
else:
    ARK_BASE_URL = _ARK_CONFIGURED_BASE_URL or 'https://ark.cn-beijing.volces.com/api/v3'
ARK_MODEL = (
    os.getenv('ARK_MODEL', '')
    or os.getenv('VOLCENGINE_MODEL', '')
    or os.getenv('DOUBAO_MODEL', '')
)
VOLCENGINE_API_KEY = ARK_API_KEY
VOLCENGINE_BASE_URL = ARK_BASE_URL
VOLCENGINE_MODEL = ARK_MODEL

# MiniMax Configuration
MINIMAX_API_KEY = os.getenv('MINIMAX_API_KEY', '')
MINIMAX_BASE_URL = os.getenv('MINIMAX_BASE_URL', '')
MINIMAX_MODEL = os.getenv('MINIMAX_MODEL', '')

# ZenMux Configuration
ZENMUX_API_KEY = os.getenv('ZENMUX_API_KEY', '')
ZENMUX_BASE_URL = os.getenv('ZENMUX_BASE_URL', '')
ZENMUX_MODEL = os.getenv('ZENMUX_MODEL', '')

# Local LLM Configuration
LOCAL_LLM_API_KEY = os.getenv('LOCAL_LLM_API_KEY', '')
LOCAL_LLM_BASE_URL = os.getenv('LOCAL_LLM_BASE_URL', '')
LOCAL_LLM_MODEL = os.getenv('LOCAL_LLM_MODEL', '')

# Codex Configuration (OpenAI Codex, fallback to OpenAI)
CODEX_API_KEY = os.getenv('CODEX_API_KEY', '') or os.getenv('OPENAI_API_KEY', '')
CODEX_BASE_URL = os.getenv('CODEX_BASE_URL', '') or os.getenv('OPENAI_BASE_URL', '')
CODEX_MODEL = os.getenv('CODEX_MODEL', '')

# fal.ai Configuration (Image/Video Generation)
FAL_API_KEY = os.getenv('FAL_API_KEY', '') or os.getenv('FAL_KEY', '')

# Replicate Configuration (Image/Video Generation)
REPLICATE_API_TOKEN = os.getenv('REPLICATE_API_TOKEN', '') or os.getenv('REPLICATE_API_KEY', '')

# Agent Engine 配置（W11 命名迁移 → AGENT_ENGINE_*；过渡期兼容 ORCHESTRATION_*
# 详见 docs/agent-runtime/agent-engine-env-rename-migration.md）
# `agent_engine_env` helper：新名优先、legacy 名兜底、命中 legacy 时发 DeprecationWarning。
from apps.services.agent_engine.legacy_env import (  # noqa: E402
    agent_engine_env as _agent_engine_env,
    alias_legacy_setting_names as _alias_legacy_setting_names,
)

# Agent Engine LiteLLM provider 映射（用于 provider_key 与 LiteLLM provider 名解耦）
AGENT_ENGINE_LITELLM_PROVIDER_ALIASES = _agent_engine_env(
    'AGENT_ENGINE_LITELLM_PROVIDER_ALIASES',
    '{"qwen":"dashscope","claude":"anthropic"}',
)
SEARCH_DEFAULT_PROVIDER = os.getenv('SEARCH_DEFAULT_PROVIDER', 'qianfan')
SEARCH_DEFAULT_COUNT = int(os.getenv('SEARCH_DEFAULT_COUNT', '8'))
SEARCH_DEFAULT_SUMMARY_ENABLED = os.getenv('SEARCH_DEFAULT_SUMMARY_ENABLED', 'True').lower() == 'true'
SEARCH_DEFAULT_FRESHNESS = os.getenv('SEARCH_DEFAULT_FRESHNESS', 'noLimit')
SEARCH_REQUEST_TIMEOUT_SEC = int(os.getenv('SEARCH_REQUEST_TIMEOUT_SEC', '30'))
BOCHA_API_KEY = os.getenv('BOCHA_API_KEY', '')
BOCHA_SEARCH_BASE_URL = os.getenv('BOCHA_SEARCH_BASE_URL', 'https://api.bocha.cn/v1/web-search')
QIANFAN_API_KEY = os.getenv('QIANFAN_API_KEY', '')
QIANFAN_SEARCH_BASE_URL = os.getenv(
    'QIANFAN_SEARCH_BASE_URL',
    'https://qianfan.baidubce.com/v2/ai_search/web_search',
)
DOUBAO_SEARCH_API_KEY = os.getenv('DOUBAO_SEARCH_API_KEY', '')
DOUBAO_SEARCH_BASE_URL = os.getenv(
    'DOUBAO_SEARCH_BASE_URL',
    'https://open.feedcoopapi.com/search_api/web_search',
)
# 子 Agent 结果压缩阈值
AGENT_ENGINE_COMPRESSOR_MAX_CHARS = int(
    _agent_engine_env('AGENT_ENGINE_COMPRESSOR_MAX_CHARS', '3000')
)
AGENT_ENGINE_COMPRESSOR_MAX_INPUT_CHARS = int(
    _agent_engine_env('AGENT_ENGINE_COMPRESSOR_MAX_INPUT_CHARS', '20000')
)

# HITL (Human-in-the-Loop) 批准超时（秒），默认 15 分钟。超过此时间的批准将失效，需要用户重新审批。
HITL_APPROVAL_TTL_SECONDS = int(os.getenv('HITL_APPROVAL_TTL_SECONDS', '900'))

# Prompt Caching 开关
AGENT_ENGINE_PROMPT_CACHE_ENABLED = (
    _agent_engine_env('AGENT_ENGINE_PROMPT_CACHE_ENABLED', 'False').lower() == 'true'
)
AGENT_ENGINE_PROMPT_CACHE_KEY_SCOPE = _agent_engine_env(
    'AGENT_ENGINE_PROMPT_CACHE_KEY_SCOPE', 'thread',
)
_PROMPT_CACHE_RETENTION_RAW = _agent_engine_env(
    'AGENT_ENGINE_PROMPT_CACHE_RETENTION', '',
).strip()
AGENT_ENGINE_PROMPT_CACHE_RETENTION = _PROMPT_CACHE_RETENTION_RAW or None

# Legacy 别名：任意老代码 `settings.ORCHESTRATION_*` 仍可读到与新名一致的值。
# Wave 13 移除 legacy 支持时，一并删除本段。
_alias_legacy_setting_names(globals(), pairs=[
    ('AGENT_ENGINE_LITELLM_PROVIDER_ALIASES', 'ORCHESTRATION_LITELLM_PROVIDER_ALIASES'),
    ('AGENT_ENGINE_COMPRESSOR_MAX_CHARS', 'ORCHESTRATION_COMPRESSOR_MAX_CHARS'),
    ('AGENT_ENGINE_COMPRESSOR_MAX_INPUT_CHARS', 'ORCHESTRATION_COMPRESSOR_MAX_INPUT_CHARS'),
    ('AGENT_ENGINE_PROMPT_CACHE_ENABLED', 'ORCHESTRATION_PROMPT_CACHE_ENABLED'),
    ('AGENT_ENGINE_PROMPT_CACHE_KEY_SCOPE', 'ORCHESTRATION_PROMPT_CACHE_KEY_SCOPE'),
    ('AGENT_ENGINE_PROMPT_CACHE_RETENTION', 'ORCHESTRATION_PROMPT_CACHE_RETENTION'),
])

# LLM API 默认缓存策略（仅当请求未显式传入时可用于后续扩展）
_LLM_PROMPT_CACHE_DEFAULT_RETENTION_RAW = os.getenv('LLM_PROMPT_CACHE_DEFAULT_RETENTION', '').strip()
LLM_PROMPT_CACHE_DEFAULT_RETENTION = _LLM_PROMPT_CACHE_DEFAULT_RETENTION_RAW or None

# Services Configuration
if IS_COMMUNITY_EDITION:
    SERVICES_SMS_PROVIDER = os.getenv('SERVICES_SMS_PROVIDER', '').strip() or 'disabled'
    SERVICES_EMAIL_PROVIDER = os.getenv('SERVICES_EMAIL_PROVIDER', '').strip() or 'disabled'
else:
    SERVICES_SMS_PROVIDER = os.getenv('SERVICES_SMS_PROVIDER', 'aliyun')
    SERVICES_EMAIL_PROVIDER = os.getenv('SERVICES_EMAIL_PROVIDER', 'tencent')
SERVICES_ASYNC_ENABLED = os.getenv('SERVICES_ASYNC_ENABLED', 'True').lower() == 'true'

# Aliyun SMS Configuration
ALIYUN_USE_ECS_ROLE = os.getenv('ALIYUN_USE_ECS_ROLE', 'True').lower() == 'true'
ALIYUN_ECS_ROLE_NAME = os.getenv('ALIYUN_ECS_ROLE_NAME', '')  # ECS角色名称
ALIYUN_ACCESS_KEY_ID = os.getenv('ALIYUN_ACCESS_KEY_ID')
ALIYUN_ACCESS_KEY_SECRET = os.getenv('ALIYUN_ACCESS_KEY_SECRET')
ALIYUN_SECURITY_TOKEN = os.getenv('ALIYUN_SECURITY_TOKEN')
ALIYUN_SMS_REGION = os.getenv('ALIYUN_SMS_REGION', 'cn-hangzhou')
ALIYUN_SMS_SIGN_NAME = os.getenv('ALIYUN_SMS_SIGN_NAME', '')
ALIYUN_SMS_TEMPLATE_CODE = os.getenv('ALIYUN_SMS_TEMPLATE_CODE', '')
# SMS 专用密钥（可选）：未设置时回退到全局 ALIYUN_ACCESS_KEY_ID/SECRET。
# 用途：当短信签名走独立的阿里云子账号时（不与 OSS 同账号），用这两个变量隔离。
ALIYUN_SMS_ACCESS_KEY_ID = os.getenv('ALIYUN_SMS_ACCESS_KEY_ID')
ALIYUN_SMS_ACCESS_KEY_SECRET = os.getenv('ALIYUN_SMS_ACCESS_KEY_SECRET')

# OSS Configuration
# 本地原生 dev 默认走文件系统 provider，避免新环境上传文件时强依赖阿里云 AK/OSS。
# deploy 也可显式选择 aliyun；选择后配置不完整会 fail-fast，不回退 local。
_DEFAULT_SERVICES_OSS_PROVIDER = 'local' if (DEBUG or IS_COMMUNITY_EDITION) else 'aliyun'
SERVICES_OSS_PROVIDER = (
    os.getenv('SERVICES_OSS_PROVIDER', '').strip() or 'local'
    if IS_COMMUNITY_EDITION
    else os.getenv('SERVICES_OSS_PROVIDER', _DEFAULT_SERVICES_OSS_PROVIDER)
)
if IS_COMMUNITY_EDITION and SERVICES_OSS_PROVIDER != 'local':
    raise ImproperlyConfigured(
        'Community edition supports the local storage provider only'
    )
SERVICES_OSS_ASYNC_ENABLED = os.getenv('SERVICES_OSS_ASYNC_ENABLED', 'True').lower() == 'true'
# 分阶段私有化门禁：新客户端均按 file_id 刷新地址、共享会话 ACL 回归通过后开启。
# 默认保持 False，避免已发布旧移动端的历史图片在签名 URL 过期后失效。
MEDIA_GENERATION_PRIVATE_OSS_ENABLED = (
    os.getenv('MEDIA_GENERATION_PRIVATE_OSS_ENABLED', 'False').lower() == 'true'
)

LOCAL_OSS_BUCKET_NAME = os.getenv('LOCAL_OSS_BUCKET_NAME', 'tabtin-local-dev')
_LOCAL_OSS_ROOT_RAW = os.getenv('LOCAL_OSS_ROOT', 'apps/tabtin_django/local-oss')
LOCAL_OSS_ROOT = str(
    Path(_LOCAL_OSS_ROOT_RAW).expanduser()
    if Path(_LOCAL_OSS_ROOT_RAW).expanduser().is_absolute()
    else PROJECT_ROOT / _LOCAL_OSS_ROOT_RAW
)
# 面向 Electron / 移动端的统一公开入口。生产 local provider 必须配置成客户端
# 实际可达的 LAN HTTP 地址或云端 HTTPS 域名，不能使用容器 DNS/内部端口。
TABTIN_PUBLIC_BASE_URL = _edition_endpoint(
    'TABTIN_PUBLIC_BASE_URL',
    saas_default=os.getenv('SOURCEMAP_API_URL', 'http://127.0.0.1:6060'),
    community_default='http://127.0.0.1:6060',
).rstrip('/')
LOCAL_OSS_PUBLIC_BASE_URL = (
    f"{TABTIN_PUBLIC_BASE_URL}/api/services/oss/local-object"
)
LOCAL_OSS_UPLOAD_BASE_URL = (
    f"{TABTIN_PUBLIC_BASE_URL}/api/services/oss/local-upload"
)

ALIYUN_OSS_REGION = '' if IS_COMMUNITY_EDITION else os.getenv('ALIYUN_OSS_REGION', 'oss-cn-wuhan-lr')
ALIYUN_OSS_BUCKET_NAME = '' if IS_COMMUNITY_EDITION else os.getenv('ALIYUN_OSS_BUCKET_NAME', 'example-assets')
ALIYUN_OSS_ENDPOINT = '' if IS_COMMUNITY_EDITION else os.getenv('ALIYUN_OSS_ENDPOINT', 'oss-cn-wuhan-lr.aliyuncs.com')
ALIYUN_OSS_USE_INTERNAL = (
    False
    if IS_COMMUNITY_EDITION
    else os.getenv('ALIYUN_OSS_USE_INTERNAL', '').lower() == 'true'
)
ALIYUN_OSS_INTERNAL_ENDPOINT = (
    os.getenv('ALIYUN_OSS_INTERNAL_ENDPOINT')
    if ALIYUN_OSS_USE_INTERNAL
    else ''
)
ALIYUN_OSS_CDN_DOMAIN = '' if IS_COMMUNITY_EDITION else os.getenv('ALIYUN_OSS_CDN_DOMAIN', '')
ASSET_PUBLIC_DOMAIN = os.getenv('ASSET_PUBLIC_DOMAIN', ALIYUN_OSS_CDN_DOMAIN)
ALIYUN_OSS_ACCESS_MODE = os.getenv('ALIYUN_OSS_ACCESS_MODE', 'public-read')

# Updater OSS Configuration
#
# 桌面更新包/manifest/blockmap 可使用独立 OSS/CDN，避免图片资产迁桶时影响更新通道。
# 未配置 UPDATER_* 时保持兼容：回退到通用 OSS 配置。
UPDATER_OSS_REGION = '' if IS_COMMUNITY_EDITION else os.getenv('UPDATER_OSS_REGION', ALIYUN_OSS_REGION)
UPDATER_OSS_BUCKET_NAME = '' if IS_COMMUNITY_EDITION else os.getenv('UPDATER_OSS_BUCKET_NAME', ALIYUN_OSS_BUCKET_NAME)
UPDATER_OSS_ENDPOINT = '' if IS_COMMUNITY_EDITION else os.getenv('UPDATER_OSS_ENDPOINT', ALIYUN_OSS_ENDPOINT)
UPDATER_OSS_USE_INTERNAL = (
    False
    if IS_COMMUNITY_EDITION
    else os.getenv(
        'UPDATER_OSS_USE_INTERNAL', str(ALIYUN_OSS_USE_INTERNAL)
    ).lower() == 'true'
)
UPDATER_OSS_INTERNAL_ENDPOINT = (
    os.getenv('UPDATER_OSS_INTERNAL_ENDPOINT', ALIYUN_OSS_INTERNAL_ENDPOINT)
    if UPDATER_OSS_USE_INTERNAL
    else ''
)
UPDATER_OSS_CDN_DOMAIN = '' if IS_COMMUNITY_EDITION else os.getenv('UPDATER_OSS_CDN_DOMAIN', ALIYUN_OSS_CDN_DOMAIN)
UPDATER_OSS_ACCESS_MODE = os.getenv('UPDATER_OSS_ACCESS_MODE', ALIYUN_OSS_ACCESS_MODE)
UPDATER_ALIYUN_ACCESS_KEY_ID = '' if IS_COMMUNITY_EDITION else os.getenv('UPDATER_ALIYUN_ACCESS_KEY_ID', ALIYUN_ACCESS_KEY_ID)
UPDATER_ALIYUN_ACCESS_KEY_SECRET = '' if IS_COMMUNITY_EDITION else os.getenv('UPDATER_ALIYUN_ACCESS_KEY_SECRET', ALIYUN_ACCESS_KEY_SECRET)
UPDATER_ALIYUN_SECURITY_TOKEN = '' if IS_COMMUNITY_EDITION else os.getenv('UPDATER_ALIYUN_SECURITY_TOKEN', ALIYUN_SECURITY_TOKEN)

# 桌面更新 CDN 刷新/预热：mock（默认，不调阿里云）| aliyun
UPDATER_CDN_OPS_MODE = (
    'mock'
    if IS_COMMUNITY_EDITION
    else os.getenv('UPDATER_CDN_OPS_MODE', 'mock').strip().lower()
)
UPDATER_CDN_ACCESS_KEY_ID = os.getenv('UPDATER_CDN_ACCESS_KEY_ID', UPDATER_ALIYUN_ACCESS_KEY_ID)
UPDATER_CDN_ACCESS_KEY_SECRET = os.getenv('UPDATER_CDN_ACCESS_KEY_SECRET', UPDATER_ALIYUN_ACCESS_KEY_SECRET)
UPDATER_CDN_ENDPOINT = '' if IS_COMMUNITY_EDITION else os.getenv('UPDATER_CDN_ENDPOINT', 'https://cdn.aliyuncs.com/')
# 可选：覆盖默认短链 slug，逗号项如 win-x64=win-x64,mac-arm64=mac-arm64
UPDATER_SHORT_LINK_SLUG_MAP = {}
for _slug_pair in (os.getenv('UPDATER_SHORT_LINK_SLUG_MAP', '') or '').split(','):
    _slug_pair = _slug_pair.strip()
    if '=' in _slug_pair:
        _slug_key, _slug_val = _slug_pair.split('=', 1)
        if _slug_key.strip() and _slug_val.strip():
            UPDATER_SHORT_LINK_SLUG_MAP[_slug_key.strip()] = _slug_val.strip()
PUBLIC_API_BASE_URL = os.getenv('PUBLIC_API_BASE_URL', os.getenv('API_BASE_URL', ''))

# 文件上传配置
OSS_MAX_FILE_SIZE = int(os.getenv('OSS_MAX_FILE_SIZE', '209715200'))  # 200MB
OSS_ALLOWED_EXTENSIONS = os.getenv(
    'OSS_ALLOWED_EXTENSIONS',
    'jpg,jpeg,jfif,png,gif,webp,bmp,avif,apng,svg,heic,heif,'
    'pdf,doc,docx,xls,xlsx,ppt,pptx,txt,csv,md,markdown,mark,json,html,htm,zip,'
    'mp4,webm,mov,avi,mp3,wav,ogg,aac,flac,tiff,tif'
).split(',')
OSS_CHUNK_SIZE = int(os.getenv('OSS_CHUNK_SIZE', '5242880'))  # 5MB
OSS_MAX_CHUNKS = int(os.getenv('OSS_MAX_CHUNKS', '1000'))

# -------------------------------------------------------------------
# AWS SES (TabMail V2)
# -------------------------------------------------------------------
AWS_ACCESS_KEY_ID = os.getenv('AWS_ACCESS_KEY_ID', '')
AWS_SECRET_ACCESS_KEY = os.getenv('AWS_SECRET_ACCESS_KEY', '')
AWS_SES_REGION = os.getenv('AWS_SES_REGION', 'us-east-1')
AWS_SES_CONFIGURATION_SET = os.getenv('AWS_SES_CONFIGURATION_SET', '')
AWS_SNS_INBOUND_TOPIC_ARN = os.getenv('AWS_SNS_INBOUND_TOPIC_ARN', '')
AWS_S3_SES_BUCKET = os.getenv('AWS_S3_SES_BUCKET', '')

# -------------------------------------------------------------------
# 统一上传预设 — 后端 Single Source of Truth, 三端通过 API 拉取
# 每个 preset 定义该场景的 MIME 白名单和大小上限（字节）。
# accept=null 表示不限制类型。
# -------------------------------------------------------------------
_MB = 1024 * 1024
OSS_UPLOAD_PRESETS = {
    'IMAGE': {
        'maxSize': 20 * _MB,
        'accept': [
            'image/jpeg', 'image/jpg', 'image/png', 'image/gif',
            'image/webp', 'image/bmp', 'image/x-ms-bmp', 'image/avif',
            'image/apng', 'image/svg+xml', 'image/heic', 'image/heif',
            'image/tiff',
        ],
    },
    'FILE': {
        'maxSize': 50 * _MB,
        'accept': None,
    },
    'MEDIA': {
        'maxSize': 200 * _MB,
        'accept': [
            'video/mp4', 'video/webm', 'video/quicktime', 'video/ogg', 'video/x-msvideo',
            'audio/mpeg', 'audio/wav', 'audio/mp3', 'audio/ogg', 'audio/webm',
            'audio/aac', 'audio/flac',
        ],
    },
    'ATTACHMENT': {
        'maxSize': 100 * _MB,
        'accept': None,
    },
    'DOCUMENT': {
        'maxSize': 50 * _MB,
        'accept': [
            'application/pdf',
            'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/vnd.ms-excel',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'application/vnd.ms-powerpoint',
            'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            'text/plain', 'text/csv', 'text/markdown', 'text/x-markdown',
            'application/json', 'text/html', 'application/xhtml+xml',
        ],
    },
}

# MIME → 扩展名映射，供 presign 校验 content_type ↔ extension 一致性
OSS_MIME_TO_EXTENSIONS: dict[str, list[str]] = {
    'image/jpeg': ['jpg', 'jpeg', 'jfif'],
    'image/jpg': ['jpg', 'jpeg', 'jfif'],
    'image/png': ['png'],
    'image/apng': ['apng'],
    'image/gif': ['gif'],
    'image/webp': ['webp'],
    'image/bmp': ['bmp'],
    'image/x-ms-bmp': ['bmp'],
    'image/avif': ['avif'],
    'image/svg+xml': ['svg'],
    'image/heic': ['heic'],
    'image/heif': ['heif'],
    'application/pdf': ['pdf'],
    'application/msword': ['doc'],
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx'],
    'application/vnd.ms-excel': ['xls'],
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['xlsx'],
    'application/vnd.ms-powerpoint': ['ppt'],
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['pptx'],
    'text/plain': ['txt'],
    'text/csv': ['csv'],
    'text/markdown': ['md', 'markdown', 'mark'],
    'text/x-markdown': ['md', 'markdown', 'mark'],
    'text/html': ['html', 'htm'],
    'application/xhtml+xml': ['xhtml', 'html', 'htm'],
    'application/json': ['json'],
    'video/mp4': ['mp4'],
    'video/webm': ['webm'],
    'video/quicktime': ['mov'],
    'audio/mpeg': ['mp3'],
    'audio/wav': ['wav'],
    'audio/mp3': ['mp3'],
    'audio/ogg': ['ogg'],
    'audio/webm': ['webm'],
    'application/zip': ['zip'],
    'application/x-zip-compressed': ['zip'],
    'image/tiff': ['tiff', 'tif'],
    'audio/aac': ['aac'],
    'audio/flac': ['flac'],
    'video/ogg': ['ogg', 'ogv'],
    'video/x-msvideo': ['avi'],
}

# 图片处理配置
OSS_IMAGE_QUALITY = int(os.getenv('OSS_IMAGE_QUALITY', '85'))
OSS_IMAGE_MAX_WIDTH = int(os.getenv('OSS_IMAGE_MAX_WIDTH', '2048'))
OSS_IMAGE_MAX_HEIGHT = int(os.getenv('OSS_IMAGE_MAX_HEIGHT', '2048'))
OSS_WATERMARK_ENABLED = os.getenv('OSS_WATERMARK_ENABLED', 'False').lower() == 'true'
OSS_WATERMARK_TEXT = os.getenv('OSS_WATERMARK_TEXT', 'Tabtin')

# ByteDance Speech Services (ASR/TTS) Configuration
# v0.1.x：ASR/TTS 凭证统一走 DB（AdminDash 配置 bytedance Provider 的 capabilities_config）。
# 旧 env 变量仅保留 admin_api 旁路视图（"settings 来源" 展示）使用；
# 业务路径（apps.services.speech.{asr,tts}.factory）已删除 settings fallback。
BYTEDANCE_ASR_APP_ID = os.getenv('BYTEDANCE_ASR_APP_ID', '')
BYTEDANCE_ASR_ACCESS_TOKEN = os.getenv('BYTEDANCE_ASR_ACCESS_TOKEN', '')
BYTEDANCE_ASR_SECRET_KEY = os.getenv('BYTEDANCE_ASR_SECRET_KEY', '')

BYTEDANCE_TTS_APP_ID = os.getenv('BYTEDANCE_TTS_APP_ID', BYTEDANCE_ASR_APP_ID)
BYTEDANCE_TTS_ACCESS_TOKEN = os.getenv('BYTEDANCE_TTS_ACCESS_TOKEN', BYTEDANCE_ASR_ACCESS_TOKEN)
BYTEDANCE_TTS_RESOURCE_ID = os.getenv('BYTEDANCE_TTS_RESOURCE_ID', 'seed-tts-2.0')
BYTEDANCE_TTS_DEFAULT_SPEAKER = os.getenv('BYTEDANCE_TTS_DEFAULT_SPEAKER', 'zh_female_vv_uranus_bigtts')

# Freesound API (音效搜索代理)
FREESOUND_API_KEY = os.getenv('FREESOUND_API_KEY', '')

# Email Configuration
COMPANY_NAME = os.getenv('COMPANY_NAME', 'TabTin')
if IS_COMMUNITY_EDITION:
    EMAIL_BACKEND = (
        os.getenv('EMAIL_BACKEND', '').strip()
        or 'django.core.mail.backends.console.EmailBackend'
    )
    EMAIL_HOST = os.getenv('EMAIL_HOST', '').strip()
else:
    EMAIL_BACKEND = os.getenv(
        'EMAIL_BACKEND', 'django.core.mail.backends.smtp.EmailBackend'
    )
    EMAIL_HOST = os.getenv('EMAIL_HOST', 'smtp.exmail.qq.com')
EMAIL_PORT = int(os.getenv('EMAIL_PORT', '465'))
EMAIL_USE_SSL = os.getenv('EMAIL_USE_SSL', 'True').lower() == 'true'
EMAIL_HOST_USER = os.getenv('EMAIL_HOST_USER', '').strip()
EMAIL_HOST_PASSWORD = os.getenv('EMAIL_HOST_PASSWORD', '').strip()
EMAIL_PROVIDER_CONFIGURED = bool(
    EMAIL_HOST and EMAIL_HOST_USER and EMAIL_HOST_PASSWORD
)
DEFAULT_FROM_EMAIL = os.getenv('DEFAULT_FROM_EMAIL', EMAIL_HOST_USER)
EMAIL_TIMEOUT = int(os.getenv('EMAIL_TIMEOUT', '30'))

# Logging Configuration
_LOG_LEVEL = os.getenv('LOG_LEVEL', 'DEBUG' if DEBUG else 'INFO')

LOGGING = {
    'version': 1,
    'disable_existing_loggers': False,
    'filters': {
        'trace_context': {
            '()': 'apps.services.agent_engine.observability.log_context.TraceContextFilter',
        },
    },
    'formatters': {
        'verbose': {
            'format': '{levelname} {asctime} {module} {process:d} {thread:d} {message}',
            'style': '{',
        },
        'detailed': {
            'format': '{levelname} {asctime} [{name}] {message}',
            'style': '{',
        },
        'simple': {
            'format': '{levelname} {message}',
            'style': '{',
        },
        'chat': {
            'format': '{asctime} | {levelname:8s} | {message}',
            'style': '{',
            'datefmt': '%Y-%m-%d %H:%M:%S',
        },
        'agent_engine': {
            'format': '{levelname} {asctime} [{name}] [trace={trace_id} run={run_id}] {message}',
            'style': '{',
        },
    },
    'handlers': {
        'file': {
            'level': 'INFO',
            'class': 'logging.handlers.RotatingFileHandler',
            'filename': BASE_DIR / 'logs' / 'django.log',
            'formatter': 'detailed',
            'maxBytes': 50 * 1024 * 1024,
            'backupCount': 3,
        },
        'api_file': {
            'level': _LOG_LEVEL,
            'class': 'logging.handlers.RotatingFileHandler',
            'filename': BASE_DIR / 'logs' / 'api_requests.log',
            'formatter': 'detailed',
            'maxBytes': 20 * 1024 * 1024,
            'backupCount': 3,
        },
        'chat_file': {
            'level': _LOG_LEVEL,
            'class': 'logging.handlers.RotatingFileHandler',
            'filename': BASE_DIR / 'logs' / 'chat.log',
            'formatter': 'chat',
            'maxBytes': 20 * 1024 * 1024,
            'backupCount': 3,
        },
        'auth_file': {
            'level': _LOG_LEVEL,
            'class': 'logging.handlers.RotatingFileHandler',
            'filename': BASE_DIR / 'logs' / 'auth.log',
            'formatter': 'detailed',
            'maxBytes': 20 * 1024 * 1024,
            'backupCount': 3,
        },
        'services_file': {
            'level': _LOG_LEVEL,
            'class': 'logging.handlers.RotatingFileHandler',
            'filename': BASE_DIR / 'logs' / 'services.log',
            'formatter': 'detailed',
            'maxBytes': 20 * 1024 * 1024,
            'backupCount': 3,
        },
        'tabdata_file': {
            'level': _LOG_LEVEL,
            'class': 'logging.handlers.RotatingFileHandler',
            'filename': BASE_DIR / 'logs' / 'tabdata.log',
            'formatter': 'detailed',
            'maxBytes': 20 * 1024 * 1024,
            'backupCount': 3,
        },
        'polling_file': {
            'level': _LOG_LEVEL,
            'class': 'logging.handlers.RotatingFileHandler',
            'filename': BASE_DIR / 'logs' / 'polling.log',
            'formatter': 'detailed',
            'maxBytes': 20 * 1024 * 1024,
            'backupCount': 3,
        },
        'errors_file': {
            'level': 'WARNING',
            'class': 'logging.handlers.RotatingFileHandler',
            'filename': BASE_DIR / 'logs' / 'errors.log',
            'formatter': 'detailed',
            'maxBytes': 20 * 1024 * 1024,
            'backupCount': 3,
        },
        'agent_engine_file': {
            'level': _LOG_LEVEL,
            'class': 'logging.handlers.RotatingFileHandler',
            'filename': BASE_DIR / 'logs' / 'agent_engine.log',
            'formatter': 'agent_engine',
            'filters': ['trace_context'],
            'maxBytes': 50 * 1024 * 1024,
            'backupCount': 3,
        },
        'hitl_audit_file': {
            'level': 'INFO',
            'class': 'logging.handlers.RotatingFileHandler',
            'filename': BASE_DIR / 'logs' / 'hitl-audit.log',
            'formatter': 'detailed',
            'maxBytes': 20 * 1024 * 1024,
            'backupCount': 5,
        },
        'console': {
            'level': _LOG_LEVEL,
            'class': 'logging.StreamHandler',
            'formatter': 'simple',
        },
    },
    'root': {
        'handlers': ['console', 'file', 'errors_file'],
        'level': _LOG_LEVEL,
    },
    'loggers': {
        'django': {
            'handlers': ['console', 'file', 'errors_file'],
            'level': _LOG_LEVEL,
            'propagate': False,
        },
        'django.db.backends': {
            'handlers': ['console'],
            'level': 'WARNING',
            'propagate': False,
        },
        'django.template': {
            'level': 'INFO',
            'propagate': True,
        },
        # 外部扫描器/错配 nginx default_server 用 IP 当 Host 头打到 Django 时，
        # Django 正确拒绝并抛 DisallowedHost。这是预期防护行为，
        # 但默认 ERROR 级别会污染 errors.log 告警面。
        # 这里单独把它降到 WARNING：仍然落盘可观测，但不再触发 errors_file。
        'django.security.DisallowedHost': {
            'handlers': ['file'],
            'level': 'WARNING',
            'propagate': False,
        },
        'middleware': {
            'handlers': ['api_file'],
            'level': _LOG_LEVEL,
            'propagate': False,
        },
        'polling': {
            'handlers': ['polling_file'],
            'level': _LOG_LEVEL,
            'propagate': False,
        },
        'apps.services.common.middleware': {
            'handlers': ['api_file'],
            'level': _LOG_LEVEL,
            'propagate': False,
        },
        'apps.users.auth': {
            'handlers': ['auth_file', 'console'],
            'level': _LOG_LEVEL,
            'propagate': False,
        },
        'apps.users.auth.api': {
            'handlers': ['auth_file'],
            'level': _LOG_LEVEL,
            'propagate': False,
        },
        'apps.users.auth.services.verification_manager': {
            'handlers': ['auth_file'],
            'level': _LOG_LEVEL,
            'propagate': False,
        },
        'apps.users.auth.services.session_manager': {
            'handlers': ['auth_file'],
            'level': _LOG_LEVEL,
            'propagate': False,
        },
        'verification_manager': {
            'handlers': ['auth_file'],
            'level': _LOG_LEVEL,
            'propagate': False,
        },
        'session_manager': {
            'handlers': ['auth_file'],
            'level': _LOG_LEVEL,
            'propagate': False,
        },
        'api': {
            'handlers': ['auth_file'],
            'level': _LOG_LEVEL,
            'propagate': False,
        },
        'apps.services': {
            'handlers': ['services_file', 'console'],
            'level': _LOG_LEVEL,
            'propagate': False,
        },
        'apps.services.sms': {
            'handlers': ['services_file'],
            'level': _LOG_LEVEL,
            'propagate': False,
        },
        'apps.services.email': {
            'handlers': ['services_file'],
            'level': _LOG_LEVEL,
            'propagate': False,
        },
        'apps.services.oss': {
            'handlers': ['services_file'],
            'level': _LOG_LEVEL,
            'propagate': False,
        },
        'factory': {
            'handlers': ['services_file'],
            'level': _LOG_LEVEL,
            'propagate': False,
        },
        'aliyun_sms': {
            'handlers': ['services_file'],
            'level': _LOG_LEVEL,
            'propagate': False,
        },
        'base': {
            'handlers': ['services_file'],
            'level': _LOG_LEVEL,
            'propagate': False,
        },
        'apps.tabdata': {
            'handlers': ['tabdata_file', 'console'],
            'level': _LOG_LEVEL,
            'propagate': False,
        },
        'chat': {
            'handlers': ['chat_file'],
            'level': _LOG_LEVEL,
            'propagate': False,
        },
        'apps.chat': {
            'handlers': ['chat_file'],
            'level': _LOG_LEVEL,
            'propagate': False,
        },
        'apps.parse.middleware': {
            'handlers': ['api_file'],
            'level': _LOG_LEVEL,
            'propagate': False,
        },
        'apps.parse.schema_services': {
            'handlers': ['api_file'],
            'level': _LOG_LEVEL,
            'propagate': False,
        },
        'apps.parse': {
            'handlers': ['api_file'],
            'level': _LOG_LEVEL,
            'propagate': False,
        },
        # Agent 引擎日志统一走 agent_engine_file handler（绑定 TraceContextFilter
        # 注入 trace_id/run_id，formatter 'agent_engine' 引用这些字段）。声明父级
        # logger 即可按 Python logger 层级匹配所有子 logger。
        'apps.services.agent_engine': {
            'handlers': ['agent_engine_file'],
            'level': _LOG_LEVEL,
            'propagate': False,
        },
        # HITL 审计：既写专用审计文件，又并入 agent_engine_file 便于与其它
        # engine 日志按 trace_id 聚合排查。对应 hitl_security.py 的稳定 logger 名。
        'apps.services.agent_engine.hitl_audit': {
            'handlers': ['hitl_audit_file', 'agent_engine_file'],
            'level': 'INFO',
            'propagate': False,
        },
        # 工具权限审计 logger（对应 tool_permission_guard.py）
        'apps.services.agent_engine.permission.audit': {
            'handlers': ['agent_engine_file'],
            'level': 'INFO',
            'propagate': False,
        },
        'django.request': {
            'handlers': ['errors_file'],
            'level': 'WARNING',
            'propagate': False,
        },
        'log': {
            'handlers': ['errors_file'],
            'level': 'WARNING',
            'propagate': False,
        },
        'apps': {
            'handlers': ['console', 'file'],
            'level': _LOG_LEVEL,
            'propagate': False,
        },
        'daphne': {
            'level': 'INFO',
            'propagate': True,
        },
        'daphne.http_protocol': {
            'handlers': ['console'],
            'level': 'WARNING',
            'propagate': False,
        },
        'daphne.ws_protocol': {
            'handlers': ['console'],
            'level': 'WARNING',
            'propagate': False,
        },
        'urllib3': {
            'level': 'WARNING',
            'propagate': False,
        },
        'requests': {
            'level': 'WARNING',
            'propagate': False,
        },
        'boto3': {
            'level': 'WARNING',
            'propagate': False,
        },
        'botocore': {
            'level': 'WARNING',
            'propagate': False,
        },
        'parso': {
            'level': 'WARNING',
            'propagate': False,
        },
        'celery': {
            'level': 'INFO',
            'propagate': False,
        },
        'amqp': {
            'level': 'WARNING',
            'propagate': False,
        },
        'kombu': {
            'level': 'WARNING',
            'propagate': False,
        },
    },
}

# Multi-server deployment: redirect all file handlers to console via LOG_TO_FILE=false
if os.getenv('LOG_TO_FILE', 'true').lower() != 'true':
    _console_handler = LOGGING['handlers']['console']
    _file_handler_names = [
        name for name, cfg in LOGGING['handlers'].items()
        if cfg.get('class', '').endswith('FileHandler')
    ]
    for _name in _file_handler_names:
        LOGGING['handlers'][_name] = {**_console_handler, 'level': LOGGING['handlers'][_name].get('level', 'INFO')}
else:
    os.makedirs(BASE_DIR / 'logs', exist_ok=True)

# ===================================================================
# RAG (向量检索) Configuration
# ===================================================================

# RAG 模块开关
RAG_ENABLED = os.getenv('RAG_ENABLED', 'True').lower() == 'true'

# Embedding 配置

# 检索配置
RAG_DEFAULT_TOP_K = int(os.getenv('RAG_DEFAULT_TOP_K', '10'))  # 默认返回结果数
RAG_SIMILARITY_THRESHOLD = float(os.getenv('RAG_SIMILARITY_THRESHOLD', '0.7'))  # 相似度阈值
RAG_MAX_CONTEXT_TOKENS = int(os.getenv('RAG_MAX_CONTEXT_TOKENS', '4000'))  # 上下文最大 token 数

# 向量化策略
RAG_AUTO_EMBED_TABLES = os.getenv('RAG_AUTO_EMBED_TABLES', 'True').lower() == 'true'  # 表格创建时自动向量化
RAG_AUTO_EMBED_RECORDS = os.getenv('RAG_AUTO_EMBED_RECORDS', 'True').lower() == 'true'  # 记录创建时自动向量化
RAG_AUTO_EMBED_DOCUMENTS = os.getenv('RAG_AUTO_EMBED_DOCUMENTS', 'True').lower() == 'true'  # 文档变更时自动向量化
RAG_BATCH_SIZE = int(os.getenv('RAG_BATCH_SIZE', '50'))  # 批量处理大小

# 成本控制
RAG_MAX_TOKENS_PER_REQUEST = int(os.getenv('RAG_MAX_TOKENS_PER_REQUEST', '8000'))  # 单次 Embedding 最大 tokens
RAG_DAILY_QUOTA = int(os.getenv('RAG_DAILY_QUOTA', '1000000'))  # [预留] 每日最大 tokens 配额，当前未强制执行

# 监控告警阈值（SS-007：原硬编码值提取为可配置项）
RAG_MONITOR_FAILURE_RATE_THRESHOLD = float(os.getenv('RAG_MONITOR_FAILURE_RATE_THRESHOLD', '20'))  # 任务失败率告警阈值（%）
RAG_MONITOR_SLOW_QUERY_MS_THRESHOLD = int(os.getenv('RAG_MONITOR_SLOW_QUERY_MS_THRESHOLD', '1000'))  # 慢查询阈值（ms）
RAG_MONITOR_SLOW_QUERY_COUNT_THRESHOLD = int(os.getenv('RAG_MONITOR_SLOW_QUERY_COUNT_THRESHOLD', '10'))  # 1h 内慢查询次数告警阈值
RAG_MONITOR_ZERO_RESULTS_RATE_THRESHOLD = float(os.getenv('RAG_MONITOR_ZERO_RESULTS_RATE_THRESHOLD', '50'))  # 零结果率告警阈值（%）
RAG_MONITOR_COVERAGE_RATE_THRESHOLD = float(os.getenv('RAG_MONITOR_COVERAGE_RATE_THRESHOLD', '50'))  # 索引覆盖率最低阈值（%）

# 检索日志保留周期（SS-011：原硬编码 30 天提取为可配置项）
RAG_SEARCH_LOG_RETENTION_DAYS = int(os.getenv('RAG_SEARCH_LOG_RETENTION_DAYS', '30'))

# 异常告警 Webhook（SS-008：为空则不发送；支持飞书/企微/Slack 等通用 POST JSON 格式）
RAG_ALERT_WEBHOOK_URL = os.getenv('RAG_ALERT_WEBHOOK_URL', '')


# ===================================================================
# 客户端错误监控 Webhook 通知（为空则禁用）
# ===================================================================
CLIENT_ERROR_WEBHOOK_URL = os.environ.get("CLIENT_ERROR_WEBHOOK_URL", "")
# SourceMap 上传用的静态 API Key（CI/CD 使用，不依赖 JWT）
SOURCEMAP_UPLOAD_KEY = os.environ.get("SOURCEMAP_UPLOAD_KEY", "")

# ===================================================================
# Collab Live Configuration
# ===================================================================
COLLAB_LIVE_PORT = os.getenv("COLLAB_LIVE_PORT", "4100")
COLLAB_LIVE_URL = os.getenv("COLLAB_LIVE_URL") or f"http://localhost:{COLLAB_LIVE_PORT}"
COLLAB_LIVE_SECRET = os.getenv("COLLAB_LIVE_SECRET", "collab-live-dev-secret")


# ===================================================================
# Payment & Membership Configuration
# ===================================================================

# ========== 支付宝配置 ==========
ALIPAY_APP_ID = os.getenv("ALIPAY_APP_ID", "")

# 支付宝私钥文件路径（证书模式推荐）
ALIPAY_PRIVATE_KEY_PATH = os.getenv(
    "ALIPAY_PRIVATE_KEY_PATH",
    os.path.join(BASE_DIR, 'apps/services/payment/cert/alipay/rsa2048.txt')
)

# 支付宝证书文件路径（证书模式）
ALIPAY_APP_CERT_PATH = os.getenv(
    "ALIPAY_APP_CERT_PATH",
    os.path.join(BASE_DIR, 'apps/services/payment/cert/alipay/appCertPublicKey_2021006112676216.crt')
)
ALIPAY_ROOT_CERT_PATH = os.getenv(
    "ALIPAY_ROOT_CERT_PATH",
    os.path.join(BASE_DIR, 'apps/services/payment/cert/alipay/alipayRootCert.crt')
)
ALIPAY_ALIPAY_CERT_PATH = os.getenv(
    "ALIPAY_ALIPAY_CERT_PATH",
    os.path.join(BASE_DIR, 'apps/services/payment/cert/alipay/alipayCertPublicKey_RSA2.crt')
)

ALIPAY_GATEWAY = os.getenv("ALIPAY_GATEWAY", "https://openapi.alipay.com/gateway.do")
ALIPAY_NOTIFY_URL = os.getenv("ALIPAY_NOTIFY_URL", "")
ALIPAY_RETURN_URL = os.getenv("ALIPAY_RETURN_URL", "")

# ========== 微信支付配置 ==========
WECHAT_APP_ID = os.getenv("WECHAT_APP_ID", "")
WECHAT_MCH_ID = os.getenv("WECHAT_MCH_ID", "")

# 微信支付私钥文件路径（推荐使用文件路径方式）
WECHAT_PRIVATE_KEY_PATH = os.getenv(
    "WECHAT_PRIVATE_KEY_PATH",
    os.path.join(BASE_DIR, 'apps/services/payment/cert/wechat/1732765815_20251121_cert/apiclient_key.pem')
)

WECHAT_CERT_SERIAL_NO = os.getenv("WECHAT_CERT_SERIAL_NO", "")
WECHAT_APIV3_KEY = os.getenv("WECHAT_APIV3_KEY", "")
WECHAT_NOTIFY_URL = os.getenv("WECHAT_NOTIFY_URL", "")
WECHAT_REFUND_NOTIFY_URL = os.getenv("WECHAT_REFUND_NOTIFY_URL", "")
WECHAT_PLATFORM_CERT_DIR = os.getenv(
    "WECHAT_PLATFORM_CERT_DIR",
    os.path.join(BASE_DIR, 'apps/services/payment/cert/wechat/platform')
)
WECHAT_PLATFORM_PUBLIC_KEY_PATH = os.getenv("WECHAT_PLATFORM_PUBLIC_KEY_PATH", "")
WECHAT_PLATFORM_PUBLIC_KEY_ID = os.getenv("WECHAT_PLATFORM_PUBLIC_KEY_ID", "")

# ========== 点券配置 ==========
CREDITS_PER_YUAN = int(os.getenv("CREDITS_PER_YUAN", "100"))  # 1元 = 100点券

# ========== 订单配置 ==========
ORDER_EXPIRE_MINUTES = int(os.getenv("ORDER_EXPIRE_MINUTES", "15"))  # 订单过期时间（分钟）

# PAY-24: 支付回调 IP 白名单（应用层纵深防御）
# 生产环境建议启用，DEBUG 模式自动放行 localhost/内网 IP
PAYMENT_CALLBACK_IP_WHITELIST_ENABLED = os.getenv("PAYMENT_CALLBACK_IP_WHITELIST_ENABLED", "true").lower() == "true"
# 是否信任反向代理传入的 X-Forwarded-For / X-Real-IP 头。
# ⚠️ 安全关键：如果 Django 直接暴露在公网（无 Nginx/LB 前置），必须设为 False，
# 否则攻击者可以伪造 X-Forwarded-For 头绕过 IP 白名单。
# 本地 ngrok 调试时建议设为 False（使用 REMOTE_ADDR 即 127.0.0.1，DEBUG 模式自动放行）。
PAYMENT_CALLBACK_TRUST_PROXY = os.getenv("PAYMENT_CALLBACK_TRUST_PROXY", "true").lower() == "true"
# 额外允许的 IP 段（如自定义代理、测试环境的公网 IP），逗号分隔 CIDR
# 注意：修改环境变量后需重启进程才能生效（模块级缓存）
PAYMENT_CALLBACK_EXTRA_ALLOWED_IPS = [
    ip.strip() for ip in os.getenv("PAYMENT_CALLBACK_EXTRA_ALLOWED_IPS", "").split(",") if ip.strip()
]

# 测试环境联调支付回调时可临时允许客户端传入小额测试金额；生产默认关闭。
PAYMENT_ALLOW_CLIENT_TEST_AMOUNT = os.getenv("PAYMENT_ALLOW_CLIENT_TEST_AMOUNT", "false").lower() == "true"

# ===================================================================
# 启动时安全校验（非 DEBUG、非测试环境）
# ===================================================================
if not DEBUG and not RUNNING_TESTS:
    _KNOWN_WEAK_SECRETS = {
        'SECRET_KEY': 'django-insecure-change-me-in-production',
    }
    for _cfg_name, _weak_val in _KNOWN_WEAK_SECRETS.items():
        if locals().get(_cfg_name) == _weak_val:
            raise ImproperlyConfigured(
                f"生产环境禁止使用默认弱密钥: {_cfg_name}，请配置安全的随机密钥"
            )

# ===================================================================
# dev_only：进宝 Echo Bot 开关
# -------------------------------------------------------------------
# 启用后 apps.services.jinbao.apps.JinbaoConfig.ready() 注册：
#   - organization post_save → 自动加进宝
#   - tabchat message_created → 触发 Celery echo task
# 关闭时（默认）完全不注册 signals，运行时 zero overhead。
# 生产环境禁止开启；下方 production guard 强制 fail-fast 兜底。
# ===================================================================
ENABLE_JINBAO_BOT = os.environ.get('ENABLE_JINBAO_BOT', '').strip().lower() in (
    '1', 'true', 'yes', 'on',
)
if not DEBUG and not RUNNING_TESTS and ENABLE_JINBAO_BOT:
    raise ImproperlyConfigured(
        "生产环境禁止启用 ENABLE_JINBAO_BOT（dev_only Echo Bot）。"
        "如果你看到这条错误，说明 .env 模板被误推到生产。"
    )
# 测试模式下强制关闭：避免 .env 里 ENABLE_JINBAO_BOT=true 让 jinbao signals
# 被默认 import → 其他 tabchat 测试在 organization 创建 / message 发送时被顺手
# ensure_jinbao_user，污染测试隔离。jinbao 自己的测试通过显式 import signals
# 模块在 setUp 内激活。
if RUNNING_TESTS:
    ENABLE_JINBAO_BOT = False

# ===================================================================
# 发布期能力开关：Project / team_space
# -------------------------------------------------------------------
# release/0.1.0 先不对客开放多人协作 Project。本地 DEBUG / 单测默认打开；
# 托管环境需显式 TABTIN_ENABLE_PROJECTS=true；
# 正式环境保持关闭，除非单独灰度。
# ===================================================================
TABTIN_ENABLE_PROJECTS = os.environ.get(
    'TABTIN_ENABLE_PROJECTS',
    'true' if DEBUG or RUNNING_TESTS else 'false',
).strip().lower() in ('1', 'true', 'yes', 'on')

# ========== 生产环境安全加固 ==========
# BI-10: 生产环境默认开启 HTTPS 安全加固（SSL 重定向、HSTS、Secure Cookie）。
# 若负载均衡器尚未配置 HTTPS 终止，需显式设置 ENABLE_HTTPS_SECURITY=false 关闭，
# 否则 SECURE_SSL_REDIRECT 会导致 301 重定向循环。
if not DEBUG and os.getenv('ENABLE_HTTPS_SECURITY', 'true').lower() == 'true':
    SECURE_SSL_REDIRECT = True
    SECURE_HSTS_SECONDS = 31536000
    SECURE_HSTS_INCLUDE_SUBDOMAINS = True
    SESSION_COOKIE_SECURE = True
    CSRF_COOKIE_SECURE = True
    SECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https')


# ===================================================================
# FTS 统一搜索引擎配置（PRD 2026-04-16 unified-search-engine）
# ===================================================================
#
# 生产：阿里云 Elasticsearch 8.x 托管服务（ADR-01）
# 本地：docker-compose.search.yml 起的 ES 8.x + analysis-icu（ADR-15）
#
# 命名选择：本项目统一用 `SEARCH_ES_*` 而非 `OPENSEARCH_*`，因为生产是 ES；
# 总控 ADR-02 澄清 `apps/fts` 命名与引擎解耦，所有配置走 ES 语义。

# 主开关（ADR-12）：默认 false，flag 关闭时 client/API 全部不工作，
# 保证 Wave 0~4 期间存量搜索路径不受影响；整批上线时通过环境变量切 true。
SEARCH_ENGINE_ENABLED = os.getenv('SEARCH_ENGINE_ENABLED', 'false').lower() == 'true'

# ES 连接（逗号分隔多节点；阿里云 ES 通常给出 HTTPS VPC 地址）
SEARCH_ES_HOSTS = [
    h.strip() for h in os.getenv('SEARCH_ES_HOSTS', 'http://localhost:9200').split(',')
    if h.strip()
]
# Basic Auth（阿里云 ES 托管实例必用；本地开发默认禁用 xpack 无需认证）
SEARCH_ES_HTTP_AUTH = (
    os.getenv('SEARCH_ES_USER', ''),
    os.getenv('SEARCH_ES_PASSWORD', ''),
)
# TLS 证书校验（本地 HTTP 可关闭；生产 HTTPS 必须开启）
SEARCH_ES_VERIFY_CERTS = os.getenv('SEARCH_ES_VERIFY_CERTS', 'true').lower() == 'true'
# 阿里云 ES 产品探测规避（阿里云 ES 返回自定义 product header 会让
# elasticsearch-py 抛 UnsupportedProductError；设为 true 时注入
# `x-elastic-product: Elasticsearch` 自定义头，使 client 跳过校验）。
# 本地镜像是官方 docker.elastic.co/elasticsearch，不需要此补丁；
# 生产阿里云 ES 必开。默认 false 要求 SRE 显式在阿里云环境打开，
# 避免本地/生产行为被静默掩盖（Review C4）。
SEARCH_ES_DISABLE_PRODUCT_CHECK = os.getenv(
    'SEARCH_ES_DISABLE_PRODUCT_CHECK', 'false',
).lower() == 'true'

# 索引前缀（多环境隔离：CI 可设 `tabtin-ci`，预发可设 `tabtin-stg`）
SEARCH_INDEX_PREFIX = os.getenv('SEARCH_INDEX_PREFIX', 'tabtin')

# 超时预算（秒 / 毫秒，PRD 4.6 / 4.8）
SEARCH_ES_TIMEOUT = int(os.getenv('SEARCH_ES_TIMEOUT', '5'))
SEARCH_ES_SEARCH_TIMEOUT_MS = int(os.getenv('SEARCH_ES_SEARCH_TIMEOUT_MS', '500'))

# Bulk Buffer 参数（Wave 1 使用，PRD 4.3.C）
SEARCH_INDEX_BUFFER_FLUSH_MS = int(os.getenv('SEARCH_INDEX_BUFFER_FLUSH_MS', '500'))
SEARCH_INDEX_BUFFER_MAX_BATCH = int(os.getenv('SEARCH_INDEX_BUFFER_MAX_BATCH', '100'))

# Circuit Breaker（PRD 4.8.A）
FTS_BREAKER_FAIL_MAX = int(os.getenv('FTS_BREAKER_FAIL_MAX', '5'))
FTS_BREAKER_RESET_TIMEOUT = int(os.getenv('FTS_BREAKER_RESET_TIMEOUT', '30'))
# Wave 2 将扩展为 1 分钟滑动窗口错误率（PRD 4.8.B）；Wave 0 仅声明占位。
FTS_BREAKER_ERROR_RATE_THRESHOLD = float(os.getenv('FTS_BREAKER_ERROR_RATE_THRESHOLD', '0.5'))
FTS_BREAKER_NAMESPACE = os.getenv('FTS_BREAKER_NAMESPACE', 'fts_breaker')
# 是否强制 pybreaker 使用 Redis 共享状态（PRD 4.8.A 核心承诺）：
#   - 生产（DEBUG=false）：默认 True，Redis 不可达直接 raise 让 worker
#     快速失败重启，避免多 worker 独立内存计数导致故障阈值失效。
#   - 本地（DEBUG=true）：默认 False，允许降级到内存便于离线开发。
FTS_BREAKER_REQUIRE_REDIS = os.getenv(
    'FTS_BREAKER_REQUIRE_REDIS',
    'true' if not DEBUG else 'false',
).lower() == 'true'

# ACL 缓存 TTL（Wave 2 使用，PRD 4.7.A）
FTS_ACL_CACHE_TTL = int(os.getenv('FTS_ACL_CACHE_TTL', '300'))
