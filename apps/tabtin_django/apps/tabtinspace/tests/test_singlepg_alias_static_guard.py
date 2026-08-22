"""#458 清扫守护（静态）：tabtinspace service 层禁止硬编码 'postgresql' alias。

single_pg 模式下 tabtinspace 模型由 router 路由到 ``default``，硬编码
``using='postgresql'`` 会让事务 / on_commit / 显式 .using 跑在过渡期镜像
连接上，与 ORM 查询连接分裂 → ``TransactionManagementError`` / 静默丢失
原子性。统一口径是 ``postgres_app_db_alias()``。

不依赖 DB，任何 suite 形态（SQLite 替身 / 真 PG）都执行。运行时探针见
``test_singlepg_atomic_alias.py``（需真 PG）。
"""

import ast
import re
from pathlib import Path

_SERVICES_DIR = Path(__file__).resolve().parent.parent / "services"

# 命中 using='postgresql' / using="postgresql" / .using('postgresql') /
# connections['postgresql'] / _raw_delete('postgresql') 等全部字面 alias 写法
_HARDCODED_ALIAS = re.compile(
    r"""using\s*[=(]\s*['"]postgresql['"]"""
    r"""|connections\[\s*['"]postgresql['"]\s*\]"""
    r"""|_raw_delete\(\s*['"]postgresql['"]\s*\)"""
)


def test_no_hardcoded_postgresql_alias_in_services():
    offenders: list[str] = []
    for path in sorted(_SERVICES_DIR.glob("*.py")):
        for lineno, line in enumerate(path.read_text().splitlines(), start=1):
            if _HARDCODED_ALIAS.search(line):
                offenders.append(f"{path.name}:{lineno}: {line.strip()}")
    assert not offenders, (
        "tabtinspace service 层出现硬编码 'postgresql' alias（应使用 "
        "postgres_app_db_alias()，见 ）：\n" + "\n".join(offenders)
    )


def test_permanently_delete_agent_uses_unified_atomic_alias():
    """永久删除会 select_for_update，事务 alias 必须与 ORM 路由一致。"""
    source = (_SERVICES_DIR / "agent_service.py").read_text()
    tree = ast.parse(source)

    method = next(
        (
            node
            for node in ast.walk(tree)
            if isinstance(node, ast.FunctionDef)
            and node.name == "permanently_delete_agent"
        ),
        None,
    )

    assert method is not None
    assert any(
        isinstance(decorator, ast.Call)
        and isinstance(decorator.func, ast.Attribute)
        and decorator.func.attr == "atomic"
        and any(
            kw.arg == "using"
            and isinstance(kw.value, ast.Call)
            and isinstance(kw.value.func, ast.Name)
            and kw.value.func.id == "postgres_app_db_alias"
            for kw in decorator.keywords
        )
        for decorator in method.decorator_list
    ), (
        "permanently_delete_agent() 内部使用 select_for_update()，"
        "必须使用 @transaction.atomic(using=postgres_app_db_alias())"
    )
