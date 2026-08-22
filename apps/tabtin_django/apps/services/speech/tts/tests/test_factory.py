"""Speech TTS 工厂、别名、同步桥接测试"""

import os

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import django

django.setup()

import pytest

from apps.services.speech.tts.factory import (
    PROVIDER_ALIASES,
    TTSConfigError,
    TTSServiceFactory,
    run_async,
    get_tts_service,
    synthesize_to_file,
)
from apps.services.speech.tts.types import (
    TTSFileResult,
    TTSResult,
    TTSSentence,
    TTSWordTimestamp,
)


class TestProviderAliases:
    def test_doubao_maps_to_bytedance(self):
        assert PROVIDER_ALIASES["doubao"] == "bytedance"

    def test_bytedance_passes_through(self):
        assert PROVIDER_ALIASES.get("bytedance", "bytedance") == "bytedance"

    def test_get_tts_service_resolves_doubao(self):
        with patch.object(TTSServiceFactory, "create_service") as mock_create:
            mock_create.return_value = MagicMock()
            with patch("apps.services.speech.tts.factory._resolve_config") as mock_cfg:
                mock_cfg.return_value = {"provider_name": "bytedance"}
                get_tts_service(provider="doubao", mode="http")
                mock_create.assert_called_once()
                args = mock_create.call_args
                assert args[0][0] == "bytedance"


class TestResolveConfigRequiresDb:
    """v0.1.x：删除 settings fallback 后，未配置 DB 应直接抛错。"""

    def test_no_db_provider_raises(self):
        from apps.services.speech.tts.factory import _resolve_config

        with patch(
            "apps.services.speech.tts.factory._try_load_from_db",
            return_value=None,
        ):
            with pytest.raises(TTSConfigError, match="未在 DB 配置"):
                _resolve_config("bytedance", mode="http")


class TestRunAsync:
    def test_runs_coroutine_in_sync_context(self):
        async def _coro():
            return 42

        result = run_async(_coro())
        assert result == 42

    def test_propagates_exception(self):
        async def _failing():
            raise ValueError("test error")

        with pytest.raises(ValueError, match="test error"):
            run_async(_failing())


_FACTORY_MOD = "apps.services.speech.tts.factory"
_AUDIO_UTILS_MOD = "apps.services.speech.tts.audio_utils"


class TestSynthesizeToFile:
    def test_word_timestamps_format(self, tmp_path):
        with patch(f"{_FACTORY_MOD}.synthesize_sync") as mock_sync, \
             patch(f"{_AUDIO_UTILS_MOD}.measure_duration", return_value=2.5), \
             patch(f"{_AUDIO_UTILS_MOD}.pcm_to_wav", return_value=str(tmp_path / "fake.wav")):
            mock_sync.return_value = TTSResult(
                audio_data=b"\x00" * 48000,
                format="pcm",
                sentences=[
                    TTSSentence(text="你好", words=[
                        TTSWordTimestamp(word="你", start_time=0.0, end_time=0.3, confidence=0.9),
                        TTSWordTimestamp(word="好", start_time=0.3, end_time=0.6, confidence=0.8),
                    ]),
                ],
            )

            result = synthesize_to_file("你好", output_dir=str(tmp_path))

            assert isinstance(result, TTSFileResult)
            assert result.measured_duration == 2.5
            assert len(result.word_timestamps) == 2

            w0 = result.word_timestamps[0]
            assert "text" in w0, "应使用 'text' 而非 'word'"
            assert w0["text"] == "你"
            assert w0["startTime"] == 0.0
            assert w0["endTime"] == 0.3

    def test_duration_fallback_to_pcm_length(self, tmp_path):
        audio_data = b"\x00" * 96000  # 48000 samples * 2 bytes = 2 seconds at 24kHz
        with patch(f"{_FACTORY_MOD}.synthesize_sync") as mock_sync, \
             patch(f"{_AUDIO_UTILS_MOD}.measure_duration", return_value=0.0), \
             patch(f"{_AUDIO_UTILS_MOD}.pcm_to_wav", return_value=str(tmp_path / "fake.wav")):
            mock_sync.return_value = TTSResult(
                audio_data=audio_data,
                format="pcm",
            )

            result = synthesize_to_file("测试", output_dir=str(tmp_path))
            assert result.measured_duration == pytest.approx(2.0, abs=0.01)
