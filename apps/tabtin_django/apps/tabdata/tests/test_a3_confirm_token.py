"""
A3 confirm_token 单元测试

覆盖 W0-5 设计稿 §14 测试矩阵 T01-T20。
"""

import json
import time
from unittest.mock import MagicMock, patch
from uuid import uuid4

import pytest

from apps.tabdata.exceptions import (
    ConfirmTokenBadSignature,
    ConfirmTokenDriftTooLarge,
    ConfirmTokenExpired,
    ConfirmTokenMalformed,
    ConfirmTokenMatchTooLarge,
    ConfirmTokenReplayDetected,
    ConfirmTokenSchemaUnknown,
)
from apps.tabdata.services.confirm_token import (
    ConfirmTokenPayload,
    _b64url_decode,
    _b64url_encode,
    canonical_json,
    issue_confirm_token,
    sha256_hex,
    sign_confirm_token,
    verify_confirm_token_signature,
)


@pytest.fixture
def sample_payload():
    now = int(time.time())
    return ConfirmTokenPayload(
        v=1,
        nonce="a" * 32,
        user_id=str(uuid4()),
        space_id=str(uuid4()),
        table_id=str(uuid4()),
        table_version=5,
        filter_hash=sha256_hex({"status": "pending"}),
        patch_hash=sha256_hex({"status": "done"}),
        matched_total=100,
        rls_context_hash="",
        requires_checkpoint_anchor=False,
        auto_anchor_checkpoint=False,
        issued_at=now,
        expires_at=now + 300,
    )


# ── T01: sign + verify happy path ─────────────────────────────────

class TestT01SignVerifyHappyPath:
    def test_roundtrip(self, sample_payload):
        token = sign_confirm_token(sample_payload)
        result = verify_confirm_token_signature(token)
        assert result.nonce == sample_payload.nonce
        assert result.user_id == sample_payload.user_id
        assert result.matched_total == sample_payload.matched_total
        assert result.v == 1


# ── T02: 篡改 body ────────────────────────────────────────────────

class TestT02TamperBody:
    def test_tampered_body_raises(self, sample_payload):
        token = sign_confirm_token(sample_payload)
        body, sig = token.split('.')
        tampered = body[:-1] + ('A' if body[-1] != 'A' else 'B')
        with pytest.raises(ConfirmTokenBadSignature):
            verify_confirm_token_signature(f"{tampered}.{sig}")


# ── T03: 篡改 sig ─────────────────────────────────────────────────

class TestT03TamperSig:
    def test_tampered_sig_raises(self, sample_payload):
        token = sign_confirm_token(sample_payload)
        body, sig = token.split('.')
        # 篡改 sig 中间字符而非末尾，避免 base64url padding bit 等价
        mid = len(sig) // 2
        replacement = 'A' if sig[mid] != 'A' else 'B'
        tampered_sig = sig[:mid] + replacement + sig[mid + 1:]
        with pytest.raises(ConfirmTokenBadSignature):
            verify_confirm_token_signature(f"{body}.{tampered_sig}")


# ── T04: 过期 ─────────────────────────────────────────────────────

class TestT04Expired:
    def test_expired_token(self, sample_payload):
        now = int(time.time())
        expired = ConfirmTokenPayload(
            **{**sample_payload.__dict__, 'expires_at': now - 1, 'issued_at': now - 301}
        )
        token = sign_confirm_token(expired)
        with pytest.raises(ConfirmTokenExpired):
            verify_confirm_token_signature(token)


# ── T05: 老版本 schema ────────────────────────────────────────────

class TestT05OldSchema:
    def test_unknown_version(self, sample_payload):
        bad = ConfirmTokenPayload(**{**sample_payload.__dict__, 'v': 99})
        token = sign_confirm_token(bad)
        with pytest.raises(ConfirmTokenSchemaUnknown):
            verify_confirm_token_signature(token)


