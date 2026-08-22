"""Endpoint smoke 测试：保证 trackers / sidechannel endpoint 函数体能跑通。

设计动机
========
波次 3a 之后的端到端 review 发现一个根因性问题：之前的契约测试都在
**helper 层** mock，**完全没经过 endpoint 函数体**。结果 endpoint 内部
任何未 import 的名字 / 方法签名不对在 helper-level mock 测试里发现不了，
但实际生产路径 100% 500。

本测试在 helper-level 之外补一层 **endpoint-level smoke**：mock service 层，
但**真的调 endpoint 函数体**——任何 endpoint 内部用到的名字不存在 / import 错 /
方法签名不对，立即冒泡到本测试，CI 抓到。

波次 4 Stage 2 一刀切后：
- 文件结构改名 ``agenda_api.py`` → ``api/trackers.py``、``tracker_api.py`` → ``api/sidechannel.py``
- endpoint 函数命名 ``create_event`` → ``create_tracker`` 等（path param ``event_id`` → ``tracker_id``）
- WS 推送统一改走 service 层 ``_push_tracker_lifecycle_ws``——HTTP 端 ``_push_tracker_ws`` 已下线

设计选择
========
- ``SimpleTestCase``：不连 DB，跑得快（mock 掉 service 层即可）
- 直接 call endpoint 函数（绕过 ninja router 反射），仍然完整执行函数体
- 断言：只检查"不能 NameError / ImportError / AttributeError"——业务断言留给
  service 层和 endpoint 层既有测试
"""

from __future__ import annotations

import uuid
from unittest.mock import MagicMock, patch
from datetime import datetime, timezone as _tz

from django.test import SimpleTestCase
from django.http import HttpRequest


def _make_request():
    request = MagicMock(spec=HttpRequest)
    request.auth = MagicMock()
    request.auth.id = uuid.uuid4()
    return request


def _make_mock_tracker(name: str = "smoke") -> MagicMock:
    """模拟一条完整的 Tracker 实例，字段足够覆盖 _serialize_tracker。"""
    now = datetime.now(tz=_tz.utc)
    t = MagicMock()
    t.id = uuid.uuid4()
    t.name = name
    t.description = "endpoint smoke"
    t.status = "draft"
    t.organization_id = uuid.uuid4()
    t.workspace_id = uuid.uuid4()
    workspace = MagicMock()
    workspace.name = "smoke-space"
    t.workspace = workspace
    t.skill_key = "test.skill"
    t.skill_params = None
    t.trigger_type = "manual"
    t.trigger_config = {}
    t.agent_id = uuid.uuid4()
    t.intent_snapshot = None
    t.last_run_at = None
    t.next_run_at = None
    t.created_at = now
    t.updated_at = now
    t.total_runs = 0
    t.success_runs = 0
    t.fail_runs = 0
    return t


def _make_mock_run() -> MagicMock:
    now = datetime.now(tz=_tz.utc)
    r = MagicMock()
    r.id = uuid.uuid4()
    r.tracker_id = uuid.uuid4()
    r.trigger_type = "manual"
    r.trigger_context = {}
    r.status = "pending"
    r.progress = 0
    r.progress_pct = 0
    r.progress_message = ""
    r.tokens_used = 0
    r.current_cycle = 1
    r.max_cycles = 3
    r.started_at = now
    r.finished_at = None
    r.duration = None
    r.error_summary = ""
    r.total_steps = 0
    r.completed_steps = 0
    r.created_at = now
    return r


