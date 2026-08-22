"""TabData field API B7 契约（TDA-15 / TDA-16）

- TDA-15: ``PUT /api/tabdata/fields/{id}`` 拒绝 field_type / type（须走 convert）
- TDA-16: select/multi_select options 只接受 canonical ``choices``
"""
from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

from django.test import SimpleTestCase
from pydantic import ValidationError

from apps.tabdata.schemas import TableFieldUpdate
from apps.tabdata.utils.field_types import MultiSelectField, SelectField


def _make_user_namespace(user_id: str = "11111111-1111-1111-1111-111111111111"):
    return SimpleNamespace(
        id=user_id,
        pk=user_id,
        is_authenticated=True,
        is_active=True,
    )


class TestTableFieldUpdateRejectsTypeChange(SimpleTestCase):
    """TDA-15: update schema 显式拒绝类型变更，避免静默丢弃。"""

    def test_rejects_field_type(self):
        with self.assertRaises(ValidationError) as ctx:
            TableFieldUpdate.model_validate({"field_type": "select"})
        self.assertIn("convert", str(ctx.exception).lower())

    def test_rejects_type_alias(self):
        with self.assertRaises(ValidationError) as ctx:
            TableFieldUpdate.model_validate({"type": "number"})
        self.assertIn("convert", str(ctx.exception).lower())

    def test_allows_name_only(self):
        payload = TableFieldUpdate.model_validate({"name": "新列名"})
        self.assertEqual(payload.name, "新列名")


class TestSelectOptionsContract(SimpleTestCase):
    """TDA-16/#904: select/multi_select 只保留 options.choices 一种契约。"""

    def test_select_validate_options_from_choices_shape(self):
        normalized = SelectField.validate_options({"choices": ["A", "B"]})
        self.assertIsNotNone(normalized)
        self.assertEqual(len(normalized["choices"]), 2)
        self.assertEqual(normalized["choices"][0]["value"], "A")

    def test_multi_select_validate_options_from_choices_shape(self):
        normalized = MultiSelectField.validate_options({"choices": ["X", "Y"]})
        self.assertIsNotNone(normalized)
        values = {c["value"] for c in normalized["choices"]}
        self.assertEqual(values, {"X", "Y"})

    def test_select_rejects_options_alias_key(self):
        with self.assertRaises(ValueError):
            SelectField.validate_options({"options": ["A", "B"]})

    def test_multi_select_rejects_options_alias_key(self):
        with self.assertRaises(ValueError):
            MultiSelectField.validate_options({"options": ["X", "Y"]})


class TestUpdateFieldApiRejectsType(SimpleTestCase):
    """TDA-15: HTTP 层拒绝 field_type/type，而非静默成功。"""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls._auth_patcher = patch(
            "apps.users.auth.permissions.JWTAuth.authenticate",
            return_value=_make_user_namespace(),
        )
        cls._auth_patcher.start()

    @classmethod
    def tearDownClass(cls):
        cls._auth_patcher.stop()
        super().tearDownClass()

    def test_put_field_with_type_returns_validation_error(self):
        field_id = uuid4()
        response = self.client.put(
            f"/api/tabdata/fields/{field_id}",
            data=json.dumps({"type": "select"}),
            content_type="application/json",
            HTTP_AUTHORIZATION="Bearer fake-test-token",
        )
        self.assertEqual(response.status_code, 400)
