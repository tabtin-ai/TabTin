"""
chat.session.presence — session viewing presence 原语 + handler 回归测试。

覆盖：
  - Redis ZSET set/refresh、clear、同设备切 session、多设备任一 active
  - 同设备指纹的并发连接隔离、disconnect 优先清理
  - 过期剔除、Redis 异常 fail-open
  - handler role / schema / 访问授权
  - Redis 写/清失败不伪造成功、gateway registry
"""
from __future__ import annotations

import asyncio
import os
from pathlib import Path
import re
import sys
import time
import uuid
from typing import Any, Dict, Optional
from unittest.mock import AsyncMock, MagicMock, patch

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

if "test" not in sys.argv:
    sys.argv.append("test")

import django  # noqa: E402

django.setup()

from django.test import SimpleTestCase  # noqa: E402

from apps.services.common.ws.protocol import ERROR_PERMISSION_DENIED  # noqa: E402

_USER_A = "user-aaaa-1111"
_USER_B = "user-bbbb-2222"
_SESSION_1 = "11111111-1111-4111-8111-111111111111"
_SESSION_2 = "22222222-2222-4222-8222-222222222222"
_FP_A = "electron-fp-aaa"
_FP_B = "electron-fp-bbb"
_CONN_A = "specific.ws.connection-a"
_CONN_B = "specific.ws.connection-b"


class _FakeRedis:
    """最小 ZSET 假实现，覆盖本模块用到的命令。"""

    def __init__(self) -> None:
        self.zsets: Dict[str, Dict[str, float]] = {}
        self.ttls: Dict[str, int] = {}

    def zadd(self, key: str, mapping: Dict[str, float]) -> int:
        bucket = self.zsets.setdefault(key, {})
        added = 0
        for member, score in mapping.items():
            if member not in bucket:
                added += 1
            bucket[member] = float(score)
        return added

    def zrem(self, key: str, *members: str) -> int:
        bucket = self.zsets.get(key, {})
        removed = 0
        for member in members:
            if member in bucket:
                del bucket[member]
                removed += 1
        return removed

    def zremrangebyscore(self, key: str, min_score: Any, max_score: Any) -> int:
        bucket = self.zsets.get(key, {})
        lo = float("-inf") if min_score in ("-inf", None) else float(min_score)
        hi = float("inf") if max_score in ("+inf", None) else float(max_score)
        doomed = [m for m, s in bucket.items() if lo <= s <= hi]
        for m in doomed:
            del bucket[m]
        return len(doomed)

    def zcard(self, key: str) -> int:
        return len(self.zsets.get(key, {}))

    def zscore(self, key: str, member: str) -> Optional[float]:
        return self.zsets.get(key, {}).get(member)

    def expire(self, key: str, ttl: int) -> bool:
        self.ttls[key] = int(ttl)
        return True

    def pipeline(self) -> "_FakePipeline":
        return _FakePipeline(self)


class _FakePipeline:
    def __init__(self, redis: _FakeRedis) -> None:
        self._redis = redis
        self._ops: list = []

    def zadd(self, key: str, mapping: Dict[str, float]):
        self._ops.append(("zadd", key, mapping))
        return self

    def zrem(self, key: str, *members: str):
        self._ops.append(("zrem", key, members))
        return self

    def expire(self, key: str, ttl: int):
        self._ops.append(("expire", key, ttl))
        return self

    def zremrangebyscore(self, key: str, min_score: Any, max_score: Any):
        self._ops.append(("zremrangebyscore", key, min_score, max_score))
        return self

    def execute(self) -> list:
        results = []
        for op in self._ops:
            name = op[0]
            if name == "zadd":
                results.append(self._redis.zadd(op[1], op[2]))
            elif name == "zrem":
                results.append(self._redis.zrem(op[1], *op[2]))
            elif name == "expire":
                results.append(self._redis.expire(op[1], op[2]))
            elif name == "zremrangebyscore":
                results.append(self._redis.zremrangebyscore(op[1], op[2], op[3]))
        self._ops.clear()
        return results


