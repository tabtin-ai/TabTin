"""
TabMemo 常量定义

数据库别名、全局配置等跨模块共享的常量。

⚠️ TabMemo 强依赖 PostgreSQL，不可切换到 MySQL。
   依赖特性：SearchVectorField、GinIndex、SearchQuery、to_tsvector。
   迁移命令必须加 --database=postgresql，详见项目根目录 CLAUDE.md。
"""

from django.conf import settings

TABMEMO_DB = getattr(settings, "TABMEMO_DB", "postgresql")

SEARCH_VECTOR_MAX_LEN = 10_000
DEFAULT_PAGE_SIZE = 30
MAX_PAGE_SIZE = 100
MAX_ATTACHMENT_COUNT = 20
ALLOWED_SORT_FIELDS = frozenset({
    "-created_at", "created_at", "-updated_at", "updated_at",
})
DEFAULT_SORT = "-created_at"

BOOKMARK_MAX_READ_BYTES = 50_000
BOOKMARK_TIMEOUT_SECONDS = 5
