"""ByteDance/Doubao TTS resource capability tests."""

from apps.services.speech.tts.providers.bytedance.base import (
    RESOURCE_TTS_10,
    RESOURCE_TTS_20,
    RESOURCE_TTS_30,
    supports_subtitle_resource,
)


def test_seed_tts_3_supports_subtitle_timestamps():
    assert supports_subtitle_resource(RESOURCE_TTS_20)
    assert supports_subtitle_resource(RESOURCE_TTS_30)
    assert not supports_subtitle_resource(RESOURCE_TTS_10)