def _patch_redis(fake: _FakeRedis):
    return patch(
        "apps.services.common.ws.session_viewing.get_redis_connection",
        return_value=fake,
    )


class SessionViewingPrimitiveTests(SimpleTestCase):
    def test_set_and_refresh_marks_active(self):
        from apps.services.common.ws.session_viewing import (
            SESSION_VIEWING_TTL_SECONDS,
            is_user_viewing_session,
            session_viewing_key,
            set_session_viewing,
        )

        fake = _FakeRedis()
        with _patch_redis(fake):
            set_session_viewing(_USER_A, _SESSION_1, _CONN_A)
            self.assertTrue(is_user_viewing_session(_USER_A, _SESSION_1))

            key = session_viewing_key(_USER_A, _SESSION_1)
            first_score = fake.zscore(key, _CONN_A)
            self.assertIsNotNone(first_score)
            self.assertEqual(fake.ttls.get(key), SESSION_VIEWING_TTL_SECONDS)

            time.sleep(0.01)
            set_session_viewing(_USER_A, _SESSION_1, _CONN_A)
            second_score = fake.zscore(key, _CONN_A)
            self.assertGreaterEqual(second_score, first_score)

    def test_clear_removes_device_member(self):
        from apps.services.common.ws.session_viewing import (
            clear_session_viewing,
            is_user_viewing_session,
            set_session_viewing,
        )

        fake = _FakeRedis()
        with _patch_redis(fake):
            set_session_viewing(_USER_A, _SESSION_1, _CONN_A)
            clear_session_viewing(_USER_A, _SESSION_1, _CONN_A)
            self.assertFalse(is_user_viewing_session(_USER_A, _SESSION_1))

    def test_same_device_switch_session_clears_old(self):
        from apps.services.common.ws.session_viewing import (
            clear_session_viewing,
            is_user_viewing_session,
            set_session_viewing,
        )

        fake = _FakeRedis()
        with _patch_redis(fake):
            set_session_viewing(_USER_A, _SESSION_1, _CONN_A)
            clear_session_viewing(_USER_A, _SESSION_1, _CONN_A)
            set_session_viewing(_USER_A, _SESSION_2, _CONN_A)
            self.assertFalse(is_user_viewing_session(_USER_A, _SESSION_1))
            self.assertTrue(is_user_viewing_session(_USER_A, _SESSION_2))

    def test_multi_device_any_active(self):
        from apps.services.common.ws.session_viewing import (
            clear_session_viewing,
            is_user_viewing_session,
            set_session_viewing,
        )

        fake = _FakeRedis()
        with _patch_redis(fake):
            set_session_viewing(_USER_A, _SESSION_1, _CONN_A)
            set_session_viewing(_USER_A, _SESSION_1, _CONN_B)
            clear_session_viewing(_USER_A, _SESSION_1, _CONN_A)
            self.assertTrue(is_user_viewing_session(_USER_A, _SESSION_1))
            clear_session_viewing(_USER_A, _SESSION_1, _CONN_B)
            self.assertFalse(is_user_viewing_session(_USER_A, _SESSION_1))

    def test_expired_members_are_purged(self):
        from apps.services.common.ws import session_viewing as sv

        fake = _FakeRedis()
        with _patch_redis(fake):
            now = time.time()
            with patch.object(sv.time, "time", return_value=now - sv.SESSION_VIEWING_TTL_SECONDS - 5):
                sv.set_session_viewing(_USER_A, _SESSION_1, _CONN_A)
            with patch.object(sv.time, "time", return_value=now):
                self.assertFalse(sv.is_user_viewing_session(_USER_A, _SESSION_1))

    def test_redis_error_fail_open_returns_false(self):
        from apps.services.common.ws.session_viewing import is_user_viewing_session

        with patch(
            "apps.services.common.ws.session_viewing.get_redis_connection",
            side_effect=ConnectionError("redis down"),
        ):
            self.assertFalse(is_user_viewing_session(_USER_A, _SESSION_1))

    def test_redis_set_failure_returns_false_and_query_fails_open(self):
        from apps.services.common.ws.session_viewing import (
            is_user_viewing_session,
            set_session_viewing,
        )

        with patch(
            "apps.services.common.ws.session_viewing.get_redis_connection",
            side_effect=ConnectionError("redis down"),
        ):
            self.assertIs(
                set_session_viewing(_USER_A, _SESSION_1, _CONN_A),
                False,
            )
            self.assertFalse(is_user_viewing_session(_USER_A, _SESSION_1))

    def test_redis_clear_failure_returns_false_and_query_fails_open(self):
        from apps.services.common.ws.session_viewing import (
            clear_session_viewing,
            is_user_viewing_session,
        )

        with patch(
            "apps.services.common.ws.session_viewing.get_redis_connection",
            side_effect=ConnectionError("redis down"),
        ):
            self.assertIs(
                clear_session_viewing(_USER_A, _SESSION_1, _CONN_A),
                False,
            )
            self.assertFalse(is_user_viewing_session(_USER_A, _SESSION_1))

    def test_missing_session_or_user_returns_false(self):
        from apps.services.common.ws.session_viewing import is_user_viewing_session

        self.assertFalse(is_user_viewing_session("", _SESSION_1))
        self.assertFalse(is_user_viewing_session(_USER_A, ""))
        self.assertFalse(is_user_viewing_session(None, _SESSION_1))  # type: ignore[arg-type]
        self.assertFalse(is_user_viewing_session(_USER_A, None))  # type: ignore[arg-type]

    def test_key_format(self):
        from apps.services.common.ws.session_viewing import session_viewing_key

        self.assertEqual(
            session_viewing_key(_USER_A, _SESSION_1),
            f"ws:session_viewing:{_USER_A}:{_SESSION_1}",
        )

    def test_client_timing_contract_matches_server_lease(self):
        """跨语言契约：客户端 lease 常量必须跟 Redis 过期时间保持一致。"""
        from apps.services.common.ws.session_viewing import SESSION_VIEWING_TTL_SECONDS

        events_path = (
            Path(__file__).resolve().parents[7]
            / "packages/ws-gateway-client/src/events.ts"
        )
        events_source = events_path.read_text(encoding="utf-8")
        lease_match = re.search(r"SERVER_LEASE_SECONDS:\s*(\d+)", events_source)
        refresh_match = re.search(r"RECOMMENDED_REFRESH_SECONDS:\s*(\d+)", events_source)

        self.assertIsNotNone(lease_match, "client presence lease constant is required")
        self.assertIsNotNone(refresh_match, "client presence refresh constant is required")
        self.assertEqual(int(lease_match.group(1)), SESSION_VIEWING_TTL_SECONDS)
        self.assertEqual(int(refresh_match.group(1)), 30)
        self.assertLess(int(refresh_match.group(1)), SESSION_VIEWING_TTL_SECONDS)

    def test_normal_refresh_logs_debug_without_duplicate_info(self):
        from apps.services.common.ws import session_viewing as sv

        fake = _FakeRedis()
        with _patch_redis(fake), patch.object(sv.logger, "info") as info, patch.object(
            sv.logger, "debug",
        ) as debug:
            self.assertTrue(sv.set_session_viewing(_USER_A, _SESSION_1, _CONN_A))
            self.assertTrue(sv.set_session_viewing(_USER_A, _SESSION_1, _CONN_A))

        self.assertEqual(info.call_count, 1)
        self.assertEqual(debug.call_count, 1)


