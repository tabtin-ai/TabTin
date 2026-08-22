"""PG 单库（single_pg）能力往返验收 smoke。

配套分支 ``feat/db-dual-to-single-pg`` / 文档
``docs/agent/pg-single-db-acceptance-harness.md``。

#373 单库主线一直缺「能不能真干活」的 live 证据：migrate 全过、起得来服务
只证明了 schema/运行时，但**核心能力在单库 + 恢复的物理 FK 下能否正确往返**
（建表写记录、建文档、存对话、跨 app FK 链解析）一直没系统验过。这个脚本补这个洞：
在**默认单库**（本分支 `.env` 即 `single_pg` + `tabtin_single`）上，走**真实 service 层**
把核心数据面跑一遍 CRUD，并断言 M3a/M3b 恢复的物理 FK 能链式解析。

验什么
------
1. **Provisioning**：``OrganizationService.create_organization`` → User/owner FK、默认 bot Space、Wallet
   （脊柱：organization.owner_id / space_membership.user_id 等物理 FK）。
2. **TabData**：``TableService.create_table`` → 默认字段 → ``RecordService.create_record`` → 读回。
3. **TabDoc**：``DocumentService.create_document`` → 落库。
4. **Chat**：``ChatSession``（workspace + current_model FK）+ ``ChatMessage``（model FK），
   并断言 ``session.current_model.model_name`` / ``session.workspace`` 跨 app 链式解析
   （ 后会话挂 workspace；M3b 把 current_model 从 UUID 软引用转成了物理 FK）。

前置
----
- 本分支默认即单库（``.env`` = ``TABTIN_DATABASE_MODE=single_pg`` + ``PG_DB_NAME=tabtin_single``），
  无需任何 flag；fresh 库需先 ``safe_migrate``（见 harness 文档）。
- 脚本会在缺会员等级时自动 ``seed_membership_tiers``（TabData 配额校验需要）。

用法
----
```bash
cd apps/tabtin_django && source venv/bin/activate
python scripts/pg_single_db_capability_smoke.py            # 默认单库，跑完自动清理
python scripts/pg_single_db_capability_smoke.py --keep-data  # 保留造的数据
```

退出码：0=全过；2=有能力 FAIL。

注意：fresh 库未 seed ``LLMSceneBinding`` 时，记录/文档落库会触发良性的
``SceneBindingUnavailable``（异步 embedding 副作用，被捕获、不影响落库），与单库无关。
"""
from __future__ import annotations

import argparse
import os
import sys
import traceback
import uuid
from pathlib import Path

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

_REPO_DJANGO_DIR = Path(__file__).resolve().parent.parent
if str(_REPO_DJANGO_DIR) not in sys.path:
    sys.path.insert(0, str(_REPO_DJANGO_DIR))

import django  # noqa: E402

django.setup()

from django.contrib.auth import get_user_model  # noqa: E402
from django.core.management import call_command  # noqa: E402
from django.db import connection  # noqa: E402


class Results:
    def __init__(self) -> None:
        self.passed: list[str] = []
        self.failed: list[str] = []

    def step(self, name, fn):
        try:
            value = fn()
            print(f"PASS  {name}: {value}")
            self.passed.append(name)
            return value
        except Exception as exc:  # noqa: BLE001 — smoke 要看到所有失败
            print(f"FAIL  {name}: {type(exc).__name__}: {exc}")
            traceback.print_exc()
            self.failed.append(name)
            return None


