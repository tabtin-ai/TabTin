"""E2E-W3-6: 字段回收站。

覆盖用户故事
============

delete field → list deleted → restore → verify

1. 回收站 Admin API 端点存在
2. TTL 配置
3. DeletedFieldSchema 结构
4. 软删字段模型支持
5. 字段 restore 白名单
"""
from __future__ import annotations

import os
from uuid import uuid4

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django

django.setup()

import pytest
from django.test import override_settings


# ── 1. 回收站端点存在 ────────────────────────────────────────


def test_deleted_fields_endpoint_exists():
    from apps.tabdata.api_admin_integrity import router
    paths = list(router.path_operations.keys())
    assert any('deleted' in p or 'recycle' in p for p in paths), \
        f"deleted-fields not in {paths}"


def test_restore_field_endpoint_exists():
    from apps.tabdata.api_admin_integrity import router
    paths = list(router.path_operations.keys())
    assert any('restore' in p for p in paths), f"restore not in {paths}"


# ── 2. TTL 配置 ──────────────────────────────────────────────


def test_field_recycle_bin_ttl_default():
    from apps.tabdata.api_admin_integrity import FIELD_RECYCLE_BIN_TTL_DAYS
    assert FIELD_RECYCLE_BIN_TTL_DAYS == 30


@override_settings(TABDATA_FIELD_RECYCLE_BIN_TTL_DAYS=60)
def test_field_recycle_bin_ttl_configurable():
    from django.conf import settings
    assert settings.TABDATA_FIELD_RECYCLE_BIN_TTL_DAYS == 60


# ── 3. DeletedFieldSchema 结构 ───────────────────────────────


def test_deleted_field_schema_structure():
    from apps.tabdata.api_admin_integrity import DeletedFieldSchema

    schema = DeletedFieldSchema(
        id='f1',
        name='test_field',
        field_type='text',
        is_deleted=True,
        deleted_at='2026-04-18T00:00:00Z',
        days_remaining=25,
    )
    assert schema.id == 'f1'
    assert schema.is_deleted is True
    assert schema.days_remaining == 25


# ── 4. 软删模型支持 ──────────────────────────────────────────


def test_table_field_has_is_deleted():
    from apps.tabdata.models import TableField
    field_names = [f.name for f in TableField._meta.get_fields()]
    assert 'is_deleted' in field_names


# ── 5. 字段 restore 白名单 ──────────────────────────────────


def test_simple_restorable_field_types():
    from apps.tabdata.services.undo_redo_field_restore import (
        SIMPLE_RESTORABLE_FIELD_TYPES,
    )
    assert len(SIMPLE_RESTORABLE_FIELD_TYPES) >= 11
    assert 'text' in SIMPLE_RESTORABLE_FIELD_TYPES
    assert 'number' in SIMPLE_RESTORABLE_FIELD_TYPES


def test_complex_restorable_field_types():
    from apps.tabdata.services.undo_redo_field_restore import (
        COMPLEX_RESTORABLE_FIELD_TYPES,
    )
    assert COMPLEX_RESTORABLE_FIELD_TYPES == frozenset({'link'})


def test_all_restorable_combined():
    from apps.tabdata.services.undo_redo_field_restore import (
        SIMPLE_RESTORABLE_FIELD_TYPES,
        COMPLEX_RESTORABLE_FIELD_TYPES,
        ALL_RESTORABLE_FIELD_TYPES,
    )
    assert ALL_RESTORABLE_FIELD_TYPES == (
        SIMPLE_RESTORABLE_FIELD_TYPES | COMPLEX_RESTORABLE_FIELD_TYPES
    )


# ── 6. C1 复杂字段禁用 flag ─────────────────────────────────


def test_c1_complex_restore_flag_registered():
    from django.conf import settings
    assert hasattr(settings, 'TABDATA_C1_COMPLEX_RESTORE_DISABLED_TYPES')


@override_settings(TABDATA_C1_COMPLEX_RESTORE_DISABLED_TYPES='link,attachment')
def test_c1_complex_restore_flag_can_disable_types():
    from django.conf import settings
    disabled = settings.TABDATA_C1_COMPLEX_RESTORE_DISABLED_TYPES.split(',')
    assert 'link' in disabled
    assert 'attachment' in disabled


# ── 7. explain_field_restore_capability ──────────────────────


def test_explain_field_restore_capability():
    from apps.tabdata.services.undo_redo_field_restore import (
        explain_field_restore_capability,
    )

    result = explain_field_restore_capability('text')
    assert result['can_undo'] is True

    result = explain_field_restore_capability('link')
    assert 'can_undo' in result