class SessionViewingAuthorizationLookupTests(SimpleTestCase):
    def test_personal_session_uses_shared_access_helper_without_direct_lookup(self):
        """个人会话也只走一次既有 helper，避免先查本人再被 helper 重查。"""
        from apps.services.common.ws.handlers.session_viewing import (
            _resolve_presence_session_sync,
        )

        user = MagicMock()
        personal_session = MagicMock()
        with patch(
            "apps.chat.conversation.models.ChatSession",
        ) as chat_session, patch(
            "apps.chat.conversation.api._common._get_session_with_shared_access",
            return_value=(personal_session, False),
        ) as shared_access:
            chat_session.objects.filter.return_value.first.return_value = None

            resolved = _resolve_presence_session_sync(_SESSION_1, user)

        self.assertIs(resolved, personal_session)
        shared_access.assert_called_once_with(_SESSION_1, user)
        chat_session.objects.filter.assert_not_called()


def _make_consumer(role: str = "electron", **overrides):
    consumer = MagicMock()
    consumer.role = role
    consumer.user = MagicMock()
    consumer.user_id = overrides.get("user_id", _USER_A)
    consumer.device_fingerprint = overrides.get("device_fingerprint", _FP_A)
    consumer.channel_name = overrides.get("channel_name", _CONN_A)
    consumer._viewing_session_id = overrides.get("_viewing_session_id", None)
    consumer._send_envelope = AsyncMock()
    consumer._send_error = AsyncMock()
    return consumer


