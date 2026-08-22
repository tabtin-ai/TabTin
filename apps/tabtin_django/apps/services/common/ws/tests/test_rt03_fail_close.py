"""
RT-03 回归测试：AgentStream / ASR / TTS / AgentRuntime 订阅 Fail-Close

验证 _check_thread_organization 和各 Validator 在以下场景下正确拒绝：
  - 线程不存在（DB 中无记录）
  - DB 查询异常
  - organization 不匹配
"""
import asyncio
import os
import sys
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

if "test" not in sys.argv:
    sys.argv.append("test")

import django  # noqa: E402
django.setup()

import pytest  # noqa: E402

from apps.services.common.ws.handlers.subscription_validators import (
    AgentActionValidator,
    AgentSessionValidator,
    AgentStreamValidator,
    ASRStreamValidator,
    TTSStreamValidator,
)

_VALID_THREAD_PREFIX = "chat-session-"
_WS_ID = str(uuid.uuid4())


def _make_consumer(organization_id=_WS_ID, user_id=None, role="electron", organization_ids=None):
    from apps.services.common.ws.organization_context import OrganizationContext

    consumer = MagicMock()
    consumer.organization_id = organization_id
    org_ids = organization_ids if organization_ids is not None else ({organization_id} if organization_id else set())
    consumer.organization_ctx = OrganizationContext(
        organization_id, set(org_ids),
    )
    consumer.user_id = user_id or str(uuid.uuid4())
    consumer.role = role
    consumer.device_fingerprint = "fp-test"
    return consumer


# ══════════════════════════════════════════════════════════
# _check_thread_organization 单元测试
# ══════════════════════════════════════════════════════════

class TestCheckThreadWorkspaceFailClose:

    @pytest.mark.asyncio
    @patch("apps.chat.conversation.models.ChatSession")
    async def test_thread_not_found_returns_false(self, mock_cs):
        """线程不存在时必须返回 False（fail-close），不允许预先订阅。"""
        mock_cs.objects.filter.return_value.values_list.return_value.first.return_value = None

        with patch(
            "apps.services.common.ws.handlers.subscription_validators.database_sync_to_async",
            side_effect=lambda fn: AsyncMock(return_value=fn()),
        ):
            result = await AgentStreamValidator._check_thread_organization(
                f"{_VALID_THREAD_PREFIX}nonexistent", _make_consumer(_WS_ID)
            )
        assert result is False

    @pytest.mark.asyncio
    @patch("apps.chat.conversation.models.ChatSession")
    async def test_same_organization_returns_true(self, mock_cs):
        """线程存在且属于同一 organization 时返回 True。"""
        mock_cs.objects.filter.return_value.values_list.return_value.first.return_value = _WS_ID

        with patch(
            "apps.services.common.ws.handlers.subscription_validators.database_sync_to_async",
            side_effect=lambda fn: AsyncMock(return_value=fn()),
        ):
            result = await AgentStreamValidator._check_thread_organization(
                f"{_VALID_THREAD_PREFIX}existing", _make_consumer(_WS_ID)
            )
        assert result is True

    @pytest.mark.asyncio
    @patch("apps.chat.conversation.models.ChatSession")
    async def test_different_organization_returns_false(self, mock_cs):
        """线程存在但属于不同 organization 时返回 False。"""
        other_ws = str(uuid.uuid4())
        mock_cs.objects.filter.return_value.values_list.return_value.first.return_value = other_ws

        with patch(
            "apps.services.common.ws.handlers.subscription_validators.database_sync_to_async",
            side_effect=lambda fn: AsyncMock(return_value=fn()),
        ):
            result = await AgentStreamValidator._check_thread_organization(
                f"{_VALID_THREAD_PREFIX}other", _make_consumer(_WS_ID)
            )
        assert result is False

    @pytest.mark.asyncio
    async def test_db_error_returns_false(self):
        """DB 异常时必须返回 False（fail-close），而非 None/True。"""
        async def raise_db_error(*args, **kwargs):
            raise Exception("DB connection lost")

        with patch(
            "apps.services.common.ws.handlers.subscription_validators.database_sync_to_async",
            return_value=raise_db_error,
        ):
            result = await AgentStreamValidator._check_thread_organization(
                f"{_VALID_THREAD_PREFIX}err", _make_consumer(_WS_ID)
            )
        assert result is False


