"""fts_verify — 索引 vs DB 一致性对账（PRD 17.1.10）。

用法：
    python manage.py fts_verify --index=tabtin-spaces --sample=100
    python manage.py fts_verify --index=all --sample=50

设计：
    1. 行数对账：DB count vs ES count（精确度受 ES near-real-time 限制，
       相差 <5% 视为正常；> 10% 触发 SRE 介入）
    2. 抽样字段对账：从 DB 随机取 N 条 → 用 _id 查 ES → 对比关键字段
       （title / content 等）是否一致
    3. 失败行的 ID 列表写入 stdout 供 SRE 进一步处理
"""
from __future__ import annotations

import logging
import random
from typing import Any, Optional

from django.core.management.base import BaseCommand, CommandError
from apps.services.common.db_router import postgres_app_db_alias

logger = logging.getLogger(__name__)


# index → (queryset_factory, field_compare_fn)
INDEX_HANDLERS: dict[str, dict[str, Any]] = {}


class Command(BaseCommand):
    help = "对账：DB 行数 vs ES 文档数；抽样字段一致性"

    def add_arguments(self, parser):
        parser.add_argument("--index", type=str, default="all")
        parser.add_argument("--sample", type=int, default=100, help="字段对账抽样数")

    def handle(self, *args, **options):
        from apps.fts.client import get_client, is_engine_enabled

        if not is_engine_enabled():
            raise CommandError(
                "SEARCH_ENGINE_ENABLED=false；fts_verify 需 ES 可达。",
            )

        target = options["index"]
        sample = max(1, int(options["sample"]))

        if target == "all":
            from apps.fts.management.commands.fts_reindex import DEFAULT_REINDEX_ORDER
            indices = DEFAULT_REINDEX_ORDER
        else:
            indices = [target]

        client = get_client()
        any_fail = False

        for full_name in indices:
            base = full_name.split("-", 1)[1] if "-" in full_name else full_name
            self.stdout.write(self.style.MIGRATE_HEADING(f"\n=== 对账 {full_name}（base={base}）==="))

            db_count = _db_count(base)
            es_count = _es_count(client, base)
            diff_pct = abs(db_count - es_count) / max(db_count, 1) * 100

            self.stdout.write(
                f"  · DB={db_count} ES={es_count} diff={db_count - es_count} "
                f"({diff_pct:.2f}%)"
            )
            if diff_pct > 10.0:
                self.stdout.write(self.style.ERROR(
                    f"  ✗ 一致性差异 {diff_pct:.2f}% 超过 10%，建议 SRE 介入跑 fts_reindex --recreate"
                ))
                any_fail = True
            elif diff_pct > 5.0:
                self.stdout.write(self.style.WARNING(
                    f"  ⚠ 一致性差异 {diff_pct:.2f}% 大于 5%（refresh 滞后？）"
                ))
            else:
                self.stdout.write(self.style.SUCCESS(
                    f"  ✓ 行数对账通过"
                ))

            # 字段对账
            mismatches = _sample_field_check(client, base, sample)
            if mismatches:
                self.stdout.write(self.style.ERROR(
                    f"  ✗ 字段对账失败：{len(mismatches)}/{sample} 条不一致"
                ))
                for mm in mismatches[:5]:
                    self.stdout.write(f"      - {mm}")
                any_fail = True
            else:
                self.stdout.write(self.style.SUCCESS(
                    f"  ✓ 字段对账通过（抽样 {sample}）"
                ))

        self.stdout.write(self.style.SUCCESS("\n=== 对账完成 ==="))
        if any_fail:
            raise CommandError("对账存在差异，请按上述提示处理")


def _db_count(base: str) -> int:
    """对应 base 的 DB 总行数（应索引部分）"""
    if base == "messages":
        from apps.chat.conversation.models import ChatMessage
        return ChatMessage.objects.using("default").filter(role__in=["user", "assistant"]).count()
    if base == "resources":
        from apps.tabtinspace.models import ContextItem
        return ContextItem.objects.using(postgres_app_db_alias()).filter(trashed_at__isnull=True).count()
    if base == "agents":
        from apps.tabtinspace.models import Agent
        return Agent.objects.using(postgres_app_db_alias()).filter(is_active=True).count()
    if base == "spaces":
        from apps.tabtinspace.models import Project, Workspace
        return (
            Workspace.objects.using(postgres_app_db_alias()).count()
            + Project.objects.using(postgres_app_db_alias()).filter(trashed_at__isnull=True).count()
        )
    if base == "memos":
        from apps.tabmemo.models import Memo
        return Memo.objects.using(postgres_app_db_alias()).filter(status="active", trashed_at__isnull=True).count()
    if base == "im":
        from apps.tabchat.models import Message as ImMessage
        return ImMessage.objects.using(postgres_app_db_alias()).filter(is_deleted=False).count()
    raise CommandError(f"未知 base 索引名: {base}")


