"""
TabData 大表容量压测命令

用途：
- 建立可复跑的容量基线（行/列规模）
- 测量关键链路耗时：写入、分页、搜索、排序、服务层读取、序列化

示例：
    # 默认场景：10k×50, 50k×200, 100k×500
    python manage.py benchmark_table_capacity

    # 自定义场景
    python manage.py benchmark_table_capacity --scenario 10000x50 --scenario 20000x100

    # 保留压测数据（默认会清理）
    python manage.py benchmark_table_capacity --scenario 10000x50 --keep-data
"""

from __future__ import annotations

import json
import platform
from dataclasses import dataclass
from pathlib import Path
from time import perf_counter
from typing import Any

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError
from django.db import connections
from django.utils import timezone

from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.models import Table, TableField, TableRecord
from apps.tabdata.services.record_service import RecordService
from apps.tabdata.utils.record_serializers import serialize_records
from apps.tabtinspace.models import (
    Agent,
    Organization,
    OrganizationMember,
    Project,
    ProjectMembership,
    SpaceMembership,
    Workspace,
)

User = get_user_model()

DEFAULT_SCENARIOS = ("10000x50", "50000x200", "100000x500")
DEFAULT_BATCH_SIZE = 500
DEFAULT_PAGE_SIZE = 100
DEFAULT_BENCHMARK_EMAIL = "benchmark.tabdata@tabtin.local"


@dataclass(frozen=True)
class Scenario:
    rows: int
    cols: int

    @property
    def label(self) -> str:
        return f"{self.rows}x{self.cols}"