def main() -> int:
    parser = argparse.ArgumentParser(description="PG 单库能力往返 smoke")
    parser.add_argument("--keep-data", action="store_true", help="不清理造出来的数据")
    args = parser.parse_args()

    from apps.services.common.db_router import is_single_database_mode, postgres_app_db_alias

    print(
        f"vendor={connection.vendor} db={connection.settings_dict.get('NAME')} "
        f"single_mode={is_single_database_mode()} alias={postgres_app_db_alias()}"
    )
    if connection.vendor != "postgresql":
        print("ABORT: 期望在 PostgreSQL 上跑（本分支默认单库 tabtin_single）")
        return 1

    User = get_user_model()
    uniq = uuid.uuid4().hex[:8]
    res = Results()
    created: dict[str, object] = {}

    # fresh 库 TabData 配额校验需要会员等级
    from apps.users.membership.models import MembershipTier

    if not MembershipTier.objects.exists():
        print("seed: 无会员等级，自动 seed_membership_tiers …")
        call_command("seed_membership_tiers")

    # 1) Provisioning（脊柱物理 FK）
    from apps.tabtinspace.models import Space
    from apps.tabtinspace.services.organization_service import OrganizationService

    user = User.objects.create_user(
        username=f"cap_{uniq}", email=f"cap_{uniq}@example.com", password="Cap!12345"
    )
    created["user"] = user
    organization = res.step(
        "provision organization+space+wallet",
        lambda: OrganizationService(user=user).create_organization(name=f"Cap {uniq}"),
    )
    from apps.tabtinspace.models import Workspace
    space = Workspace.objects.filter(organization_id=organization.id).first() if organization else None
    if space:
        from apps.users.wallet.models import OrganizationWallet

        print(
            f"   workspace={space.id} kind={space.kind} "
            f"wallet={OrganizationWallet.objects.filter(organization_id=str(organization.id)).count()}"
        )

    # 2) TabData：建表 → 默认字段 → 写记录 → 读回
    if space:
        from apps.tabdata.models import TableField, TableRecord
        from apps.tabdata.services.record_service import RecordService
        from apps.tabdata.services.table_service import TableService

        table = res.step(
            "TabData create_table",
            lambda: TableService(user=user).create_table(space_id=space.id, name=f"T_{uniq}"),
        )
        if table:
            created["table"] = table
            fields = list(TableField.objects.filter(table_id=table.id).values_list("name", flat=True))
            print(f"   default fields: {fields}")

            def _create_record():
                rec, err = RecordService(user=user).create_record(table_id=table.id, data={})
                if err:
                    raise RuntimeError(f"create_record err={err}")
                return rec.id

            res.step("TabData create_record", _create_record)
            print(f"   record count: {TableRecord.objects.filter(table_id=table.id).count()}")

    # 3) TabDoc：建文档
    if space:
        from apps.tabdoc.models import Document
        from apps.tabdoc.services.document_service import DocumentService

        def _create_doc():
            doc = DocumentService(user=user).create_document(
                space_id=str(space.id),
                title=f"D_{uniq}",
                organization_id=str(organization.id),
                parent_id=None,
                initial_content_pm_json={"type": "doc", "content": []},
                initial_content_markdown="",
                initial_content_plaintext="",
            )
            doc_id = getattr(doc, "id", doc)
            created["doc_id"] = doc_id
            assert Document.objects.filter(id=doc_id).exists(), "doc 未落库"
            return doc_id

        res.step("TabDoc create_document", _create_doc)

    # 4) Chat：session(workspace+current_model FK) + message(model FK) + 跨 app FK 链
    from apps.chat.conversation.models import ChatMessage, ChatSession
    from apps.services.llm.models import LLMModel, LLMProvider

    provider = LLMProvider.objects.create(name="cap", provider_key=f"capk_{uniq}", scope="global")
    model = LLMModel.objects.create(
        provider=provider,
        model_name="cap-model",
        display_name="Cap Model",
        context_window_tokens=8192,
        max_output_tokens=4096,
    )
    created["provider"] = provider
    created["model"] = model

    session = res.step(
        "Chat session(workspace+current_model FK)",
        lambda: ChatSession.objects.create(
            user=user,
            organization_id=str(organization.id) if organization else None,
            workspace=space,
            current_model=model,
            default_model=model,
        ),
    )
    if session:
        created["session"] = session
        res.step(
            "Chat message(model FK)",
            lambda: ChatMessage.objects.create(
                session=session, role="assistant", model=model, text_summary="cap smoke"
            ),
        )

        def _fk_chain():
            reloaded = ChatSession.objects.select_related("workspace", "current_model").get(id=session.id)
            assert reloaded.current_model is not None and reloaded.current_model.model_name == "cap-model"
            assert reloaded.workspace is not None
            return (
                f"current_model.model_name={reloaded.current_model.model_name} "
                f"workspace_id={reloaded.workspace_id}"
            )

        res.step("cross-app FK chain resolves", _fk_chain)

    # 清理
    if not args.keep_data:
        try:
            if "session" in created:
                ChatMessage.objects.filter(session=created["session"]).delete()
                created["session"].delete()
            if "model" in created:
                created["model"].delete()
            if "provider" in created:
                created["provider"].delete()
            # Organization 级联会带走 Space/Table/Record/Doc/Wallet/membership
            if organization:
                organization.delete()
            created["user"].delete()
            print("cleanup: done")
        except Exception as exc:  # noqa: BLE001
            print(f"cleanup: skipped ({type(exc).__name__}: {exc})")

    print(f"\nRESULT pass={len(res.passed)} fail={len(res.failed)}")
    if res.failed:
        print("FAILED steps: " + ", ".join(res.failed))
        return 2
    print("CAPABILITY_SMOKE=PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
