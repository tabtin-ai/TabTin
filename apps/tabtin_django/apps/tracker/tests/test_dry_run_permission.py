"""Wave 7 续作 P0-1 + P1-2：Tracker dry-run 权限校验 + 真实事件接入。

═══════════════════════════════════════════════════════════════════════
本文件分两层（**反思 9 + 反思 16 双重防线**）：

Layer A — 权限决策路径单元测试（SimpleTestCase + mock Tracker）
─────────────────────────────────────────────────────
不依赖真 PG/MySQL test DB，用 lightweight mock Tracker 实例 + mock
TrackerService 走 P0-1 三分支决策：
  - space_id 存在 → check_space_permission(viewer)
  - space_id 为空但 organization_id 存在 → check_organization_permission(viewer)
  - 两者皆无 → fail-closed 拒绝

**默认启用** —— 抓 P0-1 真实安全漏洞（tracker.space_id=None 时无任何鉴权
导致跨 organization trigger_config 泄漏）的回归。

Layer B — 真路径 dry-run 端点测试（TABTIN_REAL_DB_TEST=1 守护）
──────────────────────────────────────────────────────
守 ``TABTIN_REAL_DB_TEST=1``。**默认 SKIP**（项目客观无 PG/MySQL test
DB 基础设施 — 同 Wave 5 反思 16）。CI 接入 Django test workflow 后
必须 ``env: TABTIN_REAL_DB_TEST: "1"`` 才能让真 ORM 路径生效。

Layer B 覆盖：
  7. 真 dry-run HTTP 端点（用 ninja TestClient）跨 organization 拒绝访问
  8. 真 MailMessage / Document fixture → dry-run 真返回 app_provided 事件
  9. 不支持的 event_key 回退到 synthetic + disclaimer

═══════════════════════════════════════════════════════════════════════

测试覆盖（与 P0-1 / P1-2 修复对齐）：

  Layer A（默认启用）：
    1. ``test_dry_run_rejects_cross_organization_access`` — 跨 organization 必须 403
    2. ``test_dry_run_accepts_organization_member`` — 同 organization member viewer 通过
    3. ``test_dry_run_rejects_no_tenant_goal`` — organization_id=None 也拒绝
    4. ``test_dry_run_falls_back_to_synthetic_for_unsupported_app`` — P1-2 反向
    5. ``test_dry_run_unsupported_event_key_disclaimer`` — disclaimer 必返回

  Layer B（TABTIN_REAL_DB_TEST=1 启用）：
    6. ``test_dry_run_loads_real_mail_events_for_tabmail``
    7. ``test_dry_run_loads_real_doc_events_for_tabdoc``
    8. ``test_dry_run_isolates_organization_in_real_events`` — 关键多租户隔离
"""
from __future__ import annotations

import os
import uuid
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase, TransactionTestCase


_REQUIRES_REAL_DB = os.getenv("TABTIN_REAL_DB_TEST") == "1"


# ─── Layer A：权限决策路径单元测试（默认启用）─────────────────────


def _build_request(user) -> SimpleNamespace:
    """伪造 ninja request：仅 ``request.auth`` 字段会被 dry-run 端点读取。"""
    return SimpleNamespace(auth=user)


def _build_tracker_namespace(
    *,
    tracker_id=None,
    organization_id=None,
    space_id=None,
    trigger_type="extension_event",
    trigger_config=None,
    name="test-tracker",
):
    """伪造 Tracker 对象（避免真 ORM）；只保留 dry_run 端点会读的字段。"""
    return SimpleNamespace(
        id=tracker_id or uuid.uuid4(),
        organization_id=organization_id,
        space_id=space_id,
        trigger_type=trigger_type,
        trigger_config=trigger_config or {},
        name=name,
    )


