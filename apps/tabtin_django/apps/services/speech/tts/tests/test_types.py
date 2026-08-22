"""Speech TTS 类型序列化一致性测试"""

import pytest

from apps.services.speech.tts.types import (
    TTSChunk,
    TTSFileResult,
    TTSResult,
    TTSSentence,
    TTSStreamEvent,
    TTSWordTimestamp,
)


class TestTTSWordTimestamp:
    def test_to_dict_field_names(self):
        w = TTSWordTimestamp(word="你好", start_time=0.5, end_time=1.2, confidence=0.95)
        d = w.to_dict()
        assert "text" in d, "应使用 'text' 而非 'word' 作为字段名"
        assert "word" not in d
        assert d["text"] == "你好"
        assert d["startTime"] == 0.5
        assert d["endTime"] == 1.2
        assert d["confidence"] == 0.95

    def test_to_dict_zero_confidence(self):
        w = TTSWordTimestamp(word="世界", start_time=0.0, end_time=0.3)
        d = w.to_dict()
        assert d["confidence"] == 0.0


class TestTTSSentence:
    def test_to_dict_nested_words(self):
        words = [
            TTSWordTimestamp(word="你好", start_time=0.0, end_time=0.5),
            TTSWordTimestamp(word="世界", start_time=0.5, end_time=1.0),
        ]
        s = TTSSentence(text="你好世界", words=words)
        d = s.to_dict()
        assert d["text"] == "你好世界"
        assert len(d["words"]) == 2
        assert d["words"][0]["text"] == "你好"
        assert d["words"][1]["text"] == "世界"

    def test_to_dict_empty_words(self):
        s = TTSSentence(text="空句子")
        d = s.to_dict()
        assert d["words"] == []


class TestTTSResult:
    def test_to_dict_basic(self):
        r = TTSResult(
            audio_data=b"\x00\x01\x02",
            format="pcm",
            sample_rate=24000,
            duration=1.5,
            provider="bytedance",
            mode="http",
        )
        d = r.to_dict()
        assert d["format"] == "pcm"
        assert d["sampleRate"] == 24000
        assert d["duration"] == 1.5
        assert d["audioSize"] == 3
        assert d["provider"] == "bytedance"
        assert d["mode"] == "http"
        assert d["sentences"] == []

    def test_to_dict_with_sentences(self):
        r = TTSResult(
            audio_data=b"",
            sentences=[TTSSentence(text="测试句子")],
        )
        d = r.to_dict()
        assert len(d["sentences"]) == 1
        assert d["sentences"][0]["text"] == "测试句子"


class TestTTSFileResult:
    def test_fields_complete(self):
        fr = TTSFileResult(
            audio_path="/tmp/test.wav",
            word_timestamps=[{"text": "你", "startTime": 0.0, "endTime": 0.2}],
            measured_duration=1.5,
            sample_rate=24000,
            channels=1,
            format="pcm",
        )
        assert fr.audio_path == "/tmp/test.wav"
        assert fr.measured_duration == 1.5
        assert fr.sample_rate == 24000
        assert fr.channels == 1
        assert fr.format == "pcm"
        assert len(fr.word_timestamps) == 1
        assert fr.word_timestamps[0]["text"] == "你"

    def test_defaults(self):
        fr = TTSFileResult(audio_path="/tmp/empty.wav")
        assert fr.word_timestamps == []
        assert fr.measured_duration == 0.0
        assert fr.sample_rate == 24000
        assert fr.channels == 1
        assert fr.format == "pcm"


class TestTTSChunk:
    def test_to_dict_with_audio(self):
        c = TTSChunk(audio_data=b"\xff\xfe", event_type="audio")
        d = c.to_dict()
        assert d["eventType"] == "audio"
        assert d["isLast"] is False
        assert len(d["audioData"]) > 0

    def test_to_dict_done(self):
        c = TTSChunk(audio_data=b"", is_last=True, event_type="done")
        d = c.to_dict()
        assert d["isLast"] is True
        assert d["audioData"] == ""


class TestTTSStreamEvent:
    def test_to_dict_basic(self):
        e = TTSStreamEvent(event_type="audio", session_id="sess-1")
        d = e.to_dict()
        assert d["eventType"] == "audio"
        assert d["sessionId"] == "sess-1"
        assert "audioData" not in d

    def test_to_dict_with_error(self):
        e = TTSStreamEvent(
            event_type="error",
            error_code=50001,
            error_message="server error",
        )
        d = e.to_dict()
        assert d["errorCode"] == 50001
        assert d["errorMessage"] == "server error"