# ══════════════════════════════════════════════════════════
# AgentSessionValidator — 多组织 membership 订阅
# ══════════════════════════════════════════════════════════

from django.test import SimpleTestCase


class TestAgentSessionValidatorMembership(SimpleTestCase):

    def test_allows_session_in_non_primary_member_organization(self):
        """用户属于 session organization 且具备 owner-or-shared 时允许订阅。"""
        primary_org = str(uuid.uuid4())
        session_org = str(uuid.uuid4())
        session_id = str(uuid.uuid4())
        consumer = _make_consumer(primary_org, organization_ids={primary_org, session_org})
        topic = f"agent.session.{session_id}"

        with patch.object(
            AgentSessionValidator,
            "_get_session_organization_id",
            new_callable=AsyncMock,
            return_value=session_org,
        ), patch.object(
            AgentSessionValidator,
            "_check_session_owner_or_shared",
            new_callable=AsyncMock,
            return_value=True,
        ):
            result = asyncio.run(AgentSessionValidator().validate(consumer, topic, topic.split(".", 2)))

        self.assertIsNone(result)

    def test_rejects_session_outside_memberships(self):
        """session organization 不在连接 membership 集合中时继续 fail-close。"""
        primary_org = str(uuid.uuid4())
        session_org = str(uuid.uuid4())
        session_id = str(uuid.uuid4())
        consumer = _make_consumer(primary_org, organization_ids={primary_org})
        topic = f"agent.session.{session_id}"

        with patch.object(
            AgentSessionValidator,
            "_get_session_organization_id",
            new_callable=AsyncMock,
            return_value=session_org,
        ):
            result = asyncio.run(AgentSessionValidator().validate(consumer, topic, topic.split(".", 2)))

        self.assertEqual(result, "session access denied")

    def test_rejects_when_org_ok_but_not_owner_or_shared(self):
        """同组织但非 owner/shared 时拒绝订阅私有执行 session。"""
        primary_org = str(uuid.uuid4())
        session_id = str(uuid.uuid4())
        consumer = _make_consumer(primary_org, organization_ids={primary_org})
        topic = f"agent.session.{session_id}"

        with patch.object(
            AgentSessionValidator,
            "_get_session_organization_id",
            new_callable=AsyncMock,
            return_value=primary_org,
        ), patch.object(
            AgentSessionValidator,
            "_check_session_owner_or_shared",
            new_callable=AsyncMock,
            return_value=False,
        ):
            result = asyncio.run(AgentSessionValidator().validate(consumer, topic, topic.split(".", 2)))

        self.assertEqual(result, "session access denied")


# ══════════════════════════════════════════════════════════
# AgentStreamValidator.validate — 集成级
# ══════════════════════════════════════════════════════════

