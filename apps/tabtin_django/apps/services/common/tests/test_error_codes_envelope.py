"""Tests for the wire-envelope helpers in
``apps.services.common.error_codes`` (Wave 0 contract).

These mirror the TS-side ``cli-envelope.test.ts`` assertions — keeping
both ends of the wire shape in lockstep is the whole point of the
contract project. If a Django route ever returns a shape these tests
do not also accept on TS, that is a contract bug, not a test bug.
"""

import pytest


@pytest.fixture
def helpers():
    """Lazy import — error_codes is the module under test."""
    from apps.services.common.error_codes import (
        err_response,
        ok_response,
        ERROR_CODES,
        is_error_code,
    )

    return {
        "err": err_response,
        "ok": ok_response,
        "ERROR_CODES": ERROR_CODES,
        "is_error_code": is_error_code,
    }


# ─── ok_response ──────────────────────────────────────────────────────


def test_ok_response_default_minimal_shape(helpers):
    r = helpers["ok"]({"items": [1, 2]})
    assert r == {"ok": True, "data": {"items": [1, 2]}}
    assert "trace_id" not in r
    assert "duration_ms" not in r
    assert "success" not in r


def test_ok_response_preserves_none_payload(helpers):
    """Don't drop `data: None` — wire shape requires the field."""
    r = helpers["ok"](None)
    assert r == {"ok": True, "data": None}


def test_ok_response_explicit_trace_id_top_level(helpers):
    r = helpers["ok"]({"x": 1}, trace_id="req-abc-123")
    assert r["trace_id"] == "req-abc-123"
    # Top level, not nested under meta / data.
    assert "meta" not in r


def test_ok_response_pulls_trace_id_from_request(helpers):
    class _R:
        request_id = "req-from-mw-456"

    r = helpers["ok"]({"x": 1}, request=_R())
    assert r["trace_id"] == "req-from-mw-456"


def test_ok_response_explicit_trace_id_overrides_request(helpers):
    class _R:
        request_id = "req-from-mw"

    r = helpers["ok"](None, request=_R(), trace_id="explicit-override")
    assert r["trace_id"] == "explicit-override"


def test_ok_response_request_without_request_id_does_not_inject(helpers):
    """request middleware未挂时 request 没有 request_id 属性 — 别炸。"""

    class _R:
        pass

    r = helpers["ok"](None, request=_R())
    assert "trace_id" not in r


def test_ok_response_duration_ms_at_top_level(helpers):
    r = helpers["ok"]({"x": 1}, duration_ms=42)
    assert r["duration_ms"] == 42
    assert "meta" not in r


# ─── err_response ─────────────────────────────────────────────────────


def test_err_response_default_shape(helpers):
    r = helpers["err"]("NOT_FOUND", "organization not found")
    assert r == {
        "ok": False,
        "error": {
            "code": "NOT_FOUND",
            "message": "organization not found",
            "retryable": False,
        },
    }
    assert "success" not in r


def test_err_response_retryable_flag(helpers):
    r = helpers["err"]("RATE_LIMIT_EXCEEDED", "slow down", retryable=True)
    assert r["error"]["retryable"] is True


def test_err_response_includes_suggestions(helpers):
    r = helpers["err"](
        "AUTH_EXPIRED",
        "session expired",
        suggestions=["please log in again"],
    )
    assert r["error"]["suggestions"] == ["please log in again"]


def test_err_response_drops_empty_suggestions(helpers):
    r = helpers["err"]("VALIDATION_ERROR", "bad input", suggestions=[])
    assert "suggestions" not in r["error"]


def test_err_response_trace_id_at_top_level(helpers):
    """Wave 0 review: trace_id MUST live on the envelope, not in error.
    This locks the shape against accidental regression to v1 layout."""
    r = helpers["err"]("INTERNAL_ERROR", "boom", trace_id="req-deadbeef")
    assert r["trace_id"] == "req-deadbeef"
    assert "trace_id" not in r["error"]  # NOT under error


def test_err_response_pulls_trace_id_from_request(helpers):
    class _R:
        request_id = "req-from-mw"

    r = helpers["err"]("INTERNAL_ERROR", "boom", request=_R())
    assert r["trace_id"] == "req-from-mw"


def test_err_response_no_trace_when_neither_provided(helpers):
    r = helpers["err"]("INTERNAL_ERROR", "boom")
    assert "trace_id" not in r


def test_err_response_duration_ms_at_top_level(helpers):
    r = helpers["err"]("UNAVAILABLE", "down", duration_ms=42)
    assert r["duration_ms"] == 42


def test_err_response_empty_trace_id_is_preserved_not_dropped(helpers):
    """Wave 0 hotfix: ``''`` (empty string) trace_id must round-trip
    identically to the TS side — TS uses ``!== undefined`` so a
    present-but-empty trace_id reaches the wire. Python used to drop it
    via plain truthiness, causing W5 audit log to silently coerce
    ``""→None`` across languages and drift the join key schema."""
    r = helpers["err"]("INTERNAL_ERROR", "boom", trace_id="")
    assert r["trace_id"] == ""


def test_ok_response_empty_trace_id_is_preserved_not_dropped(helpers):
    """Counterpart to the err_response test above — same invariant."""
    r = helpers["ok"]({"x": 1}, trace_id="")
    assert r["trace_id"] == ""


def test_err_response_empty_request_id_from_middleware_is_preserved(helpers):
    """If middleware ever produces an empty request_id (broken middleware
    upstream), we still echo it as-is on the wire so the bug is observable;
    silently dropping it would mask the breakage."""
    class _R:
        request_id = ""

    r = helpers["err"]("INTERNAL_ERROR", "boom", request=_R())
    assert r["trace_id"] == ""


def test_err_response_loose_string_code_accepted(helpers):
    """domain / surface-local codes are passed through (matches TS
    ``CliErrorCode = ErrorCode | (string & {})`` semantics)."""
    r = helpers["err"]("TABDATA_VIEW_LOCKED", "view locked by user X")
    assert r["error"]["code"] == "TABDATA_VIEW_LOCKED"


# ─── Taxonomy invariants ──────────────────────────────────────────────


def test_error_codes_contains_required_canonical_codes(helpers):
    required = {
        "AUTH_INVALID",
        "AUTH_EXPIRED",
        "UNAUTHORIZED",
        "PERMISSION_DENIED",
        "FORBIDDEN",
        "NOT_FOUND",
        "VALIDATION_ERROR",
        "CONFLICT",
        "RATE_LIMIT_EXCEEDED",
        "QUOTA_EXCEEDED",
        "TIMEOUT",
        "UNAVAILABLE",
        "CANCELLED",
        "NOT_IMPLEMENTED",
        "INTERNAL_ERROR",
        "SOFT_FAIL",
        "LEGACY_SHAPE",
    }
    actual = set(helpers["ERROR_CODES"])
    missing = required - actual
    assert not missing, f"missing canonical codes: {missing}"


def test_error_codes_no_duplicates(helpers):
    assert len(set(helpers["ERROR_CODES"])) == len(helpers["ERROR_CODES"])


def test_is_error_code_accepts_canonical_values(helpers):
    for code in helpers["ERROR_CODES"]:
        assert helpers["is_error_code"](code) is True


def test_is_error_code_rejects_unknown(helpers):
    assert helpers["is_error_code"]("not_a_code") is False
    assert helpers["is_error_code"]("TABDATA_VIEW_LOCKED") is False
    assert helpers["is_error_code"](None) is False
    assert helpers["is_error_code"](42) is False
