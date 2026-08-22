"""真实 Redis MEMORY USAGE 集成测试。

只在显式提供 ``WS_EVENT_BUFFER_REDIS_URL`` 时运行；测试使用唯一 topic 前缀且只删除
该前缀生成的本地测试 key，绝不读取项目环境中的 ACK Redis 配置。
"""

from __future__ import annotations

import json
import os
import time
import uuid

import pytest
import redis

from apps.services.common.ws.event_buffer import EventBufferService, STREAM_KEY_PREFIX


_REDIS_URL = os.getenv("WS_EVENT_BUFFER_REDIS_URL")
pytestmark = pytest.mark.skipif(not _REDIS_URL, reason="需要显式本地 Redis URL")


def _cleanup(client: redis.Redis, marker: str) -> None:
    keys = list(client.scan_iter(match=f"*{marker}*"))
    if keys:
        client.delete(*keys)


def _service(client: redis.Redis) -> EventBufferService:
    service = EventBufferService()
    service._redis = client
    service._last_health_check = time.time()
    return service


def test_long_agent_run_stays_bounded_and_commit_replaces_six_piece() -> None:
    assert _REDIS_URL is not None
    client = redis.Redis.from_url(_REDIS_URL, decode_responses=True)
    marker = f"ws-bounds-{uuid.uuid4().hex}"
    topic = f"agent.stream.{marker}"
    budget_topic = f"agent.stream.{marker}-budget"
    legacy_topic = f"agent.stream.{marker}-legacy"
    service = _service(client)

    try:
        # 历史根因：大量完整 LLM 请求不能创建任何 replay entry。
        for index in range(80):
            assert service.append_event(topic, {
                "type": "agent.stream.llm_request",
                "payload": {
                    "iteration": index,
                    "messages": [{"role": "user", "content": "x" * 900_000}],
                },
            }) is None
        assert client.exists(f"{STREAM_KEY_PREFIX}{topic}") == 0

        # 模拟长 run；每条消息完成后只保留 message_committed checkpoint。
        for message_index in range(100):
            message_id = f"message-{message_index}"
            assert service.append_event(topic, {
                "type": "agent.stream.message_start",
                "payload": {"message_id": message_id},
            })
            for seq in range(20):
                assert service.append_event(topic, {
                    "type": "agent.stream.content_block_delta",
                    "payload": {
                        "message_id": message_id,
                        "index": 0,
                        "_seq": seq,
                        "delta": {"type": "text_delta", "text": "token-" * 20},
                    },
                })
            assert service.append_event(topic, {
                "type": "agent.stream.message_stop",
                "payload": {"message_id": message_id},
            })
            assert service.append_event(topic, {
                "type": "agent.stream.message_committed",
                "payload": {"message_id": message_id, "server_id": f"server-{message_index}"},
            })

        stream_key = f"{STREAM_KEY_PREFIX}{topic}"
        entries = client.xrange(stream_key, "-", "+")
        assert len(entries) == 100
        assert all('message_committed' in fields["e"] for _entry_id, fields in entries)
        assert client.memory_usage(stream_key, samples=0) < 2 * 1024 * 1024

        # 未知 critical 事件最多使用 hard budget；超过后拒写并形成显式 gap。
        rejected = 0
        for index in range(1_000):
            result = service.append_event(budget_topic, {
                "type": "agent.stream.future_business_event",
                "payload": {"event": index, "data": "z" * 32_000},
            })
            if result is None:
                rejected += 1
        budget_key = f"{STREAM_KEY_PREFIX}{budget_topic}"
        assert rejected > 0
        assert client.memory_usage(budget_key, samples=0) < 26 * 1024 * 1024
        gap_details = [json.loads(value) for value in client.hvals(service._gap_key(budget_topic))]
        assert gap_details
        assert {detail["reason"] for detail in gap_details} == {"topic_byte_budget_exceeded"}

        # 部署前已存在、尚无 ledger 的超大 Stream 用真实 MEMORY USAGE 启动账本，
        # 不能在新版本上线后继续增长。
        legacy_key = f"{STREAM_KEY_PREFIX}{legacy_topic}"
        for index in range(24):
            client.xadd(legacy_key, {"e": f"legacy-{index}-" + "q" * 1_000_000})
        before = client.memory_usage(legacy_key, samples=0)
        assert before > 20 * 1024 * 1024
        assert service.append_event(legacy_topic, {
            "type": "agent.stream.future_business_event",
            "payload": {"data": "small"},
        }) is None
        assert client.memory_usage(legacy_key, samples=0) == before
    finally:
        _cleanup(client, marker)


def test_message_commit_heals_prior_message_gap() -> None:
    assert _REDIS_URL is not None
    client = redis.Redis.from_url(_REDIS_URL, decode_responses=True)
    marker = f"ws-commit-heal-{uuid.uuid4().hex}"
    topic = f"agent.stream.{marker}"
    service = _service(client)

    try:
        message_id = "message-1"
        assert service.append_event(topic, {
            "type": "agent.stream.message_start",
            "payload": {"message_id": message_id},
        })

        stream_key = f"{STREAM_KEY_PREFIX}{topic}"
        ledger_key = service._ledger_key(topic)
        gap_key = service._gap_key(topic)
        gap_message_index_key = service._gap_message_index_key(topic, message_id)
        client.set(ledger_key, service._soft_byte_budget(topic) - 100, ex=60)

        assert service.append_event(topic, {
            "type": "agent.stream.content_block_delta",
            "payload": {
                "message_id": message_id,
                "index": 0,
                "delta": {"type": "text_delta", "text": "x" * 1_000},
            },
        }) is None
        assert client.hlen(gap_key) == 1

        client.hset(
            gap_key,
            "indexed-gap-identity",
            json.dumps({
                "reason": "topic_byte_budget_exceeded",
                "boundary": "0-0",
                "message_id": message_id,
                "event_type": "agent.stream.content_block_delta",
                "observed_bytes": 1_000,
            }),
        )
        client.sadd(gap_message_index_key, "indexed-gap-identity")
        client.expire(gap_message_index_key, 60)
        assert client.hlen(gap_key) == 2

        assert service.append_event(topic, {
            "type": "agent.stream.message_committed",
            "payload": {"message_id": message_id, "server_id": "server-1"},
        })

        assert client.hlen(gap_key) == 0
        assert client.exists(gap_message_index_key) == 0
        entries, truncated = service.read_after_many([(topic, "0-0")], raise_on_error=True)
        assert not truncated
        assert [event["type"] for _entry_id, event in entries[topic]] == [
            "agent.stream.message_committed",
        ]
        assert client.xlen(stream_key) == 1
    finally:
        _cleanup(client, marker)