def _es_count(client: Any, base: str) -> int:
    """对应 base 的 ES doc 总数（走 alias）"""
    from apps.fts.index_definitions import get_index_name, get_messages_alias
    alias = get_messages_alias() if base == "messages" else get_index_name(base)
    try:
        resp = client.count(index=alias)
        if hasattr(resp, "get"):
            return int(resp.get("count") or 0)
        return int(resp.body.get("count") or 0)  # type: ignore[union-attr]
    except Exception as exc:
        logger.warning("[fts_verify] ES count failed for %s: %s", alias, exc)
        return 0


def _sample_field_check(client: Any, base: str, sample: int) -> list[str]:
    """随机抽样比对 DB vs ES 字段。返回不一致的 doc_id 列表（带原因）。"""
    from apps.fts.index_definitions import get_index_name, get_messages_alias
    from apps.fts.services import sync_service

    mismatches: list[str] = []

    qs = _model_iterator_for_sample(base)
    if qs is None:
        return mismatches

    pool = list(qs[: sample * 5])  # 取前 5 倍样本，再随机抽
    if not pool:
        return mismatches
    targets = random.sample(pool, min(sample, len(pool)))

    alias = get_messages_alias() if base == "messages" else get_index_name(base)

    for instance in targets:
        doc_id = str(instance.pk)
        # 拉 ES 现有 doc
        try:
            es_resp = client.search(
                index=alias, body={"query": {"term": {"_id": doc_id}}, "size": 1},
            )
            hits = es_resp.get("hits", {}).get("hits", []) if hasattr(es_resp, "get") else []
            if not hits:
                mismatches.append(f"{doc_id}: ES 中不存在")
                continue
            es_src = hits[0].get("_source") or {}
        except Exception as exc:
            mismatches.append(f"{doc_id}: ES 查询失败 {exc}")
            continue

        # 重建 doc 对比关键字段
        if base == "messages":
            db_doc = sync_service.to_message_document(instance)
            keys = ("content", "role", "session_id")
        elif base == "resources":
            db_doc = sync_service.to_resource_document(instance)
            keys = ("title", "preview", "item_type")
        elif base == "agents":
            db_doc = sync_service.to_agent_document(instance)
            keys = ("name", "type")
        elif base == "spaces":
            db_doc = sync_service.to_space_document(instance)
            keys = ("name", "type")
        elif base == "memos":
            db_doc = sync_service.to_memo_document(instance)
            keys = ("content", "status")
        elif base == "im":
            db_doc = sync_service.to_im_document(instance)
            keys = ("content", "conversation_id")
        else:
            continue

        if db_doc is None:
            # 业务模型说"不该索引"但 ES 里有 → 不算 mismatch（应被 trashed/archived 删）
            continue

        for k in keys:
            db_v = db_doc.get(k)
            es_v = es_src.get(k)
            if (db_v or "") != (es_v or ""):
                mismatches.append(f"{doc_id}: 字段 {k} DB={db_v!r} ES={es_v!r}")
                break

    return mismatches


def _model_iterator_for_sample(base: str):
    """简化版：返回 queryset，用于随机抽样。"""
    if base == "messages":
        from apps.chat.conversation.models import ChatMessage
        return ChatMessage.objects.using("default").filter(role__in=["user", "assistant"]).order_by("-pk")
    if base == "resources":
        from apps.tabtinspace.models import ContextItem
        return ContextItem.objects.using(postgres_app_db_alias()).filter(trashed_at__isnull=True).select_related("workspace", "project").order_by("-pk")
    if base == "agents":
        from apps.tabtinspace.models import Agent
        return Agent.objects.using(postgres_app_db_alias()).filter(is_active=True).order_by("-pk")
    if base == "spaces":
        from apps.tabtinspace.models import Project, Workspace
        # verify 抽样优先 Workspace；不足时再看 Project
        ws = Workspace.objects.using(postgres_app_db_alias()).order_by("-pk")
        if ws.exists():
            return ws
        return Project.objects.using(postgres_app_db_alias()).filter(trashed_at__isnull=True).order_by("-pk")
    if base == "memos":
        from apps.tabmemo.models import Memo
        return Memo.objects.using(postgres_app_db_alias()).filter(status="active", trashed_at__isnull=True).order_by("-pk")
    if base == "im":
        from apps.tabchat.models import Message as ImMessage
        return ImMessage.objects.using(postgres_app_db_alias()).filter(is_deleted=False).select_related("conversation").order_by("-pk")
    return None
