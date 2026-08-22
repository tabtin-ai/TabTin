"""
EventBufferService 独立单元测试

覆盖场景：
  1. append_event — 正常写入 / 幂等写入 / maxlen 裁剪
  2. read_after_many — 单 topic / 多 topic Pipeline / 分页截断 / last_event_id 格式
  3. trim_expired — 按 max_age 裁剪 / 随机采样 max_streams
  4. redis_client — 健康检查 PING 成功复用 / PING 失败重建
  5. _sanitize_envelope_for_buffer — 脱敏 device action / credential tool / 保留非敏感

不依赖真实 Redis，全部通过 unittest.mock 模拟。
"""
import json
import os
import sys
import time
from unittest.mock import MagicMock, patch, PropertyMock

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

if "test" not in sys.argv:
    sys.argv.append("test")

import django  # noqa: E402
django.setup()

import pytest  # noqa: E402

from apps.services.common.ws.event_buffer import (
    EventBufferService,
    STREAM_KEY_PREFIX,
    MAX_REPLAY_LIMIT,
    BUFFER_CONFIG,
    DEFAULT_BUFFER_CONFIG,
    _REDIS_HEALTH_CHECK_INTERVAL,
    _STREAM_KEY_TTL_SECONDS,
    get_event_buffer,
)
from apps.services.common.ws.bus import (
    _sanitize_envelope_for_buffer,
    _SENSITIVE_PARAM_KEYS,
    _REDACTED,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def mock_redis():
    """提供一个干净的 mock Redis client。"""
    client = MagicMock()
    client.ping.return_value = True
    client.eval.return_value = [b"ok", b"1702000000000-0"]
    return client


@pytest.fixture
def buffer_service(mock_redis):
    """提供已注入 mock Redis 的 EventBufferService 实例。"""
    svc = EventBufferService()
    svc._redis = mock_redis
    svc._last_health_check = time.time()
    return svc


# ===========================================================================
# 场景 1: append_event
# ===========================================================================

class TestAppendEvent:
    """append_event: 正常写入 / 幂等 / maxlen。"""

    def test_normal_write(self, buffer_service, mock_redis):
        """正常写入 → 调用 xadd 并返回 stream ID。"""
        envelope = {"type": "agent.stream.delta", "payload": {"seq": 1}}
        result = buffer_service.append_event("agent.stream.test", envelope)

        assert result == "1702000000000-0"
        mock_redis.eval.assert_called_once()

        call_args = mock_redis.eval.call_args.args
        assert call_args[2] == f"{STREAM_KEY_PREFIX}agent.stream.test"
        stored_data = json.loads(call_args[8])
        assert stored_data["type"] == "agent.stream.delta"

    def test_agent_topic_uses_bounded_append_budget(self, buffer_service, mock_redis):
        """Agent topic 由原子 Lua 写入并携带字节硬预算。"""

        buffer_service.append_event("agent.stream.test", {"type": "test", "payload": {}})

        call_args = mock_redis.eval.call_args.args
        assert call_args[2] == f"{STREAM_KEY_PREFIX}agent.stream.test"
        assert call_args[10] == 16 * 1024 * 1024
        assert call_args[11] == 20 * 1024 * 1024

    def test_default_budget_for_unknown_topic(self, buffer_service, mock_redis):
        """未知 topic 使用保守的默认字节硬预算。"""

        buffer_service.append_event("unknown.topic.xyz", {"type": "test", "payload": {}})

        call_args = mock_redis.eval.call_args.args
        assert call_args[10] == 4 * 1024 * 1024
        assert call_args[11] == 5 * 1024 * 1024

    def test_append_script_does_not_scan_topic_gap_hash(self, buffer_service, mock_redis):
        """message_committed 清 gap 不能按 topic 全量 HGETALL。"""

        buffer_service.append_event("agent.stream.test", {
            "type": "agent.stream.message_committed",
            "payload": {"message_id": "message-1"},
        })

        script = mock_redis.eval.call_args.args[0]
        assert "HGETALL', gap_key" not in script
        assert "SMEMBERS', gap_message_index_key" in script

    def test_xadd_failure_returns_none(self, buffer_service, mock_redis):
        """xadd 异常 → 返回 None（不传播异常）。"""
        mock_redis.eval.side_effect = Exception("Redis write error")

        result = buffer_service.append_event("agent.stream.test", {"type": "test"})
        assert result is None

    def test_redis_unavailable_returns_none(self):
        """Redis 不可用 → 返回 None。"""
        svc = EventBufferService()
        svc._redis = None

        with patch("django_redis.get_redis_connection", side_effect=Exception("conn fail")):
            result = svc.append_event("test.topic", {"type": "test"})
            assert result is None

    def test_connection_error_resets_redis(self, buffer_service, mock_redis):
        """Redis 连接错误 → 重置缓存客户端。"""
        from redis.exceptions import ConnectionError as RedisConnError
        mock_redis.eval.side_effect = RedisConnError("broken pipe")

        buffer_service.append_event("test.topic", {"type": "test"})

        assert buffer_service._redis is None
        assert buffer_service._last_health_check == 0.0

    def test_bytes_stream_id_decoded(self, buffer_service, mock_redis):
        """xadd 返回 bytes → 正确解码为 str。"""
        mock_redis.eval.return_value = [b"ok", b"1702000000000-5"]

        result = buffer_service.append_event("test.topic", {"type": "test"})
        assert result == "1702000000000-5"
        assert isinstance(result, str)


# ===========================================================================
# 场景 2: read_after / read_after_many
# ===========================================================================

class TestReadAfter:
    """read_after: 单 topic 读取。"""

    def test_basic_read(self, buffer_service, mock_redis):
        """正常读取 → 返回 (stream_id, envelope) 列表。"""
        mock_redis.xrange.return_value = [
            (b"1702000000001-0", {b"e": json.dumps({"type": "ev.a", "payload": {"x": 1}}).encode()}),
            (b"1702000000002-0", {b"e": json.dumps({"type": "ev.b", "payload": {"x": 2}}).encode()}),
        ]

        result = buffer_service.read_after("test.topic", "1702000000000-0", limit=10)

        assert len(result) == 2
        assert result[0][0] == "1702000000001-0"
        assert result[0][1]["type"] == "ev.a"
        assert result[1][1]["payload"]["x"] == 2

    def test_exclusive_range_prefix(self, buffer_service, mock_redis):
        """传入的 last_event_id 应加 ( 前缀实现 exclusive range。"""
        mock_redis.xrange.return_value = []

        buffer_service.read_after("test.topic", "1702000000000-0")

        call_args = mock_redis.xrange.call_args
        assert call_args[1]["min"] == "(1702000000000-0"

    def test_limit_capped_at_max(self, buffer_service, mock_redis):
        """limit 超过 MAX_REPLAY_LIMIT 时被截断。"""
        mock_redis.xrange.return_value = []

        buffer_service.read_after("test.topic", "0-0", limit=99999)

        call_args = mock_redis.xrange.call_args
        assert call_args[1]["count"] == MAX_REPLAY_LIMIT

    def test_bad_envelope_skipped(self, buffer_service, mock_redis):
        """无效 JSON envelope 被跳过不抛异常。"""
        mock_redis.xrange.return_value = [
            ("1702000000001-0", {"e": "not valid json {{{"}),
            ("1702000000002-0", {"e": json.dumps({"type": "good", "payload": {}})}),
        ]

        result = buffer_service.read_after("test.topic", "0-0")
        assert len(result) == 1
        assert result[0][1]["type"] == "good"

    def test_missing_e_field_skipped(self, buffer_service, mock_redis):
        """缺少 'e' 字段的 entry 被跳过。"""
        mock_redis.xrange.return_value = [
            ("1702000000001-0", {"other_field": "value"}),
        ]

        result = buffer_service.read_after("test.topic", "0-0")
        assert len(result) == 0

    def test_redis_unavailable_returns_empty(self):
        """Redis 不可用 → 返回空列表。"""
        svc = EventBufferService()
        svc._redis = None
        with patch("django_redis.get_redis_connection", side_effect=Exception("fail")):
            result = svc.read_after("test.topic", "0-0")
            assert result == []


class TestReadAfterMany:
    """read_after_many: 多 topic Pipeline 批量读取。"""

    def test_single_topic(self, buffer_service, mock_redis):
        """单 topic → 结果正确。"""
        pipe = MagicMock()
        mock_redis.pipeline.return_value = pipe
        pipe.execute.return_value = [
            [("1702000000001-0", {"e": json.dumps({"type": "ev", "payload": {}})})],
        ]

        results, truncated = buffer_service.read_after_many(
            [("topic.a", "1702000000000-0")],
            limit=200,
        )

        assert "topic.a" in results
        assert len(results["topic.a"]) == 1
        assert truncated is False

    def test_multiple_topics(self, buffer_service, mock_redis):
        """多 topic → 每个 topic 独立结果。"""
        pipe = MagicMock()
        mock_redis.pipeline.return_value = pipe
        pipe.execute.return_value = [
            [("1-0", {"e": json.dumps({"type": "a", "payload": {}})})],
            [
                ("2-0", {"e": json.dumps({"type": "b1", "payload": {}})}),
                ("3-0", {"e": json.dumps({"type": "b2", "payload": {}})}),
            ],
        ]

        results, truncated = buffer_service.read_after_many(
            [("topic.a", "0-0"), ("topic.b", "0-0")],
            limit=200,
        )

        assert len(results["topic.a"]) == 1
        assert len(results["topic.b"]) == 2
        assert truncated is False

    def test_truncation_flag(self, buffer_service, mock_redis):
        """某 topic 返回数量 = limit → any_truncated=True。"""
        pipe = MagicMock()
        mock_redis.pipeline.return_value = pipe

        entries = [
            (f"{i}-0", {"e": json.dumps({"type": "ev", "payload": {"i": i}})})
            for i in range(200)
        ]
        pipe.execute.return_value = [entries]

        results, truncated = buffer_service.read_after_many(
            [("topic.a", "0-0")],
            limit=200,
        )

        assert truncated is True
        assert len(results["topic.a"]) == 200

    def test_empty_topic_cursors(self, buffer_service):
        """空 topic_cursors → 返回 ({}, False)。"""
        results, truncated = buffer_service.read_after_many([], limit=200)
        assert results == {}
        assert truncated is False

    def test_empty_results_topic_excluded(self, buffer_service, mock_redis):
        """无数据的 topic 不出现在结果 dict 中。"""
        pipe = MagicMock()
        mock_redis.pipeline.return_value = pipe
        pipe.execute.return_value = [
            [],
            [("1-0", {"e": json.dumps({"type": "ev", "payload": {}})})],
        ]

        results, _ = buffer_service.read_after_many(
            [("topic.empty", "0-0"), ("topic.data", "0-0")],
            limit=200,
        )

        assert "topic.empty" not in results
        assert "topic.data" in results

    def test_pipeline_failure_returns_empty(self, buffer_service, mock_redis):
        """Pipeline 执行失败 → 返回 ({}, False)。"""
        pipe = MagicMock()
        mock_redis.pipeline.return_value = pipe
        pipe.execute.side_effect = Exception("pipeline error")

        results, truncated = buffer_service.read_after_many(
            [("topic.a", "0-0")],
            limit=200,
        )

        assert results == {}
        assert truncated is False

    def test_limit_capped_at_max_replay(self, buffer_service, mock_redis):
        """limit 超过 MAX_REPLAY_LIMIT → 被截断为 MAX_REPLAY_LIMIT。"""
        pipe = MagicMock()
        mock_redis.pipeline.return_value = pipe
        pipe.execute.return_value = [[]]

        buffer_service.read_after_many(
            [("topic.a", "0-0")],
            limit=99999,
        )

        xrange_call = pipe.xrange.call_args
        assert xrange_call[1]["count"] == MAX_REPLAY_LIMIT


class TestCaptureSubscriptionBoundaries:
    """订阅边界必须由 Redis 原子捕获，并为每个 topic 返回明确 cursor。"""

    def test_returns_per_topic_boundaries_from_single_atomic_eval(self, buffer_service, mock_redis):
        mock_redis.eval.return_value = [b"1702000000000-4", b"1702000000001-0"]

        result = buffer_service.capture_subscription_boundaries(["topic.a", "topic.b"])

        assert result == {
            "topic.a": "1702000000000-4",
            "topic.b": "1702000000001-0",
        }
        script, key_count, *keys = mock_redis.eval.call_args.args
        assert key_count == 2
        assert keys == [f"{STREAM_KEY_PREFIX}topic.a", f"{STREAM_KEY_PREFIX}topic.b"]
        assert "XREVRANGE" in script
        assert "TIME" in script

    def test_empty_stream_boundary_is_explicit_and_never_zero_zero(self, buffer_service, mock_redis):
        mock_redis.eval.return_value = [b"1702000000999-18446744073709551615"]

        result = buffer_service.capture_subscription_boundaries(["topic.empty"])

        assert result["topic.empty"] == "1702000000999-18446744073709551615"
        assert result["topic.empty"] != "0-0"

    def test_capture_failure_fails_closed(self, buffer_service, mock_redis):
        mock_redis.eval.side_effect = Exception("redis unavailable")

        assert buffer_service.capture_subscription_boundaries(["topic.a"]) == {}


# ===========================================================================
# 场景 3: trim_expired
# ===========================================================================

class TestTrimExpired:
    """trim_expired: 按 max_age 裁剪 / 随机采样。"""

    def test_basic_trim(self, buffer_service, mock_redis):
        """正常裁剪 → 调用 xtrim 并返回总计。"""
        mock_redis.scan.return_value = (0, [f"{STREAM_KEY_PREFIX}agent.stream.test"])
        mock_redis.xtrim.return_value = 10
        mock_redis.xlen.return_value = 3

        total = buffer_service.trim_expired(max_streams=50)

        assert total == 10
        mock_redis.xtrim.assert_called_once()
        call_kwargs = mock_redis.xtrim.call_args
        assert call_kwargs[1]["approximate"] is True
        mock_redis.expire.assert_called_once()
        mock_redis.unlink.assert_not_called()

    def test_trim_unlinks_empty_stream(self, buffer_service, mock_redis):
        """XTRIM 后空 stream → UNLINK，避免无 TTL 空 key 占槽位 。"""
        key = f"{STREAM_KEY_PREFIX}agent.stream.test"
        topic = "agent.stream.test"
        mock_redis.scan.return_value = (0, [key])
        mock_redis.xtrim.return_value = 10
        mock_redis.xlen.return_value = 0

        total = buffer_service.trim_expired(max_streams=50)

        assert total == 10
        mock_redis.unlink.assert_called_once_with(key)
        mock_redis.delete.assert_called_once_with(
            buffer_service._ledger_key(topic),
            buffer_service._latest_index_key(topic),
            buffer_service._gap_key(topic),
        )
        mock_redis.expire.assert_not_called()

    def test_trim_drops_latest_index_after_entries_are_removed(self, buffer_service, mock_redis):
        """XTRIM 删除 entry 后 latest index 失效，避免后续 latest snapshot 重复减账。"""
        key = f"{STREAM_KEY_PREFIX}agent.stream.test"
        topic = "agent.stream.test"
        mock_redis.scan.return_value = (0, [key])
        mock_redis.xtrim.return_value = 2
        mock_redis.xlen.return_value = 3
        mock_redis.memory_usage.return_value = 1234

        total = buffer_service.trim_expired(max_streams=50)

        assert total == 2
        mock_redis.delete.assert_called_once_with(buffer_service._latest_index_key(topic))
        mock_redis.set.assert_called_once_with(
            buffer_service._ledger_key(topic),
            1234,
            ex=_STREAM_KEY_TTL_SECONDS,
        )

    def test_max_streams_limit(self, buffer_service, mock_redis):
        """stream 数量超过 max_streams → 只处理 max_streams 个。"""
        keys = [f"{STREAM_KEY_PREFIX}topic.{i}" for i in range(100)]
        mock_redis.scan.return_value = (0, keys)
        mock_redis.xtrim.return_value = 1
        mock_redis.xlen.return_value = 1

        total = buffer_service.trim_expired(max_streams=10)

        assert mock_redis.xtrim.call_count == 10
        assert total == 10

    def test_no_keys_returns_zero(self, buffer_service, mock_redis):
        """无 stream key → 返回 0。"""
        mock_redis.scan.return_value = (0, [])

        total = buffer_service.trim_expired()
        assert total == 0
        mock_redis.xtrim.assert_not_called()

    def test_scan_failure_returns_zero(self, buffer_service, mock_redis):
        """SCAN 失败 → 返回 0。"""
        mock_redis.scan.side_effect = Exception("scan failed")

        total = buffer_service.trim_expired()
        assert total == 0

    def test_xtrim_failure_continues(self, buffer_service, mock_redis):
        """单个 XTRIM 失败 → 继续处理其他 key。"""
        keys = [
            f"{STREAM_KEY_PREFIX}topic.a",
            f"{STREAM_KEY_PREFIX}topic.b",
        ]
        mock_redis.scan.return_value = (0, keys)
        mock_redis.xtrim.side_effect = [Exception("trim fail"), 5]
        mock_redis.xlen.return_value = 1

        total = buffer_service.trim_expired(max_streams=50)
        assert total == 5
        assert mock_redis.xtrim.call_count == 2

    def test_minid_calculation(self, buffer_service, mock_redis):
        """minid 基于 time.time() - max_age_seconds 计算。"""
        mock_redis.scan.return_value = (0, [f"{STREAM_KEY_PREFIX}agent.stream.test"])
        mock_redis.xtrim.return_value = 0
        mock_redis.xlen.return_value = 1

        now = time.time()
        with patch("apps.services.common.ws.event_buffer.time") as mock_time:
            mock_time.time.return_value = now
            buffer_service.trim_expired(max_streams=50)

        call_kwargs = mock_redis.xtrim.call_args
        expected_max_age = BUFFER_CONFIG["agent.stream"]["max_age_seconds"]
        expected_minid = int((now - expected_max_age) * 1000)
        assert call_kwargs[1]["minid"] == expected_minid

    def test_bytes_keys_decoded(self, buffer_service, mock_redis):
        """SCAN 返回 bytes key → 正确解码。"""
        mock_redis.scan.return_value = (0, [f"{STREAM_KEY_PREFIX}test.topic".encode()])
        mock_redis.xtrim.return_value = 3
        mock_redis.xlen.return_value = 1

        total = buffer_service.trim_expired(max_streams=50)
        assert total == 3


# ===========================================================================
# 场景 4: redis_client 健康检查
# ===========================================================================

class TestRedisClientHealth:
    """redis_client property: PING 健康检查 + 连接重建。"""

    def test_ping_success_reuses_connection(self):
        """PING 成功 → 复用已有连接。"""
        svc = EventBufferService()
        mock_client = MagicMock()
        mock_client.ping.return_value = True
        svc._redis = mock_client
        svc._last_health_check = time.time() - _REDIS_HEALTH_CHECK_INTERVAL - 1

        result = svc.redis_client

        assert result is mock_client
        mock_client.ping.assert_called_once()

    def test_ping_failure_rebuilds_connection(self):
        """PING 失败 → 重建连接。"""
        svc = EventBufferService()
        stale_client = MagicMock()
        stale_client.ping.side_effect = Exception("connection lost")
        svc._redis = stale_client
        svc._last_health_check = time.time() - _REDIS_HEALTH_CHECK_INTERVAL - 1

        new_client = MagicMock()
        with patch(
            "django_redis.get_redis_connection",
            return_value=new_client,
        ):
            result = svc.redis_client

        assert result is new_client
        assert svc._redis is new_client

    def test_no_check_within_interval(self):
        """在健康检查间隔内 → 不发送 PING。"""
        svc = EventBufferService()
        mock_client = MagicMock()
        svc._redis = mock_client
        svc._last_health_check = time.time()

        result = svc.redis_client

        assert result is mock_client
        mock_client.ping.assert_not_called()

    def test_initial_connection(self):
        """初始无连接 → 创建新连接。"""
        svc = EventBufferService()
        new_client = MagicMock()

        with patch(
            "django_redis.get_redis_connection",
            return_value=new_client,
        ):
            result = svc.redis_client

        assert result is new_client
        assert svc._redis is new_client

    def test_initial_connection_failure(self):
        """初始连接失败 → 返回 None。"""
        svc = EventBufferService()

        with patch(
            "django_redis.get_redis_connection",
            side_effect=Exception("redis down"),
        ):
            result = svc.redis_client

        assert result is None
        assert svc._redis is None


# ===========================================================================
# 场景 5: _sanitize_envelope_for_buffer
# ===========================================================================

class TestSanitizeEnvelope:
    """_sanitize_envelope_for_buffer: 脱敏逻辑。"""

    def test_device_action_password_redacted(self):
        """device action envelope → params 中的敏感字段被移除。"""
        with patch(
            "apps.services.common.ws.bus._get_sensitive_device_actions",
            return_value=frozenset({"screen_type_in_element"}),
        ):
            envelope = {
                "type": "agent.action.device.execute",
                "payload": {
                    "action": "screen_type_in_element",
                    "params": {
                        "text": "my_password_123",
                        "password": "secret",
                        "element_id": "input_1",
                        "coordinate": [100, 200],
                    },
                },
            }

            result = _sanitize_envelope_for_buffer(envelope)

            assert "text" not in result["payload"]["params"]
            assert "password" not in result["payload"]["params"]
            assert result["payload"]["params"]["element_id"] == "input_1"
            assert result["payload"]["params"]["coordinate"] == [100, 200]

    def test_credential_tool_input_output_redacted(self):
        """credential tool envelope → input/output 被替换为 [REDACTED]。"""
        with patch(
            "apps.services.common.ws.bus._get_credential_sensitive_tools",
            return_value=frozenset({"credential_retrieve"}),
        ):
            envelope = {
                "type": "agent.stream.tool",
                "payload": {
                    "tool_name": "credential_retrieve",
                    "input": {"site": "example.com", "username": "admin"},
                    "output": {"password": "super_secret_123"},
                    "status": "completed",
                },
            }

            result = _sanitize_envelope_for_buffer(envelope)

            assert result["payload"]["input"] == _REDACTED
            assert result["payload"]["output"] == _REDACTED
            assert result["payload"]["status"] == "completed"
            assert result["payload"]["tool_name"] == "credential_retrieve"

    def test_non_sensitive_envelope_unchanged(self):
        """非敏感 envelope → 原样返回。"""
        with patch(
            "apps.services.common.ws.bus._get_sensitive_device_actions",
            return_value=frozenset({"screen_type_in_element"}),
        ), patch(
            "apps.services.common.ws.bus._get_credential_sensitive_tools",
            return_value=frozenset({"credential_retrieve"}),
        ):
            envelope = {
                "type": "agent.stream.delta",
                "payload": {
                    "content": "Hello, world!",
                    "seq": 42,
                },
            }

            result = _sanitize_envelope_for_buffer(envelope)

            assert result is envelope

    def test_no_payload_unchanged(self):
        """无 payload 的 envelope → 原样返回。"""
        envelope = {"type": "ping", "ts": 12345}
        result = _sanitize_envelope_for_buffer(envelope)
        assert result is envelope

    def test_non_dict_payload_unchanged(self):
        """payload 不是 dict → 原样返回。"""
        envelope = {"type": "test", "payload": "string_payload"}
        result = _sanitize_envelope_for_buffer(envelope)
        assert result is envelope

    def test_non_sensitive_action_unchanged(self):
        """不在 SENSITIVE_DEVICE_ACTIONS 中的 action → 不脱敏。"""
        with patch(
            "apps.services.common.ws.bus._get_sensitive_device_actions",
            return_value=frozenset({"screen_type_in_element"}),
        ):
            envelope = {
                "type": "agent.action.device.execute",
                "payload": {
                    "action": "screen_click",
                    "params": {
                        "text": "should_stay",
                        "coordinate": [100, 200],
                    },
                },
            }

            result = _sanitize_envelope_for_buffer(envelope)
            assert result is envelope

    def test_non_sensitive_tool_unchanged(self):
        """不在 CREDENTIAL_SENSITIVE_TOOLS 中的 tool → 不脱敏。"""
        with patch(
            "apps.services.common.ws.bus._get_credential_sensitive_tools",
            return_value=frozenset({"credential_retrieve"}),
        ):
            envelope = {
                "type": "agent.stream.tool",
                "payload": {
                    "tool_name": "web_search",
                    "input": {"query": "test"},
                    "output": {"results": [1, 2, 3]},
                },
            }

            result = _sanitize_envelope_for_buffer(envelope)
            assert result is envelope

    def test_original_envelope_not_mutated(self):
        """脱敏产生新对象，不修改原始 envelope。"""
        with patch(
            "apps.services.common.ws.bus._get_sensitive_device_actions",
            return_value=frozenset({"screen_type_in_element"}),
        ):
            original_params = {
                "text": "password_123",
                "element_id": "input_1",
            }
            envelope = {
                "type": "agent.action.device.execute",
                "payload": {
                    "action": "screen_type_in_element",
                    "params": {**original_params},
                },
            }

            result = _sanitize_envelope_for_buffer(envelope)

            assert "text" in envelope["payload"]["params"]
            assert "text" not in result["payload"]["params"]
            assert result is not envelope

    def test_data_key_instead_of_payload(self):
        """使用 'data' 而非 'payload' 的 envelope 也能脱敏。"""
        with patch(
            "apps.services.common.ws.bus._get_sensitive_device_actions",
            return_value=frozenset({"screen_type_secret"}),
        ):
            envelope = {
                "type": "agent.action.device.execute",
                "data": {
                    "action": "screen_type_secret",
                    "params": {
                        "text": "my_secret",
                        "element_id": "pwd_field",
                    },
                },
            }

            result = _sanitize_envelope_for_buffer(envelope)

            assert "text" not in result["data"]["params"]
            assert result["data"]["params"]["element_id"] == "pwd_field"


# ===========================================================================
# 补充：get_event_buffer 单例 + _resolve_config
# ===========================================================================

class TestGetEventBuffer:
    """get_event_buffer: 线程安全单例。"""

    def test_singleton_returns_same_instance(self):
        """多次调用 → 返回同一实例。"""
        import apps.services.common.ws.event_buffer as mod
        old_instance = mod._event_buffer_instance
        try:
            mod._event_buffer_instance = None
            a = get_event_buffer()
            b = get_event_buffer()
            assert a is b
        finally:
            mod._event_buffer_instance = old_instance


class TestResolveConfig:
    """_resolve_config: 最长前缀匹配。"""

    def test_exact_match(self):
        """精确匹配 topic → 使用对应配置。"""
        svc = EventBufferService()
        config = svc._resolve_config("agent.stream")
        assert config["max_len"] == BUFFER_CONFIG["agent.stream"]["max_len"]

    def test_prefix_match(self):
        """前缀匹配 topic.xxx → 使用前缀配置。"""
        svc = EventBufferService()
        config = svc._resolve_config("agent.stream.thread-123")
        assert config["max_len"] == BUFFER_CONFIG["agent.stream"]["max_len"]

    def test_longest_prefix_wins(self):
        """多个前缀匹配 → 最长前缀优先。"""
        svc = EventBufferService()
        config_phone = svc._resolve_config("phone.sms.user-123")
        assert config_phone["max_len"] == BUFFER_CONFIG["phone.sms"]["max_len"]

    def test_no_match_returns_default(self):
        """无匹配 → 使用默认配置。"""
        svc = EventBufferService()
        config = svc._resolve_config("completely.unknown.topic")
        assert config == DEFAULT_BUFFER_CONFIG