class Command(BaseCommand):
    help = "压测 TabData 大表容量并输出基线报告"

    def add_arguments(self, parser):
        parser.add_argument(
            "--scenario",
            action="append",
            help="压测场景，格式 rowsxcols（可重复或逗号分隔），例如：10000x50",
        )
        parser.add_argument(
            "--batch-size",
            type=int,
            default=DEFAULT_BATCH_SIZE,
            help=f"批量写入大小（默认 {DEFAULT_BATCH_SIZE}）",
        )
        parser.add_argument(
            "--page-size",
            type=int,
            default=DEFAULT_PAGE_SIZE,
            help=f"分页读取大小（默认 {DEFAULT_PAGE_SIZE}）",
        )
        parser.add_argument(
            "--user-email",
            type=str,
            default=DEFAULT_BENCHMARK_EMAIL,
            help=f"压测用户邮箱（默认 {DEFAULT_BENCHMARK_EMAIL}）",
        )
        parser.add_argument(
            "--output",
            type=str,
            default="",
            help="报告输出路径（默认写入 apps/tabtin_django/logs/benchmarks）",
        )
        parser.add_argument(
            "--run-tag",
            type=str,
            default="",
            help="本次压测标识（默认自动生成）",
        )
        parser.add_argument(
            "--keep-data",
            action="store_true",
            help="是否保留压测生成的表与数据（默认清理）",
        )
        parser.add_argument(
            "--skip-serialize-benchmark",
            action="store_true",
            help="跳过序列化链路压测（serialize_records）",
        )
        parser.add_argument(
            "--continue-on-error",
            action="store_true",
            help="某个场景失败后继续执行后续场景",
        )
        parser.add_argument(
            "--progress-step",
            type=int,
            default=10,
            help="写入进度输出步长百分比（默认 10）",
        )

    def handle(self, *args, **options):
        scenarios = self._parse_scenarios(options.get("scenario"))
        batch_size = int(options["batch_size"])
        page_size = int(options["page_size"])
        progress_step = int(options["progress_step"])

        if batch_size <= 0:
            raise CommandError("--batch-size 必须大于 0")
        if page_size <= 0:
            raise CommandError("--page-size 必须大于 0")
        if progress_step <= 0 or progress_step > 50:
            raise CommandError("--progress-step 必须在 1 到 50 之间")

        run_tag = (options.get("run_tag") or "").strip() or timezone.now().strftime("%Y%m%d_%H%M%S")
        keep_data = bool(options["keep_data"])
        continue_on_error = bool(options["continue_on_error"])
        skip_serialize_benchmark = bool(options["skip_serialize_benchmark"])

        self.stdout.write(self.style.SUCCESS(f"[Benchmark] 开始执行，run_tag={run_tag}"))
        self.stdout.write(f"[Benchmark] 场景: {', '.join(s.label for s in scenarios)}")
        self.stdout.write(
            f"[Benchmark] 参数: batch_size={batch_size}, page_size={page_size}, keep_data={keep_data}"
        )

        started_at = timezone.now()
        user = self._ensure_benchmark_user(options["user_email"])
        context = self._create_context(user, run_tag)

        report: dict[str, Any] = {
            "run_tag": run_tag,
            "started_at": started_at.isoformat(),
            "finished_at": None,
            "options": {
                "batch_size": batch_size,
                "page_size": page_size,
                "keep_data": keep_data,
                "skip_serialize_benchmark": skip_serialize_benchmark,
                "continue_on_error": continue_on_error,
                "progress_step": progress_step,
            },
            "environment": {
                "python": platform.python_version(),
                "platform": platform.platform(),
                "timezone": str(timezone.get_current_timezone()),
            },
            "context": {
                "user_id": str(user.id),
                "user_email": user.email,
                "organization_id": str(context["organization"].id),
                "space_id": str(context["space"].id),
            },
            "scenarios": [],
            "errors": [],
        }

        global_start = perf_counter()
        try:
            for scenario in scenarios:
                self.stdout.write(self.style.WARNING(f"\n[Scenario {scenario.label}] 开始"))
                try:
                    scenario_result = self._run_scenario(
                        context=context,
                        scenario=scenario,
                        batch_size=batch_size,
                        page_size=page_size,
                        keep_data=keep_data,
                        skip_serialize_benchmark=skip_serialize_benchmark,
                        progress_step=progress_step,
                    )
                    report["scenarios"].append(scenario_result)
                    self.stdout.write(
                        self.style.SUCCESS(
                            f"[Scenario {scenario.label}] 完成，写入 {scenario.rows} 行耗时 "
                            f"{scenario_result['metrics']['insert_records_ms']} ms"
                        )
                    )
                except Exception as exc:  # noqa: BLE001
                    error_payload = {
                        "scenario": scenario.label,
                        "error": str(exc),
                    }
                    report["errors"].append(error_payload)
                    self.stderr.write(self.style.ERROR(f"[Scenario {scenario.label}] 失败: {exc}"))
                    if not continue_on_error:
                        raise
        finally:
            if not keep_data:
                self._cleanup_context(context)

        total_elapsed_ms = round((perf_counter() - global_start) * 1000, 2)
        report["finished_at"] = timezone.now().isoformat()
        report["total_elapsed_ms"] = total_elapsed_ms

        output_path = self._resolve_output_path(run_tag, options.get("output"))
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

        self.stdout.write(self.style.SUCCESS("\n[Benchmark] 全部执行完成"))
        self.stdout.write(f"[Benchmark] 总耗时: {total_elapsed_ms} ms")
        self.stdout.write(f"[Benchmark] 报告路径: {output_path}")

        if report["errors"]:
            raise CommandError(f"存在 {len(report['errors'])} 个失败场景，请查看报告")

    def _parse_scenarios(self, raw_scenarios: list[str] | None) -> list[Scenario]:
        tokens: list[str] = []
        if raw_scenarios:
            for item in raw_scenarios:
                tokens.extend(part.strip() for part in item.split(","))
        else:
            tokens.extend(DEFAULT_SCENARIOS)

        parsed: list[Scenario] = []
        seen: set[tuple[int, int]] = set()

        for token in tokens:
            if not token:
                continue
            normalized = token.lower().replace("_", "")
            if "x" not in normalized:
                raise CommandError(f"非法场景格式: {token}，期望 rowsxcols")
            rows_text, cols_text = normalized.split("x", 1)
            try:
                rows = int(rows_text)
                cols = int(cols_text)
            except ValueError as exc:
                raise CommandError(f"非法场景格式: {token}，rows/cols 必须是整数") from exc

            if rows <= 0 or cols <= 0:
                raise CommandError(f"非法场景格式: {token}，rows/cols 必须 > 0")

            key = (rows, cols)
            if key in seen:
                continue
            seen.add(key)
            parsed.append(Scenario(rows=rows, cols=cols))

        if not parsed:
            raise CommandError("至少需要一个有效场景")
        return parsed

    def _ensure_benchmark_user(self, email: str):
        user = User.objects.using("default").filter(email=email).first()
        if user:
            if not user.is_active:
                user.is_active = True
                user.save(using="default", update_fields=["is_active"])
            return user

        # 优先复用已有活跃用户，避免触发注册信号链路带来的额外副作用
        existing_user = User.objects.using("default").filter(is_active=True).first()
        if existing_user:
            self.stdout.write(
                f"[Benchmark] 未找到邮箱 {email}，复用现有用户: {existing_user.id}"
            )
            return existing_user

        self.stdout.write(f"[Benchmark] 创建压测用户: {email}")
        return User.objects.db_manager("default").create_user(
            email=email,
            password="BenchmarkOnly#2026",
            nickname="TabData Benchmark",
            is_active=True,
        )

    def _create_context(self, user, run_tag: str) -> dict[str, Any]:
        existing_space = (
            Workspace.objects.using(TABDATA_DB_ALIAS)
            .filter(organization__owner_id=user.id)
            .order_by("-updated_at")
            .first()
        )
        if existing_space is None:
            existing_space = (
                Project.objects.using(TABDATA_DB_ALIAS)
                .filter(organization__owner_id=user.id, is_archived=False)
                .order_by("-updated_at")
                .first()
            )
        if existing_space:
            organization = existing_space.organization
            agent, _ = Agent.objects.using(TABDATA_DB_ALIAS).get_or_create(
                organization_id=organization.id,
                user_id=user.id,
                defaults={
                    "name": f"Benchmark Agent {run_tag}",
                    "type": "human",
                    "is_active": True,
                    "settings": {"purpose": "benchmark"},
                },
            )
            if isinstance(existing_space, Workspace):
                SpaceMembership.objects.using(TABDATA_DB_ALIAS).get_or_create(
                    workspace_id=existing_space.id,
                    agent_id=agent.id,
                    defaults={
                        "role": "owner",
                        "is_active": True,
                        "permissions": {},
                    },
                )
            else:
                ProjectMembership.objects.using(TABDATA_DB_ALIAS).get_or_create(
                    project_id=existing_space.id,
                    user_id=user.id,
                    defaults={
                        "role": "owner",
                        "is_active": True,
                        "status": ProjectMembership.Status.ACTIVE,
                        "permissions": {},
                    },
                )
            return {
                "user": user,
                "organization": organization,
                "agent": agent,
                "space": existing_space,
                "created_context": False,
            }

        organization = Organization.objects.using(TABDATA_DB_ALIAS).create(
            name=f"TabData 压测空间 {run_tag}",
            description="自动创建的大表压测空间",
            icon="🧪",
            owner_id=user.id,
            is_default=False,
            settings={
                "purpose": "tabdata_capacity_benchmark",
                "run_tag": run_tag,
            },
        )
        OrganizationMember.objects.using(TABDATA_DB_ALIAS).get_or_create(
            organization_id=organization.id,
            user_id=user.id,
            defaults={"role": "owner"},
        )

        space = Project.objects.using(TABDATA_DB_ALIAS).create(
            organization_id=organization.id,
            name=f"TabData 大表压测 {run_tag}",
            description="自动创建的大表压测 Project",
            status=Project.Status.ACTIVE,
            order=0,
        )

        agent, _ = Agent.objects.using(TABDATA_DB_ALIAS).get_or_create(
            organization_id=organization.id,
            user_id=user.id,
            defaults={
                "name": f"Benchmark Agent {run_tag}",
                "type": "human",
                "is_active": True,
                "settings": {"purpose": "benchmark"},
            },
        )
        if not agent.is_active:
            agent.is_active = True
            agent.save(using=TABDATA_DB_ALIAS, update_fields=["is_active", "updated_at"])

        membership, _ = ProjectMembership.objects.using(TABDATA_DB_ALIAS).get_or_create(
            project_id=space.id,
            user_id=user.id,
            defaults={
                "role": "owner",
                "is_active": True,
                "status": ProjectMembership.Status.ACTIVE,
                "permissions": {},
            },
        )
        if membership.role != "owner" or not membership.is_active:
            membership.role = "owner"
            membership.is_active = True
            membership.status = ProjectMembership.Status.ACTIVE
            membership.save(
                using=TABDATA_DB_ALIAS,
                update_fields=["role", "is_active", "status", "updated_at"],
            )

        return {
            "user": user,
            "organization": organization,
            "agent": agent,
            "space": space,
            "created_context": True,
        }

    def _cleanup_context(self, context: dict[str, Any]) -> None:
        if not context.get("created_context"):
            return
        organization = context["organization"]
        space = context["space"]
        Project.objects.using(TABDATA_DB_ALIAS).filter(id=space.id).update(
            is_archived=True,
            status=Project.Status.ARCHIVED,
            name=f"[benchmark-archived] {space.name}",
        )
        Organization.objects.using(TABDATA_DB_ALIAS).filter(id=organization.id).update(
            name=f"[benchmark-archived] {organization.name}",
        )

    def _run_scenario(
        self,
        *,
        context: dict[str, Any],
        scenario: Scenario,
        batch_size: int,
        page_size: int,
        keep_data: bool,
        skip_serialize_benchmark: bool,
        progress_step: int,
    ) -> dict[str, Any]:
        user = context["user"]
        space = context["space"]

        table = None
        scenario_start = perf_counter()

        metrics: dict[str, Any] = {}
        try:
            table, create_table_ms = self._create_table(space_id=space.id, owner_id=user.id, scenario=scenario)
            metrics["create_table_ms"] = create_table_ms

            field_ids, create_fields_ms = self._create_fields(table_id=table.id, cols=scenario.cols)
            metrics["create_fields_ms"] = create_fields_ms

            insert_metrics = self._insert_records(
                table_id=table.id,
                field_ids=field_ids,
                rows=scenario.rows,
                batch_size=batch_size,
                user_id=user.id,
                progress_step=progress_step,
            )
            metrics.update(insert_metrics)

            query_metrics = self._benchmark_queries(
                table_id=table.id,
                rows=scenario.rows,
                page_size=page_size,
                user=user,
                sort_field_key=field_ids[0] if field_ids else None,
                skip_serialize_benchmark=skip_serialize_benchmark,
            )
            metrics.update(query_metrics)

            total_elapsed_ms = round((perf_counter() - scenario_start) * 1000, 2)
            metrics["scenario_total_ms"] = total_elapsed_ms
            metrics["rows_per_second"] = round(scenario.rows / (total_elapsed_ms / 1000), 2) if total_elapsed_ms > 0 else None
            metrics["cells_total"] = scenario.rows * scenario.cols
            metrics["cells_per_second"] = (
                round((scenario.rows * scenario.cols) / (total_elapsed_ms / 1000), 2)
                if total_elapsed_ms > 0
                else None
            )

            return {
                "scenario": scenario.label,
                "table_id": str(table.id),
                "status": "success",
                "metrics": metrics,
            }
        finally:
            if table and not keep_data:
                self._cleanup_table(table.id)

    def _create_table(self, *, space_id, owner_id: str, scenario: Scenario) -> tuple[Table, float]:
        started = perf_counter()
        table = Table.objects.using(TABDATA_DB_ALIAS).create(
            name=f"benchmark_{scenario.label}_{timezone.now().strftime('%H%M%S')}",
            description=f"TabData 容量压测 {scenario.label}",
            icon="📊",
            owner_id=owner_id,
            space_id=space_id,
            row_count=0,
            field_count=0,
            is_public=False,
            is_template=False,
            is_archived=False,
        )
        elapsed_ms = round((perf_counter() - started) * 1000, 2)
        return table, elapsed_ms

    def _create_fields(self, *, table_id, cols: int) -> tuple[list[str], float]:
        started = perf_counter()
        fields: list[TableField] = []
        for index in range(cols):
            fields.append(
                TableField(
                    table_id=table_id,
                    name=f"c{index + 1:04d}",
                    field_type="text",
                    description="benchmark field",
                    config={},
                    order=index + 1,
                    width=150,
                    is_primary=(index == 0),
                    is_hidden=False,
                    validation_rules={},
                    is_deleted=False,
                )
            )

        TableField.objects.using(TABDATA_DB_ALIAS).bulk_create(fields, batch_size=1000)
        Table.objects.using(TABDATA_DB_ALIAS).filter(id=table_id).update(field_count=cols)

        elapsed_ms = round((perf_counter() - started) * 1000, 2)
        field_ids = [str(field.id) for field in fields]
        return field_ids, elapsed_ms

    def _insert_records(
        self,
        *,
        table_id,
        field_ids: list[str],
        rows: int,
        batch_size: int,
        user_id: str,
        progress_step: int,
    ) -> dict[str, Any]:
        started = perf_counter()
        buffer: list[TableRecord] = []
        inserted = 0
        next_progress = progress_step
        col_count = len(field_ids)

        for row_index in range(rows):
            row_marker = f"row-{row_index:06d}"
            record_data = {
                "sort_key": row_index,
                "row_marker": row_marker,
            }

            for col_index, field_id in enumerate(field_ids):
                if col_index == 0:
                    record_data[field_id] = row_marker
                else:
                    record_data[field_id] = f"v{row_index % 1000:04d}_{col_index:04d}"

            buffer.append(
                TableRecord(
                    table_id=table_id,
                    data=record_data,
                    order=float(row_index + 1),
                    is_deleted=False,
                    version=1,
                    status="active",
                    tags=[],
                    created_by_id=user_id,
                    updated_by_id=user_id,
                )
            )

            if len(buffer) >= batch_size:
                TableRecord.objects.using(TABDATA_DB_ALIAS).bulk_create(buffer, batch_size=batch_size)
                inserted += len(buffer)
                buffer.clear()

                progress = int((inserted / rows) * 100)
                if progress >= next_progress:
                    self.stdout.write(f"  - 写入进度 {progress}% ({inserted}/{rows})")
                    while progress >= next_progress:
                        next_progress += progress_step

        if buffer:
            TableRecord.objects.using(TABDATA_DB_ALIAS).bulk_create(buffer, batch_size=batch_size)
            inserted += len(buffer)

        Table.objects.using(TABDATA_DB_ALIAS).filter(id=table_id).update(row_count=rows)

        elapsed_ms = round((perf_counter() - started) * 1000, 2)
        return {
            "insert_records_ms": elapsed_ms,
            "inserted_rows": inserted,
            "inserted_cols": col_count,
            "insert_rows_per_second": round(inserted / (elapsed_ms / 1000), 2) if elapsed_ms > 0 else None,
        }

    def _benchmark_queries(
        self,
        *,
        table_id,
        rows: int,
        page_size: int,
        user,
        sort_field_key: str | None,
        skip_serialize_benchmark: bool,
    ) -> dict[str, Any]:
        metrics: dict[str, Any] = {}
        queryset = TableRecord.objects.using(TABDATA_DB_ALIAS).filter(table_id=table_id, is_deleted=False)

        metrics["query_count_ms"], total_count = self._time_call(lambda: queryset.count())
        metrics["query_total_count"] = total_count

        metrics["query_page_1_ms"], page1_ids = self._time_call(
            lambda: list(queryset.order_by("order", "-created_at").values_list("id", flat=True)[:page_size])
        )
        metrics["query_page_1_rows"] = len(page1_ids)

        middle_page = max(1, (rows // page_size) // 2)
        start = (middle_page - 1) * page_size
        end = start + page_size
        metrics["query_page_middle_ms"], middle_ids = self._time_call(
            lambda: list(queryset.order_by("order", "-created_at").values_list("id", flat=True)[start:end])
        )
        metrics["query_page_middle_rows"] = len(middle_ids)
        metrics["query_page_middle_index"] = middle_page

        search_keyword = f"row-{rows // 2:06d}"
        metrics["query_search_ms"], matched_count = self._time_call(
            lambda: queryset.extra(
                where=["data::text ILIKE %s"],
                params=[f"%{search_keyword}%"],
            ).count()
        )
        metrics["query_search_keyword"] = search_keyword
        metrics["query_search_matched"] = matched_count

        sort_lookup = f"data__{sort_field_key}" if sort_field_key else "data__sort_key"
        metrics["query_sort_field"] = sort_field_key or "sort_key"
        metrics["query_sort_ms"], sorted_ids = self._time_call(
            lambda: list(queryset.order_by(sort_lookup).values_list("id", flat=True)[:page_size])
        )
        metrics["query_sort_rows"] = len(sorted_ids)

        service = RecordService(user=user)
        metrics["service_list_records_ms"], service_result = self._time_call(
            lambda: service.list_records(
                table_id=table_id,
                page=1,
                page_size=page_size,
            )
        )
        metrics["service_list_records_rows"] = len(service_result.get("records", []))
        metrics["service_list_records_total"] = int(service_result.get("total", 0))

        if sort_field_key:
            metrics["service_sort_field"] = sort_field_key
            metrics["service_sort_prepare_ms"], _ = self._time_call(
                lambda: service.list_records(
                    table_id=table_id,
                    page=1,
                    page_size=1,
                    sort_by=sort_field_key,
                    sort_order="asc",
                )
            )
            metrics["service_list_records_sorted_ms"], sorted_result = self._time_call(
                lambda: service.list_records(
                    table_id=table_id,
                    page=1,
                    page_size=page_size,
                    sort_by=sort_field_key,
                    sort_order="asc",
                )
            )
            metrics["service_list_records_sorted_rows"] = len(sorted_result.get("records", []))
            metrics["service_list_records_sorted_total"] = int(sorted_result.get("total", 0))

        if not skip_serialize_benchmark:
            metrics["serialize_page_ms"], serialized_count = self._time_call(
                lambda: self._serialize_page(queryset, page_size)
            )
            metrics["serialize_page_rows"] = serialized_count

        return metrics

    def _serialize_page(self, queryset, page_size: int) -> int:
        records = list(queryset.order_by("order", "-created_at")[:page_size])
        serialized = serialize_records(records)
        return len(serialized)

    def _time_call(self, func):
        started = perf_counter()
        result = func()
        elapsed_ms = round((perf_counter() - started) * 1000, 2)
        return elapsed_ms, result

    def _resolve_output_path(self, run_tag: str, output: str) -> Path:
        if output and output.strip():
            return Path(output).expanduser().resolve()
        return (
            Path("apps/tabtin_django/logs/benchmarks")
            / f"table_capacity_benchmark_{run_tag}.json"
        ).resolve()

    def _cleanup_table(self, table_id) -> None:
        # 使用原生 SQL 清理，绕开当前环境中缺失关联表导致的 ORM 级联删除失败
        try:
            with connections[TABDATA_DB_ALIAS].cursor() as cursor:
                cursor.execute("DELETE FROM tabdata_record WHERE table_id = %s", [str(table_id)])
                cursor.execute("DELETE FROM tabdata_field WHERE table_id = %s", [str(table_id)])
                cursor.execute("DELETE FROM tabdata_table WHERE id = %s", [str(table_id)])
        except Exception as exc:  # noqa: BLE001
            self.stderr.write(self.style.WARNING(f"[Benchmark] 清理表失败（已跳过）: {exc}"))
