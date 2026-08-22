"""
P0 修复回归测试

H2-01: 幂等 cache 必须在 persist_changes 成功后才写入，
       持久化失败时重试不应被误判为已处理。
H2-02: changed_pages 中 page 行不存在时应自动创建，
       而非 .update() 静默更新 0 行丢失数据。
"""
import os
import uuid
from contextlib import nullcontext
from threading import Event, Lock, Thread
from unittest.mock import MagicMock, patch, PropertyMock

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402
django.setup()

import pytest  # noqa: E402


class _AtomicFakeCache:
    """只实现本组回归所需的原子 get/add/set/delete 语义。"""

    def __init__(self):
        self._values = {}
        self._lock = Lock()

    def get(self, key):
        with self._lock:
            return self._values.get(key)

    def add(self, key, value, timeout=None):
        with self._lock:
            if key in self._values:
                return False
            self._values[key] = value
            return True

    def set(self, key, value, timeout=None):
        with self._lock:
            self._values[key] = value
            return True

    def delete(self, key):
        with self._lock:
            return self._values.pop(key, None) is not None


# ══════════════════════════════════════════════════════════
# H2-01: collab_persist 幂等 cache 时序
# ══════════════════════════════════════════════════════════

class TestCollabPersistIdempotencyTiming:
    """
    验证 collab_persist 端点的幂等 cache 写入时序：
    cache 只在 persist_changes 成功后写入。
    """

    def _make_request(self, op_id="test-op-1"):
        """构造模拟请求。"""
        req = MagicMock()
        req.headers = {"X-Live-Secret": "collab-live-dev-secret"}
        return req

    def _make_body(self, op_id="test-op-1"):
        body = MagicMock()
        body.op_id = op_id
        body.changes = {"changed_pages": {"p1": {"elements": []}}}
        body.editor_type = "system"  # 跳过用户权限重校验，专注测试幂等缓存逻辑
        body.editor_id = ""
        body.editor_name = "tester"
        body.agent_run_id = ""
        body.system_policy = "trusted_internal"
        return body

    @patch("django.db.transaction.atomic")
    @patch("apps.collab.api._cached_is_debug", return_value=True)
    @patch("apps.collab.api._get_live_secret", return_value="collab-live-dev-secret")
    @patch("apps.collab.api.VersionHistoryService")
    @patch("apps.collab.api.assert_collab_action_allowed")
    @patch("apps.collab.api.cache")
    def test_cache_set_after_persist_success(self, mock_cache, mock_get_adapter, mock_vh_svc, _, __, mock_atomic):
        """persist_changes 成功后 cache 应被写入。"""
        from apps.collab.api import collab_persist

        mock_cache.get.return_value = None
        mock_cache.add.return_value = True

        adapter = MagicMock()
        adapter.persist_changes.return_value = {"version": 2}
        adapter.get_resource.return_value = MagicMock(
            id="res-1", organization_id=None, team_id=None, organization=None,
        )
        adapter.get_version_data.return_value = None  # 跳过 VH 写入
        mock_get_adapter.return_value = MagicMock(
            adapter=adapter,
            resource=adapter.get_resource.return_value,
        )

        req = self._make_request()
        body = self._make_body(op_id="op-success")
        rid = uuid.uuid4()

        result = collab_persist(req, "slide", rid, body)

        assert result["status"] == "ok"
        adapter.persist_changes.assert_called_once()
        mock_cache.add.assert_called_once()
        mock_cache.set.assert_called_once()
        mock_cache.delete.assert_not_called()
        cache_key = mock_cache.set.call_args[0][0]
        assert "op-success" in cache_key
        assert mock_cache.set.call_args[0][1] == {"version": 2}

    @patch("django.db.transaction.atomic")
    @patch("apps.collab.api._cached_is_debug", return_value=True)
    @patch("apps.collab.api._get_live_secret", return_value="collab-live-dev-secret")
    @patch("apps.collab.api.assert_collab_action_allowed")
    @patch("apps.collab.api.cache")
    def test_cache_set_failure_keeps_claim_after_commit(
        self, mock_cache, mock_permission, _, __, mock_atomic,
    ):
        """主事务已提交时，结果缓存失败不能放开同一 op_id 立即重放。"""
        from apps.collab.api import collab_persist

        mock_cache.get.return_value = None
        mock_cache.add.return_value = True
        mock_cache.set.side_effect = ConnectionError("Redis unavailable")
        adapter = MagicMock()
        adapter.persist_changes.return_value = {"version": 2, "skipped": True}
        resource = MagicMock(
            id="res-1", organization_id=None, team_id=None, organization=None,
        )
        mock_permission.return_value = MagicMock(adapter=adapter, resource=resource)

        result = collab_persist(
            self._make_request(),
            "slide",
            uuid.uuid4(),
            self._make_body(op_id="op-cache-set-failed"),
        )

        assert result["status"] == "ok"
        adapter.persist_changes.assert_called_once()
        mock_cache.delete.assert_not_called()

    @patch("apps.collab.api.cache")
    def test_cache_hit_returns_committed_result(self, mock_cache):
        """重试命中缓存时必须返回上次已提交结果，而不是无版本号的假成功。"""
        from apps.collab.api import collab_persist

        committed_result = {"version": 7, "persisted": 1, "created": 0, "deleted": 0}
        mock_cache.get.return_value = committed_result

        req = self._make_request()
        body = self._make_body(op_id="op-committed")
        result = collab_persist(req, "slide", uuid.uuid4(), body)

        assert result == {"status": "ok", "data": committed_result}
        mock_cache.add.assert_not_called()
        mock_cache.set.assert_not_called()

    @patch("apps.collab.api.cache")
    def test_legacy_truthy_marker_fails_closed_until_expiry(self, mock_cache):
        """旧 marker 提交状态未知，过期前既不能重放也不能假报成功。"""
        from apps.collab.api import collab_persist

        mock_cache.get.return_value = 1

        result = collab_persist(
            self._make_request(),
            "slide",
            uuid.uuid4(),
            self._make_body(op_id="op-legacy-marker"),
        )

        status, payload = result
        assert status == 503
        assert payload["code"] == "COLLAB_WRITE_BUSY"
        assert payload["retryable"] is True
        mock_cache.add.assert_not_called()
        mock_cache.set.assert_not_called()

    def test_inflight_marker_is_falsey_for_old_instances(self):
        """旧实例的 truthy 成功判断不能把新实例的未提交占位当成功。"""
        from apps.collab.api import _COLLAB_PERSIST_INFLIGHT_MARKER

        assert _COLLAB_PERSIST_INFLIGHT_MARKER is not None
        assert bool(_COLLAB_PERSIST_INFLIGHT_MARKER) is False

    @patch("apps.collab.api._cached_is_debug", return_value=True)
    @patch("apps.collab.api._get_live_secret", return_value="collab-live-dev-secret")
    @patch("apps.collab.api.assert_collab_action_allowed")
    @patch("apps.collab.api.cache")
    def test_inflight_claim_returns_retryable_busy(self, mock_cache, mock_permission, _, __):
        """同一 op_id 正在执行时，后到请求不能再次进入持久化。"""
        from apps.collab.api import (
            _COLLAB_PERSIST_INFLIGHT_MARKER,
            collab_persist,
        )

        mock_cache.get.side_effect = [None, _COLLAB_PERSIST_INFLIGHT_MARKER]
        mock_cache.add.return_value = False
        adapter = MagicMock()
        resource = MagicMock(
            id="res-1", organization_id=None, team_id=None, organization=None,
        )
        mock_permission.return_value = MagicMock(adapter=adapter, resource=resource)

        status, result = collab_persist(
            self._make_request(),
            "slide",
            uuid.uuid4(),
            self._make_body(op_id="op-inflight"),
        )

        assert status == 503
        assert result["code"] == "COLLAB_WRITE_BUSY"
        assert result["retryable"] is True
        adapter.persist_changes.assert_not_called()
        mock_cache.set.assert_not_called()

    @patch("django.db.transaction.atomic")
    @patch("apps.collab.api._cached_is_debug", return_value=True)
    @patch("apps.collab.api._get_live_secret", return_value="collab-live-dev-secret")
    @patch("apps.collab.api.assert_collab_action_allowed")
    def test_concurrent_same_op_id_persists_only_once(
        self, mock_permission, _, __, mock_atomic,
    ):
        """首请求持有占位时，真实并发重试必须 503 且不能二次持久化。"""
        from apps.collab.api import collab_persist

        fake_cache = _AtomicFakeCache()
        first_persist_started = Event()
        allow_first_to_finish = Event()
        outputs = {}
        errors = {}
        adapter = MagicMock()

        def persist_once(*args, **kwargs):
            first_persist_started.set()
            if not allow_first_to_finish.wait(timeout=5):
                raise TimeoutError("test did not release the first persist")
            return {"version": 2}

        adapter.persist_changes.side_effect = persist_once
        resource = MagicMock(
            id="res-1", organization_id=None, team_id=None, organization=None,
        )
        mock_permission.return_value = MagicMock(adapter=adapter, resource=resource)
        mock_atomic.side_effect = lambda *args, **kwargs: nullcontext()

        resource_id = uuid.uuid4()
        first_body = self._make_body(op_id="op-concurrent")
        second_body = self._make_body(op_id="op-concurrent")
        first_body.skip_version_history = True
        second_body.skip_version_history = True

        def invoke(name, body):
            try:
                outputs[name] = collab_persist(
                    self._make_request(), "slide", resource_id, body,
                )
            except Exception as exc:  # pragma: no cover - asserted below
                errors[name] = exc

        first = Thread(target=invoke, args=("first", first_body), daemon=True)
        second = Thread(target=invoke, args=("second", second_body), daemon=True)

        with patch("apps.collab.api.cache", fake_cache):
            first.start()
            first_started = first_persist_started.wait(timeout=3)
            second_started = False
            try:
                if first_started:
                    second.start()
                    second_started = True
                    second.join(timeout=3)
            finally:
                allow_first_to_finish.set()
                first.join(timeout=3)
                if second_started and second.is_alive():
                    second.join(timeout=3)

        assert first_started, errors
        assert not first.is_alive()
        assert second_started and not second.is_alive()
        assert errors == {}
        assert outputs["first"] == {"status": "ok", "data": {"version": 2}}
        second_status, second_result = outputs["second"]
        assert second_status == 503
        assert second_result["code"] == "COLLAB_WRITE_BUSY"
        assert second_result["retryable"] is True
        adapter.persist_changes.assert_called_once()

    @patch("django.db.transaction.atomic")
    @patch("apps.collab.api._cached_is_debug", return_value=True)
    @patch("apps.collab.api._get_live_secret", return_value="collab-live-dev-secret")
    @patch("apps.collab.api.assert_collab_action_allowed")
    @patch("apps.collab.api.cache")
    def test_conflict_releases_inflight_claim(self, mock_cache, mock_permission, _, __, mock_atomic):
        """版本冲突不是已提交成功，必须释放占位供客户端重试。"""
        from apps.collab.api import collab_persist

        mock_cache.get.return_value = None
        mock_cache.add.return_value = True
        adapter = MagicMock()
        adapter.persist_changes.return_value = {
            "conflict": True,
            "current_version": 4,
        }
        resource = MagicMock(
            id="res-1", organization_id=None, team_id=None, organization=None,
        )
        mock_permission.return_value = MagicMock(adapter=adapter, resource=resource)

        result = collab_persist(
            self._make_request(),
            "slide",
            uuid.uuid4(),
            self._make_body(op_id="op-conflict"),
        )

        assert result["data"]["conflict"] is True
        mock_cache.delete.assert_called_once()
        mock_cache.set.assert_not_called()

    @patch("django.db.transaction.atomic")
    @patch("apps.collab.api._cached_is_debug", return_value=True)
    @patch("apps.collab.api._get_live_secret", return_value="collab-live-dev-secret")
    @patch("apps.collab.api.assert_collab_action_allowed")
    @patch("apps.collab.api.cache")
    def test_error_result_is_non_2xx_and_not_cached(self, mock_cache, mock_get_adapter, _, __, mock_atomic):
        """adapter 的错误结果不能被当作已同步，也不能污染幂等缓存。"""
        from apps.collab.api import collab_persist

        mock_cache.get.return_value = None
        mock_cache.add.return_value = True
        adapter = MagicMock()
        adapter.persist_changes.return_value = {"error": "persist failed"}
        adapter.get_resource.return_value = MagicMock(
            id="res-1", organization_id=None, team_id=None, organization=None,
        )
        mock_get_adapter.return_value = MagicMock(
            adapter=adapter,
            resource=adapter.get_resource.return_value,
        )

        status, result = collab_persist(
            self._make_request(),
            "slide",
            uuid.uuid4(),
            self._make_body(op_id="op-error-result"),
        )

        assert status == 500
        assert result["status"] == "error"
        mock_cache.delete.assert_called_once()
        mock_cache.set.assert_not_called()

    @patch("django.db.transaction.atomic")
    @patch("apps.collab.api._cached_is_debug", return_value=True)
    @patch("apps.collab.api._get_live_secret", return_value="collab-live-dev-secret")
    @patch("apps.collab.api.assert_collab_action_allowed")
    @patch("apps.collab.api.cache")
    def test_cache_not_set_on_persist_failure(self, mock_cache, mock_get_adapter, _, __, mock_atomic):
        """persist_changes 抛异常时 cache 不应写入，重试能正常执行。"""
        from apps.collab.api import collab_persist

        mock_cache.get.return_value = None
        mock_cache.add.return_value = True

        adapter = MagicMock()
        adapter.persist_changes.side_effect = RuntimeError("DB write failed")
        adapter.get_resource.return_value = MagicMock(
            id="res-1", organization_id=None, team_id=None, organization=None,
        )
        mock_get_adapter.return_value = MagicMock(
            adapter=adapter,
            resource=adapter.get_resource.return_value,
        )

        req = self._make_request()
        body = self._make_body(op_id="op-fail")
        rid = uuid.uuid4()

        status, result = collab_persist(req, "slide", rid, body)

        assert status == 500
        assert result["status"] == "error"
        mock_cache.delete.assert_called_once()
        mock_cache.set.assert_not_called()

    @patch("django.db.transaction.atomic")
    @patch("apps.collab.api._cached_is_debug", return_value=True)
    @patch("apps.collab.api._get_live_secret", return_value="collab-live-dev-secret")
    @patch("apps.collab.api.assert_collab_action_allowed")
    @patch("apps.collab.api.cache")
    def test_lock_contention_returns_structured_retryable_error(self, mock_cache, mock_permission, _, __, mock_atomic):
        """锁超时快速失败时，调用方能识别为可重试，而不是假成功。"""
        from apps.collab.api import collab_persist

        mock_cache.get.return_value = None
        mock_cache.add.return_value = True
        adapter = MagicMock()
        db_cause = RuntimeError("canceling statement due to lock timeout")
        db_cause.pgcode = "55P03"
        db_error = RuntimeError("database write failed")
        db_error.__cause__ = db_cause
        adapter.persist_changes.side_effect = db_error
        resource = MagicMock(
            id="res-1",
            organization_id=None,
            team_id=None,
            organization=None,
        )
        mock_permission.return_value = MagicMock(adapter=adapter, resource=resource)

        status, result = collab_persist(
            self._make_request(),
            "slide",
            uuid.uuid4(),
            self._make_body(op_id="op-lock-timeout"),
        )

        assert status == 503
        assert result["code"] == "COLLAB_WRITE_BUSY"
        assert result["retryable"] is True
        mock_cache.delete.assert_called_once()
        mock_cache.set.assert_not_called()

    @patch("django.db.transaction.atomic")
    @patch("apps.collab.api._cached_is_debug", return_value=True)
    @patch("apps.collab.api._get_live_secret", return_value="collab-live-dev-secret")
    @patch("apps.collab.api.VersionHistoryService")
    @patch("apps.collab.api.assert_collab_action_allowed")
    @patch("apps.collab.api.cache")
    def test_retry_after_failure_not_deduplicated(self, mock_cache, mock_get_adapter, mock_vh_svc, _, __, mock_atomic):
        """持久化失败后重试时不应返回 deduplicated。"""
        from apps.collab.api import collab_persist

        adapter = MagicMock()
        adapter.get_resource.return_value = MagicMock(
            id="res-1", organization_id=None, team_id=None, organization=None,
        )
        adapter.get_version_data.return_value = None  # 跳过 VH 写入
        mock_get_adapter.return_value = MagicMock(
            adapter=adapter,
            resource=adapter.get_resource.return_value,
        )

        req = self._make_request()
        body = self._make_body(op_id="op-retry")
        rid = uuid.uuid4()
        mock_cache.add.return_value = True

        adapter.persist_changes.side_effect = RuntimeError("DB down")
        mock_cache.get.return_value = None
        collab_persist(req, "slide", rid, body)
        mock_cache.set.assert_not_called()

        adapter.persist_changes.side_effect = None
        adapter.persist_changes.return_value = {"version": 3}
        mock_cache.get.return_value = None
        result = collab_persist(req, "slide", rid, body)

        assert result["status"] == "ok"
        assert result["data"].get("deduplicated") is not True
        mock_cache.set.assert_called_once()

    @patch("django.db.transaction.atomic")
    @patch("apps.collab.api._cached_is_debug", return_value=True)
    @patch("apps.collab.api._get_live_secret", return_value="collab-live-dev-secret")
    @patch("apps.collab.api.assert_collab_action_allowed")
    @patch("apps.collab.api.cache")
    def test_no_op_id_skips_cache(self, mock_cache, mock_get_adapter, _, __, mock_atomic):
        """op_id 为空时不使用幂等缓存。"""
        from apps.collab.api import collab_persist

        adapter = MagicMock()
        adapter.persist_changes.return_value = {"version": 1, "skipped": True}
        adapter.get_resource.return_value = MagicMock(
            id="res-1", organization_id=None, team_id=None, organization=None,
        )
        mock_get_adapter.return_value = MagicMock(
            adapter=adapter,
            resource=adapter.get_resource.return_value,
        )

        req = self._make_request()
        body = self._make_body(op_id="")
        rid = uuid.uuid4()

        collab_persist(req, "slide", rid, body)

        mock_cache.get.assert_not_called()
        mock_cache.add.assert_not_called()
        mock_cache.set.assert_not_called()


