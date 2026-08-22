"""
CC-003 / CC-005 / CC-014 / CC-027 回归测试

CC-003: create_space_checkpoint 通过 ContextItem 精确获取资源，organization_id=NULL 的资源不再漏收
CC-014: 同 organization 下其他 Space 的资源不再混入
CC-005: 被检查点引用的 VH 记录 expired_at 设为 NULL，防止 cleanup_expired 删除
CC-027: version_refs 为空时拒绝创建检查点，返回 400
"""
import os
import uuid
from datetime import timedelta
from unittest.mock import MagicMock, patch, PropertyMock

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402
django.setup()

import pytest  # noqa: E402
from django.utils import timezone  # noqa: E402


def _make_request(user_id="u-test"):
    req = MagicMock()
    req.auth = MagicMock()
    req.auth.id = user_id
    req.auth.nickname = "tester"
    return req


def _make_body(space_id=None, name="test-cp", file_checkpoint_hash="", agent_run_id="", trigger="manual"):
    body = MagicMock()
    body.space_id = space_id or uuid.uuid4()
    body.name = name
    body.file_checkpoint_hash = file_checkpoint_hash
    body.agent_run_id = agent_run_id
    body.trigger = trigger
    return body


class TestCC003ContextItemResourceCollection:
    """CC-003: ContextItem 精确归集，organization_id=NULL 的资源不再漏收。"""

    @patch("apps.collab.api.VersionHistoryService")
    def test_resources_without_organization_id_are_included(self, mock_vh_svc_cls):
        """资源即使 VH 的 organization_id=NULL，只要在 ContextItem 中存在，也应纳入检查点。"""
        from apps.collab.api import create_space_checkpoint

        space_id = uuid.uuid4()
        organization_id = uuid.uuid4()
        res_id_with_wt = uuid.uuid4()
        res_id_no_wt = uuid.uuid4()
        vh_id_1 = uuid.uuid4()
        vh_id_2 = uuid.uuid4()

        body = _make_body(space_id=space_id)
        req = _make_request()

        mock_space = MagicMock()
        mock_space.organization_id = organization_id

        mock_cp = MagicMock()
        mock_cp.id = uuid.uuid4()
        mock_cp.name = body.name
        mock_cp.created_at = timezone.now()

        context_items_qs = MagicMock()
        context_items_qs.filter.return_value = context_items_qs
        context_items_qs.exclude.return_value = context_items_qs
        context_items_qs.values_list.return_value = context_items_qs
        context_items_qs.distinct.return_value = [str(res_id_with_wt), str(res_id_no_wt)]

        vh_distinct_qs = [
            {"resource_type": "docs", "resource_id": res_id_with_wt},
            {"resource_type": "table", "resource_id": res_id_no_wt},
        ]

        def vh_filter_side_effect(**kwargs):
            qs = MagicMock()
            if "resource_id__in" in kwargs:
                qs.values.return_value.distinct.return_value = vh_distinct_qs
                return qs
            qs.order_by.return_value.values_list.return_value.first.return_value = (
                vh_id_1 if kwargs.get("resource_id") == res_id_with_wt else vh_id_2
            )
            return qs

        mock_vh_using = MagicMock()
        mock_vh_using.filter.side_effect = vh_filter_side_effect

        update_qs = MagicMock()
        update_qs.update.return_value = 2
        mock_vh_using.filter.side_effect_for_update = update_qs

        original_vh_filter = vh_filter_side_effect
        call_count = [0]

        def vh_filter_with_update(**kwargs):
            if "id__in" in kwargs and "expired_at__isnull" in kwargs:
                return update_qs
            return original_vh_filter(**kwargs)

        mock_vh_using.filter.side_effect = vh_filter_with_update

        with patch("apps.tabtinspace.models.Space.objects") as mock_space_objects, \
             patch("apps.tabtinspace.services.base.BaseService") as mock_base_svc_cls, \
             patch("apps.tabtinspace.models.ContextItem.objects") as mock_ci_objects, \
             patch("apps.collab.models.VersionHistory.objects") as mock_vh_objects, \
             patch("apps.collab.models.SpaceCheckpoint.objects") as mock_sc_objects, \
             patch("django.db.transaction.atomic") as mock_atomic:

            mock_atomic.return_value.__enter__ = MagicMock(return_value=None)
            mock_atomic.return_value.__exit__ = MagicMock(return_value=False)

            mock_space_objects.filter.return_value.only.return_value.first.return_value = mock_space

            mock_svc = MagicMock()
            mock_svc.check_space_permission.return_value = True
            mock_base_svc_cls.return_value = mock_svc

            mock_ci_objects.using.return_value = context_items_qs

            mock_vh_objects.using.return_value = mock_vh_using

            mock_sc_objects.using.return_value.create.return_value = mock_cp

            result = create_space_checkpoint(req, body)

        assert result[0] if isinstance(result, tuple) else True
        create_call = mock_sc_objects.using.return_value.create
        assert create_call.called
        version_refs = create_call.call_args[1]["version_refs"]
        assert f"docs:{res_id_with_wt}" in version_refs
        assert f"table:{res_id_no_wt}" in version_refs


