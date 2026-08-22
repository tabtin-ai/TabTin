"""计费报表导出端点回归测试。

覆盖：
- 导出服务 generate_csv_rows 在 PostgreSQL 下的真实查询与 CSV 产出。
- 导出端点对 organization owner 的角色解析：即便 owner 没有 OrganizationMember 行，
  也应能成功导出（与 check_organization_permission 的 owner_id 兜底保持一致）。
- viewer 等无导出权限角色仍被拒绝（403）。

注：JWTAuth 默认要求 session 绑定（sid），单测里直接 patch authenticate 返回用户，
聚焦验证视图自身的权限解析与导出逻辑。
"""

from __future__ import annotations

import uuid
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone as dt_timezone
from decimal import Decimal
from contextlib import contextmanager
from unittest.mock import patch
from zoneinfo import ZoneInfo

from django.contrib.auth import get_user_model
from django.test import Client, TestCase
from django.utils import timezone

from django.core.cache import cache

from apps.services.billing import api as billing_api
from apps.services.billing.models import BillingUsageEvent
from apps.services.billing.services.export_service import (
    BillingExportService,
    _format_credits_auto,
    _format_dt_ledger,
    _format_quantity_with_unit,
)
from apps.tabtinspace.models import Organization, OrganizationMember
from apps.users.auth.permissions import JWTAuth

User = get_user_model()

BASE = "/api/services/billing"


def _auth_header() -> dict:
    # token 内容无所谓：authenticate 被 patch 成直接返回用户
    return {"HTTP_AUTHORIZATION": "Bearer test-token"}


class BillingExportApiTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        self.client = Client()
        self.user = User.objects.create_user(
            username=f"export_owner_{uuid.uuid4().hex[:6]}",
            email=f"export_owner_{uuid.uuid4().hex[:6]}@test.com",
            password="pass123",
        )
        self.organization = Organization.objects.create(
            name="Export Team",
            owner_id=self.user.id,
            is_default=False,
        )
        # 造 3 条用量事件
        for i in range(3):
            BillingUsageEvent.objects.create(
                organization_id=str(self.organization.id),
                user_id=str(self.user.id),
                meter_key="llm.tokens",
                biz_type="llm",
                biz_id=f"llm-{i}",
                metadata={"source": "test", "idx": i},
                charge_status="charged",
                quantity=Decimal("1000"),
                unit_price=Decimal("0.0001"),
                amount=Decimal("0.1"),
                unit="token",
                model_name="kimi-k2",
                occurred_at=timezone.now(),
            )

    def _export_url(self) -> str:
        today = timezone.localdate()
        start = today.replace(day=1)
        return (
            f"{BASE}/organizations/{self.organization.id}/billing/export"
            f"?start_date={start.isoformat()}&end_date={today.isoformat()}"
        )

    @contextmanager
    def _auth_patches(self, user=None):
        """导出端点需同时绕过 JWT 与邀请码门禁（单测不走完整注册链路）。"""
        with (
            patch.object(JWTAuth, "authenticate", return_value=user or self.user),
            patch(
                "apps.users.auth.invite_gate_middleware._has_redeemed_invite",
                return_value=True,
            ),
        ):
            yield

    def _get_export(self):
        with self._auth_patches():
            return self.client.get(self._export_url(), **_auth_header())

    # ── 服务层：PG 查询与 CSV 产出 ───────────────────────────────

    def test_service_generates_csv_rows(self):
        """默认 audit schema：保留 user_id / task_name 等机读列。"""
        today = timezone.localdate()
        rows = list(
            BillingExportService.generate_csv_rows(
                organization_id=str(self.organization.id),
                start_date=today.replace(day=1),
                end_date=today,
            )
        )
        self.assertEqual(len(rows), 4, f"应为表头+3 行，实际 {len(rows)} 行：{rows}")
        header = rows[0].lstrip("\ufeff")
        self.assertIn("user_id", header)
        self.assertIn("task_name", header)
        self.assertIn("meter_key", header)
        self.assertNotIn("计量项", header)
        body = "".join(rows)
        self.assertNotIn("筛选项", body)
        self.assertIn("llm.tokens", body)
        self.assertIn(str(self.user.id), body)

    def test_ledger_schema_matches_usage_list_columns(self):
        """显式 schema=ledger：与用量中心中文窄列对齐。"""
        today = timezone.localdate()
        rows = list(
            BillingExportService.generate_csv_rows(
                organization_id=str(self.organization.id),
                start_date=today.replace(day=1),
                end_date=today,
                schema="ledger",
            )
        )
        self.assertEqual(len(rows), 4, f"应为表头+3 行，实际 {len(rows)} 行：{rows}")
        self.assertIn("计量项,用量,模型,业务类型,credits,场景,创建时间", rows[0])
        body = "".join(rows)
        self.assertNotIn("筛选项", body)
        self.assertNotIn("user_id", rows[0])
        self.assertIn("LLM Token", body)
        self.assertIn("模型调用", body)
        # 千分位与列表 formatNumber 对齐（1000 → 1,000）
        self.assertIn("1,000 token", body)
        self.assertIn("0.10", body)

    def test_llm_usage_schema_omits_business_type_but_keeps_scene(self):
        """新版 LLM 场景列表导出不展示业务类型，旧 ledger 契约仍单独保留。"""
        today = timezone.localdate()
        BillingUsageEvent.objects.filter(organization_id=str(self.organization.id)).delete()
        scenes = (
            ("_main_chat", "主对话"),
            ("_sub_agent", "子 Agent"),
            ("_compact", "上下文压缩"),
            ("_summary_judge", "摘要评判"),
            ("commit_message_generation", "Commit 信息生成"),
            ("memory_capture", "记忆增强"),
            ("diary_distill", "记忆增强"),
            ("user_portrait_distill", "记忆增强"),
            ("memory_compaction", "记忆增强"),
            ("unknown_scene", "unknown_scene"),
        )
        for scene_key, label in scenes:
            BillingUsageEvent.objects.create(
                organization_id=str(self.organization.id),
                user_id=str(self.user.id),
                meter_key="llm.tokens",
                biz_type="llm_call",
                biz_id=f"scene-list-export:{scene_key}",
                scene_key=scene_key,
                metadata={"status": "charged", "label": label},
                charge_status="charged",
                quantity=Decimal("1"),
                unit_price=Decimal("0.01"),
                amount=Decimal("0.01"),
                unit="token",
                model_name="kimi-k2",
                occurred_at=timezone.now(),
            )
        rows = list(
            BillingExportService.generate_csv_rows(
                organization_id=str(self.organization.id),
                start_date=today.replace(day=1),
                end_date=today,
                schema="llm_usage",
            )
        )

        header = rows[0].lstrip("\ufeff")
        self.assertEqual(header, "计量项,场景,用量,模型,credits,创建时间\r\n")
        self.assertNotIn("业务类型", header)
        self.assertIn("场景", header)
        self.assertEqual(len(rows), len(scenes) + 1)
        body = "".join(rows[1:])
        for _, label in scenes:
            self.assertIn(f"LLM Token,{label},1 token,kimi-k2,0.01,", body)
        self.assertNotIn("模型调用", body)
        self.assertNotIn("memory_capture", body)

    def test_format_credits_auto_matches_electron_format_credits_auto(self):
        """#6680：导出 amount 舍入规则与 Electron formatCreditsAuto 一致。"""
        self.assertEqual(_format_credits_auto(Decimal("0.0128")), "0.01")
        self.assertEqual(_format_credits_auto(Decimal("0.1")), "0.10")
        self.assertEqual(_format_credits_auto(Decimal("0.0099")), "0.0099")
        self.assertEqual(_format_credits_auto(Decimal("0")), "0")
        self.assertEqual(_format_credits_auto(Decimal("12.345")), "12.35")
        # n>=1：toLocaleString + maximumFractionDigits:2（含千分位）
        self.assertEqual(_format_credits_auto(Decimal("1234.56")), "1,234.56")
        self.assertEqual(_format_credits_auto(Decimal("1234.567")), "1,234.57")
        # Intl halfExpand tie：2.675 → 2.68（float f-string 会错成 2.67）
        self.assertEqual(_format_credits_auto(Decimal("2.675")), "2.68")

    def test_format_quantity_with_unit_matches_usage_list_format_number(self):
        """用量列与 Electron formatNumber(..., { maximumFractionDigits: 2 }) 对齐。"""
        self.assertEqual(_format_quantity_with_unit(Decimal("1234.5678"), "token"), "1,234.57 token")
        self.assertEqual(_format_quantity_with_unit(Decimal("1234.56"), "token"), "1,234.56 token")
        self.assertEqual(_format_quantity_with_unit(Decimal("1000"), "token"), "1,000 token")
        self.assertEqual(_format_quantity_with_unit(Decimal("128"), "token"), "128 token")
        self.assertEqual(_format_quantity_with_unit(Decimal("2.675"), "token"), "2.68 token")

    def test_ledger_csv_tie_rounding_matches_intl_half_expand(self):
        """ledger CSV 对 2.675 credits / quantity 须与 Intl.NumberFormat 同为 2.68。"""
        BillingUsageEvent.objects.filter(organization_id=str(self.organization.id)).delete()
        today = timezone.localdate()
        BillingUsageEvent.objects.create(
            organization_id=str(self.organization.id),
            user_id=str(self.user.id),
            meter_key="llm.tokens",
            biz_type="llm_call",
            biz_id="tie-round-2675",
            metadata={"source": "test"},
            charge_status="charged",
            quantity=Decimal("2.675"),
            unit_price=Decimal("1"),
            amount=Decimal("2.675"),
            unit="token",
            model_name="kimi-k2",
            occurred_at=timezone.now(),
        )
        rows = list(
            BillingExportService.generate_csv_rows(
                organization_id=str(self.organization.id),
                start_date=today.replace(day=1),
                end_date=today,
                meter_key="llm.tokens",
                schema="ledger",
            )
        )
        body = "".join(rows)
        self.assertIn("2.68 token", body)
        self.assertIn("2.68", body)
        self.assertNotIn("2.67", body)
        self.assertNotIn("2.675", body)

    def test_format_dt_ledger_uses_client_timezone_across_calendar_day(self):
        """同一 UTC 时刻按客户端时区显示，可与上海差一天（对齐 Electron 系统时区）。"""
        occurred = datetime(2026, 7, 21, 18, 0, 0, tzinfo=dt_timezone.utc)
        la = _format_dt_ledger(occurred, tz=ZoneInfo("America/Los_Angeles"))
        sh = _format_dt_ledger(occurred, tz=ZoneInfo("Asia/Shanghai"))
        self.assertIn("2026/07/21 11:00:00", la)
        self.assertIn("2026/07/22 02:00:00", sh)
        self.assertNotEqual(la, sh)

    def test_ledger_csv_respects_client_timezone_query(self):
        """导出 timezone=America/Los_Angeles 时创建时间列与系统时区列表同日同时。"""
        BillingUsageEvent.objects.filter(organization_id=str(self.organization.id)).delete()
        occurred = datetime(2026, 7, 21, 18, 0, 0, tzinfo=dt_timezone.utc)
        BillingUsageEvent.objects.create(
            organization_id=str(self.organization.id),
            user_id=str(self.user.id),
            meter_key="llm.tokens",
            biz_type="llm_call",
            biz_id="tz-cross-day",
            metadata={"source": "test"},
            charge_status="charged",
            quantity=Decimal("1"),
            unit_price=Decimal("0.01"),
            amount=Decimal("0.01"),
            unit="token",
            model_name="kimi-k2",
            occurred_at=occurred,
        )
        rows_la = list(
            BillingExportService.generate_csv_rows(
                organization_id=str(self.organization.id),
                start_date=date(2026, 7, 1),
                end_date=date(2026, 7, 31),
                meter_key="llm.tokens",
                schema="ledger",
                display_timezone=ZoneInfo("America/Los_Angeles"),
            )
        )
        body_la = "".join(rows_la)
        self.assertIn("2026/07/21 11:00:00", body_la)
        self.assertNotIn("2026/07/22 02:00:00", body_la)

        rows_sh = list(
            BillingExportService.generate_csv_rows(
                organization_id=str(self.organization.id),
                start_date=date(2026, 7, 1),
                end_date=date(2026, 7, 31),
                meter_key="llm.tokens",
                schema="ledger",
                display_timezone=ZoneInfo("Asia/Shanghai"),
            )
        )
        body_sh = "".join(rows_sh)
        self.assertIn("2026/07/22 02:00:00", body_sh)

    def test_csv_amount_matches_client_credits_display(self):
        """#6680：CSV amount 列使用 display_credits + formatCreditsAuto，与用量列表一致。"""
        BillingUsageEvent.objects.filter(organization_id=str(self.organization.id)).delete()
        today = timezone.localdate()
        BillingUsageEvent.objects.create(
            organization_id=str(self.organization.id),
            user_id=str(self.user.id),
            meter_key="llm.tokens",
            biz_type="llm_call",
            biz_id="6680-amount-round",
            metadata={"source": "test"},
            charge_status="charged",
            quantity=Decimal("128"),
            unit_price=Decimal("0.0001"),
            amount=Decimal("0.0128"),
            unit="token",
            model_name="kimi-k2-cdp",
            occurred_at=timezone.now(),
        )
        rows = list(
            BillingExportService.generate_csv_rows(
                organization_id=str(self.organization.id),
                start_date=today.replace(day=1),
                end_date=today,
                meter_key="llm.tokens",
                schema="ledger",
            )
        )
        body = "".join(rows)
        self.assertNotIn("筛选项", body)
        self.assertIn("计量项,用量,模型,业务类型,credits,场景,创建时间", rows[0])
        self.assertIn("LLM Token", body)
        self.assertIn("128 token", body)
        self.assertIn("kimi-k2-cdp", body)
        self.assertIn("模型调用", body)
        self.assertIn("0.01", body)
        self.assertNotIn("0.0128", body)
        self.assertNotIn("llm_call", body)
        # 创建时间强制文本前缀，避免表格软件显示 #####
        self.assertTrue(any("\t20" in r for r in rows))

    def test_csv_time_column_uses_occurred_at_not_created_at(self):
        """#6698：导出时间列与日期筛选同口径（occurred_at），不被入库 created_at 误导。"""
        BillingUsageEvent.objects.filter(organization_id=str(self.organization.id)).delete()
        occurred = timezone.now() - timedelta(days=10)
        event = BillingUsageEvent.objects.create(
            organization_id=str(self.organization.id),
            user_id=str(self.user.id),
            meter_key="llm.tokens",
            biz_type="llm_call",
            biz_id="6698-occurred-vs-created",
            metadata={"source": "test"},
            charge_status="charged",
            quantity=Decimal("10"),
            unit_price=Decimal("0.001"),
            amount=Decimal("0.01"),
            unit="token",
            model_name="kimi-k2",
            occurred_at=occurred,
        )
        # 强制拉开入库时间与发生时间（bulk_update 绕过 auto_now）
        BillingUsageEvent.objects.filter(pk=event.pk).update(created_at=timezone.now())
        event.refresh_from_db()
        start = timezone.localdate(occurred)
        rows = list(
            BillingExportService.generate_csv_rows(
                organization_id=str(self.organization.id),
                start_date=start,
                end_date=start,
                meter_key="llm.tokens",
                schema="ledger",
            )
        )
        body = "".join(rows)
        local_occurred = timezone.localtime(occurred)
        expected_day = f"{local_occurred.year:04d}/{local_occurred.month:02d}/{local_occurred.day:02d}"
        self.assertIn(expected_day, body)
        local_created = timezone.localtime(event.created_at)
        created_day = f"{local_created.year:04d}/{local_created.month:02d}/{local_created.day:02d}"
        if created_day != expected_day:
            self.assertNotIn(created_day, body)

    def test_service_meter_key_filters_out_storage_audit_events(self):
        """#6208：按 meter_key=llm.tokens 导出时不得包含文件删除等 storage 审计事件。"""
        today = timezone.localdate()
        BillingUsageEvent.objects.create(
            organization_id=str(self.organization.id),
            user_id=str(self.user.id),
            meter_key="storage.bytes",
            biz_type="oss_file_delete",
            biz_id="file-delete-1",
            quantity=Decimal("-1024"),
            unit_price=Decimal("0"),
            amount=Decimal("0"),
            unit="bytes",
            occurred_at=timezone.now(),
        )
        rows = list(
            BillingExportService.generate_csv_rows(
                organization_id=str(self.organization.id),
                start_date=today.replace(day=1),
                end_date=today,
                meter_key="llm.tokens",
                schema="ledger",
            )
        )
        body = "".join(rows)
        self.assertEqual(sum(1 for r in rows if "LLM Token," in r or r.startswith("LLM Token")), 3)
        self.assertIn("LLM Token", body)
        self.assertNotIn("存储 (字节)", body)
        self.assertNotIn("oss_file_delete", body)
        self.assertNotIn("storage.bytes", body)

    def test_export_endpoint_respects_meter_key(self):
        """#6208：导出 API 透传 meter_key，避免 LLM 导出混入 storage 审计。"""
        today = timezone.localdate()
        BillingUsageEvent.objects.create(
            organization_id=str(self.organization.id),
            user_id=str(self.user.id),
            meter_key="storage.bytes",
            biz_type="oss_file_delete",
            biz_id="file-delete-api",
            quantity=Decimal("-2048"),
            unit_price=Decimal("0"),
            amount=Decimal("0"),
            unit="bytes",
            occurred_at=timezone.now(),
        )
        start = today.replace(day=1)
        url = (
            f"{BASE}/organizations/{self.organization.id}/billing/export"
            f"?start_date={start.isoformat()}&end_date={today.isoformat()}"
            f"&meter_key=llm.tokens&schema=ledger"
        )
        with (
            patch.object(JWTAuth, "authenticate", return_value=self.user),
            patch(
                "apps.users.auth.invite_gate_middleware._has_redeemed_invite",
                return_value=True,
            ),
        ):
            resp = self.client.get(url, **_auth_header())
        self.assertEqual(resp.status_code, 200)
        content = b"".join(resp.streaming_content).decode("utf-8")
        self.assertIn("LLM Token", content)
        self.assertNotIn("存储 (字节)", content)
        self.assertNotIn("oss_file_delete", content)

    def test_service_no_duplicate_rows_when_pk_order_differs_from_time(self):
        """keyset 翻页回归：pk 顺序与 occurred_at 顺序相反时不得重复/遗漏。

        构造 occurred_at 递增但 UUID 主键递减的事件，并把批大小压到 1，
        强制多批翻页。倒序导出时游标必须用 lt，否则会重复/遗漏。
        """
        # 该 organization 已有 setUp 造的 3 条同时刻事件，先清掉避免干扰
        BillingUsageEvent.objects.filter(organization_id=str(self.organization.id)).delete()

        base = timezone.now() - timedelta(hours=1)
        # id 递减、occurred_at 递增
        specs = [
            (uuid.UUID(int=0xC), base + timedelta(minutes=1), "model-A"),
            (uuid.UUID(int=0xB), base + timedelta(minutes=2), "model-B"),
            (uuid.UUID(int=0xA), base + timedelta(minutes=3), "model-C"),
        ]
        for ev_id, occurred, model in specs:
            BillingUsageEvent.objects.create(
                id=ev_id,
                organization_id=str(self.organization.id),
                user_id=str(self.user.id),
                meter_key="llm.tokens",
                biz_type="llm",
                biz_id=f"biz-{model}",
                quantity=Decimal("1"),
                unit_price=Decimal("1"),
                amount=Decimal("1"),
                unit="token",
                model_name=model,
                occurred_at=occurred,
            )

        today = timezone.localdate()
        with patch(
            "apps.services.billing.services.export_service.BATCH_SIZE", 1
        ):
            rows = list(
                BillingExportService.generate_csv_rows(
                    organization_id=str(self.organization.id),
                    start_date=(today - timedelta(days=1)),
                    end_date=today,
                    biz_type="llm",
                    schema="ledger",
                )
            )
        body = "".join(rows)
        for model in ("model-A", "model-B", "model-C"):
            self.assertEqual(
                body.count(model), 1, f"{model} 应恰好出现 1 次，实际 {body.count(model)} 次"
            )
        # 数据行恰好 3 条（不含筛选项/表头）
        data_rows = [r for r in rows if "model-" in r]
        self.assertEqual(len(data_rows), 3)
        # ledger 与列表默认一致：新→旧（model-C 最新）
        self.assertIn("model-C", data_rows[0])
        self.assertIn("model-B", data_rows[1])
        self.assertIn("model-A", data_rows[2])

    def test_csv_rows_newest_first_matches_usage_ledger_default(self):
        """ledger schema 时间序与 LLM 用量列表默认 -occurred_at 一致。"""
        BillingUsageEvent.objects.filter(organization_id=str(self.organization.id)).delete()
        base = timezone.now() - timedelta(hours=2)
        for idx, model in enumerate(("old", "mid", "new")):
            BillingUsageEvent.objects.create(
                organization_id=str(self.organization.id),
                user_id=str(self.user.id),
                meter_key="llm.tokens",
                biz_type="llm_call",
                biz_id=f"sort-{model}",
                quantity=Decimal("1"),
                unit_price=Decimal("1"),
                amount=Decimal("1"),
                unit="token",
                model_name=model,
                occurred_at=base + timedelta(minutes=idx),
            )
        today = timezone.localdate()
        rows = list(
            BillingExportService.generate_csv_rows(
                organization_id=str(self.organization.id),
                start_date=today - timedelta(days=1),
                end_date=today,
                meter_key="llm.tokens",
                schema="ledger",
            )
        )
        data_rows = [r for r in rows if r.startswith("LLM Token,")]
        self.assertEqual(len(data_rows), 3)
        self.assertIn(",new,", data_rows[0])
        self.assertIn(",mid,", data_rows[1])
        self.assertIn(",old,", data_rows[2])

    # ── 端点：owner 有 member 行 ─────────────────────────────────

    def test_export_owner_with_member_row(self):
        OrganizationMember.objects.create(
            organization=self.organization, user=self.user, role="owner"
        )
        resp = self._get_export()
        self.assertEqual(resp.status_code, 200)
        content = b"".join(resp.streaming_content).decode("utf-8")
        # 默认 audit：机读列，可按成员归因
        self.assertIn("user_id", content.splitlines()[0])
        self.assertIn("llm.tokens", content)
        self.assertIn(str(self.user.id), content)
        self.assertIn("kimi-k2", content)

    def test_export_disables_proxy_buffering_headers(self):
        """#6303：尽早冲刷表头，降低客户端读超时误杀概率。"""
        OrganizationMember.objects.create(
            organization=self.organization, user=self.user, role="owner"
        )
        resp = self._get_export()
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp["X-Accel-Buffering"], "no")
        self.assertEqual(resp["Cache-Control"], "no-store")
        self.assertIn("text/csv", resp["Content-Type"])

    def test_export_filters_by_user_and_biz_type(self):
        other = User.objects.create_user(
            username=f"export_other_{uuid.uuid4().hex[:6]}",
            email=f"export_other_{uuid.uuid4().hex[:6]}@test.com",
            password="pass123",
        )
        BillingUsageEvent.objects.create(
            organization_id=str(self.organization.id),
            user_id=str(other.id),
            meter_key="llm.tokens",
            biz_type="not-exported",
            biz_id="other-row",
            quantity=Decimal("1"),
            unit_price=Decimal("1"),
            amount=Decimal("1"),
            unit="token",
            model_name="other-user-model",
            occurred_at=timezone.now(),
        )
        today = timezone.localdate()
        url = (
            f"{BASE}/organizations/{self.organization.id}/billing/export"
            f"?start_date={today.replace(day=1).isoformat()}"
            f"&end_date={today.isoformat()}"
            f"&user_id={self.user.id}&biz_type=llm"
        )
        with self._auth_patches():
            resp = self.client.get(url, **_auth_header())
        self.assertEqual(resp.status_code, 200)
        content = b"".join(resp.streaming_content).decode("utf-8")
        self.assertIn("kimi-k2", content)
        self.assertNotIn("other-user-model", content)

    def test_export_editor_cannot_export_other_user_rows(self):
        editor = User.objects.create_user(
            username=f"export_editor_{uuid.uuid4().hex[:6]}",
            email=f"export_editor_{uuid.uuid4().hex[:6]}@test.com",
            password="pass123",
        )
        other = User.objects.create_user(
            username=f"export_other_{uuid.uuid4().hex[:6]}",
            email=f"export_other_{uuid.uuid4().hex[:6]}@test.com",
            password="pass123",
        )
        OrganizationMember.objects.create(organization=self.organization, user=editor, role="editor")
        BillingUsageEvent.objects.create(
            organization_id=str(self.organization.id),
            user_id=str(editor.id),
            meter_key="llm.tokens",
            biz_type="llm",
            biz_id="editor-row",
            quantity=Decimal("1"),
            unit_price=Decimal("1"),
            amount=Decimal("1"),
            unit="token",
            model_name="editor-only-model",
            occurred_at=timezone.now(),
        )
        BillingUsageEvent.objects.create(
            organization_id=str(self.organization.id),
            user_id=str(other.id),
            meter_key="llm.tokens",
            biz_type="llm",
            biz_id="other-row",
            quantity=Decimal("1"),
            unit_price=Decimal("1"),
            amount=Decimal("1"),
            unit="token",
            model_name="other-only-model",
            occurred_at=timezone.now(),
        )
        today = timezone.localdate()
        url = (
            f"{BASE}/organizations/{self.organization.id}/billing/export"
            f"?start_date={today.replace(day=1).isoformat()}"
            f"&end_date={today.isoformat()}"
            f"&user_id={other.id}&biz_type=llm"
        )
        with self._auth_patches(editor):
            resp = self.client.get(url, **_auth_header())
        self.assertEqual(resp.status_code, 200)
        content = b"".join(resp.streaming_content).decode("utf-8")
        self.assertIn("editor-only-model", content)
        self.assertNotIn("other-only-model", content)

    # ── 端点：owner 无 member 行（ 角色兜底回归）─────────────

    def test_export_owner_without_member_row(self):
        # 不创建 OrganizationMember；owner 身份仅由 organization.owner_id 体现。
        # check_organization_permission(viewer) 会因 owner_id 命中而放行，
        # 角色解析也应兜底为 owner，否则导出 403。
        self.assertFalse(
            OrganizationMember.objects.filter(
                organization=self.organization, user=self.user
            ).exists()
        )
        resp = self._get_export()
        self.assertEqual(resp.status_code, 200)
        content = b"".join(resp.streaming_content).decode("utf-8")
        self.assertIn("llm.tokens", content)
        self.assertIn("user_id", content.splitlines()[0])

    # ── 端点：viewer 角色被拒 ────────────────────────────────────

    def test_export_viewer_denied(self):
        viewer = User.objects.create_user(
            username=f"export_viewer_{uuid.uuid4().hex[:6]}",
            email=f"export_viewer_{uuid.uuid4().hex[:6]}@test.com",
            password="pass123",
        )
        OrganizationMember.objects.create(
            organization=self.organization, user=viewer, role="viewer"
        )
        with self._auth_patches(viewer):
            resp = self.client.get(self._export_url(), **_auth_header())
        self.assertEqual(resp.status_code, 403)

    def test_usage_events_list_filters_and_paginates(self):
        BillingUsageEvent.objects.filter(organization_id=str(self.organization.id)).delete()
        now = timezone.now()
        for idx, (meter, biz_id) in enumerate([
            ("llm.tokens", "match-1"),
            ("llm.tokens", "match-2"),
            ("storage.bytes", "other-1"),
        ]):
            BillingUsageEvent.objects.create(
                organization_id=str(self.organization.id),
                user_id=str(self.user.id),
                meter_key=meter,
                biz_type="llm" if meter == "llm.tokens" else "storage",
                biz_id=biz_id,
                quantity=Decimal("100"),
                unit_price=Decimal("0.01"),
                amount=Decimal("1"),
                unit="token",
                model_name="kimi-k2",
                occurred_at=now + timedelta(minutes=idx),
            )

        url = (
            f"{BASE}/organizations/{self.organization.id}/usage-events"
            f"?user_id={self.user.id}&biz_type=llm&meter_key=llm.tokens&search=match&limit=1&offset=1"
        )
        with (
            patch.object(JWTAuth, "authenticate", return_value=self.user),
            patch(
                "apps.users.auth.invite_gate_middleware._has_redeemed_invite",
                return_value=True,
            ),
        ):
            resp = self.client.get(url, **_auth_header())
        self.assertEqual(resp.status_code, 200)
        payload = resp.json()["data"]
        self.assertEqual(payload["total"], 2)
        self.assertEqual(len(payload["events"]), 1)
        self.assertEqual(payload["events"][0]["meter_key"], "llm.tokens")
        self.assertEqual(payload["events"][0]["user_id"], str(self.user.id))
        self.assertEqual(payload["events"][0]["biz_type"], "llm")
        self.assertIn("metadata", payload["events"][0])
        self.assertIn("created_at", payload["events"][0])
        self.assertIn("display_credits", payload["events"][0])

    def test_user_ledger_excludes_unsettled_funding_snapshot_placeholder(self):
        """资金模式快照不是实际用量，不能伪装成 0 credits 已扣费账单。"""
        BillingUsageEvent.objects.filter(organization_id=str(self.organization.id)).delete()
        pending = BillingUsageEvent.objects.create(
            organization_id=str(self.organization.id),
            user_id=str(self.user.id),
            meter_key="llm.tokens",
            biz_type="",
            biz_id="",
            scene_key="memory_capture",
            quantity=Decimal("0"),
            unit_price=Decimal("0"),
            amount=Decimal("0"),
            unit="tokens",
            model_name="",
            metadata={
                "status": "pending_deduction",
                "funding_mode": "provider_credit_v1",
            },
            occurred_at=timezone.now(),
        )
        settled = BillingUsageEvent.objects.create(
            organization_id=str(self.organization.id),
            user_id=str(self.user.id),
            meter_key="llm.tokens",
            biz_type="llm_call",
            biz_id="memory_capture:done",
            scene_key="memory_capture",
            quantity=Decimal("120"),
            unit_price=Decimal("0.01"),
            amount=Decimal("1.2"),
            unit="tokens",
            model_name="glm-4.7",
            metadata={"status": "charged"},
            occurred_at=timezone.now(),
        )

        url = (
            f"{BASE}/organizations/{self.organization.id}/usage-events"
            "?meter_key=llm.tokens&limit=20"
        )
        with self._auth_patches():
            resp = self.client.get(url, **_auth_header())

        self.assertEqual(resp.status_code, 200)
        payload = resp.json()["data"]
        self.assertEqual(payload["total"], 1)
        self.assertEqual(payload["events"][0]["id"], str(settled.id))
        self.assertNotEqual(payload["events"][0]["id"], str(pending.id))

        today = timezone.localdate()
        ledger_rows = "".join(
            BillingExportService.generate_csv_rows(
                organization_id=str(self.organization.id),
                start_date=today,
                end_date=today,
                meter_key="llm.tokens",
                schema="ledger",
            )
        )
        self.assertIn("glm-4.7", ledger_rows)
        self.assertNotIn(str(pending.id), ledger_rows)
        self.assertEqual(ledger_rows.count("LLM Token"), 1)

    def test_usage_events_llm_call_filter_includes_legacy_llm(self):
        """UI「模型调用」筛选传 biz_type=llm_call 时，须命中账本兼容值 llm。"""
        BillingUsageEvent.objects.filter(organization_id=str(self.organization.id)).delete()
        now = timezone.now()
        for biz_type, biz_id, model_name in (
            ("llm", "legacy-llm", "legacy-llm-model"),
            ("llm_call", "canonical-llm-call", "canonical-llm-call-model"),
            ("llm_chat", "chat-only", "chat-only-model"),
        ):
            BillingUsageEvent.objects.create(
                organization_id=str(self.organization.id),
                user_id=str(self.user.id),
                meter_key="llm.tokens",
                biz_type=biz_type,
                biz_id=biz_id,
                metadata={"status": "charged"},
                charge_status="charged",
                quantity=Decimal("100"),
                unit_price=Decimal("0.01"),
                amount=Decimal("1"),
                unit="token",
                model_name=model_name,
                occurred_at=now,
            )

        url = (
            f"{BASE}/organizations/{self.organization.id}/usage-events"
            f"?meter_key=llm.tokens&biz_type=llm_call&limit=20"
        )
        with (
            patch.object(JWTAuth, "authenticate", return_value=self.user),
            patch(
                "apps.users.auth.invite_gate_middleware._has_redeemed_invite",
                return_value=True,
            ),
        ):
            resp = self.client.get(url, **_auth_header())
        self.assertEqual(resp.status_code, 200)
        payload = resp.json()["data"]
        biz_ids = {e["biz_id"] for e in payload["events"]}
        self.assertEqual(payload["total"], 2)
        self.assertEqual(biz_ids, {"legacy-llm", "canonical-llm-call"})

        export_url = (
            f"{self._export_url()}&meter_key=llm.tokens&biz_type=llm_call&schema=ledger"
        )
        with (
            patch.object(JWTAuth, "authenticate", return_value=self.user),
            patch(
                "apps.users.auth.invite_gate_middleware._has_redeemed_invite",
                return_value=True,
            ),
        ):
            export_resp = self.client.get(export_url, **_auth_header())
        self.assertEqual(export_resp.status_code, 200)
        csv_body = b"".join(export_resp.streaming_content).decode("utf-8")
        self.assertIn("legacy-llm-model", csv_body)
        self.assertIn("canonical-llm-call-model", csv_body)
        self.assertNotIn("chat-only-model", csv_body)
        self.assertIn("模型调用", csv_body)
        self.assertNotIn("LLM 对话", csv_body)

    def test_usage_events_main_chat_filter_uses_scene_key(self):
        """LLM 对话是主对话场景，不是账本中并不存在的 llm_chat 业务类型。"""
        BillingUsageEvent.objects.filter(organization_id=str(self.organization.id)).delete()
        now = timezone.now()
        for scene_key, biz_id in (
            ("_main_chat", "main-chat"),
            ("_sub_agent", "sub-agent"),
        ):
            BillingUsageEvent.objects.create(
                organization_id=str(self.organization.id),
                user_id=str(self.user.id),
                meter_key="llm.tokens",
                biz_type="llm_call",
                biz_id=biz_id,
                scene_key=scene_key,
                metadata={"status": "charged"},
                charge_status="charged",
                quantity=Decimal("100"),
                unit_price=Decimal("0.01"),
                amount=Decimal("1"),
                unit="token",
                model_name="kimi-k2.7-code",
                occurred_at=now,
            )

        url = (
            f"{BASE}/organizations/{self.organization.id}/usage-events"
            f"?meter_key=llm.tokens&biz_type=llm_call&scene_key=_main_chat&limit=20"
        )
        with (
            patch.object(JWTAuth, "authenticate", return_value=self.user),
            patch(
                "apps.users.auth.invite_gate_middleware._has_redeemed_invite",
                return_value=True,
            ),
        ):
            resp = self.client.get(url, **_auth_header())
        self.assertEqual(resp.status_code, 200)
        payload = resp.json()["data"]
        self.assertEqual(payload["total"], 1)
        self.assertEqual(payload["events"][0]["biz_id"], "main-chat")

        today = timezone.localdate()
        csv_body = "".join(
            BillingExportService.generate_csv_rows(
                organization_id=str(self.organization.id),
                start_date=today,
                end_date=today,
                meter_key="llm.tokens",
                biz_type="llm_call",
                scene_key="_main_chat",
            )
        )
        self.assertIn("main-chat", csv_body)
        self.assertNotIn("sub-agent", csv_body)

        export_url = (
            f"{self._export_url()}&meter_key=llm.tokens"
            f"&biz_type=llm_call&scene_key=_main_chat"
        )
        with self._auth_patches():
            export_resp = self.client.get(export_url, **_auth_header())
        self.assertEqual(export_resp.status_code, 200)
        exported_body = b"".join(export_resp.streaming_content).decode("utf-8")
        self.assertIn("main-chat", exported_body)
        self.assertNotIn("sub-agent", exported_body)

    def test_usage_events_editor_cannot_list_other_user_rows(self):
        editor = User.objects.create_user(
            username=f"list_editor_{uuid.uuid4().hex[:6]}",
            email=f"list_editor_{uuid.uuid4().hex[:6]}@test.com",
            password="pass123",
        )
        other = User.objects.create_user(
            username=f"list_other_{uuid.uuid4().hex[:6]}",
            email=f"list_other_{uuid.uuid4().hex[:6]}@test.com",
            password="pass123",
        )
        OrganizationMember.objects.create(organization=self.organization, user=editor, role="editor")
        BillingUsageEvent.objects.filter(organization_id=str(self.organization.id)).delete()
        for uid, biz_id in [(str(editor.id), "editor-row"), (str(other.id), "other-row")]:
            BillingUsageEvent.objects.create(
                organization_id=str(self.organization.id),
                user_id=uid,
                meter_key="llm.tokens",
                biz_type="llm",
                biz_id=biz_id,
                quantity=Decimal("100"),
                unit_price=Decimal("0.01"),
                amount=Decimal("1"),
                unit="token",
                model_name="kimi-k2",
                occurred_at=timezone.now(),
            )
        url = (
            f"{BASE}/organizations/{self.organization.id}/usage-events"
            f"?user_id={other.id}&biz_type=llm&limit=20"
        )
        with self._auth_patches(editor):
            resp = self.client.get(url, **_auth_header())
        self.assertEqual(resp.status_code, 200)
        payload = resp.json()["data"]
        self.assertEqual(payload["total"], 1)
        self.assertEqual(payload["events"][0]["user_id"], str(editor.id))
        self.assertEqual(payload["events"][0]["biz_id"], "editor-row")

    # ── ：用量流水任务名（metadata.session_id → 会话标题） ──────

    def _create_session_and_event(
        self,
        *,
        title: str,
        organization_id: str,
        session_id_kind: str = "pk",
    ):
        """造一条会话 + 一条挂在本组织的 llm_call 事件。

        真实数据形态：ChatSession.save() 自动把 thread_id 补成 ``chat-session-<id>``；
        客户端 X-TabTin-Session-Id 主路径传的是**主键 UUID**（session_id_kind="pk"），
        少数路径可能传带前缀的 thread_id（session_id_kind="thread_id"）。两者都要能反查到。
        """
        from apps.chat.conversation.models import ChatSession

        session = ChatSession.objects.create(
            user=self.user,
            organization_id=organization_id,
            title=title,
        )
        session_id = str(session.id) if session_id_kind == "pk" else session.thread_id
        event = BillingUsageEvent.objects.create(
            organization_id=str(self.organization.id),
            user_id=str(self.user.id),
            meter_key="llm.tokens",
            biz_type="llm_call",
            biz_id=f"agent-turn:{session_id}:_main_chat:0",
            metadata={"session_id": session_id},
            quantity=Decimal("100"),
            unit_price=Decimal("0.01"),
            amount=Decimal("1"),
            unit="token",
            model_name="kimi-k2",
            occurred_at=timezone.now(),
        )
        return session, event

    def test_usage_events_resolve_task_name_from_session(self):
        BillingUsageEvent.objects.filter(organization_id=str(self.organization.id)).delete()
        # 主路径：session_id = 主键 UUID，thread_id 带 chat-session- 前缀
        _, pk_event = self._create_session_and_event(
            title="调研竞品定价",
            organization_id=str(self.organization.id),
            session_id_kind="pk",
        )
        # 兼容路径：session_id = 带前缀的 thread_id
        _, thread_event = self._create_session_and_event(
            title="整理周报",
            organization_id=str(self.organization.id),
            session_id_kind="thread_id",
        )
        # 无 session_id 的事件（存储 / 历史数据）task_name 应为空串
        BillingUsageEvent.objects.create(
            organization_id=str(self.organization.id),
            user_id=str(self.user.id),
            meter_key="storage.bytes",
            biz_type="oss_upload",
            biz_id="file-1",
            quantity=Decimal("1024"),
            unit_price=Decimal("0"),
            amount=Decimal("0"),
            unit="byte",
            occurred_at=timezone.now(),
        )

        url = f"{BASE}/organizations/{self.organization.id}/usage-events?limit=20"
        with self._auth_patches():
            resp = self.client.get(url, **_auth_header())
        self.assertEqual(resp.status_code, 200)
        events = resp.json()["data"]["events"]
        by_id = {e["id"]: e for e in events}
        self.assertEqual(by_id[str(pk_event.id)]["task_name"], "调研竞品定价")
        self.assertEqual(by_id[str(thread_event.id)]["task_name"], "整理周报")
        oss = next(e for e in events if e["biz_type"] == "oss_upload")
        self.assertEqual(oss["task_name"], "")

    def test_usage_events_task_name_not_leaked_across_organizations(self):
        """session_id 撞上其他组织的会话时不得泄漏对方标题。"""
        BillingUsageEvent.objects.filter(organization_id=str(self.organization.id)).delete()
        other_organization = Organization.objects.create(
            name="Other Team",
            owner_id=self.user.id,
            is_default=False,
        )
        # 会话属于其他组织，但事件落在本组织
        self._create_session_and_event(
            title="别家组织的机密任务",
            organization_id=str(other_organization.id),
        )

        url = f"{BASE}/organizations/{self.organization.id}/usage-events?limit=20"
        with self._auth_patches():
            resp = self.client.get(url, **_auth_header())
        self.assertEqual(resp.status_code, 200)
        events = resp.json()["data"]["events"]
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["task_name"], "")

    def test_export_csv_contains_task_name_column(self):
        """默认 audit schema 必须保留 task_name，供成员/审计导出归因。"""
        BillingUsageEvent.objects.filter(organization_id=str(self.organization.id)).delete()
        self._create_session_and_event(
            title="导出验证任务",
            organization_id=str(self.organization.id),
        )

        today = timezone.localdate()
        rows = list(
            BillingExportService.generate_csv_rows(
                organization_id=str(self.organization.id),
                start_date=today.replace(day=1),
                end_date=today,
            )
        )
        self.assertIn("task_name", rows[0])
        self.assertIn("user_id", rows[0])
        # 表头列数与数据行列数一致（metadata JSON 含逗号但有引号包裹，粗解析用表头计数即可）
        header_cols = rows[0].lstrip("\ufeff").strip().split(",")
        self.assertEqual(header_cols.index("task_name"), 10)
        self.assertEqual(header_cols.index("user_id"), 2)
        self.assertIn("导出验证任务", "".join(rows))
        self.assertIn(str(self.user.id), "".join(rows))

    def test_export_endpoint_default_schema_keeps_member_attribution(self):
        """成员导出（不传 schema）走 audit，CSV 含 user_id / task_name。"""
        BillingUsageEvent.objects.filter(organization_id=str(self.organization.id)).delete()
        self._create_session_and_event(
            title="成员导出任务",
            organization_id=str(self.organization.id),
        )
        today = timezone.localdate()
        start = today.replace(day=1)
        url = (
            f"{BASE}/organizations/{self.organization.id}/billing/export"
            f"?start_date={start.isoformat()}&end_date={today.isoformat()}"
        )
        with (
            patch.object(JWTAuth, "authenticate", return_value=self.user),
            patch(
                "apps.users.auth.invite_gate_middleware._has_redeemed_invite",
                return_value=True,
            ),
        ):
            resp = self.client.get(url, **_auth_header())
        self.assertEqual(resp.status_code, 200)
        content = b"".join(resp.streaming_content).decode("utf-8")
        header = content.splitlines()[0].lstrip("\ufeff")
        self.assertIn("user_id", header)
        self.assertIn("task_name", header)
        self.assertNotIn("计量项", header)
        self.assertIn(str(self.user.id), content)
        self.assertIn("成员导出任务", content)

    def test_export_endpoint_schema_ledger_returns_zh_columns(self):
        """LLM 账本导出显式 schema=ledger 时返回中文窄列。"""
        today = timezone.localdate()
        start = today.replace(day=1)
        url = (
            f"{BASE}/organizations/{self.organization.id}/billing/export"
            f"?start_date={start.isoformat()}&end_date={today.isoformat()}"
            f"&meter_key=llm.tokens&schema=ledger"
        )
        with (
            patch.object(JWTAuth, "authenticate", return_value=self.user),
            patch(
                "apps.users.auth.invite_gate_middleware._has_redeemed_invite",
                return_value=True,
            ),
        ):
            resp = self.client.get(url, **_auth_header())
        self.assertEqual(resp.status_code, 200)
        content = b"".join(resp.streaming_content).decode("utf-8")
        header = content.splitlines()[0].lstrip("\ufeff")
        self.assertIn("计量项,用量,模型,业务类型,credits,场景,创建时间", header)
        self.assertNotIn("user_id", header)
        self.assertNotIn("task_name", header)

    def test_export_endpoint_schema_llm_usage_matches_scene_list_columns(self):
        """新版场景列表导出走独立 schema，不改写旧 ledger 或 audit。"""
        today = timezone.localdate()
        start = today.replace(day=1)
        url = (
            f"{BASE}/organizations/{self.organization.id}/billing/export"
            f"?start_date={start.isoformat()}&end_date={today.isoformat()}"
            f"&meter_key=llm.tokens&schema=llm_usage"
        )
        with self._auth_patches():
            resp = self.client.get(url, **_auth_header())

        self.assertEqual(resp.status_code, 200)
        content = b"".join(resp.streaming_content).decode("utf-8")
        header = content.splitlines()[0].lstrip("\ufeff")
        self.assertEqual(header, "计量项,场景,用量,模型,credits,创建时间")
        self.assertNotIn("业务类型", header)
        self.assertIn("场景", header)
        self.assertNotIn("biz_type", header)
        self.assertNotIn("biz_id", header)

    def _export_rate_key(self) -> str:
        return f"{billing_api._EXPORT_RATE_KEY_PREFIX}{self.organization.id}"

    def _export_rate_count(self) -> int:
        return int(cache.get(self._export_rate_key(), 0) or 0)

    def test_invalid_schema_does_not_consume_export_rate_limit(self):
        """非法 schema 须在计次前 400，不得消耗组织共享导出配额。"""
        cache.delete(self._export_rate_key())
        today = timezone.localdate()
        start = today.replace(day=1)
        bad_url = (
            f"{BASE}/organizations/{self.organization.id}/billing/export"
            f"?start_date={start.isoformat()}&end_date={today.isoformat()}"
            f"&schema=invalid"
        )
        with self._auth_patches():
            for _ in range(billing_api._EXPORT_RATE_MAX + 2):
                resp = self.client.get(bad_url, **_auth_header())
                self.assertEqual(resp.status_code, 400)
        self.assertEqual(self._export_rate_count(), 0)

        # 非法请求烧完后，合法导出仍应成功（未被 429）
        with self._auth_patches():
            ok = self.client.get(self._export_url(), **_auth_header())
        self.assertEqual(ok.status_code, 200)
        self.assertEqual(self._export_rate_count(), 1)

    def test_invalid_timezone_does_not_consume_export_rate_limit(self):
        """非法 timezone 须在计次前 400。"""
        cache.delete(self._export_rate_key())
        today = timezone.localdate()
        start = today.replace(day=1)
        bad_url = (
            f"{BASE}/organizations/{self.organization.id}/billing/export"
            f"?start_date={start.isoformat()}&end_date={today.isoformat()}"
            f"&schema=ledger&timezone=Not/A_Zone"
        )
        with self._auth_patches():
            resp = self.client.get(bad_url, **_auth_header())
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(self._export_rate_count(), 0)

    def test_valid_export_still_enforces_rate_limit(self):
        """合法导出走完配额后仍应 429。"""
        cache.delete(self._export_rate_key())
        with self._auth_patches():
            for i in range(billing_api._EXPORT_RATE_MAX):
                resp = self.client.get(self._export_url(), **_auth_header())
                self.assertEqual(resp.status_code, 200, f"第 {i + 1} 次合法导出应成功")
            limited = self.client.get(self._export_url(), **_auth_header())
        self.assertEqual(limited.status_code, 429)
        self.assertEqual(self._export_rate_count(), billing_api._EXPORT_RATE_MAX)