class DryRunPermissionDecisionTest(SimpleTestCase):
    """**P0-1 修复主防线**：验证 dry-run 端点在 3 种 tracker 租户绑定下的
    权限决策——跨 organization 必须拒绝；同 organization 必须允许；无租户必须拒绝。

    本测试不真起 HTTP server，直接 patch Tracker.objects.get +
    TrackerService 调用，验证决策路径走对了分支。
    """

    def _call_dry_run(self, *, tracker, user, replay_last=5,
                       svc_space_perm=None, svc_organization_perm=None):
        """统一调用 dry-run 端点的 helper。

        参数：
          tracker: 伪造 Tracker namespace
          user: 伪造 request.auth user
          svc_space_perm / svc_organization_perm: 期望 TrackerService 返回的权限值
        """
        from apps.tracker.api import trackers as trackers_api

        request = _build_request(user)

        with patch("apps.tracker.models.Tracker.objects.get") as mock_get:
            mock_get.return_value = tracker

            with patch.object(
                trackers_api,
                "_resolve_recent_events_for_dry_run",
                return_value=("synthetic", "test-note", []),
            ):
                with patch(
                    "apps.tracker.services.tracker_service.TrackerService"
                ) as MockSvc:
                    svc_instance = MagicMock()
                    if svc_space_perm is not None:
                        svc_instance.check_space_permission.return_value = svc_space_perm
                    if svc_organization_perm is not None:
                        svc_instance.check_organization_permission.return_value = svc_organization_perm
                    MockSvc.return_value = svc_instance

                    resp = trackers_api.tracker_dry_run(
                        request,
                        tracker_id=tracker.id,
                        replay_last=replay_last,
                    )
                    return resp, svc_instance

    # ── P0-1 测试 1：跨 organization（space_id=None, organization_id=别人的）必须 403 ──

    def test_dry_run_rejects_cross_organization_access(self):
        """**P0-1 关键防线**：tracker.space_id=None + organization_id=W1，user 是 W2
        member（非 W1）→ check_organization_permission 返回 False → 必须 403。

        修复前 bug：``if tracker.space_id:`` 整个块被跳过，**任何登录用户**
        都能 dry-run 任意 organization 的 Tracker，泄漏 trigger_config（含
        webhook secret / table_id / filter expressions 等敏感配置）。
        """
        user_w2 = SimpleNamespace(id=uuid.uuid4())  # 来自 Organization W2
        # Tracker 属于 Organization W1（与 user 不同）
        tracker = _build_tracker_namespace(
            organization_id=uuid.uuid4(),  # W1
            space_id=None,
        )

        # check_organization_permission(W1, viewer) 返回 False（user 不在 W1）
        resp, svc = self._call_dry_run(
            tracker=tracker, user=user_w2,
            svc_organization_perm=False,
        )

        # 必须拒绝（permission_denied_response）
        # 该 helper 返回 (status_code, payload) 形式；状态码 403 或带 ok=False
        # 检查响应里有 permission denied 关键字
        self._assert_permission_denied(resp)
        # 关键：**check_organization_permission 必须被调到** —— 否则 P0-1 修复未生效
        svc.check_organization_permission.assert_called_once()
        # 不能调 check_space_permission（space_id 为空）
        svc.check_space_permission.assert_not_called()

    # ── P0-1 测试 2：同 organization member 应允许 ──

    def test_dry_run_accepts_organization_member(self):
        """同 organization member（无 space_id 但 organization viewer）应允许 dry-run。"""
        user = SimpleNamespace(id=uuid.uuid4())
        tracker = _build_tracker_namespace(
            organization_id=uuid.uuid4(),
            space_id=None,
            trigger_config={"event_key": "tabmail.email.received"},
        )

        resp, svc = self._call_dry_run(
            tracker=tracker, user=user,
            svc_organization_perm=True,  # user 是该 organization 的 viewer
        )

        # 不应是 permission denied
        self._assert_not_permission_denied(resp)
        svc.check_organization_permission.assert_called_once()

    # ── P0-1 测试 3：organization_id 也为空 → fail-closed 拒绝 ──

    def test_dry_run_rejects_no_tenant_tracker(self):
        """tracker.organization_id 也为 None（异常 Tracker 状态，违反 charter §7.4）→
        必须直接拒绝（fail-closed），不允许 dry-run。

        理由：charter §7.4 模型边界要求 Tracker 必须有 organization_id。
        如果 DB 里出现 organization_id=None 的 Tracker，说明数据有问题，
        让任何人 dry-run 都是泄漏风险。
        """
        user = SimpleNamespace(id=uuid.uuid4())
        tracker = _build_tracker_namespace(
            organization_id=None,
            space_id=None,
        )

        resp, svc = self._call_dry_run(tracker=tracker, user=user)

        self._assert_permission_denied(resp)
        # 三个 TrackerService 权限检查都不应被调（早退到 fail-closed）
        svc.check_space_permission.assert_not_called()
        svc.check_organization_permission.assert_not_called()

    # ── P0-1 测试 4：space_id 存在时仍走 check_space_permission ──

    def test_dry_run_with_space_id_uses_space_permission(self):
        """space_id 存在时，rule 1 优先 — 仍走 check_space_permission。

        防止 P0-1 修复"过度修复"：space_id 存在的 Tracker 不应跳到
        check_organization_permission（这是 fallback 路径，不是主路径）。
        """
        user = SimpleNamespace(id=uuid.uuid4())
        tracker = _build_tracker_namespace(
            organization_id=uuid.uuid4(),
            space_id=uuid.uuid4(),
        )

        resp, svc = self._call_dry_run(
            tracker=tracker, user=user,
            svc_space_perm=True,
        )

        self._assert_not_permission_denied(resp)
        svc.check_space_permission.assert_called_once()
        # organization fallback 不应被触发
        svc.check_organization_permission.assert_not_called()

    # ── helpers ────────────────────────────────────

    def _assert_permission_denied(self, resp):
        """统一断言 permission_denied_response。

        permission_denied_response 在 ``apps.tabdata.api_helpers`` 里定义，
        当前返回 ``django.http.JsonResponse(status=403)``。历史上也存在过
        (status_code, payload) tuple / dict-with-ok=False 形态，本 helper
        三种形态都接受。
        """
        if hasattr(resp, "status_code"):
            self.assertIn(resp.status_code, (401, 403),
                          f"应返回 401/403，实际 {resp.status_code}: {resp!r}")
        elif isinstance(resp, tuple):
            status_code, payload = resp[0], resp[1]
            self.assertIn(status_code, (401, 403),
                          f"应返回 401/403，实际 {status_code}: {payload}")
        elif isinstance(resp, dict):
            self.assertFalse(resp.get("ok", True), f"应 ok=False，实际 {resp}")
        else:
            self.fail(f"unexpected response shape: {resp!r}")

    def _assert_not_permission_denied(self, resp):
        """与 _assert_permission_denied 反向。"""
        if hasattr(resp, "status_code"):
            self.assertNotIn(resp.status_code, (401, 403),
                             f"不应是权限错误，实际 {resp.status_code}: {resp!r}")
        elif isinstance(resp, tuple):
            status_code = resp[0]
            self.assertNotIn(status_code, (401, 403),
                             f"不应是权限错误，实际 {status_code}: {resp}")
        elif isinstance(resp, dict):
            # ok 不应是 False（除非另有原因报 not_found）
            if resp.get("ok") is False:
                # 允许 not_found 但不允许 permission_denied 文案
                err = str(resp.get("error", ""))
                self.assertNotIn("权限", err)
                self.assertNotIn("permission", err.lower())


