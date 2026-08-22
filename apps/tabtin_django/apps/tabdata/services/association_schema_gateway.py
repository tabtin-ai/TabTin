"""
关联结构变更唯一编排入口。

plan() 生成 ImpactPlan；execute() 在固定事务与锁顺序下落地。
本期为骨架：落地 LinkRelation / LinkEdge，不改 legacy LinkRecord 读写路径。

锁顺序（execute 固定）：
1. SELECT LinkRelation ... FOR UPDATE（若已有 relation）
2. 按 UUID 排序锁定相关 TableRecord
3. diff edges → 写 LinkEdge
4. （后续）更新双侧展示缓存 / native / Y.Doc
5. （后续）同事务写 Outbox
"""

from __future__ import annotations

import hashlib
import json
import logging
from typing import Any, Iterable, Optional, Sequence
from uuid import UUID

from django.db import transaction
from apps.tabdata.constants import (
    DEFAULT_LINK_RELATIONSHIP,
    SYMMETRIC_RELATIONSHIP_MAP,
    TABDATA_DB_ALIAS,
)
from apps.tabdata.models import LinkEdge, LinkRelation, Table, TableField, TableRecord
from apps.tabdata.services.association_schema_types import (
    AssociationCommand,
    AssociationCommandKind,
    ExecuteResult,
    ImpactBlocker,
    ImpactPlan,
)

logger = logging.getLogger(__name__)

_VALID_RELATIONSHIPS = frozenset(SYMMETRIC_RELATIONSHIP_MAP.keys())


class AssociationSchemaError(ValueError):
    """关联结构变更业务错误。"""

    def __init__(self, code: str, message: str, *, details: Optional[dict] = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}


