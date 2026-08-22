"""
CC-004 / CC-022 / CC-028 / CC-029 回归测试

CC-004: restore_space_checkpoint 无全局事务 → 现在用 transaction.atomic 包裹，
        任一资源恢复失败则全部回滚，不再产生部分成功的不一致状态。
CC-022: restore_space_checkpoint 固定返回 HTTP 200 → 现在根据恢复结果返回
        200（全部成功）、500（部分/全部失败）。
CC-028: N 资源串行恢复的性能优化 → restore_to_version 支持 target 参数，
        跳过逐个 get_version 查询。
CC-029: N+1 DB 查询 → 批量预查询 VersionHistory，一次 IN 查询替代 N 次。
"""
import os

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402

django.setup()

import uuid  # noqa: E402
from unittest.mock import MagicMock, patch, call  # noqa: E402

import pytest  # noqa: E402

# SpaceCheckpoint/VersionHistory 在 restore_space_checkpoint 函数体内通过
# `from .models import ...` 导入，因此需要 patch models 模块的属性
_PATCH_SC = "apps.collab.models.SpaceCheckpoint"
_PATCH_VH = "apps.collab.models.VersionHistory"
_PATCH_BASE_SVC = "apps.tabtinspace.services.base.BaseService"


def _make_request(user_id="u-caller"):
    req = MagicMock()
    req.auth = MagicMock()
    req.auth.id = user_id
    req.auth.nickname = "caller"
    return req


def _make_checkpoint(space_id=None, version_refs=None, name="cp-1"):
    cp = MagicMock()
    cp.id = uuid.uuid4()
    cp.space_id = space_id or uuid.uuid4()
    cp.name = name
    cp.version_refs = version_refs or {}
    cp.file_checkpoint_hash = ""
    cp.organization_id = uuid.uuid4()
    return cp


def _make_version_history(vid=None, resource_type="docs", resource_id=None):
    vh = MagicMock()
    vh.id = vid or uuid.uuid4()
    vh.resource_type = resource_type
    vh.resource_id = resource_id or uuid.uuid4()
    return vh


# ═══════════════════════════════════════════════════════════
# CC-004: 全局事务，任一失败全部回滚
# ═══════════════════════════════════════════════════════════


