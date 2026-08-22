from __future__ import annotations

import json
from datetime import datetime, time

from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone
from django.utils.dateparse import parse_date, parse_datetime

from apps.maintenance.runtime_rag_terminal import (
    RagTerminalFilters,
    resolve_rag_terminal_failed,
)


def _parse_created_before(value: str) -> datetime:
    if not value:
        raise CommandError("--created-before 必填，避免误清理新失败")
    parsed = parse_datetime(value)
    if parsed is None:
        date_value = parse_date(value)
        if date_value:
            parsed = datetime.combine(date_value, time.min)
    if parsed is None:
        raise CommandError("--created-before 必须是 ISO datetime 或 YYYY-MM-DD")
    if timezone.is_naive(parsed):
        parsed = timezone.make_aware(parsed, timezone.get_current_timezone())
    return parsed


def _parse_dry_run(value: str) -> bool:
    normalized = str(value).strip().lower()
    if normalized in {"", "true", "1", "yes", "y"}:
        return True
    if normalized in {"false", "0", "no", "n"}:
        return False
    raise CommandError("--dry-run 必须为 true 或 false")


class Command(BaseCommand):
    help = "将明确匹配的 RAG terminal failed 历史噪音标记为 archived，不删除原始记录。"

    def add_arguments(self, parser):
        parser.add_argument("--error-signature", required=True, help="必填：按错误签名子串过滤")
        parser.add_argument("--scene-key", default="", help="按派生 scene_key 过滤")
        parser.add_argument("--created-before", required=True, help="必填：只处理该时间之前创建的任务")
        parser.add_argument("--limit", type=int, default=100, help="最多处理多少条")
        parser.add_argument("--ticket-id", default="", help="必填：审批 / 工单号")
        parser.add_argument("--reason", default="", help="必填：人工处理原因")
        parser.add_argument(
            "--dry-run",
            default="true",
            help="默认 true。只有显式 --dry-run=false 才写入 overlay / audit log。",
        )

    def handle(self, *args, **options):
        limit = int(options["limit"])
        if limit <= 0:
            raise CommandError("--limit 必须 > 0")
        ticket_id = options["ticket_id"].strip()
        reason = options["reason"].strip()
        if not ticket_id:
            raise CommandError("ticket_id_required: --ticket-id 必填")
        if not reason:
            raise CommandError("reason_required: --reason 必填")

        filters = RagTerminalFilters(
            scene_key=options["scene_key"].strip(),
            error_signature=options["error_signature"].strip(),
            created_before=_parse_created_before(options["created_before"].strip()),
            limit=limit,
        )
        try:
            result = resolve_rag_terminal_failed(
                filters=filters,
                ticket_id=ticket_id,
                reason=reason,
                dry_run=_parse_dry_run(options["dry_run"]),
            )
        except ValueError as exc:
            raise CommandError(str(exc)) from exc
        self.stdout.write(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