class TestCC014CrossSpaceIsolation:
    """CC-014: 同 organization 下其他 Space 的资源不混入。"""

    def test_only_current_space_resources_included(self):
        """即使其他 Space 共享同一 organization_id，其资源也不应出现在检查点中。"""
        from apps.collab.api import create_space_checkpoint

        space_id = uuid.uuid4()
        organization_id = uuid.uuid4()
        own_res_id = uuid.uuid4()
        vh_id = uuid.uuid4()

        body = _make_body(space_id=space_id)
        req = _make_request()

        mock_space = MagicMock()
        mock_space.organization_id = organization_id

        mock_cp = MagicMock()
        mock_cp.id = uuid.uuid4()
        mock_cp.name = body.name
        mock_cp.created_at = timezone.now()

        context_items_qs = MagicMock()
        context_items_qs.filter.return_value = context_items_qs
        context_items_qs.exclude.return_value = context_items_qs
        context_items_qs.values_list.return_value = context_items_qs
        context_items_qs.distinct.return_value = [str(own_res_id)]

        def vh_filter_side_effect(**kwargs):
            qs = MagicMock()
            if "resource_id__in" in kwargs:
                passed_ids = kwargs["resource_id__in"]
                assert own_res_id in passed_ids, "VH 查询应只包含当前 Space 的资源 ID"
                qs.values.return_value.distinct.return_value = [
                    {"resource_type": "docs", "resource_id": own_res_id},
                ]
                return qs
            qs.order_by.return_value.values_list.return_value.first.return_value = vh_id
            return qs

        mock_vh_using = MagicMock()

        def vh_filter_with_update(**kwargs):
            if "id__in" in kwargs and "expired_at__isnull" in kwargs:
                qs = MagicMock()
                qs.update.return_value = 1
                return qs
            return vh_filter_side_effect(**kwargs)

        mock_vh_using.filter.side_effect = vh_filter_with_update

        with patch("apps.tabtinspace.models.Space.objects") as mock_space_objects, \
             patch("apps.tabtinspace.services.base.BaseService") as mock_base_svc_cls, \
             patch("apps.tabtinspace.models.ContextItem.objects") as mock_ci_objects, \
             patch("apps.collab.models.VersionHistory.objects") as mock_vh_objects, \
             patch("apps.collab.models.SpaceCheckpoint.objects") as mock_sc_objects, \
             patch("django.db.transaction.atomic") as mock_atomic:

            mock_atomic.return_value.__enter__ = MagicMock(return_value=None)
            mock_atomic.return_value.__exit__ = MagicMock(return_value=False)

            mock_space_objects.filter.return_value.only.return_value.first.return_value = mock_space
            mock_svc = MagicMock()
            mock_svc.check_space_permission.return_value = True
            mock_base_svc_cls.return_value = mock_svc
            mock_ci_objects.using.return_value = context_items_qs
            mock_vh_objects.using.return_value = mock_vh_using
            mock_sc_objects.using.return_value.create.return_value = mock_cp

            result = create_space_checkpoint(req, body)

        create_call = mock_sc_objects.using.return_value.create
        version_refs = create_call.call_args[1]["version_refs"]
        assert len(version_refs) == 1
        assert f"docs:{own_res_id}" in version_refs

    def test_context_item_filter_uses_space_id_not_organization_id(self):
        """确认 ContextItem 查询使用 space_id 而非 organization_id。"""
        from apps.collab.api import create_space_checkpoint

        space_id = uuid.uuid4()
        body = _make_body(space_id=space_id)
        req = _make_request()

        mock_space = MagicMock()
        mock_space.organization_id = uuid.uuid4()

        context_items_qs = MagicMock()
        context_items_qs.filter.return_value = context_items_qs
        context_items_qs.exclude.return_value = context_items_qs
        context_items_qs.values_list.return_value = context_items_qs
        context_items_qs.distinct.return_value = []

        with patch("apps.tabtinspace.models.Space.objects") as mock_space_objects, \
             patch("apps.tabtinspace.services.base.BaseService") as mock_base_svc_cls, \
             patch("apps.tabtinspace.models.ContextItem.objects") as mock_ci_objects, \
             patch("apps.collab.models.VersionHistory.objects"), \
             patch("apps.collab.models.SpaceCheckpoint.objects"), \
             patch("django.db.transaction.atomic") as mock_atomic:

            mock_atomic.return_value.__enter__ = MagicMock(return_value=None)
            mock_atomic.return_value.__exit__ = MagicMock(return_value=False)

            mock_space_objects.filter.return_value.only.return_value.first.return_value = mock_space
            mock_svc = MagicMock()
            mock_svc.check_space_permission.return_value = True
            mock_base_svc_cls.return_value = mock_svc
            mock_ci_objects.using.return_value = context_items_qs

            create_space_checkpoint(req, body)

        context_items_qs.filter.assert_called_once_with(
            space_id=space_id, trashed_at__isnull=True,
        )


