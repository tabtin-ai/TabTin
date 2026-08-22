from django.conf import settings
"""Capabilities 模块公共常量。

注意：schemas.py 中的 Literal 类型必须与此处枚举值保持同步。
"""

CAPABILITIES_DB = ('default' if getattr(settings, 'TABTIN_SINGLE_DATABASE_MODE', False) else 'postgresql')
# ─── 枚举值 ──────────────────────────────────────────
# 修改此处枚举值时，必须同步更新 schemas.py 中对应的 Literal 定义

TOOL_CATEGORIES = ("app", "runtime", "service", "extension", "platform", "custom")
INTERFACE_TYPES = ("function_call", "cli", "api", "hybrid")
EXECUTION_TARGETS = ("frontend", "backend", "hybrid")
RISK_LEVELS = ("safe", "review", "strict")
TOOL_STATUSES = ("active", "deprecated", "disabled")
LINK_RELATIONS = ("required", "optional", "activates", "references")

# ─── 数值常量 ────────────────────────────────────────

MAX_DESCRIPTION_PREVIEW = 200
MAX_DOC_FOR_EMBEDDING = 500
DEFAULT_TOP_K = 10
MAX_TOP_K = 100
MAX_PAGE_SIZE = 200
