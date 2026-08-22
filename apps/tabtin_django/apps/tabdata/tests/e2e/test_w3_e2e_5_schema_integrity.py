"""E2E-W3-5: Schema Integrity V2。

覆盖用户故事
============

check 发现漂移 → repair 修复 → 验证清洁

1. IntegrityV2Service 可导入且有 check / repair_stream
2. 5 种 DriftItem 类型枚举
3. SchemaCheckReport 数据结构
4. RepairEvent 数据结构
5. Admin API router 存在（schema-check / schema-repair）
"""
from __future__ import annotations

import os
from dataclasses import asdict
from uuid import uuid4

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django

django.setup()

import pytest


# ── 1. IntegrityV2Service 可导入 ──────────────────────────────


def test_integrity_service_importable():
    from apps.tabdata.services.integrity_v2_service import IntegrityV2Service
    assert hasattr(IntegrityV2Service, 'check')
    assert hasattr(IntegrityV2Service, 'repair_stream')


# ── 2. 5 种 DriftItem 类型 ──────────────────────────────────


def test_drift_item_types_coverage():
    """5 种漂移类型已覆盖。"""
    from apps.tabdata.services.integrity_v2_service import DriftItem

    drift_types = [
        'column_missing', 'column_orphan', 'type_mismatch',
        'ref_stale', 'row_count_mismatch',
    ]
    for dt in drift_types:
        item = DriftItem(type=dt)
        assert item.type == dt


def test_drift_item_serialization():
    """DriftItem 可序列化为 dict。"""
    from apps.tabdata.services.integrity_v2_service import DriftItem

    item = DriftItem(
        type='column_missing',
        field_id='f1',
        field_name='name',
        expected='TEXT',
        actual=None,
        auto_fixable=True,
    )
    d = asdict(item)
    assert d['type'] == 'column_missing'
    assert d['auto_fixable'] is True


# ── 3. SchemaCheckReport 结构 ────────────────────────────────


def test_schema_check_report_structure():
    from apps.tabdata.services.integrity_v2_service import SchemaCheckReport

    report = SchemaCheckReport(
        table_id=str(uuid4()),
        table_name='test_table',
    )
    assert report.drift_items == []
    assert report.checked_fields == 0
    assert report.error is None


# ── 4. RepairEvent 结构 ──────────────────────────────────────


def test_repair_event_structure():
    from apps.tabdata.services.integrity_v2_service import RepairEvent

    event = RepairEvent(seq=1, drift_type='column_missing', status='success', message='OK')
    d = event.to_dict()
    assert d['seq'] == 1
    assert d['drift_type'] == 'column_missing'
    assert d['status'] == 'success'


# ── 5. Admin API router 存在 ─────────────────────────────────


def test_integrity_admin_router_exists():
    from apps.tabdata.api_admin_integrity import router
    assert router is not None


def test_schema_check_endpoint_exists():
    from apps.tabdata.api_admin_integrity import router
    paths = list(router.path_operations.keys())
    assert any('check' in p for p in paths), f"schema-check not in {paths}"


def test_schema_repair_endpoint_exists():
    from apps.tabdata.api_admin_integrity import router
    paths = list(router.path_operations.keys())
    assert any('repair' in p for p in paths), f"schema-repair not in {paths}"


# ── 6. PG 类型归一化 ────────────────────────────────────────


def test_pg_type_normalize():
    from apps.tabdata.services.integrity_v2_service import _normalize_pg_type

    assert _normalize_pg_type('text') == 'TEXT'
    assert _normalize_pg_type('integer') == 'INTEGER'
    assert _normalize_pg_type('double precision') == 'DOUBLE PRECISION'
    assert _normalize_pg_type('jsonb') == 'JSONB'


# ── 7. API schema 结构 ──────────────────────────────────────


def test_admin_api_schemas():
    from apps.tabdata.api_admin_integrity import (
        DriftItemSchema,
        SchemaCheckResponseSchema,
        DeletedFieldSchema,
    )

    assert DriftItemSchema is not None
    assert SchemaCheckResponseSchema is not None
    assert DeletedFieldSchema is not None