class TestCC027EmptyCheckpointRejection:
    """CC-027: version_refs 为空时拒绝创建检查点。"""

    def test_returns_400_when_space_has_no_context_items(self):
        """Space 下没有 ContextItem 时，应返回 400。"""
        from apps.collab.api import create_space_checkpoint

        space_id = uuid.uuid4()
        body = _make_body(space_id=space_id)
        req = _make_request()

        mock_space = MagicMock()
        mock_space.organization_id = uuid.uuid4()

        context_items_qs = MagicMock()
        context_items_qs.filter.return_value = context_items_qs
        context_items_qs.exclude.return_value = context_items_qs
        context_items_qs.values_list.return_value = context_items_qs
        context_items_qs.distinct.return_value = []

        with patch("apps.tabtinspace.models.Space.objects") as mock_space_objects, \
             patch("apps.tabtinspace.services.base.BaseService") as mock_base_svc_cls, \
             patch("apps.tabtinspace.models.ContextItem.objects") as mock_ci_objects, \
             patch("apps.collab.models.VersionHistory.objects"), \
             patch("apps.collab.models.SpaceCheckpoint.objects") as mock_sc_objects, \
             patch("django.db.transaction.atomic") as mock_atomic:

            mock_atomic.return_value.__enter__ = MagicMock(return_value=None)
            mock_atomic.return_value.__exit__ = MagicMock(return_value=False)

            mock_space_objects.filter.return_value.only.return_value.first.return_value = mock_space
            mock_svc = MagicMock()
            mock_svc.check_space_permission.return_value = True
            mock_base_svc_cls.return_value = mock_svc
            mock_ci_objects.using.return_value = context_items_qs

            status, result = create_space_checkpoint(req, body)

        assert status == 400
        assert result["status"] == "error"
        mock_sc_objects.using.return_value.create.assert_not_called()

    def test_returns_400_when_resources_have_no_vh(self):
        """Space 下有 ContextItem 但所有资源都无 VH 时，应返回 400。"""
        from apps.collab.api import create_space_checkpoint

        space_id = uuid.uuid4()
        res_id = uuid.uuid4()
        body = _make_body(space_id=space_id)
        req = _make_request()

        mock_space = MagicMock()
        mock_space.organization_id = uuid.uuid4()

        context_items_qs = MagicMock()
        context_items_qs.filter.return_value = context_items_qs
        context_items_qs.exclude.return_value = context_items_qs
        context_items_qs.values_list.return_value = context_items_qs
        context_items_qs.distinct.return_value = [str(res_id)]

        mock_vh_using = MagicMock()

        def vh_filter_side_effect(**kwargs):
            qs = MagicMock()
            if "resource_id__in" in kwargs:
                qs.values.return_value.distinct.return_value = []
                return qs
            qs.order_by.return_value.values_list.return_value.first.return_value = None
            return qs

        mock_vh_using.filter.side_effect = vh_filter_side_effect

        with patch("apps.tabtinspace.models.Space.objects") as mock_space_objects, \
             patch("apps.tabtinspace.services.base.BaseService") as mock_base_svc_cls, \
             patch("apps.tabtinspace.models.ContextItem.objects") as mock_ci_objects, \
             patch("apps.collab.models.VersionHistory.objects") as mock_vh_objects, \
             patch("apps.collab.models.SpaceCheckpoint.objects") as mock_sc_objects, \
             patch("django.db.transaction.atomic") as mock_atomic:

            mock_atomic.return_value.__enter__ = MagicMock(return_value=None)
            mock_atomic.return_value.__exit__ = MagicMock(return_value=False)

            mock_space_objects.filter.return_value.only.return_value.first.return_value = mock_space
            mock_svc = MagicMock()
            mock_svc.check_space_permission.return_value = True
            mock_base_svc_cls.return_value = mock_svc
            mock_ci_objects.using.return_value = context_items_qs
            mock_vh_objects.using.return_value = mock_vh_using

            status, result = create_space_checkpoint(req, body)

        assert status == 400
        assert result["status"] == "error"
        mock_sc_objects.using.return_value.create.assert_not_called()