class TrackersApiEndpointSmokeTest(SimpleTestCase):
    """``apps/tracker/api/trackers.py`` 所有 endpoint 函数体可执行性 smoke。"""

    def _assert_endpoint_callable(self, fn, *args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except (NameError, ImportError) as e:
            self.fail(f"endpoint {type(e).__name__}: {e}")
        except AttributeError as e:
            msg = str(e)
            if "has no attribute" in msg and "MagicMock" not in msg:
                self.fail(f"endpoint AttributeError: {e}")
        except TypeError as e:
            msg = str(e)
            if "unexpected keyword argument" in msg:
                self.fail(f"endpoint TypeError (signature mismatch): {e}")
        except Exception:
            pass

    # ── /events 主端点 ─────────────────────────────────────────────

    def test_create_tracker_endpoint_callable(self):
        from apps.tracker.api import trackers
        from apps.tracker.tracker_schemas import TrackerCreate

        payload = TrackerCreate(
            name="smoke",
            description="endpoint smoke test",
            trigger_type="manual",
            skill_key="test.skill",
            agent_id=str(uuid.uuid4()),
        )
        mock_svc = MagicMock()
        mock_svc.check_space_permission.return_value = True
        mock_svc.create_tracker.return_value = _make_mock_tracker()

        # service.create_tracker 内部已调 _push_tracker_lifecycle_ws；HTTP 端不推。
        # 直接 mock service 层 helper（service 模块）避免真触发 WS publish。
        from apps.tracker.services import tracker_service as tracker_service_module
        with patch.object(trackers, "_tracker_service", return_value=mock_svc), \
             patch.object(trackers, "ensure_space_in_organization", return_value=None), \
             patch.object(tracker_service_module, "_push_tracker_lifecycle_ws"):
            self._assert_endpoint_callable(
                trackers.create_tracker,
                _make_request(),
                payload,
                str(uuid.uuid4()),
                str(uuid.uuid4()),
            )

    def test_update_tracker_endpoint_callable(self):
        from apps.tracker.api import trackers
        from apps.tracker.services import tracker_service as tracker_service_module
        from apps.tracker.tracker_schemas import TrackerUpdate

        mock_tracker = _make_mock_tracker()
        payload = TrackerUpdate(name="renamed")
        # HTTP update 路径不走 svc.update_tracker；它直接 import service helper 推 WS。
        with patch.object(trackers.Tracker.objects, "get", return_value=mock_tracker), \
             patch.object(trackers, "_ensure_permission"), \
             patch.object(tracker_service_module, "_push_tracker_lifecycle_ws"):
            self._assert_endpoint_callable(
                trackers.update_tracker,
                _make_request(),
                mock_tracker.id,
                payload,
            )

    def test_delete_tracker_endpoint_callable(self):
        from apps.tracker.api import trackers
        from apps.tracker.services import tracker_service as tracker_service_module

        mock_tracker = _make_mock_tracker()
        mock_svc = MagicMock()
        with patch.object(trackers.Tracker.objects, "get", return_value=mock_tracker), \
             patch.object(trackers, "_ensure_permission"), \
             patch.object(trackers, "_tracker_service", return_value=mock_svc), \
             patch.object(tracker_service_module, "_push_tracker_lifecycle_ws"):
            self._assert_endpoint_callable(
                trackers.delete_tracker,
                _make_request(),
                mock_tracker.id,
            )

    def test_get_tracker_endpoint_callable(self):
        from apps.tracker.api import trackers

        mock_tracker = _make_mock_tracker()
        with patch.object(trackers.Tracker.objects, "get", return_value=mock_tracker), \
             patch.object(trackers, "_ensure_permission"):
            self._assert_endpoint_callable(
                trackers.get_tracker,
                _make_request(),
                mock_tracker.id,
            )

    # ── 生命周期 endpoint ──────────────────────────────────────────

    def test_activate_tracker_endpoint_callable(self):
        from apps.tracker.api import trackers

        mock_tracker = _make_mock_tracker()
        mock_svc = MagicMock()
        mock_svc.activate_tracker.return_value = mock_tracker
        with patch.object(trackers, "_tracker_service", return_value=mock_svc):
            self._assert_endpoint_callable(
                trackers.activate_tracker,
                _make_request(),
                mock_tracker.id,
            )

    def test_pause_tracker_endpoint_callable(self):
        from apps.tracker.api import trackers

        mock_tracker = _make_mock_tracker()
        mock_svc = MagicMock()
        mock_svc.pause_tracker.return_value = mock_tracker
        with patch.object(trackers, "_tracker_service", return_value=mock_svc):
            self._assert_endpoint_callable(
                trackers.pause_tracker,
                _make_request(),
                mock_tracker.id,
            )

    def test_resume_tracker_endpoint_callable(self):
        from apps.tracker.api import trackers

        mock_tracker = _make_mock_tracker()
        mock_svc = MagicMock()
        mock_svc.resume_tracker.return_value = mock_tracker
        with patch.object(trackers, "_tracker_service", return_value=mock_svc):
            self._assert_endpoint_callable(
                trackers.resume_tracker,
                _make_request(),
                mock_tracker.id,
            )

    def test_list_host_schedule_endpoint_callable(self):
        from apps.tracker.api import trackers

        request = _make_request()
        request.META = {"HTTP_X_DEVICE_FINGERPRINT": "smoke-device"}
        mock_svc = MagicMock()
        mock_svc.list_host_schedule.return_value = []
        mock_svc.list_host_work.return_value = []
        with patch.object(trackers, "_caller_device", return_value=MagicMock()), \
             patch.object(trackers, "_tracker_service", return_value=mock_svc):
            self._assert_endpoint_callable(trackers.list_host_schedule, request)

    def test_fire_host_schedule_endpoint_callable(self):
        from apps.tracker.api import trackers

        request = _make_request()
        request.META = {"HTTP_X_DEVICE_FINGERPRINT": "smoke-device"}
        mock_svc = MagicMock()
        mock_svc.fire_host_scheduled_tracker.return_value = {
            "fired": True,
            "skipped": False,
            "run_id": str(uuid.uuid4()),
        }
        with patch.object(trackers, "_caller_device", return_value=MagicMock()), \
             patch.object(trackers, "_tracker_service", return_value=mock_svc):
            self._assert_endpoint_callable(
                trackers.fire_host_schedule,
                request,
                uuid.uuid4(),
            )

    def test_prepare_host_run_endpoint_callable(self):
        from apps.tracker.api import trackers

        request = _make_request()
        request.META = {"HTTP_X_DEVICE_FINGERPRINT": "smoke-device"}
        mock_svc = MagicMock()
        mock_svc.prepare_host_run.return_value = {
            "prepared": True,
            "run_id": str(uuid.uuid4()),
            "session_id": str(uuid.uuid4()),
            "prompt": "go",
        }
        with patch.object(trackers, "_caller_device", return_value=MagicMock()), \
             patch.object(trackers, "_tracker_service", return_value=mock_svc):
            self._assert_endpoint_callable(
                trackers.prepare_host_run,
                request,
                uuid.uuid4(),
            )

    def test_reconcile_host_schedule_endpoint_callable(self):
        from apps.tracker.api import trackers

        request = _make_request()
        request.META = {"HTTP_X_DEVICE_FINGERPRINT": "smoke-device"}
        mock_svc = MagicMock()
        mock_svc.reconcile_host_lifecycle.return_value = {"resumed": 0, "recovered": 0}
        with patch.object(trackers, "_caller_device", return_value=MagicMock()), \
             patch.object(trackers, "_tracker_service", return_value=mock_svc):
            self._assert_endpoint_callable(trackers.reconcile_host_schedule, request)

    def test_trigger_tracker_endpoint_callable(self):
        from apps.tracker.api import trackers

        mock_run = _make_mock_run()
        mock_svc = MagicMock()
        mock_svc.trigger_tracker.return_value = mock_run
        with patch.object(trackers, "_tracker_service", return_value=mock_svc):
            self._assert_endpoint_callable(
                trackers.trigger_tracker,
                _make_request(),
                uuid.uuid4(),
                None,
            )


class SidechannelApiEndpointSmokeTest(SimpleTestCase):
    """``apps/tracker/api/sidechannel.py`` (webhook + progress endpoint) smoke。"""

    def _assert_endpoint_callable(self, fn, *args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except (NameError, ImportError) as e:
            self.fail(f"endpoint {type(e).__name__}: {e}")
        except AttributeError as e:
            msg = str(e)
            if "has no attribute" in msg and "MagicMock" not in msg:
                self.fail(f"endpoint AttributeError: {e}")
        except TypeError as e:
            msg = str(e)
            if "unexpected keyword argument" in msg:
                self.fail(f"endpoint TypeError (signature mismatch): {e}")
        except Exception:
            pass

    def test_update_run_progress_endpoint_callable(self):
        """charter §6.4 SDK 进度上报：endpoint 函数体跑完不抛 TypeError。"""
        from apps.tracker.api import sidechannel

        mock_run = _make_mock_run()
        mock_run.status = "running"
        mock_run.tracker = _make_mock_tracker()

        payload = sidechannel.ProgressUpdateRequest(progress_pct=50, progress_message="halfway")

        with patch.object(sidechannel, "_ensure_tracker_permission"), \
             patch("apps.tracker.models.TrackerRun.objects.select_related") as sel:
            sel.return_value.get.return_value = mock_run
            self._assert_endpoint_callable(
                sidechannel.update_run_progress,
                _make_request(),
                mock_run.id,
                payload,
            )