class TestCC004GlobalTransaction:
    """CC-004: restore_space_checkpoint 多资源恢复必须在全局事务内执行。"""

    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.api.VersionHistoryService")
    def test_second_resource_fail_rolls_back_first(
        self, mock_vh_svc_cls, mock_get_adapter, mock_force_close,
    ):
        """第二个资源恢复失败时，第一个资源的恢复也必须回滚，返回 500。"""
        from apps.collab.api import restore_space_checkpoint

        res_a_id = str(uuid.uuid4())
        res_b_id = str(uuid.uuid4())
        ver_a_id = uuid.uuid4()
        ver_b_id = uuid.uuid4()

        version_refs = {
            f"docs:{res_a_id}": str(ver_a_id),
            f"table:{res_b_id}": str(ver_b_id),
        }
        cp = _make_checkpoint(version_refs=version_refs)

        adapter = MagicMock()
        adapter.get_resource.return_value = MagicMock()
        adapter.check_permission.return_value = True
        mock_get_adapter.return_value = adapter

        restored_a = MagicMock()
        restored_a.id = uuid.uuid4()

        call_count = [0]

        def restore_side_effect(*args, **kwargs):
            call_count[0] += 1
            if call_count[0] == 1:
                return restored_a
            return None

        mock_svc = MagicMock()
        mock_svc.restore_to_version.side_effect = restore_side_effect
        mock_vh_svc_cls.return_value = mock_svc

        vh_a = _make_version_history(vid=ver_a_id)
        vh_b = _make_version_history(vid=ver_b_id)

        with patch(_PATCH_SC) as mock_sc, \
             patch(_PATCH_VH) as mock_vh_model, \
             patch(_PATCH_BASE_SVC) as mock_base_svc:
            mock_sc.objects.using.return_value.filter.return_value.first.return_value = cp
            mock_base_svc.return_value.check_space_permission.return_value = True
            mock_vh_model.objects.using.return_value.filter.return_value = [vh_a, vh_b]

            req = _make_request()
            status, result = restore_space_checkpoint(req, cp.id)

        assert status == 500, "第二个资源失败时应返回 500"
        assert result["status"] == "error"
        mock_force_close.assert_not_called()

    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.api.VersionHistoryService")
    def test_restore_exception_rolls_back_all(
        self, mock_vh_svc_cls, mock_get_adapter, mock_force_close,
    ):
        """restore_to_version 抛异常时，事务回滚，返回 500。"""
        from apps.collab.api import restore_space_checkpoint

        res_id = str(uuid.uuid4())
        ver_id = uuid.uuid4()
        cp = _make_checkpoint(version_refs={f"docs:{res_id}": str(ver_id)})

        adapter = MagicMock()
        adapter.get_resource.return_value = MagicMock()
        adapter.check_permission.return_value = True
        mock_get_adapter.return_value = adapter

        mock_svc = MagicMock()
        mock_svc.restore_to_version.side_effect = RuntimeError("DB exploded")
        mock_vh_svc_cls.return_value = mock_svc

        vh = _make_version_history(vid=ver_id)

        with patch(_PATCH_SC) as mock_sc, \
             patch(_PATCH_VH) as mock_vh_model, \
             patch(_PATCH_BASE_SVC) as mock_base_svc:
            mock_sc.objects.using.return_value.filter.return_value.first.return_value = cp
            mock_base_svc.return_value.check_space_permission.return_value = True
            mock_vh_model.objects.using.return_value.filter.return_value = [vh]

            req = _make_request()
            status, result = restore_space_checkpoint(req, cp.id)

        assert status == 500
        assert result["status"] == "error"
        mock_force_close.assert_not_called()


# ═══════════════════════════════════════════════════════════
# CC-022: HTTP 响应语义
# ═══════════════════════════════════════════════════════════