class TestAgentStreamValidatorFailClose(SimpleTestCase):

    @pytest.mark.asyncio
    async def test_rejects_when_thread_not_found(self):
        """线程不存在时 validate 应返回拒绝错误。"""
        validator = AgentStreamValidator()
        consumer = _make_consumer()
        thread_id = f"{_VALID_THREAD_PREFIX}{uuid.uuid4()}"
        topic = f"agent.stream.{thread_id}"
        parts = topic.split(".", 2)

        with patch.object(
            AgentStreamValidator,
            "_check_thread_organization",
            new_callable=AsyncMock,
            return_value=False,
        ):
            result = await validator.validate(consumer, topic, parts)
        assert result is not None
        assert "denied" in result

    @pytest.mark.asyncio
    async def test_rejects_when_db_error(self):
        """DB 异常时 validate 应返回拒绝错误。"""
        validator = AgentStreamValidator()
        consumer = _make_consumer()
        thread_id = f"{_VALID_THREAD_PREFIX}{uuid.uuid4()}"
        topic = f"agent.stream.{thread_id}"
        parts = topic.split(".", 2)

        with patch.object(
            AgentStreamValidator,
            "_check_thread_organization",
            new_callable=AsyncMock,
            return_value=False,
        ):
            result = await validator.validate(consumer, topic, parts)
        assert result is not None
        assert "denied" in result

    def test_allows_when_thread_in_same_organization(self):
        """线程属于同一 organization 且具备 owner-or-shared 时 validate 返回 None。"""
        validator = AgentStreamValidator()
        consumer = _make_consumer()
        thread_id = f"{_VALID_THREAD_PREFIX}{uuid.uuid4()}"
        topic = f"agent.stream.{thread_id}"
        parts = topic.split(".", 2)

        async def _run():
            with patch.object(
                AgentStreamValidator,
                "_check_thread_organization",
                new_callable=AsyncMock,
                return_value=True,
            ), patch.object(
                AgentStreamValidator,
                "_check_thread_session_access",
                new_callable=AsyncMock,
                return_value=True,
            ):
                return await validator.validate(consumer, topic, parts)

        self.assertIsNone(asyncio.run(_run()))

    def test_share_scoped_subscription_passes_exact_share_id_to_access_gate(self):
        validator = AgentStreamValidator()
        consumer = _make_consumer()
        thread_id = f"{_VALID_THREAD_PREFIX}{uuid.uuid4()}"
        topic = f"agent.stream.{thread_id}"
        share_id = str(uuid.uuid4())
        consumer._pending_topic_contexts = {
            topic: {"share_id": share_id},
        }
        parts = topic.split(".", 2)

        async def _run():
            with patch.object(
                AgentStreamValidator,
                "_check_thread_organization",
                new_callable=AsyncMock,
                return_value=True,
            ), patch.object(
                AgentStreamValidator,
                "_check_thread_session_access",
                new_callable=AsyncMock,
                return_value=True,
            ) as access_gate:
                result = await validator.validate(consumer, topic, parts)
                access_gate.assert_awaited_once_with(
                    thread_id,
                    consumer,
                    session_share_id=share_id,
                )
                return result

        self.assertIsNone(asyncio.run(_run()))

    def test_rejects_when_org_ok_but_not_owner_or_shared(self):
        """同组织但非责任人/shared 时拒绝私有执行流。"""
        validator = AgentStreamValidator()
        consumer = _make_consumer()
        thread_id = f"{_VALID_THREAD_PREFIX}{uuid.uuid4()}"
        topic = f"agent.stream.{thread_id}"
        parts = topic.split(".", 2)

        async def _run():
            with patch.object(
                AgentStreamValidator,
                "_check_thread_organization",
                new_callable=AsyncMock,
                return_value=True,
            ), patch.object(
                AgentStreamValidator,
                "_check_thread_session_access",
                new_callable=AsyncMock,
                return_value=False,
            ):
                return await validator.validate(consumer, topic, parts)

        result = asyncio.run(_run())
        self.assertIsNotNone(result)
        self.assertIn("denied", result)

    def test_rejects_when_no_organization_id(self):
        """consumer 缺少 organization_id 时应被拒绝。"""
        validator = AgentStreamValidator()
        consumer = _make_consumer(organization_id=None)
        thread_id = f"{_VALID_THREAD_PREFIX}{uuid.uuid4()}"
        topic = f"agent.stream.{thread_id}"
        parts = topic.split(".", 2)

        result = asyncio.run(validator.validate(consumer, topic, parts))
        self.assertIsNotNone(result)
        self.assertIn("organization", result.lower())