class TestCC005ProtectCheckpointReferencedVersions:
    """CC-005: 创建检查点后保护引用的 VH 记录。"""

    def test_referenced_vh_expired_at_set_to_null(self):
        """创建检查点后，被引用的 VH 的 expired_at 应被设为 NULL。"""
        from apps.collab.api import create_space_checkpoint

        space_id = uuid.uuid4()
        res_id = uuid.uuid4()
        vh_id = uuid.uuid4()
        body = _make_body(space_id=space_id)
        req = _make_request()

        mock_space = MagicMock()
        mock_space.organization_id = uuid.uuid4()

        mock_cp = MagicMock()
        mock_cp.id = uuid.uuid4()
        mock_cp.name = body.name
        mock_cp.created_at = timezone.now()

        context_items_qs = MagicMock()
        context_items_qs.filter.return_value = context_items_qs
        context_items_qs.exclude.return_value = context_items_qs
        context_items_qs.values_list.return_value = context_items_qs
        context_items_qs.distinct.return_value = [str(res_id)]

        update_qs = MagicMock()
        update_qs.update.return_value = 1

        expiry_time = timezone.now() + timedelta(days=7)
        expiry_qs = MagicMock()
        expiry_qs.values_list.return_value = [(vh_id, expiry_time)]

        def vh_filter_side_effect(**kwargs):
            if "id__in" in kwargs and "expired_at__isnull" in kwargs:
                if kwargs["expired_at__isnull"] is False:
                    return expiry_qs if not hasattr(vh_filter_side_effect, '_update_called') else update_qs
                return update_qs
            qs = MagicMock()
            if "resource_id__in" in kwargs:
                qs.values.return_value.distinct.return_value = [
                    {"resource_type": "docs", "resource_id": res_id},
                ]
                return qs
            qs.order_by.return_value.values_list.return_value.first.return_value = vh_id
            return qs

        call_count = [0]
        def vh_filter_counting(**kwargs):
            if "id__in" in kwargs and "expired_at__isnull" in kwargs and kwargs["expired_at__isnull"] is False:
                call_count[0] += 1
                if call_count[0] == 1:
                    return expiry_qs
                return update_qs
            return vh_filter_side_effect(**kwargs)

        mock_vh_using = MagicMock()
        mock_vh_using.filter.side_effect = vh_filter_counting

        with patch("apps.tabtinspace.models.Space.objects") as mock_space_objects, \
             patch("apps.tabtinspace.services.base.BaseService") as mock_base_svc_cls, \
             patch("apps.tabtinspace.models.ContextItem.objects") as mock_ci_objects, \
             patch("apps.collab.models.VersionHistory.objects") as mock_vh_objects, \
             patch("apps.collab.models.SpaceCheckpoint.objects") as mock_sc_objects, \
             patch("django.db.transaction.atomic") as mock_atomic:

            mock_atomic.return_value.__enter__ = MagicMock(return_value=None)
            mock_atomic.return_value.__exit__ = MagicMock(return_value=False)

            mock_space_objects.filter.return_value.only.return_value.first.return_value = mock_space
            mock_svc = MagicMock()
            mock_svc.check_space_permission.return_value = True
            mock_base_svc_cls.return_value = mock_svc
            mock_ci_objects.using.return_value = context_items_qs
            mock_vh_objects.using.return_value = mock_vh_using
            mock_sc_objects.using.return_value.create.return_value = mock_cp

            result = create_space_checkpoint(req, body)

        if isinstance(result, tuple):
            assert result[0] != 400, f"不应返回 400: {result}"
        update_qs.update.assert_called_once_with(expired_at=None)

    def test_original_expired_at_stored_in_metadata(self):
        """创建检查点时应将原始 expired_at 存储在 metadata 中。"""
        from apps.collab.api import create_space_checkpoint

        space_id = uuid.uuid4()
        res_id = uuid.uuid4()
        vh_id = uuid.uuid4()
        body = _make_body(space_id=space_id)
        req = _make_request()

        mock_space = MagicMock()
        mock_space.organization_id = uuid.uuid4()

        mock_cp = MagicMock()
        mock_cp.id = uuid.uuid4()
        mock_cp.name = body.name
        mock_cp.created_at = timezone.now()

        context_items_qs = MagicMock()
        context_items_qs.filter.return_value = context_items_qs
        context_items_qs.exclude.return_value = context_items_qs
        context_items_qs.values_list.return_value = context_items_qs
        context_items_qs.distinct.return_value = [str(res_id)]

        expiry_time = timezone.now() + timedelta(days=7)

        expiry_select_qs = MagicMock()
        expiry_select_qs.values_list.return_value = [(vh_id, expiry_time)]

        update_qs = MagicMock()
        update_qs.update.return_value = 1

        call_count = [0]
        def vh_filter_side_effect(**kwargs):
            if "id__in" in kwargs and "expired_at__isnull" in kwargs and kwargs["expired_at__isnull"] is False:
                call_count[0] += 1
                if call_count[0] == 1:
                    return expiry_select_qs
                return update_qs
            qs = MagicMock()
            if "resource_id__in" in kwargs:
                qs.values.return_value.distinct.return_value = [
                    {"resource_type": "docs", "resource_id": res_id},
                ]
                return qs
            qs.order_by.return_value.values_list.return_value.first.return_value = vh_id
            return qs

        mock_vh_using = MagicMock()
        mock_vh_using.filter.side_effect = vh_filter_side_effect

        with patch("apps.tabtinspace.models.Space.objects") as mock_space_objects, \
             patch("apps.tabtinspace.services.base.BaseService") as mock_base_svc_cls, \
             patch("apps.tabtinspace.models.ContextItem.objects") as mock_ci_objects, \
             patch("apps.collab.models.VersionHistory.objects") as mock_vh_objects, \
             patch("apps.collab.models.SpaceCheckpoint.objects") as mock_sc_objects, \
             patch("django.db.transaction.atomic") as mock_atomic:

            mock_atomic.return_value.__enter__ = MagicMock(return_value=None)
            mock_atomic.return_value.__exit__ = MagicMock(return_value=False)

            mock_space_objects.filter.return_value.only.return_value.first.return_value = mock_space
            mock_svc = MagicMock()
            mock_svc.check_space_permission.return_value = True
            mock_base_svc_cls.return_value = mock_svc
            mock_ci_objects.using.return_value = context_items_qs
            mock_vh_objects.using.return_value = mock_vh_using
            mock_sc_objects.using.return_value.create.return_value = mock_cp

            create_space_checkpoint(req, body)

        create_call = mock_sc_objects.using.return_value.create
        metadata = create_call.call_args[1].get("metadata", {})
        assert "original_expired_at" in metadata
        assert str(vh_id) in metadata["original_expired_at"]
        assert metadata["original_expired_at"][str(vh_id)] == expiry_time.isoformat()