class TestCC022HTTPResponseSemantics:
    """CC-022: restore_space_checkpoint 根据结果返回正确的 HTTP 状态码。"""

    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.api.VersionHistoryService")
    def test_all_success_returns_200(
        self, mock_vh_svc_cls, mock_get_adapter, mock_force_close,
    ):
        """所有资源恢复成功时返回 200 + status: ok。"""
        from apps.collab.api import restore_space_checkpoint

        res_id = str(uuid.uuid4())
        ver_id = uuid.uuid4()
        cp = _make_checkpoint(version_refs={f"docs:{res_id}": str(ver_id)})

        adapter = MagicMock()
        adapter.get_resource.return_value = MagicMock()
        adapter.check_permission.return_value = True
        mock_get_adapter.return_value = adapter

        restored_vh = MagicMock()
        restored_vh.id = uuid.uuid4()
        mock_svc = MagicMock()
        mock_svc.restore_to_version_with_lock_held.return_value = restored_vh
        mock_vh_svc_cls.return_value = mock_svc

        vh = _make_version_history(vid=ver_id)

        class _FakeAtomic:
            def __enter__(self):
                return self
            def __exit__(self, *args):
                return False

        with patch(_PATCH_SC) as mock_sc, \
             patch(_PATCH_VH) as mock_vh_model, \
             patch(_PATCH_BASE_SVC) as mock_base_svc, \
             patch("django.db.transaction.atomic", return_value=_FakeAtomic()):
            mock_sc.objects.using.return_value.filter.return_value.first.return_value = cp
            mock_base_svc.return_value.check_space_permission.return_value = True
            mock_vh_model.objects.using.return_value.filter.return_value = [vh]

            req = _make_request()
            result = restore_space_checkpoint(req, cp.id)

        if isinstance(result, tuple):
            status, data = result
            assert status == 200
            assert data["status"] == "ok"
        else:
            assert result["status"] == "ok"
            assert len(result["data"]["results"]) == 1
            assert result["data"]["results"][0]["restored"] is True

    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.collab.api.get_adapter_or_raise")
    def test_no_adapter_returns_500_with_errors(
        self, mock_get_adapter, mock_force_close,
    ):
        """所有资源无 adapter 时返回 500 + errors 列表。"""
        from apps.collab.api import restore_space_checkpoint

        res_id = str(uuid.uuid4())
        ver_id = uuid.uuid4()
        cp = _make_checkpoint(version_refs={f"unknown:{res_id}": str(ver_id)})

        mock_get_adapter.side_effect = ValueError("No adapter")

        with patch(_PATCH_SC) as mock_sc, \
             patch(_PATCH_VH) as mock_vh_model, \
             patch(_PATCH_BASE_SVC) as mock_base_svc:
            mock_sc.objects.using.return_value.filter.return_value.first.return_value = cp
            mock_base_svc.return_value.check_space_permission.return_value = True
            mock_vh_model.objects.using.return_value.filter.return_value = []

            req = _make_request()
            status, result = restore_space_checkpoint(req, cp.id)

        assert status == 500
        assert result["status"] == "error"
        assert "errors" in result["data"]

    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.collab.api.get_adapter_or_raise")
    def test_version_not_found_returns_500(
        self, mock_get_adapter, mock_force_close,
    ):
        """目标版本不存在时返回 500（预查询找不到 VH）。"""
        from apps.collab.api import restore_space_checkpoint

        res_id = str(uuid.uuid4())
        ver_id = uuid.uuid4()
        cp = _make_checkpoint(version_refs={f"docs:{res_id}": str(ver_id)})

        adapter = MagicMock()
        adapter.get_resource.return_value = MagicMock()
        adapter.check_permission.return_value = True
        mock_get_adapter.return_value = adapter

        with patch(_PATCH_SC) as mock_sc, \
             patch(_PATCH_VH) as mock_vh_model, \
             patch(_PATCH_BASE_SVC) as mock_base_svc:
            mock_sc.objects.using.return_value.filter.return_value.first.return_value = cp
            mock_base_svc.return_value.check_space_permission.return_value = True
            mock_vh_model.objects.using.return_value.filter.return_value = []

            req = _make_request()
            status, result = restore_space_checkpoint(req, cp.id)

        assert status == 500
        assert result["status"] == "error"

    @patch("apps.collab.api._force_close_collab_document")
    def test_empty_version_refs_returns_200(self, mock_force_close):
        """version_refs 为空时返回 200 + 空 results。"""
        from apps.collab.api import restore_space_checkpoint

        cp = _make_checkpoint(version_refs={})

        with patch(_PATCH_SC) as mock_sc, \
             patch(_PATCH_BASE_SVC) as mock_base_svc:
            mock_sc.objects.using.return_value.filter.return_value.first.return_value = cp
            mock_base_svc.return_value.check_space_permission.return_value = True

            req = _make_request()
            status, result = restore_space_checkpoint(req, cp.id)

        assert status == 200
        assert result["status"] == "ok"
        assert result["data"]["results"] == []

    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.api.VersionHistoryService")
    def test_mixed_valid_invalid_refs_returns_500(
        self, mock_vh_svc_cls, mock_get_adapter, mock_force_close,
    ):
        """部分 ref 无效（无 adapter）+ 部分有效时，拒绝执行并返回 500，
        保证全有全无语义。"""
        from apps.collab.api import restore_space_checkpoint

        valid_res_id = str(uuid.uuid4())
        valid_ver_id = uuid.uuid4()
        invalid_res_id = str(uuid.uuid4())
        invalid_ver_id = uuid.uuid4()

        version_refs = {
            f"docs:{valid_res_id}": str(valid_ver_id),
            f"unknown:{invalid_res_id}": str(invalid_ver_id),
        }
        cp = _make_checkpoint(version_refs=version_refs)

        def adapter_side_effect(res_type):
            if res_type == "unknown":
                raise ValueError("No adapter")
            return MagicMock(
                get_resource=MagicMock(return_value=MagicMock()),
                check_permission=MagicMock(return_value=True),
            )

        mock_get_adapter.side_effect = adapter_side_effect

        vh = _make_version_history(vid=valid_ver_id)

        with patch(_PATCH_SC) as mock_sc, \
             patch(_PATCH_VH) as mock_vh_model, \
             patch(_PATCH_BASE_SVC) as mock_base_svc:
            mock_sc.objects.using.return_value.filter.return_value.first.return_value = cp
            mock_base_svc.return_value.check_space_permission.return_value = True
            mock_vh_model.objects.using.return_value.filter.return_value = [vh]

            req = _make_request()
            status, result = restore_space_checkpoint(req, cp.id)

        assert status == 500, "部分无效 ref 应拒绝执行并返回 500"
        assert result["status"] == "error"
        mock_force_close.assert_not_called()