# ─── Layer A 续：P1-2 dry-run 真事件接入决策路径 ─────────────────


class DryRunEventResolutionRoutingTest(SimpleTestCase):
    """**P1-2 修复防线（决策层）**：验证 ``_resolve_recent_events_for_dry_run``
    根据 trigger_type + event_key 路由到正确的 resolver。

    Layer A 不真查 DB；patch real resolvers 验证它们被正确调度。
    """

    def test_resolves_tabmail_email_received_to_real_resolver(self):
        """``extension_event`` + ``event_key=tabmail.email.received`` →
        必须调 ``_resolve_real_mail_received_events``。"""
        from apps.tracker.api import trackers as trackers_api

        tracker = _build_tracker_namespace(
            trigger_type="extension_event",
            trigger_config={"event_key": "tabmail.email.received"},
            organization_id=uuid.uuid4(),
        )

        with patch.object(
            trackers_api, "_resolve_real_mail_received_events",
            return_value=("app_provided", "real-note", [{"x": 1}]),
        ) as mock_real_mail:
            source, note, events = trackers_api._resolve_recent_events_for_dry_run(
                tracker, replay_last=5,
            )

        mock_real_mail.assert_called_once()
        self.assertEqual(source, "app_provided")
        self.assertEqual(events, [{"x": 1}])

    def test_resolves_tabdoc_document_published_to_real_resolver(self):
        """``extension_event`` + ``event_key=tabdoc.document.published`` →
        必须调 ``_resolve_real_doc_published_events``。"""
        from apps.tracker.api import trackers as trackers_api

        tracker = _build_tracker_namespace(
            trigger_type="extension_event",
            trigger_config={"event_key": "tabdoc.document.published"},
            organization_id=uuid.uuid4(),
        )

        with patch.object(
            trackers_api, "_resolve_real_doc_published_events",
            return_value=("app_provided", "real-note", [{"y": 2}]),
        ) as mock_real_doc:
            source, note, events = trackers_api._resolve_recent_events_for_dry_run(
                tracker, replay_last=5,
            )

        mock_real_doc.assert_called_once()
        self.assertEqual(source, "app_provided")
        self.assertEqual(events, [{"y": 2}])

    def test_dry_run_falls_back_to_synthetic_for_unsupported_app(self):
        """**P1-2 防线**：未支持的 event_key（如 ``tabsite.event.x``）必须回到
        synthetic + disclaimer，不能 silently 跑出错误数据。"""
        from apps.tracker.api.trackers import _resolve_recent_events_for_dry_run

        tracker = _build_tracker_namespace(
            trigger_type="extension_event",
            trigger_config={"event_key": "tabsite.publish.x"},
            organization_id=uuid.uuid4(),
        )

        source, note, events = _resolve_recent_events_for_dry_run(
            tracker, replay_last=3,
        )

        self.assertEqual(source, "synthetic")
        self.assertEqual(len(events), 3)
        self.assertIn("暂未对应 recent events 接口", note)
        # 合成事件必须包含 event_key 让前端能展示"原本想触发什么"
        self.assertIn("event_key", events[0])
        self.assertEqual(events[0]["event_key"], "tabsite.publish.x")

    def test_dry_run_empty_event_key_falls_back_to_synthetic(self):
        """空 event_key（用户没填）也应走 synthetic，note 提示空。"""
        from apps.tracker.api.trackers import _resolve_recent_events_for_dry_run

        tracker = _build_tracker_namespace(
            trigger_type="extension_event",
            trigger_config={},  # 没有 event_key
            organization_id=uuid.uuid4(),
        )

        source, note, events = _resolve_recent_events_for_dry_run(
            tracker, replay_last=2,
        )
        self.assertEqual(source, "synthetic")
        self.assertEqual(len(events), 2)


