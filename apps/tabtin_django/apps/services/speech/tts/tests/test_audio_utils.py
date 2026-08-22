"""Speech TTS 音频工具测试"""

import os
import struct
from unittest.mock import patch

import pytest

from apps.services.speech.tts.audio_utils import (
    measure_duration,
    pcm_to_wav,
    save_audio_to_file,
)


def _generate_pcm_silence(duration_sec: float, sample_rate: int = 24000) -> bytes:
    """生成指定时长的静默 PCM 数据（s16le, mono）"""
    num_samples = int(duration_sec * sample_rate)
    return b"\x00\x00" * num_samples


class TestPcmToWav:
    def test_creates_wav_file(self, tmp_path):
        pcm = _generate_pcm_silence(0.5)
        out = str(tmp_path / "test.wav")
        result = pcm_to_wav(pcm, out)
        assert result == out
        assert os.path.isfile(out)
        assert os.path.getsize(out) > len(pcm)  # WAV header adds bytes

    def test_empty_pcm(self, tmp_path):
        out = str(tmp_path / "empty.wav")
        pcm_to_wav(b"", out)
        assert os.path.isfile(out)

    @patch("apps.services.speech.tts.audio_utils.subprocess.run")
    def test_ffmpeg_not_found_raises(self, mock_run, tmp_path):
        mock_run.side_effect = FileNotFoundError("ffmpeg")
        with pytest.raises(RuntimeError, match="ffmpeg"):
            pcm_to_wav(b"\x00\x00", str(tmp_path / "fail.wav"))


class TestMeasureDuration:
    def test_valid_wav(self, tmp_path):
        pcm = _generate_pcm_silence(1.0)
        wav_path = str(tmp_path / "test.wav")
        pcm_to_wav(pcm, wav_path)
        dur = measure_duration(wav_path)
        assert dur > 0.9
        assert dur < 1.2

    def test_nonexistent_file(self):
        dur = measure_duration("/nonexistent/file.wav")
        assert dur == 0.0

    @patch("apps.services.speech.tts.audio_utils.subprocess.run")
    def test_ffprobe_not_found(self, mock_run):
        mock_run.side_effect = FileNotFoundError("ffprobe")
        dur = measure_duration("/some/file.wav")
        assert dur == 0.0


class TestSaveAudioToFile:
    def test_pcm_creates_wav(self, tmp_path):
        pcm = _generate_pcm_silence(0.5)
        path = save_audio_to_file(pcm, format="pcm", output_dir=str(tmp_path))
        assert path.endswith(".wav")
        assert os.path.isfile(path)

    def test_mp3_writes_directly(self, tmp_path):
        fake_mp3 = b"\xff\xfb\x90\x00" + b"\x00" * 100
        path = save_audio_to_file(fake_mp3, format="mp3", output_dir=str(tmp_path))
        assert path.endswith(".mp3")
        assert os.path.isfile(path)
        with open(path, "rb") as f:
            assert f.read() == fake_mp3

    def test_ogg_opus_extension(self, tmp_path):
        data = b"\x00" * 50
        path = save_audio_to_file(data, format="ogg_opus", output_dir=str(tmp_path))
        assert path.endswith(".ogg")

    def test_custom_filename(self, tmp_path):
        data = b"\x00" * 50
        path = save_audio_to_file(
            data, format="mp3", output_dir=str(tmp_path), filename="custom"
        )
        assert os.path.basename(path) == "custom.mp3"
