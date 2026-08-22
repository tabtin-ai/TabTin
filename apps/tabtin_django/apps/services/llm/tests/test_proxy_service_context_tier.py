"""proxy_service._resolve_upstream_tier_headers 的透传语义测试。

这是 long_context_tier 链路的「Django 代理→上游」关键节点：
客户端透来 `X-TabTin-Context-Tier: long_1m` 时，proxy 必须把档位
配置里的 `extra_headers`（如 `anthropic-beta: context-1m-2025-08-07`）
合并到 upstream headers，否则 ZenMux / Anthropic 按默认 200K 走。

覆盖四条路径：
  1. 显式 tier_id 命中 → 返回该档 extra_headers
  2. 显式 tier_id 未命中 → 回退默认档 extra_headers
  3. 无 tier_id → 默认档 extra_headers
  4. 模型未配档位 → 空 dict
"""

from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import patch

from django.test import SimpleTestCase

from apps.services.llm.proxy_api import (
    _attempt_key_matches_logical_index,
    _extract_billing_header_values,
    _is_trusted_agent_billing_key,
)
from apps.services.llm.services.proxy_service import (
    ProxyContext,
    _resolve_upstream_tier_headers,
    settle_and_charge,
)


class AgentBillingKeyTrustTests(SimpleTestCase):
    @patch("apps.tabchat.models.AgentMentionJob.objects.filter")
    def test_key_must_bind_to_running_job_identity(self, filter_jobs):
        filter_jobs.return_value.exists.return_value = True

        trusted = _is_trusted_agent_billing_key(
            "agent-turn:tabchat-agent-mention:10:agent-1:_main_chat:0",
            user_id="user-1",
            organization_id="org-1",
            session_id="session-1",
            request_source="_main_chat",
        )

        self.assertTrue(trusted)
        filter_jobs.assert_called_once_with(
            billing_idempotency_key="tabchat-agent-mention:10:agent-1",
            organization_id="org-1",
            session_id="session-1",
            source_message__sender_id="user-1",
            status="running",
        )

    @patch("apps.tabchat.models.AgentMentionJob.objects.filter")
    def test_unscoped_or_malformed_key_is_rejected_without_lookup(self, filter_jobs):
        self.assertFalse(
            _is_trusted_agent_billing_key(
                "arbitrary-client-key",
                user_id="user-1",
                organization_id="org-1",
                session_id="session-1",
                request_source="_main_chat",
            )
        )
        self.assertFalse(
            _is_trusted_agent_billing_key(
                "agent-turn:tabchat-agent-mention:10:agent-1:_compact:0",
                user_id="user-1",
                organization_id="org-1",
                session_id="session-1",
                request_source="_main_chat",
            )
        )
        filter_jobs.assert_not_called()

    @patch("apps.tabchat.models.AgentMentionJob.objects.filter")
    def test_subagent_scope_is_bound_to_parent_job(self, filter_jobs):
        filter_jobs.return_value.exists.return_value = True

        trusted = _is_trusted_agent_billing_key(
            "agent-turn:tabchat-agent-mention:10:agent-1:subagent:child-1:_sub_agent:0",
            user_id="user-1",
            organization_id="org-1",
            session_id="session-1",
            request_source="_sub_agent",
        )

        self.assertTrue(trusted)
        self.assertEqual(
            filter_jobs.call_args.kwargs["billing_idempotency_key"],
            "tabchat-agent-mention:10:agent-1",
        )