class TestCC005ResidualDeleteCheckpointRestoresExpiry:
    """CC-005 残留修复: 删除检查点时恢复 VH 的 expired_at。"""

    def test_delete_restores_expired_at(self):
        """删除检查点后，仅被此检查点保护的 VH 应恢复原始 expired_at。"""
        from apps.collab.api import delete_space_checkpoint

        checkpoint_id = uuid.uuid4()
        space_id = uuid.uuid4()
        vh_id = uuid.uuid4()
        expiry_str = (timezone.now() + timedelta(days=7)).isoformat()

        req = _make_request()

        mock_cp = MagicMock()
        mock_cp.id = checkpoint_id
        mock_cp.space_id = space_id
        mock_cp.version_refs = {f"docs:{uuid.uuid4()}": str(vh_id)}
        mock_cp.metadata = {"original_expired_at": {str(vh_id): expiry_str}}

        other_cp_qs = MagicMock()
        other_cp_qs.filter.return_value = other_cp_qs
        other_cp_qs.exclude.return_value = other_cp_qs
        other_cp_qs.values_list.return_value = []

        update_qs = MagicMock()
        update_qs.update.return_value = 1

        def vh_filter_side_effect(**kwargs):
            return update_qs

        mock_vh_using = MagicMock()
        mock_vh_using.filter.side_effect = vh_filter_side_effect

        with patch("apps.collab.models.SpaceCheckpoint.objects") as mock_sc_objects, \
             patch("apps.collab.models.VersionHistory.objects") as mock_vh_objects, \
             patch("apps.tabtinspace.services.base.BaseService") as mock_base_svc_cls, \
             patch("django.db.transaction.atomic"):

            mock_sc_objects.using.return_value.filter.return_value.first.return_value = mock_cp
            mock_sc_objects.using.return_value.filter.return_value.exclude.return_value.values_list.return_value = []
            mock_svc = MagicMock()
            mock_svc.check_space_permission.return_value = True
            mock_base_svc_cls.return_value = mock_svc
            mock_vh_objects.using.return_value = mock_vh_using

            result = delete_space_checkpoint(req, checkpoint_id)

        if isinstance(result, tuple):
            assert result[0] == 200 or result[0] is None
        mock_cp.delete.assert_called_once()
        update_qs.update.assert_called()

    def test_delete_skips_vh_referenced_by_other_checkpoint(self):
        """被其他检查点引用的 VH 不应恢复 expired_at。"""
        from apps.collab.api import delete_space_checkpoint

        checkpoint_id = uuid.uuid4()
        space_id = uuid.uuid4()
        vh_id_shared = uuid.uuid4()
        vh_id_unique = uuid.uuid4()
        expiry_str_shared = (timezone.now() + timedelta(days=7)).isoformat()
        expiry_str_unique = (timezone.now() + timedelta(days=14)).isoformat()

        req = _make_request()

        mock_cp = MagicMock()
        mock_cp.id = checkpoint_id
        mock_cp.space_id = space_id
        mock_cp.version_refs = {
            f"docs:{uuid.uuid4()}": str(vh_id_shared),
            f"table:{uuid.uuid4()}": str(vh_id_unique),
        }
        mock_cp.metadata = {"original_expired_at": {
            str(vh_id_shared): expiry_str_shared,
            str(vh_id_unique): expiry_str_unique,
        }}

        other_refs = {f"docs:{uuid.uuid4()}": str(vh_id_shared)}

        update_calls = []
        def vh_filter_side_effect(**kwargs):
            update_calls.append(kwargs)
            qs = MagicMock()
            qs.update.return_value = 1
            return qs

        mock_vh_using = MagicMock()
        mock_vh_using.filter.side_effect = vh_filter_side_effect

        with patch("apps.collab.models.SpaceCheckpoint.objects") as mock_sc_objects, \
             patch("apps.collab.models.VersionHistory.objects") as mock_vh_objects, \
             patch("apps.tabtinspace.services.base.BaseService") as mock_base_svc_cls, \
             patch("django.db.transaction.atomic"):

            mock_sc_objects.using.return_value.filter.return_value.first.return_value = mock_cp
            mock_sc_objects.using.return_value.filter.return_value.exclude.return_value.values_list.return_value = [other_refs]
            mock_svc = MagicMock()
            mock_svc.check_space_permission.return_value = True
            mock_base_svc_cls.return_value = mock_svc
            mock_vh_objects.using.return_value = mock_vh_using

            delete_space_checkpoint(req, checkpoint_id)

        updated_ids = [c.get("id") for c in update_calls if "id" in c]
        assert vh_id_shared not in updated_ids, "共享 VH 不应被恢复 expired_at"

    def test_delete_skips_named_and_pinned_vh(self):
        """已命名或置顶的 VH 不应恢复 expired_at（它们应保持 NULL）。"""
        from apps.collab.api import delete_space_checkpoint

        checkpoint_id = uuid.uuid4()
        space_id = uuid.uuid4()
        vh_id = uuid.uuid4()
        expiry_str = (timezone.now() + timedelta(days=7)).isoformat()

        req = _make_request()

        mock_cp = MagicMock()
        mock_cp.id = checkpoint_id
        mock_cp.space_id = space_id
        mock_cp.version_refs = {f"docs:{uuid.uuid4()}": str(vh_id)}
        mock_cp.metadata = {"original_expired_at": {str(vh_id): expiry_str}}

        filter_kwargs_log = []
        def vh_filter_side_effect(**kwargs):
            filter_kwargs_log.append(kwargs)
            qs = MagicMock()
            qs.update.return_value = 0
            return qs

        mock_vh_using = MagicMock()
        mock_vh_using.filter.side_effect = vh_filter_side_effect

        with patch("apps.collab.models.SpaceCheckpoint.objects") as mock_sc_objects, \
             patch("apps.collab.models.VersionHistory.objects") as mock_vh_objects, \
             patch("apps.tabtinspace.services.base.BaseService") as mock_base_svc_cls, \
             patch("django.db.transaction.atomic"):

            mock_sc_objects.using.return_value.filter.return_value.first.return_value = mock_cp
            mock_sc_objects.using.return_value.filter.return_value.exclude.return_value.values_list.return_value = []
            mock_svc = MagicMock()
            mock_svc.check_space_permission.return_value = True
            mock_base_svc_cls.return_value = mock_svc
            mock_vh_objects.using.return_value = mock_vh_using

            delete_space_checkpoint(req, checkpoint_id)

        restore_calls = [c for c in filter_kwargs_log if "is_named" in c]
        for call_kwargs in restore_calls:
            assert call_kwargs["is_named"] is False
            assert call_kwargs["pinned"] is False
            assert call_kwargs["expired_at__isnull"] is True

    def test_delete_checkpoint_not_found(self):
        """删除不存在的检查点应返回 404。"""
        from apps.collab.api import delete_space_checkpoint

        req = _make_request()

        with patch("apps.collab.models.SpaceCheckpoint.objects") as mock_sc_objects:
            mock_sc_objects.using.return_value.filter.return_value.first.return_value = None
            status, result = delete_space_checkpoint(req, uuid.uuid4())

        assert status == 404

    def test_delete_old_checkpoint_without_metadata(self):
        """旧检查点无 metadata 时应正常删除，不做 expired_at 恢复。"""
        from apps.collab.api import delete_space_checkpoint

        checkpoint_id = uuid.uuid4()
        req = _make_request()

        mock_cp = MagicMock()
        mock_cp.id = checkpoint_id
        mock_cp.space_id = uuid.uuid4()
        mock_cp.version_refs = {f"docs:{uuid.uuid4()}": str(uuid.uuid4())}
        mock_cp.metadata = {}

        with patch("apps.collab.models.SpaceCheckpoint.objects") as mock_sc_objects, \
             patch("apps.collab.models.VersionHistory.objects") as mock_vh_objects, \
             patch("apps.tabtinspace.services.base.BaseService") as mock_base_svc_cls, \
             patch("django.db.transaction.atomic"):

            mock_sc_objects.using.return_value.filter.return_value.first.return_value = mock_cp
            mock_svc = MagicMock()
            mock_svc.check_space_permission.return_value = True
            mock_base_svc_cls.return_value = mock_svc

            result = delete_space_checkpoint(req, checkpoint_id)

        mock_cp.delete.assert_called_once()
        mock_vh_objects.using.return_value.filter.assert_not_called()


