from unittest.mock import Mock, patch

from django.test import SimpleTestCase

from apps.services.agent_engine.utils.memory_locks import session_memory_lock
from apps.services.llm.scenes.exceptions import CapabilityMismatch


class SessionMemoryLockTests(SimpleTestCase):
    def _client(self):
        lock = Mock()
        lock.acquire.return_value = True
        client = Mock()
        client.lock.return_value = lock
        return client, lock

    def test_normal_enter_exit_releases_lock(self):
        client, lock = self._client()

        with patch(
            "apps.services.agent_engine.utils.memory_locks._get_redis_client",
            return_value=client,
        ):
            with session_memory_lock("session-1") as acquired:
                self.assertTrue(acquired)

        lock.release.assert_called_once_with()

    def test_capability_mismatch_from_body_is_preserved(self):
        client, lock = self._client()
        original = CapabilityMismatch("expected", scene_key="memory_capture")

        with patch(
            "apps.services.agent_engine.utils.memory_locks._get_redis_client",
            return_value=client,
        ):
            with self.assertRaises(CapabilityMismatch) as caught:
                with session_memory_lock("session-1"):
                    raise original

        self.assertIs(caught.exception, original)
        lock.release.assert_called_once_with()

    def test_ordinary_body_exception_is_preserved(self):
        client, lock = self._client()
        original = ValueError("expected")

        with patch(
            "apps.services.agent_engine.utils.memory_locks._get_redis_client",
            return_value=client,
        ):
            with self.assertRaises(ValueError) as caught:
                with session_memory_lock("session-1"):
                    raise original

        self.assertIs(caught.exception, original)
        lock.release.assert_called_once_with()

    def test_acquire_error_degrades_to_not_acquired_without_secondary_error(self):
        client, lock = self._client()
        lock.acquire.side_effect = RuntimeError("redis unavailable")

        with patch(
            "apps.services.agent_engine.utils.memory_locks._get_redis_client",
            return_value=client,
        ):
            with session_memory_lock("session-1") as acquired:
                self.assertFalse(acquired)

        lock.release.assert_not_called()