class BillingHeaderExtractionTests(SimpleTestCase):
    def test_attempt_headers_use_attempt_key_as_idempotency_key(self):
        headers = _extract_billing_header_values({
            "HTTP_X_TABTIN_BILLING_IDEMPOTENCY_KEY": "legacy-key",
            "HTTP_X_TABTIN_BILLING_LOGICAL_KEY": "agent-turn:scope:_main_chat:0",
            "HTTP_X_TABTIN_BILLING_ATTEMPT_KEY": "agent-turn:scope:_main_chat:0:attempt:1",
            "HTTP_X_TABTIN_BILLING_ATTEMPT_INDEX": "1",
        })

        self.assertEqual(
            headers.idempotency_key,
            "agent-turn:scope:_main_chat:0:attempt:1",
        )
        self.assertEqual(headers.logical_billing_key, "agent-turn:scope:_main_chat:0")
        self.assertEqual(headers.attempt_index, 1)

    def test_legacy_header_ignores_orphan_attempt_index(self):
        headers = _extract_billing_header_values({
            "HTTP_X_TABTIN_BILLING_IDEMPOTENCY_KEY": "legacy-key",
            "HTTP_X_TABTIN_BILLING_ATTEMPT_INDEX": "1",
        })

        self.assertEqual(headers.idempotency_key, "legacy-key")
        self.assertEqual(headers.logical_billing_key, "")
        self.assertIsNone(headers.attempt_index)

    def test_attempt_key_must_match_logical_key_and_index(self):
        self.assertTrue(
            _attempt_key_matches_logical_index(
                "agent-turn:scope:_main_chat:0:attempt:1",
                logical_billing_key="agent-turn:scope:_main_chat:0",
                attempt_index=1,
            )
        )
        self.assertFalse(
            _attempt_key_matches_logical_index(
                "agent-turn:scope:_main_chat:0:attempt:2",
                logical_billing_key="agent-turn:scope:_main_chat:0",
                attempt_index=1,
            )
        )


def _make_model(tiers: list[dict] | None) -> SimpleNamespace:
    """造一个最小 model_instance，仅 custom_billing_config 一个字段。"""
    if tiers is None:
        return SimpleNamespace(model_name="test-model", custom_billing_config={})
    return SimpleNamespace(
        model_name="test-model",
        custom_billing_config={"tiered_pricing": {"tiers": tiers}},
    )


def _make_ctx(
    model_instance: SimpleNamespace | None,
    *,
    tier_id: str | None = None,
) -> ProxyContext:
    return ProxyContext(
        request_id="req-test",
        model_instance=model_instance,
        context_tier_id=tier_id,
    )


STANDARD_TIER = {
    "id": "standard",
    "label": "标准 (200K)",
    "is_default": True,
    "max_input_tokens": 200000,
}

LONG_TIER = {
    "id": "long_1m",
    "label": "长上下文 (1M, Beta)",
    "max_input_tokens": 1000000,
    "extra_headers": {"anthropic-beta": "context-1m-2025-08-07"},
    "tags": ["beta"],
}


class TestResolveUpstreamTierHeaders(SimpleTestCase):
    def test_explicit_tier_id_returns_its_extra_headers(self):
        """用户显式选了 long_1m → 必须透 anthropic-beta，否则 1M 就是假的。"""
        ctx = _make_ctx(_make_model([STANDARD_TIER, LONG_TIER]), tier_id="long_1m")
        headers = _resolve_upstream_tier_headers(ctx)
        self.assertEqual(headers, {"anthropic-beta": "context-1m-2025-08-07"})

    def test_default_tier_headers_when_no_tier_id(self):
        """无显式 tier_id → 走默认档（is_default=true 的 standard，没配 extra_headers）。
        不应错把 long_1m 的 header 塞给默认请求，否则用户不知情被 1M 计费。"""
        ctx = _make_ctx(_make_model([STANDARD_TIER, LONG_TIER]))
        headers = _resolve_upstream_tier_headers(ctx)
        self.assertEqual(headers, {})

    def test_unknown_tier_id_falls_back_to_default(self):
        """tier_id 拼错 → 降级到默认档，不阻塞请求。"""
        ctx = _make_ctx(_make_model([STANDARD_TIER, LONG_TIER]), tier_id="typo")
        headers = _resolve_upstream_tier_headers(ctx)
        self.assertEqual(headers, {})  # standard 没配 extra_headers

    def test_no_tiers_returns_empty(self):
        """模型未配档位 → 空 dict，不干扰 upstream headers。"""
        ctx = _make_ctx(_make_model(None))
        headers = _resolve_upstream_tier_headers(ctx)
        self.assertEqual(headers, {})

    def test_no_model_instance_returns_empty(self):
        """ctx.model_instance 为 None 时安全返回（防御式，避免 AttributeError 崩掉 proxy）。"""
        ctx = _make_ctx(None)
        headers = _resolve_upstream_tier_headers(ctx)
        self.assertEqual(headers, {})

    def test_stringifies_non_string_header_values(self):
        """extra_headers 里混入数字等非字符串时安全转字符串，不抛类型错误。"""
        weird_tier = {
            "id": "weird",
            "is_default": True,
            "max_input_tokens": 100000,
            "extra_headers": {"x-retry-count": 3, "x-enabled": True},
        }
        ctx = _make_ctx(_make_model([weird_tier]))
        headers = _resolve_upstream_tier_headers(ctx)
        self.assertEqual(headers, {"x-retry-count": "3", "x-enabled": "True"})

    def test_ignores_malformed_extra_headers(self):
        """extra_headers 不是 dict（运营误填）时静默忽略，不破坏请求。"""
        bad_tier = {
            "id": "bad",
            "is_default": True,
            "max_input_tokens": 100000,
            "extra_headers": "anthropic-beta=context-1m",  # 错填成字符串
        }
        ctx = _make_ctx(_make_model([bad_tier]))
        headers = _resolve_upstream_tier_headers(ctx)
        self.assertEqual(headers, {})

    def test_drops_empty_header_values(self):
        """空值的 header 被过滤，防止把 `X: ` 发出去触发上游 400。"""
        cleanup_tier = {
            "id": "cleanup",
            "is_default": True,
            "max_input_tokens": 100000,
            "extra_headers": {
                "anthropic-beta": "context-1m-2025-08-07",
                "x-empty": "",
                "x-none": None,
            },
        }
        ctx = _make_ctx(_make_model([cleanup_tier]))
        headers = _resolve_upstream_tier_headers(ctx)
        self.assertIn("anthropic-beta", headers)
        self.assertNotIn("x-none", headers)


