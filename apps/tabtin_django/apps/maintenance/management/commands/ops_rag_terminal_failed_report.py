from __future__ import annotations

import json
from datetime import datetime, time

from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone
from django.utils.dateparse import parse_date, parse_datetime

from apps.maintenance.runtime_rag_terminal import (
    RagTerminalFilters,
    build_rag_terminal_failed_report,
)


def _parse_created_before(value: str) -> datetime | None:
    if not value:
        return None
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


class Command(BaseCommand):
    help = "分析 RAG EmbeddingTask terminal failed 历史噪音影响面。"

    def add_arguments(self, parser):
        parser.add_argument("--scene-key", default="", help="按派生 scene_key 过滤")
        parser.add_argument("--task-name", default="", help="按派生 Celery task name 过滤")
        parser.add_argument("--error-signature", default="", help="按错误签名子串过滤")
        parser.add_argument("--created-before", default="", help="只统计该时间之前创建的任务")
        parser.add_argument("--limit", type=int, default=100, help="最多扫描多少条未处理 terminal failed")
        parser.add_argument("--dry-run", action="store_true", help="兼容参数；report 永远只读")

    def handle(self, *args, **options):
        limit = int(options["limit"])
        if limit <= 0:
            raise CommandError("--limit 必须 > 0")
        filters = RagTerminalFilters(
            scene_key=options["scene_key"].strip(),
            task_name=options["task_name"].strip(),
            error_signature=options["error_signature"].strip(),
            created_before=_parse_created_before(options["created_before"].strip()),
            limit=limit,
        )
        report = build_rag_terminal_failed_report(filters)
        report["dry_run"] = True
        self.stdout.write(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