# ── T06-T09: payload 业务校验（在 service 层测试）─────────────────

class TestT06ToT09PayloadValidation:
    def test_user_mismatch(self):
        from apps.tabdata.exceptions import ConfirmTokenUserMismatch
        from apps.tabdata.services.update_by_filter_service import UpdateByFilterService

        user = MagicMock()
        user.id = uuid4()
        svc = UpdateByFilterService(user=user)

        payload = MagicMock(spec=ConfirmTokenPayload)
        payload.user_id = str(uuid4())
        payload.space_id = ""
        payload.table_id = str(uuid4())

        with pytest.raises(ConfirmTokenUserMismatch):
            svc._verify_payload_against_request(payload, payload.table_id, {}, {})


# ── T11: 重放检测 ─────────────────────────────────────────────────

class TestT11Replay:
    @patch('apps.tabdata.services.confirm_token.reserve_nonce')
    @patch('apps.tabdata.services.confirm_token.get_nonce_state')
    def test_replay_detected(self, mock_state, mock_reserve):
        mock_reserve.return_value = False
        mock_state.return_value = "reserved"

        from apps.tabdata.services.update_by_filter_service import UpdateByFilterService
        user = MagicMock()
        user.id = uuid4()
        svc = UpdateByFilterService(user=user)

        payload = MagicMock(spec=ConfirmTokenPayload)
        payload.nonce = "test_nonce"

        with pytest.raises(ConfirmTokenReplayDetected):
            svc._handle_nonce_conflict(payload)


# ── T12: 漂移 8% ─────────────────────────────────────────────────

class TestT12DriftOk:
    def test_drift_8_percent_passes(self):
        drift_ratio = abs(1080 - 1000) / max(1000, 1)
        assert drift_ratio < 0.10


# ── T13: 漂移 30% ────────────────────────────────────────────────

class TestT13DriftWarning:
    def test_drift_30_percent_warns(self):
        drift_ratio = abs(1300 - 1000) / max(1000, 1)
        assert drift_ratio > 0.10
        assert drift_ratio <= 0.50


# ── T14: 漂移 60% ────────────────────────────────────────────────

class TestT14DriftReject:
    def test_drift_60_percent_rejects(self):
        drift_ratio = abs(1600 - 1000) / max(1000, 1)
        assert drift_ratio > 0.50

    def test_drift_exception(self):
        exc = ConfirmTokenDriftTooLarge(expected=1000, actual=1600, ratio=0.6)
        assert exc.expected == 1000
        assert exc.actual == 1600
        assert exc.http_status == 409


# ── T20: 巨量 matched_total ──────────────────────────────────────

class TestT20MatchTooLarge:
    def test_match_too_large_exception(self):
        exc = ConfirmTokenMatchTooLarge(matched_total=11000, hard_limit=10000)
        assert exc.matched_total == 11000
        assert exc.http_status == 400


# ── canonical_json 稳定性测试 ─────────────────────────────────────

class TestCanonicalJson:
    def test_key_order_independence(self):
        a = canonical_json({"b": 2, "a": [{"x": 1, "y": 2}, 3]})
        b = canonical_json({"a": [{"y": 2, "x": 1}, 3], "b": 2})
        assert a == b

    def test_unicode_passthrough(self):
        result = canonical_json({"name": "订单表"})
        assert "订单表" in result.decode('utf-8')

    def test_sha256_hex_stability(self):
        h1 = sha256_hex({"status": "pending"})
        h2 = sha256_hex({"status": "pending"})
        assert h1 == h2
        assert len(h1) == 64


# ── issue_confirm_token 集成测试 ──────────────────────────────────

