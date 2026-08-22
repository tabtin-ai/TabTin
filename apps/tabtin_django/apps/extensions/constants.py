"""Extension 框架常量定义"""

from __future__ import annotations

from django.db.models import TextChoices


# ---------------------------------------------------------------------------
# Extension 类型
# ---------------------------------------------------------------------------

class ExtensionType(TextChoices):
    CHANNEL = "channel", "渠道"
    INTEGRATION = "integration", "集成"


# ---------------------------------------------------------------------------
# Extension 连接状态
# ---------------------------------------------------------------------------

class ConnectionStatus(TextChoices):
    DISCONNECTED = "disconnected", "未连接"
    CONNECTING = "connecting", "连接中"
    CONNECTED = "connected", "已连接"
    ERROR = "error", "错误"


# ---------------------------------------------------------------------------
# 认证方式
# ---------------------------------------------------------------------------

class AuthType(TextChoices):
    NONE = "none", "无认证"
    API_KEY = "api_key", "API Key"
    OAUTH2 = "oauth2", "OAuth2"
    APP_PASSWORD = "app_password", "应用密码"
    BOT_TOKEN = "bot_token", "Bot Token"


# ---------------------------------------------------------------------------
# 标准事件动作后缀
# ---------------------------------------------------------------------------

class EventAction(TextChoices):
    CREATED = "created", "已创建"
    UPDATED = "updated", "已更新"
    DELETED = "deleted", "已删除"
    RECEIVED = "received", "已收到"
    SENT = "sent", "已发送"
    DELIVERED = "delivered", "已投递"
    FAILED = "failed", "失败"
    BOUNCED = "bounced", "退回"


# ---------------------------------------------------------------------------
# 事件日志状态
# ---------------------------------------------------------------------------

class EventLogStatus(TextChoices):
    PENDING = "pending", "待处理"
    DISPATCHED = "dispatched", "已分发"
    CONSUMED = "consumed", "已消费"
    FAILED = "failed", "失败"
    SKIPPED = "skipped", "跳过"


# ---------------------------------------------------------------------------
# 通知规则优先级
# ---------------------------------------------------------------------------

class NotificationPriority(TextChoices):
    LOW = "low", "低"
    NORMAL = "normal", "普通"
    HIGH = "high", "高"
    URGENT = "urgent", "紧急"


# ---------------------------------------------------------------------------
# EventBus 线网 ID（改名需同步运维日志/监控）
# ---------------------------------------------------------------------------

# Extension → Tracker（Goal）触发（原 tabgoal_trigger，迁移后运维日志检索请用新 ID）
GOAL_EXTENSION_TRIGGER_CONSUMER_ID = "agenda_goal_trigger"
