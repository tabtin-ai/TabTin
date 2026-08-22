"""TabChat 自定义 ORM Lookups。

注册 IntegerField 的 bitand lookup，使 `flags__bitand=X` 等价于
SQL `(flags & X) != 0`，用于高效查询位图标志。

由 TabchatConfig.ready() 加载。
"""

from django.db.models import IntegerField
from django.db.models.lookups import Lookup


class BitAnd(Lookup):
    """flags__bitand=X  →  (flags & X) != 0

    .filter(flags__bitand=READ)   → 已读
    .exclude(flags__bitand=READ)  → 未读
    """

    lookup_name = "bitand"

    def as_sql(self, compiler, connection):
        lhs, lhs_params = self.process_lhs(compiler, connection)
        rhs, rhs_params = self.process_rhs(compiler, connection)
        return f"({lhs} & {rhs}) != 0", [*lhs_params, *rhs_params]


IntegerField.register_lookup(BitAnd)