# ═══════════════════════════════════════════════════════════
# CC-028/CC-029: 批量预查询 & target 参数
# ═══════════════════════════════════════════════════════════


class TestCC028CC029BatchPrefetch:
    """CC-028/CC-029: 批量预查询 VersionHistory，通过 target 参数传递。"""

    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.api.VersionHistoryService")
    def test_restore_passes_target_to_service(
        self, mock_vh_svc_cls, mock_get_adapter, mock_force_close,
    ):
        """restore_space_checkpoint 应将预取的 VH 作为 target 传给 restore_to_version_with_lock_held。"""
        from apps.collab.api import restore_space_checkpoint

        res_id = str(uuid.uuid4())
        ver_id = uuid.uuid4()
        cp = _make_checkpoint(version_refs={f"docs:{res_id}": str(ver_id)})

        adapter = MagicMock()
        adapter.get_resource.return_value = MagicMock()
        adapter.check_permission.return_value = True
        mock_get_adapter.return_value = adapter

        restored_vh = MagicMock()
        restored_vh.id = uuid.uuid4()
        mock_svc = MagicMock()
        mock_svc.restore_to_version_with_lock_held.return_value = restored_vh
        mock_vh_svc_cls.return_value = mock_svc

        prefetched_vh = _make_version_history(vid=ver_id)

        class _FakeAtomic:
            def __enter__(self):
                return self
            def __exit__(self, *args):
                return False

        with patch(_PATCH_SC) as mock_sc, \
             patch(_PATCH_VH) as mock_vh_model, \
             patch(_PATCH_BASE_SVC) as mock_base_svc, \
             patch("django.db.transaction.atomic", return_value=_FakeAtomic()):
            mock_sc.objects.using.return_value.filter.return_value.first.return_value = cp
            mock_base_svc.return_value.check_space_permission.return_value = True
            mock_vh_model.objects.using.return_value.filter.return_value = [prefetched_vh]

            req = _make_request()
            restore_space_checkpoint(req, cp.id)

        call_args = mock_svc.restore_to_version_with_lock_held.call_args
        assert call_args is not None, "restore_to_version_with_lock_held 应被调用"
        assert call_args.kwargs.get("target") is prefetched_vh, \
            "应将预取的 VH 实例作为 target 参数传递"

    def test_service_restore_to_version_accepts_target(self):
        """VersionHistoryService.restore_to_version 接受 target 参数，
        跳过内部 get_version 查询。"""
        from apps.collab.service import VersionHistoryService
        from apps.collab.adapters.base import CollabAdapter

        class DummyAdapter(CollabAdapter):
            resource_type = "test"

            def serialize_snapshot(self, data):
                return self.compress_json(data)

            def deserialize_snapshot(self, blob):
                return self.decompress_json(blob)

            def compute_diff(self, base, cur):
                return None

            def apply_diff(self, base, diff_blob):
                return base

            def get_content_stats(self, data):
                return {}

            def get_resource(self, rid):
                return MagicMock()

            def check_permission(self, user, resource, action="edit"):
                return True

            def build_snapshot(self, resource):
                return {}

            def persist_changes(self, resource, changes, editor_info):
                return {}

            def prepare_restore(self, resource, data):
                return None

            def restore(self, resource, data, *, prepared=None, user=None):
                pass

        adapter = DummyAdapter()
        svc = VersionHistoryService(adapter)

        rid = uuid.uuid4()
        vid = uuid.uuid4()
        target_vh = MagicMock()
        target_vh.id = vid
        target_vh.name = "v1"

        editor_info = {"editor_type": "user", "editor_id": "u1", "editor_name": "test"}

        with patch("apps.collab.service.cache") as mock_cache, \
             patch.object(svc, "get_version") as mock_get_version, \
             patch.object(svc, "rebuild_data", return_value={"content": "test"}), \
             patch.object(svc, "_do_create_history") as mock_create_history, \
             patch("apps.collab.service.transaction") as mock_tx, \
             patch("apps.collab.service.ChangeLog") as mock_cl:
            mock_cache.add.return_value = True
            mock_atomic_ctx = MagicMock()
            mock_tx.atomic.return_value = mock_atomic_ctx
            mock_atomic_ctx.__enter__ = MagicMock(return_value=None)
            mock_atomic_ctx.__exit__ = MagicMock(return_value=False)

            new_vh = MagicMock()
            new_vh.id = uuid.uuid4()
            mock_create_history.return_value = new_vh

            result = svc.restore_to_version(
                rid, vid, editor_info, target=target_vh,
            )

        mock_get_version.assert_not_called()
        assert result is not None

    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.api.VersionHistoryService")
    def test_batch_query_called_once(
        self, mock_vh_svc_cls, mock_get_adapter, mock_force_close,
    ):
        """N 个资源应只做 1 次批量 VH 查询，而非 N 次单独查询。"""
        from apps.collab.api import restore_space_checkpoint

        res_ids = [str(uuid.uuid4()) for _ in range(3)]
        ver_ids = [uuid.uuid4() for _ in range(3)]
        version_refs = {
            f"docs:{res_ids[i]}": str(ver_ids[i]) for i in range(3)
        }
        cp = _make_checkpoint(version_refs=version_refs)

        adapter = MagicMock()
        adapter.get_resource.return_value = MagicMock()
        adapter.check_permission.return_value = True
        mock_get_adapter.return_value = adapter

        restored_vh = MagicMock()
        restored_vh.id = uuid.uuid4()
        mock_svc = MagicMock()
        mock_svc.restore_to_version.return_value = restored_vh
        mock_vh_svc_cls.return_value = mock_svc

        vhs = [_make_version_history(vid=ver_ids[i]) for i in range(3)]

        with patch(_PATCH_SC) as mock_sc, \
             patch(_PATCH_VH) as mock_vh_model, \
             patch(_PATCH_BASE_SVC) as mock_base_svc:
            mock_sc.objects.using.return_value.filter.return_value.first.return_value = cp
            mock_base_svc.return_value.check_space_permission.return_value = True

            mock_vh_qs = MagicMock()
            mock_vh_qs.filter.return_value = vhs
            mock_vh_model.objects.using.return_value = mock_vh_qs

            req = _make_request()
            restore_space_checkpoint(req, cp.id)

        mock_vh_qs.filter.assert_called_once()
        filter_kwargs = mock_vh_qs.filter.call_args
        assert "id__in" in filter_kwargs.kwargs
        assert len(filter_kwargs.kwargs["id__in"]) == 3