# ══════════════════════════════════════════════════════════
# H2-02: SlideCollabAdapter.persist_changes — changed_pages
#         行不存在时 fallback 创建
# ══════════════════════════════════════════════════════════

class TestSlideCollabAdapterChangedPagesFallback:
    """
    验证 changed_pages 的页面行不存在时，
    adapter 会 fallback 到 update_or_create 创建该行，而非静默丢弃。
    """

    def _make_resource(self, project_id="proj-1", version=5):
        resource = MagicMock()
        resource.id = project_id
        resource.latest_version = version
        return resource

    @patch("apps.tabslide.post_save.run_post_save_hooks")
    @patch("apps.tabslide.field_mapping.frontend_page_to_full_defaults")
    @patch("apps.tabslide.field_mapping.frontend_page_to_defaults")
    @patch("apps.tabslide.models.SlidePage")
    @patch("apps.tabslide.models.SlideProject")
    @patch("django.db.transaction.on_commit")
    @patch("django.db.transaction.atomic")
    def test_existing_page_uses_update(
        self,
        mock_atomic,
        mock_on_commit,
        mock_project_model,
        mock_page_model,
        mock_defaults,
        mock_full_defaults,
        mock_post_save,
    ):
        """页面存在时使用 .update() 更新，不触发 fallback 创建。"""
        from apps.collab.adapters.slide import SlideCollabAdapter

        mock_atomic.return_value.__enter__ = MagicMock()
        mock_atomic.return_value.__exit__ = MagicMock(return_value=False)

        resource = self._make_resource(version=5)
        resource.refresh_from_db = MagicMock()

        mock_project_model.objects.using.return_value.filter.return_value.update.return_value = 1
        type(resource).latest_version = PropertyMock(return_value=6)

        mock_defaults.return_value = {"elements_data": [{"id": "e1"}]}

        qs_mock = MagicMock()
        qs_mock.update.return_value = 1
        mock_page_model.objects.using.return_value.filter.return_value = qs_mock

        adapter = SlideCollabAdapter()
        changes = {
            "changed_pages": {"page-1": {"elements": [{"id": "e1"}]}},
        }
        editor_info = {"editor_type": "user", "editor_id": "u1"}

        adapter.persist_changes(resource, changes, editor_info)

        qs_mock.update.assert_called()
        mock_full_defaults.assert_not_called()

    @patch("apps.tabslide.post_save.run_post_save_hooks")
    @patch("apps.tabslide.field_mapping.frontend_page_to_full_defaults")
    @patch("apps.tabslide.field_mapping.frontend_page_to_defaults")
    @patch("apps.tabslide.models.SlidePage")
    @patch("apps.tabslide.models.SlideProject")
    @patch("django.db.transaction.on_commit")
    @patch("django.db.transaction.atomic")
    def test_missing_page_falls_back_to_create(
        self,
        mock_atomic,
        mock_on_commit,
        mock_project_model,
        mock_page_model,
        mock_defaults,
        mock_full_defaults,
        mock_post_save,
    ):
        """页面不存在时应 fallback 到 update_or_create 创建。"""
        from apps.collab.adapters.slide import SlideCollabAdapter

        mock_atomic.return_value.__enter__ = MagicMock()
        mock_atomic.return_value.__exit__ = MagicMock(return_value=False)

        resource = self._make_resource(version=10)
        resource.refresh_from_db = MagicMock()

        mock_project_model.objects.using.return_value.filter.return_value.update.return_value = 1

        # project 来自 select_for_update().filter().first()，需单独设置 latest_version
        mock_project = mock_project_model.objects.using.return_value.select_for_update.return_value.filter.return_value.first.return_value
        mock_project.latest_version = 11
        mock_project.id = "proj-1"

        mock_defaults.return_value = {"elements_data": [{"id": "e2"}]}
        mock_full_defaults.return_value = {
            "elements_data": [{"id": "e2"}],
            "html_source": "",
            "content_format": "json",
            "background": None,
            "master_elements": None,
            "layout_ref": None,
            "remark": "",
            "animations": None,
            "turning_mode": "",
        }

        qs_mock = MagicMock()
        qs_mock.update.return_value = 0
        mock_page_model.objects.using.return_value.filter.return_value = qs_mock
        mock_page_model.objects.using.return_value.update_or_create = MagicMock(
            return_value=(MagicMock(), True)
        )

        adapter = SlideCollabAdapter()
        changes = {
            "changed_pages": {"page-new": {"elements": [{"id": "e2"}], "order": 3}},
        }
        editor_info = {"editor_type": "agent", "editor_id": "a1"}

        adapter.persist_changes(resource, changes, editor_info)

        qs_mock.update.assert_called()
        mock_full_defaults.assert_called_once()
        mock_page_model.objects.using.return_value.update_or_create.assert_called_once()

        uoc_kwargs = mock_page_model.objects.using.return_value.update_or_create.call_args
        assert uoc_kwargs[1]["defaults"]["page_id"] == "page-new"
        assert uoc_kwargs[1]["defaults"]["version"] == 11
        assert uoc_kwargs[1]["defaults"]["order"] == 3.0

    @patch("apps.tabslide.post_save.run_post_save_hooks")
    @patch("apps.tabslide.field_mapping.frontend_page_to_full_defaults")
    @patch("apps.tabslide.field_mapping.frontend_page_to_defaults")
    @patch("apps.tabslide.models.SlidePage")
    @patch("apps.tabslide.models.SlideProject")
    @patch("django.db.transaction.on_commit")
    @patch("django.db.transaction.atomic")
    def test_mixed_existing_and_missing_pages(
        self,
        mock_atomic,
        mock_on_commit,
        mock_project_model,
        mock_page_model,
        mock_defaults,
        mock_full_defaults,
        mock_post_save,
    ):
        """多页混合场景：存在的页面走 update，不存在的走 create。"""
        from apps.collab.adapters.slide import SlideCollabAdapter

        mock_atomic.return_value.__enter__ = MagicMock()
        mock_atomic.return_value.__exit__ = MagicMock(return_value=False)

        resource = self._make_resource(version=20)
        resource.refresh_from_db = MagicMock()

        mock_project_model.objects.using.return_value.filter.return_value.update.return_value = 1
        type(resource).latest_version = PropertyMock(return_value=21)

        update_results = {"page-exist": 1, "page-ghost": 0}
        call_count = {"n": 0}

        def side_effect_update(**kwargs):
            page_ids = list(update_results.keys())
            pid = page_ids[call_count["n"]]
            call_count["n"] += 1
            return update_results[pid]

        qs_mock = MagicMock()
        qs_mock.update.side_effect = side_effect_update
        mock_page_model.objects.using.return_value.filter.return_value = qs_mock
        mock_page_model.objects.using.return_value.update_or_create = MagicMock(
            return_value=(MagicMock(), True)
        )

        mock_defaults.return_value = {"elements_data": []}
        mock_full_defaults.return_value = {
            "elements_data": [],
            "html_source": "",
            "content_format": "json",
            "background": None,
            "master_elements": None,
            "layout_ref": None,
            "remark": "",
            "animations": None,
            "turning_mode": "",
        }

        adapter = SlideCollabAdapter()
        changes = {
            "changed_pages": {
                "page-exist": {"elements": []},
                "page-ghost": {"elements": [], "order": 5},
            },
        }
        editor_info = {"editor_type": "user", "editor_id": "u1"}

        adapter.persist_changes(resource, changes, editor_info)

        assert qs_mock.update.call_count == 2
        mock_full_defaults.assert_called_once()
        mock_page_model.objects.using.return_value.update_or_create.assert_called_once()
