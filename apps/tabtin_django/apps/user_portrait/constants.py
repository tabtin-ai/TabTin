from django.conf import settings
"""
User Portrait 常量定义。
"""

# 数据库路由的 alias（跟 db_router.py 一致）
USER_PORTRAIT_DB = ('default' if getattr(settings, 'TABTIN_SINGLE_DATABASE_MODE', False) else 'postgresql')
# Hint 软提示的字符上限（微决策 2: B 软提示）
HINT_SOFT_LIMIT_CHARS = 200

# 单个 hint 的硬上限（防止恶意注入超长内容）
HINT_HARD_LIMIT_CHARS = 2000

# pending_hints 列表最多保留多少条（超出按时间最旧的丢弃）
MAX_PENDING_HINTS = 20

# 蒸馏触发原因（跟模型 UserPortraitSnapshot.TriggerReason 一致，方便 Service 引用）
TRIGGER_SCHEDULED = "scheduled"
TRIGGER_HINT = "hint"
TRIGGER_MANUAL = "manual"
TRIGGER_ORGANIZATION_CHANGE = "organization_change"

# Snapshot 历史保留多少天（超过自动清理）
SNAPSHOT_RETENTION_DAYS = 30
