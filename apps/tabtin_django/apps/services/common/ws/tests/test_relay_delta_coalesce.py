"""Django relay 在分配 Redis cursor 前安全合并相邻 delta。"""

from apps.services.common.ws.handlers.relay_delta_coalesce import coalesce_deferred_publishes


def _delta(message_id: str, text: str, *, index: int = 0, seq: int = 1):
    return (
        "content_block_delta",
        {
            "message_id": message_id,
            "index": index,
            "_seq": seq,
            "delta": {"type": "text_delta", "text": text},
        },
    )


def test_adjacent_same_key_deltas_are_coalesced_in_order() -> None:
    result = coalesce_deferred_publishes([
        _delta("message-1", "hello", seq=1),
        _delta("message-1", " world", seq=2),
    ])

    assert len(result) == 1
    assert result[0][1]["delta"]["text"] == "hello world"
    assert result[0][1]["_seq"] == 2
    assert result[0][1]["coalesced_count"] == 2


def test_precoalesced_deltas_add_both_covered_seq_counts() -> None:
    first = _delta("message-1", "AB", seq=2)
    first[1]["coalesced_count"] = 2
    second = _delta("message-1", "CDE", seq=5)
    second[1]["coalesced_count"] = 3

    result = coalesce_deferred_publishes([first, second])

    assert len(result) == 1
    assert result[0][1]["delta"]["text"] == "ABCDE"
    assert result[0][1]["_seq"] == 5
    assert result[0][1]["coalesced_count"] == 5


def test_does_not_coalesce_across_message_or_non_delta_boundary() -> None:
    result = coalesce_deferred_publishes([
        _delta("message-1", "a"),
        ("content_block_stop", {"message_id": "message-1", "index": 0}),
        _delta("message-1", "b"),
        _delta("message-2", "c"),
    ])

    assert [item[0] for item in result] == [
        "content_block_delta",
        "content_block_stop",
        "content_block_delta",
        "content_block_delta",
    ]


def test_structured_delta_is_never_coalesced() -> None:
    citations = (
        "content_block_delta",
        {
            "message_id": "message-1",
            "index": 0,
            "delta": {"type": "citations_delta", "citations": [{"url": "a"}]},
        },
    )

    assert len(coalesce_deferred_publishes([citations, citations])) == 2


def test_coalesced_body_is_split_at_limit() -> None:
    result = coalesce_deferred_publishes(
        [_delta("message-1", "1234"), _delta("message-1", "5678")],
        max_chars=6,
    )

    assert len(result) == 2
