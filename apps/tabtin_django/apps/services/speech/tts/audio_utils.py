"""
TTS 音频工具函数

从 TabVideo TTS 模块迁入，统一收口到 Speech 服务层。
供 TabVideo 视频管线、Speech REST API 等下游使用。

核心能力：
  1. PCM → WAV 转换（ffmpeg，无损，时长精确）
  2. ffprobe 实测音频时长（不信任 API 报告值）
  3. 内存音频 → 文件保存
"""

from __future__ import annotations

import logging
import os
import subprocess
import tempfile
from typing import Optional

logger = logging.getLogger(__name__)


def pcm_to_wav(
    pcm_data: bytes,
    output_path: str,
    sample_rate: int = 24000,
    channels: int = 1,
    bits: int = 16,
) -> str:
    """
    将原始 PCM 数据转换为 WAV 文件。

    WAV 仅添加 header，无 encoder delay，时长精确可信。
    不同于 MP3 的 encoder delay（0.3-1.3s），WAV 是视频管线的唯一可靠格式。
    """
    try:
        fmt = f"s{bits}le"
        result = subprocess.run(
            [
                "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                "-f", fmt,
                "-ar", str(sample_rate),
                "-ac", str(channels),
                "-i", "pipe:0",
                output_path,
            ],
            input=pcm_data,
            capture_output=True, timeout=30,
        )
        if result.returncode != 0:
            raise RuntimeError(f"ffmpeg PCM→WAV 失败: {result.stderr.decode()}")
        return output_path
    except subprocess.TimeoutExpired:
        raise RuntimeError("ffmpeg PCM→WAV 超时（30s）")
    except FileNotFoundError as e:
        raise RuntimeError(f"ffmpeg 未安装或路径不存在: {e}") from e


def measure_duration(audio_path: str) -> float:
    """
    用 ffprobe 测量音频实际时长（秒）。

    这是唯一可信的时长来源：
      - 不信任 TTS API 报告的时长（不含尾部衰减）
      - 不信任 word timestamps 的 endTime（可能偏短）
      - 不信任按采样率计算的理论值（可能有 padding）
    """
    try:
        result = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                audio_path,
            ],
            capture_output=True, text=True, timeout=10,
        )
        return float(result.stdout.strip())
    except (subprocess.TimeoutExpired, FileNotFoundError) as e:
        logger.warning("ffprobe 测量失败 path=%s err=%s", audio_path, e)
        return 0.0
    except (ValueError, AttributeError) as e:
        logger.warning("ffprobe 输出解析失败 path=%s err=%s", audio_path, e)
        return 0.0


def save_audio_to_file(
    audio_data: bytes,
    *,
    format: str = "mp3",
    output_dir: Optional[str] = None,
    filename: Optional[str] = None,
    sample_rate: int = 24000,
    channels: int = 1,
) -> str:
    """
    将内存中的音频数据保存为文件。

    如果 format 为 pcm，会自动转换为 WAV（添加 header）。
    其他格式（mp3/ogg_opus）直接写入对应扩展名。

    Returns:
        保存后的文件路径
    """
    if output_dir is None:
        output_dir = tempfile.mkdtemp(prefix="speech_tts_")
    os.makedirs(output_dir, exist_ok=True)

    if format == "pcm":
        ext = ".wav"
    elif format == "ogg_opus":
        ext = ".ogg"
    else:
        ext = f".{format}"

    if filename is None:
        import uuid
        filename = f"{uuid.uuid4().hex}{ext}"
    elif not filename.endswith(ext):
        filename = f"{filename}{ext}"

    output_path = os.path.join(output_dir, filename)

    if format == "pcm":
        pcm_to_wav(audio_data, output_path, sample_rate=sample_rate, channels=channels)
    else:
        with open(output_path, "wb") as f:
            f.write(audio_data)

    return output_path