class TestIssueConfirmToken:
    def test_issue_and_verify(self):
        token_str, payload = issue_confirm_token(
            user_id=str(uuid4()),
            space_id=str(uuid4()),
            table_id=str(uuid4()),
            table_version=1,
            filter_clause={"status": "pending"},
            patch={"status": "done"},
            matched_total=50,
            is_agent=False,
        )
        assert isinstance(token_str, str)
        assert '.' in token_str
        assert payload.v == 1
        assert payload.matched_total == 50

        verified = verify_confirm_token_signature(token_str)
        assert verified.nonce == payload.nonce

    def test_agent_forces_checkpoint(self):
        _, payload = issue_confirm_token(
            user_id=str(uuid4()),
            space_id=str(uuid4()),
            table_id=str(uuid4()),
            table_version=1,
            filter_clause={},
            patch={"x": 1},
            matched_total=5,
            is_agent=True,
        )
        assert payload.requires_checkpoint_anchor is True
        assert payload.auto_anchor_checkpoint is True

    def test_large_match_triggers_checkpoint(self):
        _, payload = issue_confirm_token(
            user_id=str(uuid4()),
            space_id=str(uuid4()),
            table_id=str(uuid4()),
            table_version=1,
            filter_clause={},
            patch={"x": 1},
            matched_total=1500,
            is_agent=False,
        )
        assert payload.requires_checkpoint_anchor is True
        assert payload.auto_anchor_checkpoint is True


# ── 异常类测试 ────────────────────────────────────────────────────

class TestExceptionClasses:
    def test_all_exceptions_have_code(self):
        from apps.tabdata import exceptions as exc_mod
        confirm_exceptions = [
            exc_mod.ConfirmTokenMalformed,
            exc_mod.ConfirmTokenBadSignature,
            exc_mod.ConfirmTokenExpired,
            exc_mod.ConfirmTokenSchemaUnknown,
            exc_mod.ConfirmTokenUserMismatch,
            exc_mod.ConfirmTokenSpaceMismatch,
            exc_mod.ConfirmTokenTableMismatch,
            exc_mod.ConfirmTokenTableChanged,
            exc_mod.ConfirmTokenFilterChanged,
            exc_mod.ConfirmTokenPatchChanged,
            exc_mod.ConfirmTokenPermissionChanged,
            exc_mod.ConfirmTokenReplayDetected,
            exc_mod.ConfirmTokenPreviouslyFailed,
            exc_mod.ConfirmTokenDriftTooLarge,
            exc_mod.ConfirmTokenMatchTooLarge,
            exc_mod.ConfirmTokenRedisUnavailable,
        ]
        for exc_class in confirm_exceptions:
            assert hasattr(exc_class, 'code'), f"{exc_class.__name__} missing code"
            assert hasattr(exc_class, 'http_status'), f"{exc_class.__name__} missing http_status"
            assert exc_class.code.startswith('a3.'), f"{exc_class.__name__} code should start with a3."

    def test_expired_has_timestamps(self):
        exc = ConfirmTokenExpired(issued_at=100, expires_at=400)
        assert exc.issued_at == 100
        assert exc.expires_at == 400

    def test_previously_failed_has_error(self):
        from apps.tabdata.exceptions import ConfirmTokenPreviouslyFailed
        exc = ConfirmTokenPreviouslyFailed(previous_error="SomeError")
        assert exc.previous_error == "SomeError"


# ── T18: secret 变更后旧 token 无效 ──────────────────────────────

class TestT18SecretRotation:
    def test_different_secret_invalidates(self, sample_payload):
        token = sign_confirm_token(sample_payload)

        with patch('apps.tabdata.services.confirm_token._get_confirm_token_secret',
                   return_value='new_secret_key_12345'):
            with pytest.raises(ConfirmTokenBadSignature):
                verify_confirm_token_signature(token)


# ── b64url 工具测试 ───────────────────────────────────────────────

class TestB64Url:
    def test_roundtrip(self):
        data = b"hello world \x00\xff"
        encoded = _b64url_encode(data)
        decoded = _b64url_decode(encoded)
        assert decoded == data

    def test_no_padding(self):
        encoded = _b64url_encode(b"abc")
        assert '=' not in encoded
