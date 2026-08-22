"""真实 MySQL + PG 集成验证脚本（验收命令 7 对应实现）。

背景：pytest 单元测试套件采用 SimpleTestCase + mock 绕开 SQLite
测试库（其他 app 的 PG-specific migration 在 SQLite 下 DDL 语法错）。
本脚本补充真实双库写入路径的验证。

执行：
    cd apps/tabtin_django && source venv/bin/activate
    python apps/fts/tests/integration/verify_outbox_migration.py

前置条件：
    - `python manage.py migrate fts` 已执行（MySQL 落表）
    - `python manage.py migrate fts --database=postgresql` 已执行

输出：行号 + 成功标记；任何步骤失败都 raise 非零退出。
"""

from __future__ import annotations

import os
import sys
import uuid
from pathlib import Path

# 追加项目根，支持直接 `python apps/fts/tests/integration/...` 运行
_BACKEND_ROOT = Path(__file__).resolve().parents[4]
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402

django.setup()


def main() -> int:
    from apps.fts.models import FtsOutbox, FtsOutboxPg

    run_id = uuid.uuid4().hex[:8]
    print(f"[verify] run_id={run_id}")

    # 1. MySQL 写入（走默认 manager，Router 分发到 default）
    doc_a = f"verify-msg-{run_id}"
    row_a = FtsOutbox.objects.create(
        index_name="tabtin-messages",
        doc_id=doc_a,
        action="upsert",
        organization_id=f"wt-{run_id}",
    )
    assert FtsOutbox.objects.filter(doc_id=doc_a).exists(), "MySQL 写入失败"
    print(f"[verify] ✅ FtsOutbox pk={row_a.pk} 已写入 MySQL (default)")

    # 2. PG 显式 using 写入
    doc_b = f"verify-res-{run_id}"
    row_b = FtsOutboxPg.objects.using("postgresql").create(
        index_name="tabtin-resources",
        doc_id=doc_b,
        action="upsert",
        organization_id=f"wt-{run_id}",
    )
    assert FtsOutboxPg.objects.using("postgresql").filter(doc_id=doc_b).exists()
    print(f"[verify] ✅ FtsOutboxPg pk={row_b.pk} 已写入 PG (postgresql using)")

    # 3. PG 默认 manager 写入（证明 Router 生效）
    doc_c = f"verify-agent-{run_id}"
    row_c = FtsOutboxPg.objects.create(
        index_name="tabtin-agents",
        doc_id=doc_c,
        action="upsert",
    )
    assert not FtsOutbox.objects.filter(doc_id=doc_c).exists(), (
        "Router 失效：FtsOutboxPg 被错误地写入了 MySQL"
    )
    assert FtsOutboxPg.objects.using("postgresql").filter(doc_id=doc_c).exists()
    print(f"[verify] ✅ FtsOutboxPg pk={row_c.pk} 经 Router 默认分发到 PG")

    # 4. 清理（保持库干净）
    FtsOutbox.objects.filter(doc_id__in=[doc_a]).delete()
    FtsOutboxPg.objects.using("postgresql").filter(
        doc_id__in=[doc_b, doc_c],
    ).delete()
    print("[verify] ✅ 清理完成")

    print("[verify] 全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