class AssociationSchemaGateway:
    """关联结构变更网关（骨架）。"""

    # ──────────────────────────────────────────────────────
    # 公开接口
    # ──────────────────────────────────────────────────────

    @classmethod
    def plan(cls, command: AssociationCommand) -> ImpactPlan:
        """预览关联结构变更影响，不落库。"""
        blockers = list(cls._validate_command(command))
        details: dict[str, Any] = {
            "organization_id": str(command.organization_id),
            "host_relationship": command.host_relationship,
            "is_one_way": command.is_one_way,
        }

        if command.kind == AssociationCommandKind.CREATE_LINK:
            blockers.extend(cls._plan_create_link(command, details))
        elif command.kind == AssociationCommandKind.UPDATE_LINK:
            blockers.extend(cls._plan_update_link(command, details))
        elif command.kind == AssociationCommandKind.DELETE_LINK:
            blockers.extend(cls._plan_delete_link(command, details))
        elif command.kind == AssociationCommandKind.SET_EDGES:
            blockers.extend(cls._plan_set_edges(command, details))
        else:
            blockers.append(
                ImpactBlocker(
                    code="unsupported_command",
                    message=f"不支持的命令: {command.kind}",
                )
            )

        fingerprint = cls._fingerprint(command, details, blockers)
        return ImpactPlan(
            command_kind=command.kind,
            fingerprint=fingerprint,
            can_execute=len(blockers) == 0,
            blockers=tuple(blockers),
            will_delete_symmetric_field=bool(
                details.get("will_delete_symmetric_field", False)
            ),
            truncated_link_count=int(details.get("truncated_link_count", 0)),
            affected_view_ids=tuple(details.get("affected_view_ids", ())),
            estimated_recompute_rows=int(details.get("estimated_recompute_rows", 0)),
            sync_mode=str(details.get("sync_mode", "sync")),
            undo_supported=bool(details.get("undo_supported", False)),
            details=details,
        )

    @classmethod
    def execute(
        cls,
        command: AssociationCommand,
        *,
        plan: Optional[ImpactPlan] = None,
    ) -> ExecuteResult:
        """执行关联结构变更。

        若传入 plan，校验 fingerprint；否则内部重新 plan。
        """
        impact = plan or cls.plan(command)
        if command.expected_fingerprint and command.expected_fingerprint != impact.fingerprint:
            return ExecuteResult(
                success=False,
                error_code="fingerprint_mismatch",
                error_message="影响预览已过期，请重新 plan",
                fingerprint=impact.fingerprint,
            )
        if plan is not None and not plan.can_execute:
            first = plan.blockers[0] if plan.blockers else None
            return ExecuteResult(
                success=False,
                error_code=first.code if first else "blocked",
                error_message=first.message if first else "无法执行",
                fingerprint=plan.fingerprint,
                details={"blockers": [b.code for b in plan.blockers]},
            )
        if not impact.can_execute:
            first = impact.blockers[0] if impact.blockers else None
            return ExecuteResult(
                success=False,
                error_code=first.code if first else "blocked",
                error_message=first.message if first else "无法执行",
                fingerprint=impact.fingerprint,
            )

        try:
            with transaction.atomic(using=TABDATA_DB_ALIAS):
                if command.kind == AssociationCommandKind.CREATE_LINK:
                    return cls._execute_create_link(command, impact)
                if command.kind == AssociationCommandKind.UPDATE_LINK:
                    return cls._execute_update_link(command, impact)
                if command.kind == AssociationCommandKind.DELETE_LINK:
                    return cls._execute_delete_link(command, impact)
                if command.kind == AssociationCommandKind.SET_EDGES:
                    return cls._execute_set_edges(command, impact)
                raise AssociationSchemaError(
                    "unsupported_command",
                    f"不支持的命令: {command.kind}",
                )
        except AssociationSchemaError as exc:
            logger.warning(
                "association_schema_execute_failed code=%s message=%s",
                exc.code,
                exc.message,
            )
            return ExecuteResult(
                success=False,
                error_code=exc.code,
                error_message=exc.message,
                fingerprint=impact.fingerprint,
                details=exc.details,
            )

    # ──────────────────────────────────────────────────────
    # plan helpers
    # ──────────────────────────────────────────────────────

    @classmethod
    def _validate_command(cls, command: AssociationCommand) -> list[ImpactBlocker]:
        blockers: list[ImpactBlocker] = []
        if not command.organization_id:
            blockers.append(
                ImpactBlocker(code="missing_organization", message="缺少 organization_id")
            )
        if command.host_relationship not in _VALID_RELATIONSHIPS:
            blockers.append(
                ImpactBlocker(
                    code="invalid_relationship",
                    message=f"非法基数: {command.host_relationship}",
                )
            )
        if command.is_one_way and command.symmetric_field_id:
            blockers.append(
                ImpactBlocker(
                    code="one_way_with_symmetric",
                    message="单向关系不能指定 symmetric_field_id",
                )
            )
        if (not command.is_one_way) and command.kind == AssociationCommandKind.CREATE_LINK:
            if not command.symmetric_field_id and not command.metadata.get(
                "allow_missing_symmetric"
            ):
                # create 允许稍后补齐对称字段；标记 warning 于 details，不 blocker
                pass
        return blockers

    @classmethod
    def _plan_create_link(
        cls,
        command: AssociationCommand,
        details: dict[str, Any],
    ) -> list[ImpactBlocker]:
        blockers: list[ImpactBlocker] = []
        if not command.host_table_id or not command.foreign_table_id:
            blockers.append(
                ImpactBlocker(
                    code="missing_tables",
                    message="create_link 需要 host_table_id 与 foreign_table_id",
                )
            )
            return blockers
        if not command.host_field_id:
            blockers.append(
                ImpactBlocker(
                    code="missing_host_field",
                    message=(
                        "骨架阶段 create_link 需要已存在的 host_field_id；"
                        "字段创建仍走 LinkFieldService"
                    ),
                )
            )
            return blockers

        host_table = (
            Table.objects.using(TABDATA_DB_ALIAS)
            .filter(id=command.host_table_id, organization_id=command.organization_id)
            .first()
        )
        foreign_table = (
            Table.objects.using(TABDATA_DB_ALIAS)
            .filter(id=command.foreign_table_id, organization_id=command.organization_id)
            .first()
        )
        if host_table is None or foreign_table is None:
            blockers.append(
                ImpactBlocker(
                    code="table_not_found",
                    message="宿主表或目标表不存在，或不属于该组织",
                )
            )
            return blockers

        host_field = (
            TableField.objects.using(TABDATA_DB_ALIAS)
            .filter(
                id=command.host_field_id,
                table_id=command.host_table_id,
                is_deleted=False,
            )
            .first()
        )
        if host_field is None:
            blockers.append(
                ImpactBlocker(code="host_field_not_found", message="宿主关联字段不存在")
            )
            return blockers
        if host_field.field_type != "link":
            blockers.append(
                ImpactBlocker(
                    code="host_field_not_link",
                    message="host_field 必须是 link 类型",
                )
            )

        if LinkRelation.objects.using(TABDATA_DB_ALIAS).filter(
            host_field_id=command.host_field_id
        ).exists():
            blockers.append(
                ImpactBlocker(
                    code="relation_already_exists",
                    message="该宿主字段已注册 LinkRelation",
                )
            )

        if not command.is_one_way:
            if not command.symmetric_field_id:
                blockers.append(
                    ImpactBlocker(
                        code="missing_symmetric_field",
                        message="双向关系需要 symmetric_field_id",
                    )
                )
            else:
                sym = (
                    TableField.objects.using(TABDATA_DB_ALIAS)
                    .filter(
                        id=command.symmetric_field_id,
                        table_id=command.foreign_table_id,
                        is_deleted=False,
                        field_type="link",
                    )
                    .first()
                )
                if sym is None:
                    blockers.append(
                        ImpactBlocker(
                            code="symmetric_field_not_found",
                            message="对称关联字段不存在或不在目标表",
                        )
                    )
                elif LinkRelation.objects.using(TABDATA_DB_ALIAS).filter(
                    symmetric_field_id=command.symmetric_field_id
                ).exists():
                    blockers.append(
                        ImpactBlocker(
                            code="symmetric_already_registered",
                            message="对称字段已注册到其他 LinkRelation",
                        )
                    )

        details["host_table_id"] = str(command.host_table_id)
        details["foreign_table_id"] = str(command.foreign_table_id)
        details["host_field_id"] = str(command.host_field_id)
        if command.symmetric_field_id:
            details["symmetric_field_id"] = str(command.symmetric_field_id)
        details["undo_supported"] = False
        return blockers

    @classmethod
    def _plan_update_link(
        cls,
        command: AssociationCommand,
        details: dict[str, Any],
    ) -> list[ImpactBlocker]:
        blockers: list[ImpactBlocker] = []
        relation = cls._load_relation(command)
        if relation is None:
            blockers.append(
                ImpactBlocker(code="relation_not_found", message="LinkRelation 不存在")
            )
            return blockers
        details["relation_id"] = str(relation.id)
        # 骨架：仅允许改 is_one_way / host_relationship 元数据；换表/截断在后续 PR
        if command.foreign_table_id and command.foreign_table_id != relation.foreign_table_id:
            blockers.append(
                ImpactBlocker(
                    code="foreign_table_change_deferred",
                    message="换目标表尚未接入 gateway，请继续使用 LinkFieldService",
                )
            )
        if (
            command.host_relationship != relation.host_relationship
            and command.host_relationship in ("OneOne", "ManyOne")
            and relation.host_relationship in ("OneMany", "ManyMany")
        ):
            # 降基数：统计可能截断的边（骨架只计数，不截断）
            edge_count = (
                LinkEdge.objects.using(TABDATA_DB_ALIAS)
                .filter(relation=relation)
                .count()
            )
            details["truncated_link_count"] = edge_count
            details["sync_mode"] = "async" if edge_count > 1000 else "sync"
        details["will_delete_symmetric_field"] = (
            command.is_one_way and not relation.is_one_way
        )
        return blockers

    @classmethod
    def _plan_delete_link(
        cls,
        command: AssociationCommand,
        details: dict[str, Any],
    ) -> list[ImpactBlocker]:
        blockers: list[ImpactBlocker] = []
        relation = cls._load_relation(command)
        if relation is None:
            blockers.append(
                ImpactBlocker(code="relation_not_found", message="LinkRelation 不存在")
            )
            return blockers
        details["relation_id"] = str(relation.id)
        details["will_delete_symmetric_field"] = (
            relation.symmetric_field_id is not None
        )
        details["truncated_link_count"] = (
            LinkEdge.objects.using(TABDATA_DB_ALIAS).filter(relation=relation).count()
        )
        return blockers

    @classmethod
    def _plan_set_edges(
        cls,
        command: AssociationCommand,
        details: dict[str, Any],
    ) -> list[ImpactBlocker]:
        blockers: list[ImpactBlocker] = []
        relation = cls._load_relation(command)
        if relation is None:
            blockers.append(
                ImpactBlocker(code="relation_not_found", message="LinkRelation 不存在")
            )
            return blockers
        details["relation_id"] = str(relation.id)
        details["edge_count"] = len(command.edges)
        return blockers

    # ──────────────────────────────────────────────────────
    # execute helpers（固定锁序）
    # ──────────────────────────────────────────────────────

    @classmethod
    def _execute_create_link(
        cls,
        command: AssociationCommand,
        impact: ImpactPlan,
    ) -> ExecuteResult:
        relation = LinkRelation.objects.using(TABDATA_DB_ALIAS).create(
            organization_id=command.organization_id,
            host_table_id=command.host_table_id,
            foreign_table_id=command.foreign_table_id,
            host_field_id=command.host_field_id,
            symmetric_field_id=None if command.is_one_way else command.symmetric_field_id,
            host_relationship=command.host_relationship or DEFAULT_LINK_RELATIONSHIP,
            is_one_way=command.is_one_way,
        )
        logger.info(
            "link_relation_created relation_id=%s host_field_id=%s one_way=%s",
            relation.id,
            command.host_field_id,
            command.is_one_way,
        )
        return ExecuteResult(
            success=True,
            relation_id=relation.id,
            host_field_id=command.host_field_id,
            symmetric_field_id=None if command.is_one_way else command.symmetric_field_id,
            fingerprint=impact.fingerprint,
        )

    @classmethod
    def _execute_update_link(
        cls,
        command: AssociationCommand,
        impact: ImpactPlan,
    ) -> ExecuteResult:
        relation = cls._lock_relation(command.relation_id)
        if relation is None:
            raise AssociationSchemaError("relation_not_found", "LinkRelation 不存在")

        relation.host_relationship = command.host_relationship or relation.host_relationship
        becoming_one_way = command.is_one_way and not relation.is_one_way
        if becoming_one_way:
            relation.is_one_way = True
            relation.symmetric_field = None
        elif not command.is_one_way and relation.is_one_way:
            if not command.symmetric_field_id:
                raise AssociationSchemaError(
                    "missing_symmetric_field",
                    "单向转双向需要 symmetric_field_id",
                )
            relation.is_one_way = False
            relation.symmetric_field_id = command.symmetric_field_id
        relation.save(
            using=TABDATA_DB_ALIAS,
            update_fields=[
                "host_relationship",
                "is_one_way",
                "symmetric_field",
                "updated_at",
            ],
        )
        return ExecuteResult(
            success=True,
            relation_id=relation.id,
            host_field_id=relation.host_field_id,
            symmetric_field_id=relation.symmetric_field_id,
            fingerprint=impact.fingerprint,
            details={"became_one_way": becoming_one_way},
        )

    @classmethod
    def _execute_delete_link(
        cls,
        command: AssociationCommand,
        impact: ImpactPlan,
    ) -> ExecuteResult:
        relation = cls._lock_relation(command.relation_id)
        if relation is None:
            raise AssociationSchemaError("relation_not_found", "LinkRelation 不存在")
        relation_id = relation.id
        deleted_edges, _ = (
            LinkEdge.objects.using(TABDATA_DB_ALIAS)
            .filter(relation=relation)
            .delete()
        )
        relation.delete(using=TABDATA_DB_ALIAS)
        return ExecuteResult(
            success=True,
            relation_id=relation_id,
            edges_deleted=deleted_edges,
            fingerprint=impact.fingerprint,
        )

    @classmethod
    def _execute_set_edges(
        cls,
        command: AssociationCommand,
        impact: ImpactPlan,
    ) -> ExecuteResult:
        """按锁序重写某 relation 的边集合（骨架；不触碰 LinkRecord）。"""
        relation = cls._lock_relation(command.relation_id)
        if relation is None:
            raise AssociationSchemaError("relation_not_found", "LinkRelation 不存在")

        desired = cls._normalize_edges(command.edges)
        record_ids = sorted(
            {edge["host_record_id"] for edge in desired}
            | {edge["foreign_record_id"] for edge in desired}
        )
        if record_ids:
            # 按 UUID 排序锁定相关记录，避免并发基数校验死锁
            list(
                TableRecord.objects.using(TABDATA_DB_ALIAS)
                .select_for_update()
                .filter(id__in=record_ids)
                .order_by("id")
            )

        existing = {
            (e.host_record_id, e.foreign_record_id): e
            for e in LinkEdge.objects.using(TABDATA_DB_ALIAS)
            .select_for_update()
            .filter(relation=relation)
        }
        desired_keys = {(e["host_record_id"], e["foreign_record_id"]) for e in desired}

        to_delete = [e for key, e in existing.items() if key not in desired_keys]
        created = 0
        updated = 0
        if to_delete:
            LinkEdge.objects.using(TABDATA_DB_ALIAS).filter(
                id__in=[e.id for e in to_delete]
            ).delete()

        for edge in desired:
            key = (edge["host_record_id"], edge["foreign_record_id"])
            current = existing.get(key)
            if current is None:
                LinkEdge.objects.using(TABDATA_DB_ALIAS).create(
                    relation=relation,
                    host_record_id=edge["host_record_id"],
                    foreign_record_id=edge["foreign_record_id"],
                    host_order=edge.get("host_order", 0),
                    foreign_order=edge.get("foreign_order", 0),
                )
                created += 1
            else:
                new_host_order = edge.get("host_order", current.host_order)
                new_foreign_order = edge.get("foreign_order", current.foreign_order)
                if (
                    current.host_order != new_host_order
                    or current.foreign_order != new_foreign_order
                ):
                    current.host_order = new_host_order
                    current.foreign_order = new_foreign_order
                    current.save(
                        using=TABDATA_DB_ALIAS,
                        update_fields=["host_order", "foreign_order"],
                    )
                    updated += 1

        return ExecuteResult(
            success=True,
            relation_id=relation.id,
            edges_created=created,
            edges_deleted=len(to_delete),
            edges_updated=updated,
            fingerprint=impact.fingerprint,
        )

    # ──────────────────────────────────────────────────────
    # shared helpers
    # ──────────────────────────────────────────────────────

    @classmethod
    def _load_relation(cls, command: AssociationCommand) -> Optional[LinkRelation]:
        if not command.relation_id:
            return None
        return (
            LinkRelation.objects.using(TABDATA_DB_ALIAS)
            .filter(
                id=command.relation_id,
                organization_id=command.organization_id,
            )
            .first()
        )

    @classmethod
    def _lock_relation(cls, relation_id: Optional[UUID]) -> Optional[LinkRelation]:
        if not relation_id:
            return None
        return (
            LinkRelation.objects.using(TABDATA_DB_ALIAS)
            .select_for_update()
            .filter(id=relation_id)
            .first()
        )

    @staticmethod
    def _normalize_edges(edges: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
        normalized: list[dict[str, Any]] = []
        seen: set[tuple[UUID, UUID]] = set()
        for raw in edges or ():
            try:
                host_id = UUID(str(raw["host_record_id"]))
                foreign_id = UUID(str(raw["foreign_record_id"]))
            except (KeyError, TypeError, ValueError) as exc:
                raise AssociationSchemaError(
                    "invalid_edge",
                    f"非法边载荷: {raw}",
                    details={"raw": repr(raw)},
                ) from exc
            key = (host_id, foreign_id)
            if key in seen:
                raise AssociationSchemaError(
                    "duplicate_edge",
                    f"重复边: {host_id} → {foreign_id}",
                )
            seen.add(key)
            normalized.append(
                {
                    "host_record_id": host_id,
                    "foreign_record_id": foreign_id,
                    "host_order": int(raw.get("host_order", 0) or 0),
                    "foreign_order": int(raw.get("foreign_order", 0) or 0),
                }
            )
        return normalized

    @staticmethod
    def _fingerprint(
        command: AssociationCommand,
        details: dict[str, Any],
        blockers: Iterable[ImpactBlocker],
    ) -> str:
        payload = {
            "kind": command.kind.value,
            "organization_id": str(command.organization_id),
            "relation_id": str(command.relation_id) if command.relation_id else None,
            "host_table_id": str(command.host_table_id) if command.host_table_id else None,
            "foreign_table_id": (
                str(command.foreign_table_id) if command.foreign_table_id else None
            ),
            "host_field_id": str(command.host_field_id) if command.host_field_id else None,
            "symmetric_field_id": (
                str(command.symmetric_field_id) if command.symmetric_field_id else None
            ),
            "host_relationship": command.host_relationship,
            "is_one_way": command.is_one_way,
            "edges": list(command.edges),
            "details": details,
            "blockers": [b.code for b in blockers],
        }
        raw = json.dumps(payload, sort_keys=True, default=str, separators=(",", ":"))
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]