class TestSettleAndChargeSceneKey(SimpleTestCase):
    """子 Agent 计费收尾（任务 B）：网关真计费点 settle_and_charge 必须把
    ctx.scene_key 透传进 charge_llm_usage → BillingUsageEvent，与同一请求写入
    LLMUsageFact 的 scene_key 同源同值（让财务报表按活类型下钻）。"""

    def _ctx(self, *, scene_key: str, source: str = "agent_runtime") -> ProxyContext:
        return ProxyContext(
            request_id="req-scene",
            user_id="u1",
            organization_id="ws1",
            source=source,
            scene_key=scene_key,
            model_instance=SimpleNamespace(model_name="m"),
        )

    def _run(self, ctx: ProxyContext):
        with patch(
            "apps.services.llm.services.billing.charge_llm_usage",
            return_value={"credits_consumed_precise": Decimal("0")},
        ) as mock_charge, patch(
            "apps.services.llm.services.billed_call._record_usage_fact_for_billed_call",
        ) as mock_usage_fact, patch(
            "apps.services.llm.services.billed_call._settle_freeze_safely",
        ):
            settle_and_charge(ctx, {"input_tokens": 10, "output_tokens": 5})
        return mock_charge, mock_usage_fact

    def test_explicit_scene_key_passed_to_charge(self):
        mock_charge, _ = self._run(self._ctx(scene_key="_sub_agent"))
        self.assertEqual(mock_charge.call_args.kwargs["scene_key"], "_sub_agent")

    def test_empty_scene_key_falls_back_to_source_mapping(self):
        # scene_key 为空 → 回退 map_source_to_scene_key（未知 source → _main_chat）
        mock_charge, _ = self._run(self._ctx(scene_key="", source="unknown_src"))
        self.assertEqual(mock_charge.call_args.kwargs["scene_key"], "_main_chat")

    def test_explicit_billing_key_deduplicates_charge_and_usage_fact(self):
        ctx = self._ctx(scene_key="_main_chat")
        ctx.billing_idempotency_key = "agent-turn:job-1:_main_chat:0"

        mock_charge, mock_usage_fact = self._run(ctx)

        self.assertEqual(
            mock_charge.call_args.kwargs["idempotency_key"],
            ctx.billing_idempotency_key,
        )
        self.assertEqual(
            mock_charge.call_args.kwargs["biz_id"],
            ctx.billing_idempotency_key,
        )
        self.assertEqual(
            mock_usage_fact.call_args.kwargs["request_id"],
            ctx.billing_idempotency_key,
        )

    def test_session_id_passed_via_billing_metadata(self):
        """#4572：session_id 必须随 billing_metadata 落进 BillingUsageEvent.metadata，
        供用量流水反查会话标题（任务名）。"""
        ctx = self._ctx(scene_key="_main_chat")
        ctx.session_id = "thread-abc"

        mock_charge, _ = self._run(ctx)

        self.assertEqual(
            mock_charge.call_args.kwargs["billing_metadata"],
            {"session_id": "thread-abc"},
        )

    def test_freeze_id_passed_via_billing_metadata(self):
        ctx = self._ctx(scene_key="_main_chat")
        ctx.freeze_id = "freeze:run:1"

        mock_charge, _ = self._run(ctx)

        self.assertEqual(
            mock_charge.call_args.kwargs["billing_metadata"],
            {"freeze_id": "freeze:run:1"},
        )

    def test_no_session_id_sends_none_billing_metadata(self):
        mock_charge, _ = self._run(self._ctx(scene_key="_main_chat"))
        self.assertIsNone(mock_charge.call_args.kwargs["billing_metadata"])