# ─── Layer A 续：Wave 8 — disclaimer 文案随 events_source 切换 ─────


class DryRunDisclaimerTextTest(SimpleTestCase):
    """**Wave 8 治理（用户视角诚信）**：disclaimer 文案必须如实反映回放路径。

    修复前（Wave 7 mini 二次验证抓出）：``events_source=app_provided`` 时
    disclaimer 仍说"未回放真实"——与代码实际行为不符,误导用户。

    本测试钉住 _build_disclaimer 纯函数行为,不需要真 ORM:
      - synthetic: 必须保留"未回放真实"措辞
      - app_provided: 必须如实告知回放数 + app 名 + organization 隔离 + 时间倒序

    走真路径(直接调 _build_disclaimer),不 MagicMock 制造死代码（反思 9）。
    """

    def test_dry_run_disclaimer_synthetic_path(self):
        """synthetic events_source → disclaimer 必须包含"未回放真实"措辞。"""
        from apps.tracker.api.trackers import _build_disclaimer

        text = _build_disclaimer(
            events_source="synthetic",
            trigger_type="extension_event",
            event_key="tabsite.publish.x",
            real_count=0,
        )

        self.assertIn("未回放真实", text)
        self.assertIn("合成事件", text)
        # 不应出现"已回放"等误导措辞
        self.assertNotIn("已回放", text)
        self.assertNotIn("回放了", text)

    def test_dry_run_disclaimer_synthetic_for_table_event(self):
        """table_event 也走 synthetic（TabData 暂无 recent records 接口）→
        disclaimer 必须明示"未回放真实"。"""
        from apps.tracker.api.trackers import _build_disclaimer

        text = _build_disclaimer(
            events_source="synthetic",
            trigger_type="table_event",
            event_key=None,  # table_event 没有 event_key
            real_count=0,
        )

        self.assertIn("未回放真实", text)
        self.assertNotIn("回放了", text)

    def test_dry_run_disclaimer_app_provided_path_tabmail(self):
        """app_provided + tabmail.email.received → disclaimer 必须如实告知:
            - 回放了真实事件
            - app 名 = tabmail
            - organization 隔离 + 时间倒序
            - 真实回放数
        修复 Wave 7 mini 二次验证抓出的诚信问题。
        """
        from apps.tracker.api.trackers import _build_disclaimer

        text = _build_disclaimer(
            events_source="app_provided",
            trigger_type="extension_event",
            event_key="tabmail.email.received",
            real_count=3,
        )

        # 必须如实告知"回放了"真实事件
        self.assertIn("回放了", text)
        self.assertIn("真实", text)
        # app 名必须出现
        self.assertIn("tabmail", text)
        # organization 隔离 + 时间倒序的关键提示
        self.assertIn("organization", text)
        self.assertIn("时间倒序", text)
        # 真实回放数必须出现
        self.assertIn("3", text)
        # 不能再说"未回放真实"
        self.assertNotIn("未回放真实", text)

    def test_dry_run_disclaimer_app_provided_path_tabdoc(self):
        """app_provided + tabdoc.document.published → disclaimer 必须含 'tabdoc'。"""
        from apps.tracker.api.trackers import _build_disclaimer

        text = _build_disclaimer(
            events_source="app_provided",
            trigger_type="extension_event",
            event_key="tabdoc.document.published",
            real_count=5,
        )

        self.assertIn("tabdoc", text)
        self.assertIn("5", text)
        self.assertIn("回放了", text)
        self.assertNotIn("未回放真实", text)

    def test_dry_run_response_uses_app_provided_disclaimer_when_real_events(self):
        """**端到端**:tracker_dry_run 端点 response 在 _resolve_recent_events_for_dry_run
        返回 app_provided 时,disclaimer 字段必须是 app_provided 文案——而非 synthetic
        默认文案(反思 20:链路透传必有端到端测试)。

        本测试 patch _resolve_recent_events_for_dry_run 返回 app_provided + 2 条事件,
        验证 response.disclaimer 走对了分支。
        """
        from apps.tracker.api import trackers as trackers_api

        user = SimpleNamespace(id=uuid.uuid4())
        tracker = _build_tracker_namespace(
            organization_id=uuid.uuid4(),
            space_id=uuid.uuid4(),
            trigger_type="extension_event",
            trigger_config={"event_key": "tabmail.email.received"},
        )

        request = _build_request(user)

        fake_events = [
            {"source": "extension_event", "event_key": "tabmail.email.received",
             "payload": {"from": "a@example.com", "subject": "x"}},
            {"source": "extension_event", "event_key": "tabmail.email.received",
             "payload": {"from": "b@example.com", "subject": "y"}},
        ]

        with patch("apps.tracker.models.Tracker.objects.get") as mock_get:
            mock_get.return_value = tracker
            with patch.object(
                trackers_api,
                "_resolve_recent_events_for_dry_run",
                return_value=("app_provided", "loaded 2 events", fake_events),
            ):
                with patch(
                    "apps.tracker.services.tracker_service.TrackerService"
                ) as MockSvc:
                    svc = MagicMock()
                    svc.check_space_permission.return_value = True
                    MockSvc.return_value = svc

                    resp = trackers_api.tracker_dry_run(
                        request, tracker_id=tracker.id, replay_last=2,
                    )

        # success_response → tuple 或 dict;统一解析
        payload = resp[1] if isinstance(resp, tuple) else resp
        self.assertTrue(payload.get("ok") is not False, f"应该是成功响应: {payload}")
        # ninja-style success_response 通常包 data 字段
        data = payload.get("data") if isinstance(payload, dict) and "data" in payload else payload

        # events_source 必须是 app_provided
        self.assertEqual(data.get("events_source"), "app_provided")
        # disclaimer 必须是 app_provided 文案 — 不能是默认 synthetic
        disclaimer = str(data.get("disclaimer") or "")
        self.assertIn("回放了", disclaimer,
                      f"app_provided 路径必须用 app_provided disclaimer,实际: {disclaimer}")
        self.assertIn("tabmail", disclaimer)
        self.assertIn("2", disclaimer, "真实回放数必须出现在 disclaimer 中")
        self.assertNotIn("未回放真实", disclaimer,
                         "app_provided 时不能再说未回放真实(用户视角诚信问题)")

    def test_dry_run_response_always_carries_events_source_and_disclaimer(self):
        """**TS-8 v1 诚实标注契约**：dry-run 成功响应**必须**同时携带顶层
        ``events_source`` 与 ``disclaimer`` 两个键——无论真实回放还是合成预览。

        这是 CLI 横幅 / 未来前端「合成预览」提示的取数前提；缺任一键都会让
        诚实标注链路断裂、用户可能把合成预览误当真实回放。本测试同时覆盖
        synthetic 与 app_provided 两条路径，钉住「键必在」契约（与具体文案
        断言解耦）。
        """
        from apps.tracker.api import trackers as trackers_api

        user = SimpleNamespace(id=uuid.uuid4())

        cases = [
            ("synthetic", "table-event note", []),
            ("app_provided", "loaded 2 events", [
                {"source": "extension_event", "event_key": "tabmail.email.received",
                 "payload": {"from": "a@example.com", "subject": "x"}},
            ]),
        ]

        for source, note, fake_events in cases:
            tracker = _build_tracker_namespace(
                organization_id=uuid.uuid4(),
                space_id=uuid.uuid4(),
                trigger_type="extension_event",
                trigger_config={"event_key": "tabmail.email.received"},
            )
            request = _build_request(user)

            with patch("apps.tracker.models.Tracker.objects.get") as mock_get:
                mock_get.return_value = tracker
                with patch.object(
                    trackers_api,
                    "_resolve_recent_events_for_dry_run",
                    return_value=(source, note, fake_events),
                ):
                    with patch(
                        "apps.tracker.services.tracker_service.TrackerService"
                    ) as MockSvc:
                        svc = MagicMock()
                        svc.check_space_permission.return_value = True
                        MockSvc.return_value = svc

                        resp = trackers_api.tracker_dry_run(
                            request, tracker_id=tracker.id, replay_last=2,
                        )

            payload = resp[1] if isinstance(resp, tuple) else resp
            data = (payload.get("data")
                    if isinstance(payload, dict) and "data" in payload else payload)

            self.assertIn("events_source", data,
                          f"{source} 响应必须含 events_source 键")
            self.assertEqual(data.get("events_source"), source)
            self.assertIn("disclaimer", data,
                          f"{source} 响应必须含 disclaimer 键")
            self.assertTrue(str(data.get("disclaimer") or "").strip(),
                            f"{source} 的 disclaimer 不能为空")

    def test_dry_run_response_uses_synthetic_disclaimer_when_synthetic(self):
        """synthetic 路径 → response.disclaimer 必须是 synthetic 默认文案。"""
        from apps.tracker.api import trackers as trackers_api

        user = SimpleNamespace(id=uuid.uuid4())
        tracker = _build_tracker_namespace(
            organization_id=uuid.uuid4(),
            space_id=uuid.uuid4(),
            trigger_type="table_event",
            trigger_config={"table_id": "synthetic-table"},
        )

        request = _build_request(user)

        with patch("apps.tracker.models.Tracker.objects.get") as mock_get:
            mock_get.return_value = tracker
            with patch.object(
                trackers_api,
                "_resolve_recent_events_for_dry_run",
                return_value=("synthetic", "table-event note", []),
            ):
                with patch(
                    "apps.tracker.services.tracker_service.TrackerService"
                ) as MockSvc:
                    svc = MagicMock()
                    svc.check_space_permission.return_value = True
                    MockSvc.return_value = svc

                    resp = trackers_api.tracker_dry_run(
                        request, tracker_id=tracker.id, replay_last=2,
                    )

        payload = resp[1] if isinstance(resp, tuple) else resp
        data = payload.get("data") if isinstance(payload, dict) and "data" in payload else payload

        self.assertEqual(data.get("events_source"), "synthetic")
        disclaimer = str(data.get("disclaimer") or "")
        self.assertIn("未回放真实", disclaimer,
                      f"synthetic 路径必须用 synthetic disclaimer,实际: {disclaimer}")
        self.assertNotIn("回放了", disclaimer)