def _run_handler(consumer, payload: dict):
    from apps.services.common.ws.handlers.session_viewing import (
        create_session_viewing_handler,
    )

    handler = create_session_viewing_handler(consumer)
    asyncio.run(handler({"request_id": "req-presence-1", "payload": payload}))


def _sent(consumer) -> dict:
    consumer._send_envelope.assert_awaited()
    return consumer._send_envelope.await_args.args[0]


class SessionViewingHandlerTests(SimpleTestCase):
    def test_daemon_role_denied(self):
        from apps.services.common.ws.handlers.session_viewing import (
            CHAT_SESSION_PRESENCE_NAK,
        )

        consumer = _make_consumer(role="daemon")
        _run_handler(consumer, {"session_id": _SESSION_1})
        consumer._send_error.assert_awaited()
        code = consumer._send_error.await_args.args[1]
        self.assertEqual(code, ERROR_PERMISSION_DENIED)
        # 若走 NAK 也接受（实现二选一），但不得写 Redis
        self.assertFalse(consumer._send_envelope.called or False)

    def test_device_runtime_role_denied(self):
        consumer = _make_consumer(role="device_runtime")
        _run_handler(consumer, {"session_id": _SESSION_1})
        consumer._send_error.assert_awaited()
        self.assertEqual(
            consumer._send_error.await_args.args[1],
            ERROR_PERMISSION_DENIED,
        )

    def test_missing_session_id_key_schema_invalid(self):
        from apps.services.common.ws.handlers.session_viewing import (
            CHAT_SESSION_PRESENCE_NAK,
        )

        consumer = _make_consumer()
        _run_handler(consumer, {})
        sent = _sent(consumer)
        self.assertEqual(sent["type"], CHAT_SESSION_PRESENCE_NAK)
        self.assertEqual(sent["payload"]["error_code"], "schema_invalid")

    def test_invalid_uuid_does_not_write_redis(self):
        from apps.services.common.ws.handlers.session_viewing import (
            CHAT_SESSION_PRESENCE_NAK,
        )

        consumer = _make_consumer()
        with patch(
            "apps.services.common.ws.handlers.session_viewing.set_session_viewing",
        ) as set_fn:
            _run_handler(consumer, {"session_id": "not-a-uuid"})
            set_fn.assert_not_called()
        sent = _sent(consumer)
        self.assertEqual(sent["type"], CHAT_SESSION_PRESENCE_NAK)
        self.assertEqual(sent["payload"]["error_code"], "schema_invalid")

    def test_uuid_variant_uses_canonical_session_id_for_access_and_redis_key(self):
        from apps.services.common.ws.session_viewing import (
            is_user_viewing_session,
            session_viewing_key,
        )

        raw_session_id = f"{{{_SESSION_1.upper()}}}"
        consumer = _make_consumer()
        fake = _FakeRedis()
        with _patch_redis(fake), patch(
            "apps.services.common.ws.handlers.session_viewing._resolve_presence_session",
            new=AsyncMock(return_value=MagicMock()),
        ) as resolve_session:
            _run_handler(consumer, {"session_id": raw_session_id})
            resolve_session.assert_awaited_once_with(_SESSION_1, consumer.user)
            self.assertEqual(consumer._viewing_session_id, _SESSION_1)
            self.assertTrue(is_user_viewing_session(_USER_A, _SESSION_1))
            self.assertIn(session_viewing_key(_USER_A, _SESSION_1), fake.zsets)
            self.assertNotIn(session_viewing_key(_USER_A, raw_session_id), fake.zsets)

    def test_access_denied_does_not_write_redis(self):
        from apps.services.common.ws.handlers.session_viewing import (
            CHAT_SESSION_PRESENCE_NAK,
        )

        consumer = _make_consumer()
        with patch(
            "apps.services.common.ws.handlers.session_viewing._resolve_presence_session",
            new=AsyncMock(return_value=None),
        ), patch(
            "apps.services.common.ws.handlers.session_viewing.set_session_viewing",
        ) as set_fn:
            _run_handler(consumer, {"session_id": _SESSION_1})
            set_fn.assert_not_called()
        sent = _sent(consumer)
        self.assertEqual(sent["type"], CHAT_SESSION_PRESENCE_NAK)
        self.assertIn(sent["payload"]["error_code"], ("not_found", "permission_denied"))

    def test_set_presence_ok_and_tracks_consumer_state(self):
        from apps.services.common.ws.handlers.session_viewing import (
            CHAT_SESSION_PRESENCE_OK,
        )

        consumer = _make_consumer()
        session = MagicMock()
        with patch(
            "apps.services.common.ws.handlers.session_viewing._resolve_presence_session",
            new=AsyncMock(return_value=session),
        ), patch(
            "apps.services.common.ws.handlers.session_viewing.set_session_viewing",
            return_value=True,
        ) as set_fn, patch(
            "apps.services.common.ws.handlers.session_viewing.clear_session_viewing",
        ) as clear_fn:
            _run_handler(consumer, {"session_id": _SESSION_1})
            set_fn.assert_called_once_with(
                _USER_A, _SESSION_1, _CONN_A, device_fingerprint=_FP_A,
            )
            clear_fn.assert_not_called()

        self.assertEqual(consumer._viewing_session_id, _SESSION_1)
        sent = _sent(consumer)
        self.assertEqual(sent["type"], CHAT_SESSION_PRESENCE_OK)

    def test_switch_session_clears_old_then_sets_new(self):
        from apps.services.common.ws.handlers.session_viewing import (
            CHAT_SESSION_PRESENCE_OK,
        )

        consumer = _make_consumer(_viewing_session_id=_SESSION_1)
        session = MagicMock()
        with patch(
            "apps.services.common.ws.handlers.session_viewing._resolve_presence_session",
            new=AsyncMock(return_value=session),
        ), patch(
            "apps.services.common.ws.handlers.session_viewing.set_session_viewing",
            return_value=True,
        ) as set_fn, patch(
            "apps.services.common.ws.handlers.session_viewing.clear_session_viewing",
            return_value=True,
        ) as clear_fn:
            _run_handler(consumer, {"session_id": _SESSION_2})
            clear_fn.assert_called_once_with(
                _USER_A, _SESSION_1, _CONN_A, device_fingerprint=_FP_A,
            )
            set_fn.assert_called_once_with(
                _USER_A, _SESSION_2, _CONN_A, device_fingerprint=_FP_A,
            )

        self.assertEqual(consumer._viewing_session_id, _SESSION_2)
        self.assertEqual(_sent(consumer)["type"], CHAT_SESSION_PRESENCE_OK)

    def test_null_session_clears_presence(self):
        from apps.services.common.ws.handlers.session_viewing import (
            CHAT_SESSION_PRESENCE_OK,
        )

        consumer = _make_consumer(_viewing_session_id=_SESSION_1)
        with patch(
            "apps.services.common.ws.handlers.session_viewing.clear_session_viewing",
            return_value=True,
        ) as clear_fn, patch(
            "apps.services.common.ws.handlers.session_viewing.set_session_viewing",
        ) as set_fn:
            _run_handler(consumer, {"session_id": None})
            clear_fn.assert_called_once_with(
                _USER_A, _SESSION_1, _CONN_A, device_fingerprint=_FP_A,
            )
            set_fn.assert_not_called()

        self.assertIsNone(consumer._viewing_session_id)
        self.assertEqual(_sent(consumer)["type"], CHAT_SESSION_PRESENCE_OK)

    def test_ignores_payload_user_and_device_fields(self):
        """身份只信 consumer，不信 payload 伪造的 user/device。"""
        from apps.services.common.ws.handlers.session_viewing import (
            CHAT_SESSION_PRESENCE_OK,
        )

        consumer = _make_consumer()
        session = MagicMock()
        with patch(
            "apps.services.common.ws.handlers.session_viewing._resolve_presence_session",
            new=AsyncMock(return_value=session),
        ), patch(
            "apps.services.common.ws.handlers.session_viewing.set_session_viewing",
            return_value=True,
        ) as set_fn:
            _run_handler(
                consumer,
                {
                    "session_id": _SESSION_1,
                    "user_id": _USER_B,
                    "device_fingerprint": "forged-fp",
                },
            )
            set_fn.assert_called_once_with(
                _USER_A, _SESSION_1, _CONN_A, device_fingerprint=_FP_A,
            )

        self.assertEqual(_sent(consumer)["type"], CHAT_SESSION_PRESENCE_OK)

    def test_missing_user_or_fingerprint_is_rejected_without_write(self):
        for identity in ({"user_id": None}, {"device_fingerprint": None}):
            with self.subTest(identity=identity):
                consumer = _make_consumer(**identity)
                with patch(
                    "apps.services.common.ws.handlers.session_viewing.set_session_viewing",
                ) as set_fn:
                    _run_handler(consumer, {"session_id": _SESSION_1})
                consumer._send_error.assert_awaited_once()
                self.assertEqual(
                    consumer._send_error.await_args.args[1],
                    ERROR_PERMISSION_DENIED,
                )
                set_fn.assert_not_called()

    def test_set_failure_naks_and_keeps_consumer_state_unchanged(self):
        from apps.services.common.ws.handlers.session_viewing import (
            CHAT_SESSION_PRESENCE_NAK,
        )

        consumer = _make_consumer()
        with patch(
            "apps.services.common.ws.handlers.session_viewing._resolve_presence_session",
            new=AsyncMock(return_value=MagicMock()),
        ), patch(
            "apps.services.common.ws.handlers.session_viewing.set_session_viewing",
            return_value=False,
        ):
            _run_handler(consumer, {"session_id": _SESSION_1})

        self.assertIsNone(consumer._viewing_session_id)
        sent = _sent(consumer)
        self.assertEqual(sent["type"], CHAT_SESSION_PRESENCE_NAK)
        self.assertEqual(sent["payload"]["error_code"], "presence_unavailable")

    def test_clear_failure_naks_and_preserves_consumer_state(self):
        from apps.services.common.ws.handlers.session_viewing import (
            CHAT_SESSION_PRESENCE_NAK,
        )

        consumer = _make_consumer(_viewing_session_id=_SESSION_1)
        with patch(
            "apps.services.common.ws.handlers.session_viewing.clear_session_viewing",
            return_value=False,
        ):
            _run_handler(consumer, {"session_id": None})

        self.assertEqual(consumer._viewing_session_id, _SESSION_1)
        sent = _sent(consumer)
        self.assertEqual(sent["type"], CHAT_SESSION_PRESENCE_NAK)
        self.assertEqual(sent["payload"]["error_code"], "presence_unavailable")


