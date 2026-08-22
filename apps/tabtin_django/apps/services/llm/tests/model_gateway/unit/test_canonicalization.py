from datetime import datetime, timedelta, timezone

import pytest

from apps.services.llm.model_gateway.canonical import CanonicalizationError, canonicalize


def test_key_order_and_unicode_normalization_are_stable():
    assert canonicalize({"b": 2, "a": "é"}) == canonicalize({"a": "e\u0301", "b": 2})


def test_array_order_is_preserved_and_significant():
    assert canonicalize({"items": [1, 2]}) != canonicalize({"items": [2, 1]})


def test_decimal_string_and_timestamp_normalization():
    value = {"amount": "0.0100", "at": datetime(2026, 1, 1, 8, tzinfo=timezone(timedelta(hours=8)))}
    assert canonicalize(value) == b'{"amount":"0.0100","at":"2026-01-01T00:00:00Z"}'


@pytest.mark.parametrize("value", [1.0, float("nan"), float("inf")])
def test_floats_are_rejected(value):
    with pytest.raises(CanonicalizationError):
        canonicalize({"value": value})


def test_repeated_calls_do_not_mutate_input():
    value = {"lines": ["a\r\nb"], "enabled": True, "empty": None}
    before = {"lines": ["a\r\nb"], "enabled": True, "empty": None}
    assert canonicalize(value) == canonicalize(value)
    assert value == before