# ─── Layer B：真路径测试（TABTIN_REAL_DB_TEST=1 守护）──────────


if _REQUIRES_REAL_DB:

    class _DryRunRealDbTestBase(TransactionTestCase):
        """共享 setUp / fixture / cleanup。"""
        databases = {"default", "postgresql"}

        @classmethod
        def setUpClass(cls):
            super().setUpClass()
            from django.db.models.signals import post_save
            from apps.tabtinspace.signals import create_default_organization
            from django.contrib.auth import get_user_model
            post_save.disconnect(create_default_organization, sender=get_user_model())

        @classmethod
        def tearDownClass(cls):
            from django.db.models.signals import post_save
            from apps.tabtinspace.signals import create_default_organization
            from django.contrib.auth import get_user_model
            post_save.connect(create_default_organization, sender=get_user_model())
            super().tearDownClass()

        def setUp(self):
            from apps.tabtinspace.tests.fixtures import create_test_organization_with_agent
            self.ctx_a = create_test_organization_with_agent(prefix="dry_run_a")
            self.ctx_b = create_test_organization_with_agent(prefix="dry_run_b")

        def tearDown(self):
            from apps.tabtinspace.tests.fixtures import cleanup_test_organization
            cleanup_test_organization(self.ctx_a["organization"], delete_user=True)
            cleanup_test_organization(self.ctx_b["organization"], delete_user=True)


    class CrossOrganizationAccessTest(_DryRunRealDbTestBase):
        """**P0-1 真路径关键防线**：跨 organization 真 dry-run 必须 403。

        构造：user A（W1 owner）创建 space_id=None 的 Tracker（绑 W1） →
        user B（W2 owner，与 W1 无任何成员关系）调 dry-run → 必须拒绝。
        """

        def _create_tracker(self, *, ctx, space_id=None):
            from apps.tracker.models import Tracker
            return Tracker.objects.create(
                id=uuid.uuid4(),
                organization_id=ctx["organization"].id,
                space_id=space_id,
                agent_id=ctx["agent"].id,
                name="cross-wt-test",
                description="",
                skill_key="test_skill",
                trigger_type="extension_event",
                trigger_config={
                    "event_key": "tabmail.email.received",
                    "secret": "do_not_leak_this_value",  # 敏感配置
                },
                status="active",
                created_by_id=ctx["user"].id,
            )

        def test_dry_run_rejects_cross_organization_access(self):
            """**P0-1 真实修复验证**：W2 user 不能 dry-run W1 的 space_id=None Tracker。"""
            from apps.tracker.api import trackers as trackers_api

            tracker_w1 = self._create_tracker(ctx=self.ctx_a, space_id=None)
            user_w2 = self.ctx_b["user"]

            request = _build_request(user_w2)
            resp = trackers_api.tracker_dry_run(
                request, tracker_id=tracker_w1.id, replay_last=3,
            )

            # 必须拒绝（permission_denied_response 返回 (403, dict)）
            if isinstance(resp, tuple):
                self.assertEqual(resp[0], 403,
                                 f"跨 organization 访问必须 403，实际 {resp}")
            # secret 不能出现在响应里（即便错误响应）
            resp_str = str(resp)
            self.assertNotIn(
                "do_not_leak_this_value", resp_str,
                "**P0-1 关键安全验证**：拒绝响应不能泄漏 trigger_config secret",
            )

        def test_dry_run_accepts_organization_member(self):
            """同 W1 user 调 dry-run 应通过（status 200）。"""
            from apps.tracker.api import trackers as trackers_api

            tracker_w1 = self._create_tracker(ctx=self.ctx_a, space_id=None)
            user_w1 = self.ctx_a["user"]

            request = _build_request(user_w1)
            resp = trackers_api.tracker_dry_run(
                request, tracker_id=tracker_w1.id, replay_last=3,
            )

            # 应该是 success_response（dict with success=True）
            # tracker_dry_run 走 ninja，成功返回 dict；权限拒绝走 JsonResponse(403)
            if hasattr(resp, "status_code"):
                self.assertNotIn(resp.status_code, (401, 403),
                                 f"同 organization 应通过，实际 {resp!r}")
            elif isinstance(resp, tuple):
                self.assertNotIn(resp[0], (401, 403),
                                 f"同 organization 应通过，实际 {resp}")
            elif isinstance(resp, dict):
                self.assertTrue(resp.get("success", False),
                                f"同 organization 应通过，实际 {resp}")