class SessionViewingDisconnectAndRegistryTests(SimpleTestCase):
    def test_cleanup_helper_clears_current_presence(self):
        from apps.services.common.ws.handlers.session_viewing import (
            cleanup_session_viewing_for_consumer,
        )

        consumer = _make_consumer(_viewing_session_id=_SESSION_1)
        with patch(
            "apps.services.common.ws.handlers.session_viewing.clear_session_viewing",
            return_value=True,
        ) as clear_fn:
            asyncio.run(cleanup_session_viewing_for_consumer(consumer))
            clear_fn.assert_called_once_with(
                _USER_A, _SESSION_1, _CONN_A, device_fingerprint=_FP_A,
            )
        self.assertIsNone(consumer._viewing_session_id)

    def test_cleanup_noop_without_viewing_session(self):
        from apps.services.common.ws.handlers.session_viewing import (
            cleanup_session_viewing_for_consumer,
        )

        consumer = _make_consumer(_viewing_session_id=None)
        with patch(
            "apps.services.common.ws.handlers.session_viewing.clear_session_viewing",
        ) as clear_fn:
            asyncio.run(cleanup_session_viewing_for_consumer(consumer))
            clear_fn.assert_not_called()

    def test_same_fingerprint_connections_do_not_clear_each_other(self):
        from apps.services.common.ws.handlers.session_viewing import (
            cleanup_session_viewing_for_consumer,
        )
        from apps.services.common.ws.session_viewing import (
            is_user_viewing_session,
            session_viewing_key,
        )

        fake = _FakeRedis()
        connection_a = _make_consumer(channel_name=_CONN_A)
        connection_b = _make_consumer(channel_name=_CONN_B)
        with _patch_redis(fake), patch(
            "apps.services.common.ws.handlers.session_viewing._resolve_presence_session",
            new=AsyncMock(return_value=MagicMock()),
        ):
            _run_handler(connection_a, {"session_id": _SESSION_1})
            _run_handler(connection_b, {"session_id": _SESSION_1})
            asyncio.run(cleanup_session_viewing_for_consumer(connection_a))

            key = session_viewing_key(_USER_A, _SESSION_1)
            self.assertNotIn(_CONN_A, fake.zsets[key])
            self.assertIn(_CONN_B, fake.zsets[key])
            self.assertTrue(is_user_viewing_session(_USER_A, _SESSION_1))

    def test_gateway_registers_presence_handler(self):
        from apps.services.common.ws.gateway import GatewayConsumer
        from apps.services.common.ws.handlers.session_viewing import (
            CHAT_SESSION_PRESENCE,
        )

        consumer = GatewayConsumer()
        self.assertTrue(callable(consumer._handlers()[CHAT_SESSION_PRESENCE]))

    def test_gateway_disconnect_cleans_presence_before_later_await_fails(self):
        from apps.services.common.ws.gateway import GatewayConsumer
        from apps.services.common.ws.organization_context import OrganizationContext
        from apps.services.common.ws.session_viewing import (
            is_user_viewing_session,
            session_viewing_key,
            set_session_viewing,
        )

        consumer = object.__new__(GatewayConsumer)
        consumer._total_conn_counted = False
        consumer._unauth_counted = False
        consumer._client_ip = None
        consumer._ws_transport_connected_at = 0.0
        consumer._ws_connected_at = 0.0
        consumer.user_id = _USER_A
        consumer.device_fingerprint = _FP_A
        consumer.role = "electron"
        consumer.organization_ctx = OrganizationContext(None, set())
        consumer.subscriptions = set()
        consumer._last_message_type = "-"
        consumer._viewing_session_id = _SESSION_1
        consumer.channel_name = _CONN_A

        fake = _FakeRedis()
        with _patch_redis(fake), patch.object(
            GatewayConsumer,
            "_mark_runtime_snapshot_disconnected",
            new=AsyncMock(side_effect=RuntimeError("later disconnect failure")),
        ):
            self.assertTrue(set_session_viewing(_USER_A, _SESSION_1, _CONN_A))
            self.assertTrue(set_session_viewing(_USER_A, _SESSION_1, _CONN_B))
            with self.assertRaisesRegex(RuntimeError, "later disconnect failure"):
                asyncio.run(GatewayConsumer.disconnect(consumer, 1000))

            key = session_viewing_key(_USER_A, _SESSION_1)
            self.assertNotIn(_CONN_A, fake.zsets[key])
            self.assertIn(_CONN_B, fake.zsets[key])
            self.assertTrue(is_user_viewing_session(_USER_A, _SESSION_1))
