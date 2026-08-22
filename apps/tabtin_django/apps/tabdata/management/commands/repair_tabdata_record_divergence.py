"""Repair TabData tombstones that are still projected by the collaboration room."""

import hashlib
import json
import os
from uuid import UUID, uuid4

from django.core.management.base import BaseCommand, CommandError

from apps.collab.adapters.table import TableCollabAdapter
from apps.collab.service import RestoreError, VersionHistoryService
from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.models import Table, TableRecord
from apps.tabdata.services.collab_service import CollabService


PLAN_SCHEMA = "tabdata-record-divergence-repair/v1"
APPLY_ENVIRONMENT = "ack-test"
RECONCILE_PROBE_KEY = "__tabdata_record_divergence_repair_probe"


def _canonical_uuid(raw_value: str, *, option_name: str) -> str:
    try:
        return str(UUID(str(raw_value)))
    except (TypeError, ValueError) as exc:
        raise CommandError(f"{option_name} 必须是有效 UUID") from exc


def _timestamp(value) -> str | None:
    return value.isoformat() if value is not None else None


class Command(BaseCommand):
    help = (
        "扫描单表中已软删除但可能仍残留在协作投影的记录；默认只读预演，"
        "仅 ack-test 可显式 apply。"
    )

    def add_arguments(self, parser):
        parser.add_argument("--table", required=True, help="目标表 UUID")
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="显式只读预演（不传 --apply 时本来就是 dry-run）",
        )
        parser.add_argument(
            "--apply",
            action="store_true",
            help="重校验计划中的 tombstone 候选并等待协作持久化屏障",
        )
        parser.add_argument("--confirm-table", help="写入前再次输入目标表 UUID")
        parser.add_argument("--expected-space", help="写入前核验目标 Space UUID")
        parser.add_argument(
            "--expected-organization",
            help="写入前核验目标 Organization UUID",
        )
        parser.add_argument(
            "--plan-hash",
            help="写入前必须回传本次 dry-run 输出的 plan_hash",
        )
        parser.add_argument(
            "--confirm-flush-pending-collab",
            action="store_true",
            help=(
                "确认执行窗口已停止编辑，并接受当前 Y.Doc 待保存的记录、字段和视图"
                "差异会按正常协作规则一并落库"
            ),
        )

    def handle(self, *args, **options):
        if options["apply"] and options["dry_run"]:
            raise CommandError("--apply 与 --dry-run 不能同时使用")

        table_id = _canonical_uuid(options["table"], option_name="--table")
        table = (
            Table.objects.using(TABDATA_DB_ALIAS)
            .filter(id=table_id, is_archived=False)
            .first()
        )
        if table is None:
            raise CommandError(f"找不到有效表：{table_id}")

        plan = self._build_plan(table)
        plan_hash = self._plan_hash(plan)
        self._print_plan(plan, plan_hash, apply=options["apply"])

        if not options["apply"]:
            self.stdout.write(
                "未执行写操作；确认后请带 --apply、目标归属参数及上述 plan_hash 重跑。"
            )
            return

        self._validate_apply_options(table, plan_hash, options)
        self._apply_plan(table, plan)

    @staticmethod
    def _build_plan(table: Table) -> dict:
        fresh_table = (
            Table.objects.using(TABDATA_DB_ALIAS)
            .filter(id=table.pk, is_archived=False)
            .first()
        )
        if fresh_table is None:
            raise CommandError(f"目标表已归档或不存在：{table.pk}")
        table = fresh_table
        tombstones = list(
            TableRecord.objects.using(TABDATA_DB_ALIAS)
            .filter(table=table, is_deleted=True)
            .order_by("id")
            .values("id", "version", "deleted_at", "updated_at")
        )
        return {
            "schema": PLAN_SCHEMA,
            "table_id": str(table.id),
            "organization_id": str(table.organization_id),
            "space_id": str(table.space_id),
            "table_version": int(table.record_version_seq or 0),
            "active_count": TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
                table=table,
                is_deleted=False,
            ).count(),
            "tombstones": [
                {
                    "id": str(item["id"]),
                    "version": int(item["version"] or 0),
                    "deleted_at": _timestamp(item["deleted_at"]),
                    "updated_at": _timestamp(item["updated_at"]),
                }
                for item in tombstones
            ],
        }

    @staticmethod
    def _plan_hash(plan: dict) -> str:
        serialized = json.dumps(
            plan,
            ensure_ascii=True,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        return hashlib.sha256(serialized).hexdigest()

    def _print_plan(self, plan: dict, plan_hash: str, *, apply: bool) -> None:
        self.stdout.write(f"mode={'APPLY' if apply else 'DRY-RUN'}")
        self.stdout.write(f"table={plan['table_id']}")
        self.stdout.write(f"organization={plan['organization_id']}")
        self.stdout.write(f"space={plan['space_id']}")
        self.stdout.write(f"table_version={plan['table_version']}")
        self.stdout.write(f"active_count={plan['active_count']}")
        self.stdout.write(f"tombstone_count={len(plan['tombstones'])}")
        for tombstone in plan["tombstones"]:
            self.stdout.write(f"tombstone_id={tombstone['id']}")
        self.stdout.write(
            "apply_effect=revalidate_tombstone_candidates_and_flush_collab_diff"
        )
        self.stdout.write(f"plan_hash={plan_hash}")

    @staticmethod
    def _validate_apply_options(table: Table, plan_hash: str, options: dict) -> None:
        environment = os.environ.get("TABTIN_ENV", "").strip().lower()
        if environment != APPLY_ENVIRONMENT:
            raise CommandError(
                f"--apply 仅允许 TABTIN_ENV={APPLY_ENVIRONMENT}，当前为 {environment or '<empty>'}"
            )

        required_options = {
            "--confirm-table": options.get("confirm_table"),
            "--expected-space": options.get("expected_space"),
            "--expected-organization": options.get("expected_organization"),
            "--plan-hash": options.get("plan_hash"),
            "--confirm-flush-pending-collab": options.get(
                "confirm_flush_pending_collab"
            ),
        }
        missing = [name for name, value in required_options.items() if not value]
        if missing:
            raise CommandError(f"--apply 缺少安全确认参数：{', '.join(missing)}")

        confirm_table = _canonical_uuid(
            options["confirm_table"],
            option_name="--confirm-table",
        )
        expected_space = _canonical_uuid(
            options["expected_space"],
            option_name="--expected-space",
        )
        expected_organization = _canonical_uuid(
            options["expected_organization"],
            option_name="--expected-organization",
        )
        if confirm_table != str(table.id):
            raise CommandError("--confirm-table 与目标表不一致")
        if expected_space != str(table.space_id):
            raise CommandError("--expected-space 与目标表归属不一致")
        if expected_organization != str(table.organization_id):
            raise CommandError("--expected-organization 与目标表归属不一致")
        if options["plan_hash"] != plan_hash:
            raise CommandError("plan_hash 已变化；请重新 dry-run 后再确认执行")

    @staticmethod
    def _trigger_reconciliation(table: Table, record_ids: list[str]) -> None:
        probe_value = str(uuid4())
        result = CollabService.apply_table_ops(
            table_id=table.id,
            op_id=str(uuid4()),
            ops=[
                {
                    "op": "map.set",
                    "path": ["meta"],
                    "key": RECONCILE_PROBE_KEY,
                    "value": probe_value,
                },
                {
                    "op": "map.delete",
                    "path": ["meta"],
                    "key": RECONCILE_PROBE_KEY,
                },
            ],
            timeout=30,
            editor_type="system",
            editor_id="system:tabdata-record-divergence-repair",
            editor_name="system:tabdata-record-divergence-repair",
            system_policy="trusted_internal",
            require_store_success=True,
            record_lifecycle_revalidation_ids=record_ids,
        )
        if (
            not isinstance(result, dict)
            or result.get("status") == "error"
            or result.get("error")
        ):
            error = (
                result.get("error") or result.get("message")
                if isinstance(result, dict)
                else result
            )
            raise CommandError(f"协作保存探针触发失败：{error or 'invalid response'}")
        # call_live_api_safe 正常情况下已剥掉 HTTP envelope；兼容直接 mock/未来
        # transport 透传 envelope 的形态，避免运维命令误判成功响应。
        payload = result.get("data") if isinstance(result.get("data"), dict) else result
        applied = payload.get("applied")
        if not isinstance(applied, int) or applied < 2:
            raise CommandError(
                f"协作保存探针未完整应用：expected>=2 actual={applied!r}"
            )
        if payload.get("store_completed") is not True:
            raise CommandError(
                "协作持久化屏障未确认完成；结果可能未知，请先查 collab-live 日志，"
                "不要直接重试"
            )
        candidate_count = payload.get("record_lifecycle_candidates")
        remaining_count = payload.get("record_lifecycle_remaining")
        if type(candidate_count) is not int or candidate_count < 1:
            raise CommandError(
                "当前协作房间未找到计划中的候选记录；可能已清理、命中了其他实例，"
                "或房间尚未重新加载，请人工核验后再决定是否重试"
            )
        if type(remaining_count) is not int or remaining_count != 0:
            raise CommandError(
                f"生命周期重校验后仍有 {remaining_count!r} 条候选投影；"
                "请停止执行并核验 restore/协作并发"
            )

    @staticmethod
    def _assert_tombstone_candidates_unchanged(plan: dict) -> None:
        """Fail closed if a candidate was restored or otherwise changed in flight."""
        planned = {item["id"]: item for item in plan["tombstones"]}
        current_rows = (
            TableRecord.objects.using(TABDATA_DB_ALIAS)
            .filter(table_id=plan["table_id"], id__in=planned)
            .values("id", "is_deleted", "version", "deleted_at", "updated_at")
        )
        current = {
            str(item["id"]): {
                "id": str(item["id"]),
                "version": int(item["version"] or 0),
                "deleted_at": _timestamp(item["deleted_at"]),
                "updated_at": _timestamp(item["updated_at"]),
            }
            for item in current_rows
            if item["is_deleted"]
        }
        if current != planned:
            raise CommandError(
                "持久化屏障完成后 tombstone 候选已变化；"
                "可能并发发生了恢复或删除，结果需要人工核验，不要直接重试"
            )

    def _apply_plan(self, table: Table, plan: dict) -> None:
        if not plan["tombstones"]:
            self.stdout.write(self.style.SUCCESS("没有 tombstone 需要清理。"))
            return

        # Share the cross-instance lock used by collab-first table restore. The lock
        # must span the fresh plan check and strict store barrier; a check-only gate
        # would leave a Y.Doc-first/DB-second restore race.
        history_service = VersionHistoryService(TableCollabAdapter())
        repair_run_id = uuid4()
        try:
            history_service.acquire_restore_lock(table.id, repair_run_id)
        except RestoreError as exc:
            raise CommandError(
                "目标表正在恢复，或 Redis 恢复锁不可用；"
                "本次未执行，请核验后重新 dry-run"
            ) from exc

        reconciliation_started = False
        reconciliation_confirmed = False
        try:
            if self._build_plan(table) != plan:
                raise CommandError(
                    "执行计划已漂移：tombstone、活跃记录或表版本发生变化；"
                    "请重新 dry-run 后再确认"
                )

            reconciliation_started = True
            self._trigger_reconciliation(
                table,
                [tombstone["id"] for tombstone in plan["tombstones"]],
            )
            self._assert_tombstone_candidates_unchanged(plan)
            reconciliation_confirmed = True
        finally:
            if not reconciliation_started or reconciliation_confirmed:
                history_service.release_restore_lock(table.id)
            else:
                # A client timeout does not cancel the remote DirectConnection/store.
                # Keep table restore serialized until the 120s lock TTL expires rather
                # than allowing a restore into an unknown in-flight repair outcome.
                self.stderr.write(self.style.WARNING(
                    "协作持久化结果未确认；恢复锁将保留到 TTL 自动过期，"
                    "期间不要恢复该表或盲目重试。"
                ))

        self.stdout.write(self.style.SUCCESS(
            "当前协作房间中命中的候选记录已完成生命周期重校验与持久化屏障；"
            "未发送记录删除。"
            "当前 Y.Doc 待保存的记录、字段和视图差异已按正常协作规则处理，"
            "最终结果仍须通过 UI、链接查询和协作日志确认。"
        ))
