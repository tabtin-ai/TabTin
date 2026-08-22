"""
音乐生成服务抽象基类

设计原则：
  1. 输出 WAV，与 TTS 服务保持一致（避免 MP3 encoder delay）
  2. 时长由 ffprobe 实测（不信任 API 报告值）
  3. 支持自动循环/截断以匹配目标时长
  4. 返回 MusicMetadata（beats、sections）供 Orchestrator beat snap
"""

from __future__ import annotations

import logging
import os
import subprocess
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Optional

logger = logging.getLogger(__name__)


@dataclass
class MusicSection:
    """音乐结构段落"""
    type: str   # intro / verse / chorus / bridge / buildup / drop / outro
    start: float
    end: float
    energy: float = 0.5

    def to_dict(self) -> dict:
        return {"type": self.type, "start": self.start, "end": self.end, "energy": self.energy}


@dataclass
class MusicResult:
    """音乐生成结果"""
    audio_path: str
    measured_duration: float          # ffprobe 实测（秒）
    bpm: float = 0.0
    beats: list[float] = field(default_factory=list)
    downbeats4: list[float] = field(default_factory=list)
    downbeats8: list[float] = field(default_factory=list)
    sections: list[MusicSection] = field(default_factory=list)
    sample_rate: int = 44100
    raw_metadata: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "audioPath": self.audio_path,
            "measuredDuration": self.measured_duration,
            "bpm": self.bpm,
            "beats": self.beats,
            "downbeats4": self.downbeats4,
            "downbeats8": self.downbeats8,
            "sections": [s.to_dict() for s in self.sections],
            "sampleRate": self.sample_rate,
        }

    def to_music_metadata(self) -> dict:
        """转换为引擎 MusicMetadata 格式（直接可传入 Orchestrator）"""
        return {
            "bpm": self.bpm,
            "duration": self.measured_duration,
            "beats": self.beats,
            "downbeats4": self.downbeats4,
            "downbeats8": self.downbeats8,
            "sections": [s.to_dict() for s in self.sections],
            "safeCutPoints": [s.start for s in self.sections],
        }


# 向后兼容别名
BGMResult = MusicResult


class BaseMusicService(ABC):
    """音乐生成服务抽象基类"""

    def __init__(self, config: dict[str, Any]):
        self.config = config
        self.provider_name: str = config.get("provider_name", "unknown")
        self.max_retries: int = config.get("max_retries", 3)
        self.timeout_seconds: int = config.get("timeout_seconds", 120)
        self._provider_id: str = config.get("provider_id", "")
        self._rate_limit: int = int(config.get("rate_limit", 0) or 0)

    def _check_rate_limit(self) -> Optional[dict[str, Any]]:
        """Provider 级限流检查（共享 LLM 的滑动窗口机制）。"""
        from apps.services.llm.services.rate_limiter import check_provider_rate_limit
        return check_provider_rate_limit(
            provider_id=self._provider_id,
            rate_limit=self._rate_limit,
            provider_name=self.provider_name,
            service_tag="bgm",
        )

    def _report_call_result(
        self, *, success: bool, latency_seconds: float = 0, error_message: str = "",
    ) -> None:
        """上报调用结果，驱动 Provider 熔断状态机。"""
        from apps.services.llm.services.rate_limiter import report_call_result_by_id
        report_call_result_by_id(
            self._provider_id,
            success=success,
            latency_seconds=latency_seconds,
            error_message=error_message,
        )

    def _raise_if_rate_limited(self) -> None:
        """限流检查便捷方法——触发限流时直接抛异常。"""
        rate_limit_error = self._check_rate_limit()
        if rate_limit_error:
            raise RuntimeError(rate_limit_error["error"])

    @abstractmethod
    def generate(
        self,
        prompt: str,
        *,
        target_duration: float = 60.0,
        style: str = "",
        bpm: Optional[int] = None,
        output_dir: Optional[str] = None,
    ) -> MusicResult:
        """
        生成音乐

        子类实现时应在入口调用 self._raise_if_rate_limited()，
        在完成/失败后调用 self._report_call_result()。

        Args:
            prompt: 音乐风格描述
            target_duration: 目标时长（秒），会自动循环/截断
            style: 风格预设名（可选）
            bpm: 目标 BPM（可选）
            output_dir: 输出目录

        Returns:
            MusicResult
        """
        ...

    @staticmethod
    def measure_duration(audio_path: str) -> float:
        """ffprobe 测量音频实际时长"""
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
        except Exception as e:
            logger.warning("ffprobe 测量失败 path=%s err=%s", audio_path, e)
            return 0.0

    @staticmethod
    def loop_to_duration(
        input_path: str,
        output_path: str,
        target_duration: float,
        fade_in: float = 1.0,
        fade_out: float = 2.0,
    ) -> str:
        """
        使用 FFmpeg aloop + afade 将音乐循环/截断到目标时长。

        实战经验（MiniMax 生成 30-130s，视频可能需要 100+s）：
          aloop=loop=N  — 重复 N 次
          atrim=duration=T  — 截到 T 秒
          afade=t=in:d=1  — 开头淡入
          afade=t=out:st=S:d=2  — 结尾淡出
        """
        src_duration = BaseMusicService.measure_duration(input_path)
        if src_duration <= 0:
            raise RuntimeError(f"无法测量源音乐时长: {input_path}")

        if src_duration >= target_duration:
            fade_out_start = max(0, target_duration - fade_out)
            af = (
                f"atrim=duration={target_duration},"
                f"afade=t=in:d={fade_in},"
                f"afade=t=out:st={fade_out_start}:d={fade_out}"
            )
        else:
            loops = int(target_duration / src_duration) + 1
            fade_out_start = max(0, target_duration - fade_out)
            af = (
                f"aloop=loop={loops}:size=0,"
                f"atrim=duration={target_duration},"
                f"afade=t=in:d={fade_in},"
                f"afade=t=out:st={fade_out_start}:d={fade_out}"
            )

        try:
            result = subprocess.run(
                [
                    "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                    "-i", input_path,
                    "-af", af,
                    output_path,
                ],
                capture_output=True, timeout=60,
            )
            if result.returncode != 0:
                raise RuntimeError(f"FFmpeg loop 失败: {result.stderr.decode()}")
            return output_path
        except Exception as e:
            logger.error("音乐 loop 处理失败: %s", e)
            raise

    @staticmethod
    def convert_to_wav(input_path: str, output_path: str, sample_rate: int = 44100) -> str:
        """将任意音频格式转为 WAV（避免 MP3 encoder delay）"""
        try:
            result = subprocess.run(
                [
                    "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                    "-i", input_path,
                    "-ar", str(sample_rate),
                    "-ac", "2",
                    output_path,
                ],
                capture_output=True, timeout=30,
            )
            if result.returncode != 0:
                raise RuntimeError(f"FFmpeg 转换失败: {result.stderr.decode()}")
            return output_path
        except Exception as e:
            logger.error("音频转 WAV 失败: %s", e)
            raise


# 向后兼容别名
BaseBGMService = BaseMusicService