class TestSettleAndChargeTotalConsumed(SimpleTestCase):
    """#5052 followup：settle_and_charge 上报给 runtime 的 credits_charged 必须是
    「本次总消耗」= 配额覆盖 + 免费溢出 + 钱包实扣 paygo，而非仅钱包 paygo。

    否则 quota_only（默认）模式下 paygo 恒为 0 → tabtin.billing 尾帧上报 0 →
    runtime state.creditsCharged 恒 0 → CostCap.max_credits_per_run 预算闸门永不触发。"""

    def _ctx(self) -> ProxyContext:
        return ProxyContext(
            request_id="req-total",
            user_id="u1",
            organization_id="ws1",
            source="agent_runtime",
            scene_key="_main_chat",
            model_instance=SimpleNamespace(model_name="m"),
        )

    def _run(self, charge_return):
        with patch(
            "apps.services.llm.services.billing.charge_llm_usage",
            return_value=charge_return,
        ), patch(
            "apps.services.llm.services.billed_call._record_usage_fact_for_billed_call",
        ), patch(
            "apps.services.llm.services.billed_call._settle_freeze_safely",
        ):
            return settle_and_charge(self._ctx(), {"input_tokens": 10, "output_tokens": 5})

    def test_quota_only_paygo_zero_still_reports_total(self):
        # quota_only：钱包实扣 paygo=0，但配额覆盖 8 + 溢出 2 = 10 实际消耗。
        credits_charged, charge_ok, error_category = self._run({
            "quota_covered_credits_precise": Decimal("8"),
            "overflow_credits_precise": Decimal("2"),
            "credits_consumed_precise": Decimal("0"),
        })
        self.assertTrue(charge_ok)
        self.assertEqual(credits_charged, 10.0)
        self.assertIsNone(error_category)

    def test_paygo_only_still_counted(self):
        # 纯钱包实扣：paygo 5，其余缺省 → 总 5。
        credits_charged, charge_ok, error_category = self._run({
            "credits_consumed_precise": Decimal("5"),
        })
        self.assertTrue(charge_ok)
        self.assertEqual(credits_charged, 5.0)
        self.assertIsNone(error_category)

    def test_zero_consumption_dict_reports_zero_but_ok(self):
        # 真实零消耗（幂等命中 / 零 token）：字段存在但为 0 → 总消耗 0，charge_ok True。
        credits_charged, charge_ok, error_category = self._run(
            {"credits_consumed_precise": Decimal("0")}
        )
        self.assertTrue(charge_ok)
        self.assertEqual(credits_charged, 0.0)
        self.assertIsNone(error_category)

    def test_charge_none_defaults_to_billing_charge_failed(self):
        with patch(
            "apps.services.llm.services.billed_call._organization_has_post_charge_insufficient_block",
            return_value=False,
        ):
            credits_charged, charge_ok, error_category = self._run(None)
        self.assertFalse(charge_ok)
        self.assertEqual(credits_charged, 0.0)
        self.assertEqual(error_category, "billing_charge_failed")

    def test_charge_none_with_post_charge_block_is_insufficient(self):
        with patch(
            "apps.services.llm.services.billed_call._organization_has_post_charge_insufficient_block",
            return_value=True,
        ):
            _credits, charge_ok, error_category = self._run(None)
        self.assertFalse(charge_ok)
        self.assertEqual(error_category, "organization_insufficient_credits")