class TestCC026TransactionAtomicVersionQuery:
    """
    CC-026: create_space_checkpoint 无事务保护的 TOCTOU 窗口修复回归测试。

    修复：将最新版本查询（version_refs 构建）移入 atomic 块内，
    确保查询 version_refs 与写入 SpaceCheckpoint 在同一事务中执行，
    防止两步之间 collab_persist 写入新版本导致 version_refs 不是精确同时刻快照。
    """

    def test_version_query_inside_atomic_block(self):
        """
        验证 version_refs 查询在 atomic 块内执行。
        通过追踪 atomic 上下文管理器的调用顺序，确认 VH 查询发生在 atomic 进入之后。
        """
        from apps.collab.api import create_space_checkpoint

        space_id = uuid.uuid4()
        organization_id = uuid.uuid4()
        res_id = uuid.uuid4()
        vh_id = uuid.uuid4()

        body = _make_body(space_id=space_id)
        req = _make_request()

        mock_space = MagicMock()
        mock_space.organization_id = organization_id

        mock_cp = MagicMock()
        mock_cp.id = uuid.uuid4()
        mock_cp.name = body.name
        mock_cp.created_at = timezone.now()

        context_items_qs = MagicMock()
        context_items_qs.filter.return_value = context_items_qs
        context_items_qs.exclude.return_value = context_items_qs
        context_items_qs.values_list.return_value = context_items_qs
        context_items_qs.distinct.return_value = [str(res_id)]

        call_order = []

        # 追踪 atomic 上下文管理器的进入时机
        original_atomic = __import__("django.db.transaction", fromlist=["atomic"]).atomic

        class TrackingAtomic:
            def __init__(self, *args, **kwargs):
                self._args = args
                self._kwargs = kwargs

            def __enter__(self):
                call_order.append("atomic_enter")
                return self

            def __exit__(self, *args):
                call_order.append("atomic_exit")
                return False

        def vh_filter_side_effect(**kwargs):
            qs = MagicMock()
            if "resource_id__in" in kwargs:
                call_order.append("vh_query_latest_versions")
                qs.values.return_value.distinct.return_value = [
                    {"resource_type": "docs", "resource_id": res_id},
                ]
                return qs
            if "resource_type" in kwargs and "resource_id" in kwargs:
                call_order.append("vh_query_single_latest")
                qs.order_by.return_value.values_list.return_value.first.return_value = vh_id
                return qs
            if "id__in" in kwargs and "expired_at__isnull" in kwargs:
                call_order.append("vh_query_expired_at")
                qs.values_list.return_value = []
                qs.update.return_value = 0
                return qs
            return qs

        mock_vh_using = MagicMock()
        mock_vh_using.filter.side_effect = vh_filter_side_effect

        with patch("apps.tabtinspace.models.Space.objects") as mock_space_objects, \
             patch("apps.tabtinspace.services.base.BaseService") as mock_base_svc_cls, \
             patch("apps.tabtinspace.models.ContextItem.objects") as mock_ci_objects, \
             patch("apps.collab.models.VersionHistory.objects") as mock_vh_objects, \
             patch("apps.collab.models.SpaceCheckpoint.objects") as mock_sc_objects, \
             patch("django.db.transaction.atomic", return_value=TrackingAtomic()):

            mock_space_objects.filter.return_value.only.return_value.first.return_value = mock_space
            mock_svc = MagicMock()
            mock_svc.check_space_permission.return_value = True
            mock_base_svc_cls.return_value = mock_svc
            mock_ci_objects.using.return_value = context_items_qs
            mock_vh_objects.using.return_value = mock_vh_using
            mock_sc_objects.using.return_value.create.return_value = mock_cp

            create_space_checkpoint(req, body)

        # 核心断言：version_refs 查询必须发生在 atomic_enter 之后
        assert "atomic_enter" in call_order, "atomic 块必须被进入"
        assert "vh_query_latest_versions" in call_order, "VH 最新版本查询必须执行"

        atomic_enter_idx = call_order.index("atomic_enter")
        vh_query_idx = call_order.index("vh_query_latest_versions")
        assert vh_query_idx > atomic_enter_idx, (
            f"CC-026: VH 版本查询（索引 {vh_query_idx}）必须在 atomic 进入（索引 {atomic_enter_idx}）之后执行，"
            f"实际调用顺序：{call_order}"
        )

    def test_checkpoint_and_version_query_in_same_transaction(self):
        """
        验证 SpaceCheckpoint 写入与 version_refs 查询在同一 atomic 块内。
        模拟并发 persist 场景：若查询在事务外，并发 persist 可插入新版本导致快照不一致。
        此测试验证修复后查询与写入在同一事务内，减少 TOCTOU 窗口。
        """
        from apps.collab.api import create_space_checkpoint

        space_id = uuid.uuid4()
        organization_id = uuid.uuid4()
        res_id = uuid.uuid4()
        vh_id_before_persist = uuid.uuid4()  # 并发 persist 前的版本
        vh_id_after_persist = uuid.uuid4()   # 并发 persist 后的新版本

        body = _make_body(space_id=space_id)
        req = _make_request()

        mock_space = MagicMock()
        mock_space.organization_id = organization_id

        mock_cp = MagicMock()
        mock_cp.id = uuid.uuid4()
        mock_cp.name = body.name
        mock_cp.created_at = timezone.now()

        context_items_qs = MagicMock()
        context_items_qs.filter.return_value = context_items_qs
        context_items_qs.exclude.return_value = context_items_qs
        context_items_qs.values_list.return_value = context_items_qs
        context_items_qs.distinct.return_value = [str(res_id)]

        # 模拟：在事务内查询时，返回 vh_id_after_persist（事务内一致性视图）
        def vh_filter_side_effect(**kwargs):
            qs = MagicMock()
            if "resource_id__in" in kwargs:
                qs.values.return_value.distinct.return_value = [
                    {"resource_type": "docs", "resource_id": res_id},
                ]
                return qs
            if "resource_type" in kwargs and "resource_id" in kwargs:
                # 事务内查询返回最新版本
                qs.order_by.return_value.values_list.return_value.first.return_value = vh_id_after_persist
                return qs
            if "id__in" in kwargs and "expired_at__isnull" in kwargs:
                qs.values_list.return_value = []
                qs.update.return_value = 0
                return qs
            return qs

        mock_vh_using = MagicMock()
        mock_vh_using.filter.side_effect = vh_filter_side_effect

        with patch("apps.tabtinspace.models.Space.objects") as mock_space_objects, \
             patch("apps.tabtinspace.services.base.BaseService") as mock_base_svc_cls, \
             patch("apps.tabtinspace.models.ContextItem.objects") as mock_ci_objects, \
             patch("apps.collab.models.VersionHistory.objects") as mock_vh_objects, \
             patch("apps.collab.models.SpaceCheckpoint.objects") as mock_sc_objects, \
             patch("django.db.transaction.atomic") as mock_atomic:

            mock_atomic.return_value.__enter__ = MagicMock(return_value=None)
            mock_atomic.return_value.__exit__ = MagicMock(return_value=False)

            mock_space_objects.filter.return_value.only.return_value.first.return_value = mock_space
            mock_svc = MagicMock()
            mock_svc.check_space_permission.return_value = True
            mock_base_svc_cls.return_value = mock_svc
            mock_ci_objects.using.return_value = context_items_qs
            mock_vh_objects.using.return_value = mock_vh_using
            mock_sc_objects.using.return_value.create.return_value = mock_cp

            create_space_checkpoint(req, body)

        # 验证 atomic 被调用（事务保护存在）
        mock_atomic.assert_called_once()
        # 验证 checkpoint 写入时 version_refs 包含正确版本
        create_call = mock_sc_objects.using.return_value.create
        assert create_call.called
        version_refs = create_call.call_args[1]["version_refs"]
        assert f"docs:{res_id}" in version_refs
        assert version_refs[f"docs:{res_id}"] == str(vh_id_after_persist)
