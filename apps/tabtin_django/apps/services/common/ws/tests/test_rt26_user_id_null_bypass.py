"""
RT-26 回归测试：notifications / scheduled.tasks Validator user_id=None Fail-Close

验证 NotificationsValidator 和 ScheduledTasksValidator 在 consumer.user_id 为 None 时
正确拒绝订阅（返回错误字符串），而非静默放行（返回 None）。
"""
import os
import sys
import uuid
from unittest.mock import MagicMock

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

if "test" not in sys.argv:
    sys.argv.append("test")

import django  # noqa: E402
django.setup()

import pytest  # noqa: E402

from apps.services.common.ws.handlers.subscription_validators import (
    NotificationsValidator,
    ScheduledTasksValidator,
)


def _make_consumer(user_id=None, organization_id=None, role="electron"):
    consumer = MagicMock()
    consumer.user_id = user_id
    consumer.organization_id = organization_id
    consumer.role = role
    return consumer


# ══════════════════════════════════════════════════════════
# NotificationsValidator — user_id=None fail-close
# ══════════════════════════════════════════════════════════

class TestNotificationsValidatorUserIdNull:

    @pytest.mark.asyncio
    async def test_rejects_when_user_id_is_none(self):
        """consumer.user_id=None 时必须拒绝，不能静默放行。"""
        validator = NotificationsValidator()
        target_user = str(uuid.uuid4())
        consumer = _make_consumer(user_id=None)
        topic = f"notifications.{target_user}"
        parts = topic.split(".", 1)

        result = await validator.validate(consumer, topic, parts)
        assert result is not None, "user_id=None should be rejected, not allowed"
        assert "user_id" in result.lower() or "user" in result.lower()

    @pytest.mark.asyncio
    async def test_rejects_when_user_id_mismatch(self):
        """consumer.user_id 与 topic user_id 不一致时拒绝。"""
        validator = NotificationsValidator()
        own_user = str(uuid.uuid4())
        other_user = str(uuid.uuid4())
        consumer = _make_consumer(user_id=own_user)
        topic = f"notifications.{other_user}"
        parts = topic.split(".", 1)

        result = await validator.validate(consumer, topic, parts)
        assert result is not None
        assert "mismatch" in result

    @pytest.mark.asyncio
    async def test_allows_when_user_id_matches(self):
        """consumer.user_id 与 topic user_id 匹配时允许。"""
        validator = NotificationsValidator()
        user_id = str(uuid.uuid4())
        consumer = _make_consumer(user_id=user_id)
        topic = f"notifications.{user_id}"
        parts = topic.split(".", 1)

        result = await validator.validate(consumer, topic, parts)
        assert result is None

    @pytest.mark.asyncio
    async def test_rejects_when_user_id_is_empty_string(self):
        """consumer.user_id='' (falsy) 时必须拒绝。"""
        validator = NotificationsValidator()
        target_user = str(uuid.uuid4())
        consumer = _make_consumer(user_id="")
        topic = f"notifications.{target_user}"
        parts = topic.split(".", 1)

        result = await validator.validate(consumer, topic, parts)
        assert result is not None


# ══════════════════════════════════════════════════════════
# ScheduledTasksValidator — user_id=None fail-close
# ══════════════════════════════════════════════════════════

class TestScheduledTasksValidatorUserIdNull:

    @pytest.mark.asyncio
    async def test_rejects_when_user_id_is_none(self):
        """consumer.user_id=None 时必须拒绝，不能静默放行。"""
        validator = ScheduledTasksValidator()
        target_user = str(uuid.uuid4())
        consumer = _make_consumer(user_id=None)
        topic = f"scheduled.tasks.{target_user}"
        parts = topic.split(".", 2)

        result = await validator.validate(consumer, topic, parts)
        assert result is not None, "user_id=None should be rejected, not allowed"
        assert "user_id" in result.lower() or "user" in result.lower()

    @pytest.mark.asyncio
    async def test_rejects_when_user_id_mismatch(self):
        """consumer.user_id 与 topic user_id 不一致时拒绝。"""
        validator = ScheduledTasksValidator()
        own_user = str(uuid.uuid4())
        other_user = str(uuid.uuid4())
        consumer = _make_consumer(user_id=own_user)
        topic = f"scheduled.tasks.{other_user}"
        parts = topic.split(".", 2)

        result = await validator.validate(consumer, topic, parts)
        assert result is not None
        assert "mismatch" in result

    @pytest.mark.asyncio
    async def test_allows_when_user_id_matches(self):
        """consumer.user_id 与 topic user_id 匹配时允许。"""
        validator = ScheduledTasksValidator()
        user_id = str(uuid.uuid4())
        consumer = _make_consumer(user_id=user_id)
        topic = f"scheduled.tasks.{user_id}"
        parts = topic.split(".", 2)

        result = await validator.validate(consumer, topic, parts)
        assert result is None

    @pytest.mark.asyncio
    async def test_rejects_when_user_id_is_empty_string(self):
        """consumer.user_id='' (falsy) 时必须拒绝。"""
        validator = ScheduledTasksValidator()
        target_user = str(uuid.uuid4())
        consumer = _make_consumer(user_id="")
        topic = f"scheduled.tasks.{target_user}"
        parts = topic.split(".", 2)

        result = await validator.validate(consumer, topic, parts)
        assert result is not None
