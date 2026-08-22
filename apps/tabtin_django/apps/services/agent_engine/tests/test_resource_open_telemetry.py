"""
ResourceOpenTelemetry API 集成测试 — 「Agent 产物在 Space 内的打开」专题 Wave 7。

业务目标（PRD §6 标准 1/2 + RFC v1.0 §8.3）：
    Electron main 进程把 ResourceRouter emit 的事件按 5s/100 条 batch 上报到本
    endpoint，bulk_create 落 PostgreSQL `agent_engine_resource_open_event` 表，
    让 PM 在上线 14 天后跑抽样脚本拿到三个标准的真实数字。

防回归覆盖：
    1. POST 单条 / 批量 → 200 + bulk_create 真入库（PG）
    2. JWT user_id 校正：payload.user_id ≠ JWT user.id 时被拒（防伪造）
    3. enum 校验：trigger_source / resolve_source / outcome / event_name 全部
       拒掉 typo（白名单 frozenset）
    4. partial-ok：单 batch 部分非法时合法事件入库 + 非法计入 rejected
    5. UUID 字段（space_id / organization_id / agent_run_id / message_id）非合法
       UUID 时被拒
    6. ts 毫秒 epoch 转 UTC datetime 正确（避免时区污染）
    7. batch 上限 100（schema 兜底）
    8. 抽样所需 SELECT DISTINCT resolve_source 真返回 6 个 tag
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone as dt_timezone
from types import SimpleNamespace
from unittest.mock import patch

from django.db import connections
from django.test import Client, TestCase

from apps.services.agent_engine.models import ResourceOpenEvent


# ── helpers ─────────────────────────────────────────────────────────


def _make_event(**overrides):
    """构造一条满足 schema 校验的事件 payload，用 overrides 覆盖关键字段。"""
    base = {
        "event_name": "resource_open.resolved",
        "trigger_source": "chat_markdown",
        "pointer_scheme": "tabtin",
        "pointer_type": "table",
        "pointer_id_hash": "0123456789abcdef",
        "hint_app_id": None,
        "resolved_carrier_app_id": "tabdata",
        "resolve_source": "manifest_default",
        "outcome": "in_space_opened",
        "space_id": str(uuid.uuid4()),
        "user_id": "<set in test>",
        "organization_id": str(uuid.uuid4()),
        "agent_run_id": None,
        "message_id": None,
        "tool_call_id": None,
        "duration_ms": 12,
        "ts": 1_700_000_000_000,
        "client": "electron",
        "client_version": "0.42.0",
    }
    base.update(overrides)
    return base


class ResourceOpenTelemetryAPITestCase(TestCase):
    """埋点上报通路 endpoint 集成测试（PRD §6 三标准基础）。"""

    # 同时让默认连接和 PG 连接都创建测试库 schema —— ResourceOpenEvent 是 PG-only
    databases = {"default", "postgresql"}

    def setUp(self):
        self.client = Client()

        # 模拟 jwt_auth：让 request.auth 返回一个有合法 UUID id 的 User 实例
        self.user_id = uuid.uuid4()
        self.auth_user = SimpleNamespace(
            id=self.user_id,
            username="w7-telemetry-test",
            is_staff=False,
            is_superuser=False,
        )
        self.jwt_auth_patcher = patch(
            "apps.users.auth.permissions.JWTAuth.__call__",
            return_value=self.auth_user,
        )
        self.jwt_auth_patcher.start()
        self.addCleanup(self.jwt_auth_patcher.stop)

        # 缩短 endpoint URL 复用
        self.endpoint = "/api/services/telemetry/resource-open/batch"

    # ── 1. POST 单条 / 批量 ─────────────────────────────────────

    def test_post_single_event_creates_one_row(self):
        evt = _make_event(user_id=str(self.user_id))
        resp = self.client.post(
            self.endpoint,
            data=json.dumps({"events": [evt]}),
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 200, resp.content)
        body = resp.json()
        self.assertEqual(body["accepted"], 1)
        self.assertEqual(body["rejected"], 0)
        # 真入 PG（using=postgresql）
        self.assertEqual(
            ResourceOpenEvent.objects.using("postgresql").count(), 1
        )
        row = ResourceOpenEvent.objects.using("postgresql").first()
        assert row is not None
        self.assertEqual(row.event_name, "resource_open.resolved")
        self.assertEqual(row.trigger_source, "chat_markdown")
        self.assertEqual(row.outcome, "in_space_opened")
        self.assertEqual(row.resolve_source, "manifest_default")
        self.assertEqual(str(row.user_id), str(self.user_id))

    def test_post_batch_50_events_bulk_create(self):
        events = [
            _make_event(
                user_id=str(self.user_id),
                pointer_id_hash=f"hash{i:012x}",
                ts=1_700_000_000_000 + i,
            )
            for i in range(50)
        ]
        resp = self.client.post(
            self.endpoint,
            data=json.dumps({"events": events}),
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 200, resp.content)
        body = resp.json()
        self.assertEqual(body["accepted"], 50)
        self.assertEqual(body["rejected"], 0)
        self.assertEqual(
            ResourceOpenEvent.objects.using("postgresql").count(), 50
        )

    # ── 2. JWT user_id 防伪造 ─────────────────────────────────

    def test_post_user_id_mismatch_rejected(self):
        other_user = uuid.uuid4()
        evt = _make_event(user_id=str(other_user))
        resp = self.client.post(
            self.endpoint,
            data=json.dumps({"events": [evt]}),
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 200, resp.content)
        body = resp.json()
        self.assertEqual(body["accepted"], 0)
        self.assertEqual(body["rejected"], 1)
        self.assertTrue(any("user_id mismatch" in e for e in body["errors"]))
        self.assertEqual(
            ResourceOpenEvent.objects.using("postgresql").count(), 0,
            "防伪造：user_id 不匹配的事件不能落库",
        )

    def test_post_partial_ok_mixed_user_ids(self):
        """混合一条合法 + 一条 user_id 伪造 → accepted=1, rejected=1。"""
        good = _make_event(user_id=str(self.user_id), pointer_id_hash="aaaaaaaaaaaaaaaa")
        evil = _make_event(user_id=str(uuid.uuid4()), pointer_id_hash="bbbbbbbbbbbbbbbb")
        resp = self.client.post(
            self.endpoint,
            data=json.dumps({"events": [good, evil]}),
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 200, resp.content)
        body = resp.json()
        self.assertEqual(body["accepted"], 1)
        self.assertEqual(body["rejected"], 1)
        self.assertEqual(
            ResourceOpenEvent.objects.using("postgresql").count(), 1
        )

    # ── 3. enum 校验 ───────────────────────────────────────────

    def test_post_invalid_trigger_source_rejected_at_schema(self):
        evt = _make_event(user_id=str(self.user_id), trigger_source="UNKNOWN_FOO")
        resp = self.client.post(
            self.endpoint,
            data=json.dumps({"events": [evt]}),
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 422, resp.content)

    def test_post_invalid_resolve_source_rejected_at_schema(self):
        evt = _make_event(user_id=str(self.user_id), resolve_source="user_perf")  # typo
        resp = self.client.post(
            self.endpoint,
            data=json.dumps({"events": [evt]}),
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 422, resp.content)

    def test_post_invalid_outcome_rejected_at_schema(self):
        evt = _make_event(user_id=str(self.user_id), outcome="OPENED")  # typo
        resp = self.client.post(
            self.endpoint,
            data=json.dumps({"events": [evt]}),
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 422, resp.content)

    def test_post_invalid_event_name_rejected_at_schema(self):
        evt = _make_event(user_id=str(self.user_id), event_name="resource_open.triggered")
        resp = self.client.post(
            self.endpoint,
            data=json.dumps({"events": [evt]}),
            content_type="application/json",
        )
        # event_name=triggered 是 RFC §8.1 早期枚举，已从 W2 events.ts 移除；
        # 这里继续拒，强制契约对齐
        self.assertEqual(resp.status_code, 422, resp.content)

    # ── 4. UUID 字段 ───────────────────────────────────────────

    def test_post_invalid_space_id_uuid_rejected(self):
        evt = _make_event(user_id=str(self.user_id), space_id="not-a-uuid")
        resp = self.client.post(
            self.endpoint,
            data=json.dumps({"events": [evt]}),
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 200, resp.content)
        body = resp.json()
        self.assertEqual(body["rejected"], 1)
        self.assertTrue(any("space_id" in e for e in body["errors"]))

    def test_post_invalid_organization_id_uuid_rejected(self):
        evt = _make_event(user_id=str(self.user_id), organization_id="bad-wt")
        resp = self.client.post(
            self.endpoint,
            data=json.dumps({"events": [evt]}),
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 200, resp.content)
        body = resp.json()
        self.assertEqual(body["rejected"], 1)

    # ── 5. ts → UTC datetime 转换 ─────────────────────────────

    def test_post_ts_ms_epoch_converts_to_aware_utc_datetime(self):
        ts_ms = 1_700_000_000_000
        evt = _make_event(user_id=str(self.user_id), ts=ts_ms)
        resp = self.client.post(
            self.endpoint,
            data=json.dumps({"events": [evt]}),
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 200, resp.content)
        row = ResourceOpenEvent.objects.using("postgresql").first()
        assert row is not None
        expected = datetime.fromtimestamp(ts_ms / 1000, tz=dt_timezone.utc)
        self.assertEqual(row.ts, expected)
        self.assertIsNotNone(row.ts.tzinfo, "datetime 必须 timezone-aware")

    # ── 6. batch 上限 ─────────────────────────────────────────

    def test_post_batch_above_100_rejected_at_schema(self):
        events = [
            _make_event(user_id=str(self.user_id), pointer_id_hash=f"h{i:015x}")
            for i in range(101)
        ]
        resp = self.client.post(
            self.endpoint,
            data=json.dumps({"events": events}),
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 422, resp.content)

    def test_post_batch_empty_rejected_at_schema(self):
        resp = self.client.post(
            self.endpoint,
            data=json.dumps({"events": []}),
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 422, resp.content)

    # ── 7. 多 outcome / resolve_source 真入库覆盖 ────────────

    def test_post_all_6_resolve_sources_distinct_returned_by_sql(self):
        """W7 北极星 #5：抽样脚本 SELECT DISTINCT resolve_source 必须返回 6 个值。"""
        sources = [
            "user_pref",
            "session_override",
            "agent_hint",
            "manifest_default",
            "system_fallback",
            "modifier_key",
        ]
        events = [
            _make_event(
                user_id=str(self.user_id),
                resolve_source=src,
                pointer_id_hash=f"r{i:015x}",
            )
            for i, src in enumerate(sources)
        ]
        resp = self.client.post(
            self.endpoint,
            data=json.dumps({"events": events}),
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 200, resp.content)
        # SELECT DISTINCT resolve_source FROM agent_engine_resource_open_event
        with connections["postgresql"].cursor() as cur:
            cur.execute(
                "SELECT DISTINCT resolve_source FROM agent_engine_resource_open_event "
                "ORDER BY resolve_source"
            )
            distinct_sources = sorted([row[0] for row in cur.fetchall()])
        self.assertEqual(distinct_sources, sorted(sources))

    def test_post_all_4_outcomes_landed(self):
        """W7 北极星：4 个 outcome（in_space / system / denied / error）都能入库。"""
        outcomes = [
            ("in_space_opened", "resource_open.resolved", "manifest_default", None),
            ("system_app_opened", "resource_open.resolved", "system_fallback", None),
            ("denied_known_bad", "resource_open.failed", "system_fallback",
             "Refused to open known-bad scheme: chrome:"),
            ("error", "resource_open.failed", "system_fallback", "mock OS error"),
        ]
        events = [
            _make_event(
                user_id=str(self.user_id),
                outcome=oc,
                event_name=ev,
                resolve_source=rs,
                error_message=em,
                pointer_id_hash=f"o{i:015x}",
            )
            for i, (oc, ev, rs, em) in enumerate(outcomes)
        ]
        resp = self.client.post(
            self.endpoint,
            data=json.dumps({"events": events}),
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 200, resp.content)
        body = resp.json()
        self.assertEqual(body["accepted"], 4)
        # 每个 outcome 各一行
        for oc, _, _, _ in outcomes:
            self.assertEqual(
                ResourceOpenEvent.objects.using("postgresql")
                .filter(outcome=oc).count(),
                1,
                f"outcome={oc} 必须入库 1 行",
            )

    # ── 8. 不带 auth header → 401 ────────────────────────────

    def test_post_unauthenticated_rejected(self):
        # 临时移除 jwt_auth patch，验证 anonymous 被拒
        self.jwt_auth_patcher.stop()
        self.addCleanup(self.jwt_auth_patcher.start)  # 让 tearDown 不混乱
        evt = _make_event(user_id=str(self.user_id))
        resp = self.client.post(
            self.endpoint,
            data=json.dumps({"events": [evt]}),
            content_type="application/json",
        )
        self.assertIn(resp.status_code, (401, 403), resp.content)
