"""
TabtinSpace 领域异常
"""


class CrossDatabaseCleanupError(Exception):
    """跨库（MySQL ↔ PostgreSQL）数据清理失败。

    在 pre_delete signal 中 raise 此异常可阻止 User 删除，
    避免 MySQL 侧 User 被删而 PostgreSQL 侧孤儿数据残留。
    """
    pass
