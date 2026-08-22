"""fts_forget_user — GDPR 合规：抹除某用户在 FTS 全栈的痕迹。

用法：
    python manage.py fts_forget_user <user_id>
    python manage.py fts_forget_user <user_id> --dry-run

清理范围（与 PRD 5.5 + 14.1 GDPR 原则对齐）：
    1. 6 个 ES 索引上的 `user_id={user_id}` 文档（delete_by_query 走 alias）
    2. 6 个 ES 索引上的 `creator_id={user_id}` 文档（覆盖资源 / 备忘录类）
    3. 6 个 ES 索引上的 `sender_id={user_id}` 文档（覆盖 IM 类）
    4. PG `fts_analytics` 表中 `user_id={user_id}` 的所有行
    5. **不**清理 outbox（业务表清理后 outbox 自动 stale，由 retention 处理）

注意：本命令只清"FTS 范围"的痕迹；完整 GDPR 还需要业务侧（chat / spaces /
tabmemo 等）各自清理对应业务行，这部分超出 fts 职责。
"""
from __future__ import annotations

import logging

from django.core.management.base import BaseCommand, CommandError
from apps.services.common.db_router import postgres_app_db_alias

logger = logging.getLogger(__name__)


# 6 索引每个的"用户 ID 字段"映射（PRD 4.4 / 4.5 字段约定）
INDEX_USER_FIELDS = {
    "messages": ("user_id",),
    "resources": ("creator_id",),
    "agents": ("user_id",),  # ES user_id 映射 Agent.owner_user_id
    "spaces": (),  # Space 没有 user_id 字段（依赖 SpaceMembership，不在 ES 上）
    "memos": ("user_id",),  # Memo.owner_id 写到 ES.user_id
    "im": ("sender_id",),
}


class Command(BaseCommand):
    help = "GDPR：抹除某用户在 FTS 上的所有数据（ES + fts_analytics）"

    def add_arguments(self, parser):
        parser.add_argument("user_id", type=str, help="用户 UUID")
        parser.add_argument(
            "--dry-run", action="store_true",
            help="只统计要删的条数，不真删",
        )

    def handle(self, *args, **options):
        from apps.fts.client import get_client, is_engine_enabled

        user_id = options["user_id"]
        dry_run = options["dry_run"]

        if not user_id:
            raise CommandError("user_id 不能为空")

        if not is_engine_enabled():
            self.stdout.write(self.style.WARNING(
                "SEARCH_ENGINE_ENABLED=false；只清理 fts_analytics，跳过 ES 删除"
            ))
            client = None
        else:
            client = get_client()

        # 1) ES 删除
        if client is not None:
            from apps.fts.index_definitions import (
                INDEX_DEFINITIONS, get_index_name, get_messages_alias,
            )
            for base, fields in INDEX_USER_FIELDS.items():
                if not fields:
                    continue
                if base == "messages":
                    alias = get_messages_alias()
                else:
                    alias = get_index_name(base)
                for field in fields:
                    body = {"query": {"term": {field: user_id}}}
                    try:
                        if dry_run:
                            count_resp = client.count(index=alias, body=body)
                            count = count_resp.get("count", 0) if hasattr(count_resp, "get") else 0
                            self.stdout.write(
                                f"  [dry-run] {alias}.{field} matched={count}"
                            )
                        else:
                            resp = client.delete_by_query(
                                index=alias, body=body,
                                conflicts="proceed", refresh=True,
                                wait_for_completion=True,
                            )
                            deleted = resp.get("deleted", 0) if hasattr(resp, "get") else 0
                            self.stdout.write(self.style.SUCCESS(
                                f"  ✓ {alias}.{field} deleted={deleted}"
                            ))
                    except Exception as exc:
                        self.stdout.write(self.style.ERROR(
                            f"  ✗ {alias}.{field} failed: {exc}"
                        ))

        # 2) fts_analytics 删除（PG 单库）
        if dry_run:
            from apps.fts.models import SearchAnalytics
            try:
                count = SearchAnalytics.objects.using(postgres_app_db_alias()).filter(user_id=user_id).count()
                self.stdout.write(f"  [dry-run] fts_analytics rows={count}")
            except Exception as exc:
                self.stdout.write(self.style.ERROR(
                    f"  ✗ fts_analytics dry-run failed: {exc}"
                ))
        else:
            from apps.fts.services import analytics_service
            deleted = analytics_service.forget_user(user_id=user_id)
            self.stdout.write(self.style.SUCCESS(
                f"  ✓ fts_analytics deleted={deleted}"
            ))

        self.stdout.write(self.style.SUCCESS(
            f"\n=== fts_forget_user user_id={user_id} 完成 ==="
        ))