class TestAgentActionValidatorSessionAccess(SimpleTestCase):
    """#6912：agent.action.* 须复用 owner-or-shared，不能只靠 org。"""

    def test_allows_owner_or_shared_electron(self):
        validator = AgentActionValidator()
        consumer = _make_consumer()
        thread_id = f"{_VALID_THREAD_PREFIX}{uuid.uuid4()}"
        topic = f"agent.action.{thread_id}"
        parts = topic.split(".", 2)

        async def _run():
            with patch.object(
                AgentStreamValidator,
                "_check_thread_organization",
                new_callable=AsyncMock,
                return_value=True,
            ), patch.object(
                AgentStreamValidator,
                "_check_thread_session_access",
                new_callable=AsyncMock,
                return_value=True,
            ), patch(
                "apps.services.common.ws.handlers.subscription_validators.run_sync_io",
                new_callable=AsyncMock,
                return_value=None,
            ):
                return await validator.validate(consumer, topic, parts)

        self.assertIsNone(asyncio.run(_run()))

    def test_rejects_when_org_ok_but_not_owner_or_shared(self):
        validator = AgentActionValidator()
        consumer = _make_consumer()
        thread_id = f"{_VALID_THREAD_PREFIX}{uuid.uuid4()}"
        topic = f"agent.action.{thread_id}"
        parts = topic.split(".", 2)

        async def _run():
            with patch.object(
                AgentStreamValidator,
                "_check_thread_organization",
                new_callable=AsyncMock,
                return_value=True,
            ), patch.object(
                AgentStreamValidator,
                "_check_thread_session_access",
                new_callable=AsyncMock,
                return_value=False,
            ):
                return await validator.validate(consumer, topic, parts)

        result = asyncio.run(_run())
        self.assertIsNotNone(result)
        self.assertIn("denied", result)

    def test_rejects_non_device_role_even_when_session_ok(self):
        validator = AgentActionValidator()
        consumer = _make_consumer(role="web")
        thread_id = f"{_VALID_THREAD_PREFIX}{uuid.uuid4()}"
        topic = f"agent.action.{thread_id}"
        parts = topic.split(".", 2)

        async def _run():
            with patch.object(
                AgentStreamValidator,
                "_check_thread_organization",
                new_callable=AsyncMock,
                return_value=True,
            ), patch.object(
                AgentStreamValidator,
                "_check_thread_session_access",
                new_callable=AsyncMock,
                return_value=True,
            ):
                return await validator.validate(consumer, topic, parts)

        result = asyncio.run(_run())
        self.assertIsNotNone(result)
        self.assertIn("role", result.lower())


# ══════════════════════════════════════════════════════════
# ASR / TTS / AgentRuntime — fail-close 一致性
# ══════════════════════════════════════════════════════════

class TestASRTTSAgentRuntimeFailClose:
    """验证 ASR、TTS 两个 Validator 共享的 fail-close 行为。"""

    @pytest.fixture(params=[
        ("asr.stream", ASRStreamValidator, "asr stream access denied"),
        ("tts.stream", TTSStreamValidator, "tts stream access denied"),
    ], ids=["ASR", "TTS"])
    def validator_info(self, request):
        return request.param

    @pytest.mark.asyncio
    async def test_rejects_when_thread_not_found(self, validator_info):
        prefix, cls, expected_msg = validator_info
        validator = cls()
        consumer = _make_consumer()
        thread_id = f"{_VALID_THREAD_PREFIX}{uuid.uuid4()}"
        topic = f"{prefix}.{thread_id}"
        parts = topic.split(".", 2)

        with patch.object(
            AgentStreamValidator,
            "_check_thread_organization",
            new_callable=AsyncMock,
            return_value=False,
        ):
            result = await validator.validate(consumer, topic, parts)
        assert result == expected_msg

    @pytest.mark.asyncio
    async def test_rejects_when_db_error(self, validator_info):
        prefix, cls, expected_msg = validator_info
        validator = cls()
        consumer = _make_consumer()
        thread_id = f"{_VALID_THREAD_PREFIX}{uuid.uuid4()}"
        topic = f"{prefix}.{thread_id}"
        parts = topic.split(".", 2)

        with patch.object(
            AgentStreamValidator,
            "_check_thread_organization",
            new_callable=AsyncMock,
            return_value=False,
        ):
            result = await validator.validate(consumer, topic, parts)
        assert result == expected_msg

    @pytest.mark.asyncio
    async def test_allows_when_thread_in_same_organization(self, validator_info):
        prefix, cls, _ = validator_info
        validator = cls()
        consumer = _make_consumer()
        thread_id = f"{_VALID_THREAD_PREFIX}{uuid.uuid4()}"
        topic = f"{prefix}.{thread_id}"
        parts = topic.split(".", 2)

        with patch.object(
            AgentStreamValidator,
            "_check_thread_organization",
            new_callable=AsyncMock,
            return_value=True,
        ), patch.object(
            AgentStreamValidator,
            "_check_thread_session_access",
            new_callable=AsyncMock,
            return_value=True,
        ):
            result = await validator.validate(consumer, topic, parts)
        assert result is None
