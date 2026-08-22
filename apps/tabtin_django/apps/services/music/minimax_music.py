"""
MiniMax 音乐生成服务实现 — music-2.5

API: https://api.minimaxi.com/v1/music_generation
模型: music-2.5

关键实战经验：
  1. lyrics 必填 — 即使纯器乐也不能传空字符串
  2. lyrics 里写描述性文字会被当歌词唱 — 只用 [Inst] 结构标签
  3. 单次生成 30-130s（不可控）— 需要 aloop+afade 循环到目标时长
  4. 输出格式可选 WAV — 设 audio_setting.format='wav'
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
import time
import uuid
from typing import Any, Optional

import requests

from .base import BaseMusicService, MusicResult, MusicSection

logger = logging.getLogger(__name__)

STYLE_PRESETS: dict[str, dict[str, str]] = {
    "tech": {
        "prompt": "ambient electronic, cinematic tech presentation, "
                  "corporate background music, warm pads, subtle percussion, "
                  "inspiring and professional",
        "lyrics": "[Intro]\n[Inst]\n[Verse]\n[Inst]\n[Build Up]\n[Inst]\n"
                  "[Chorus]\n[Inst]\n[Outro]\n[Inst]",
    },
    "data": {
        "prompt": "cinematic data visualization, progressive build, "
                  "technological, ambient textures, rising energy",
        "lyrics": "[Intro]\n[Inst]\n[Build Up]\n[Inst]\n[Chorus]\n[Inst]\n"
                  "[Verse]\n[Inst]\n[Outro]\n[Inst]",
    },
    "narrative": {
        "prompt": "light acoustic, gentle piano, storytelling, warm, "
                  "subtle strings, intimate atmosphere",
        "lyrics": "[Intro]\n[Inst]\n[Verse]\n[Inst]\n[Verse]\n[Inst]\n"
                  "[Outro]\n[Inst]",
    },
    "energetic": {
        "prompt": "upbeat electronic, energetic pop, driving beat, "
                  "synth hooks, festival energy, confident",
        "lyrics": "[Intro]\n[Inst]\n[Build Up]\n[Inst]\n[Drop]\n[Inst]\n"
                  "[Build Up]\n[Inst]\n[Drop]\n[Inst]\n[Outro]\n[Inst]",
    },
    "calm": {
        "prompt": "lo-fi chill, ambient pad, soft rhodes piano, "
                  "minimal percussion, relaxing atmosphere, study music",
        "lyrics": "[Intro]\n[Inst]\n[Verse]\n[Inst]\n[Verse]\n[Inst]\n"
                  "[Outro]\n[Inst]",
    },
}

INSTRUMENTAL_LYRICS = (
    "[Intro]\n[Inst]\n[Verse]\n[Inst]\n[Build Up]\n[Inst]\n"
    "[Chorus]\n[Inst]\n[Outro]\n[Inst]"
)


class MiniMaxMusicService(BaseMusicService):
    """
    MiniMax music-2.5 音乐生成

    config 示例:
        {
            "provider_name": "minimax",
            "api_key": "sk-api-xxx",
            "api_url": "https://api.minimaxi.com/v1/music_generation",
            "model": "music-2.5",
        }
    """

    def __init__(self, config: dict[str, Any]):
        super().__init__(config)
        self.api_key: str = config.get("api_key", "")
        self.api_url: str = config.get(
            "api_url",
            "https://api.minimaxi.com/v1/music_generation",
        )
        self.model: str = config.get("model", "music-2.5")

    def generate(
        self,
        prompt: str,
        *,
        target_duration: float = 60.0,
        style: str = "",
        bpm: Optional[int] = None,
        output_dir: Optional[str] = None,
    ) -> MusicResult:
        self._raise_if_rate_limited()

        if not prompt.strip() and not style:
            raise ValueError("prompt 或 style 至少提供一个")

        if output_dir is None:
            output_dir = tempfile.mkdtemp(prefix="music_bgm_")

        preset = STYLE_PRESETS.get(style, {})
        final_prompt = prompt or preset.get("prompt", "")
        lyrics = preset.get("lyrics", INSTRUMENTAL_LYRICS)

        if bpm:
            final_prompt = f"{final_prompt}, {bpm} BPM"

        request_id = str(uuid.uuid4())
        _start = time.monotonic()

        raw_path = os.path.join(output_dir, f"{request_id}_raw.wav")
        for attempt in range(self.max_retries):
            try:
                raw_path = self._call_api(final_prompt, lyrics, raw_path)
                break
            except Exception as e:
                if attempt < self.max_retries - 1:
                    wait = 3 * (2 ** attempt)
                    logger.warning(
                        "MiniMax Music 第 %d 次失败，%ds 后重试: %s",
                        attempt + 1, wait, e,
                    )
                    time.sleep(wait)
                else:
                    self._report_call_result(
                        success=False,
                        latency_seconds=time.monotonic() - _start,
                        error_message=str(e)[:500],
                    )
                    raise RuntimeError(
                        f"MiniMax Music 生成失败（已重试 {self.max_retries} 次）: {e}"
                    ) from e

        raw_duration = self.measure_duration(raw_path)
        if raw_duration <= 0:
            self._report_call_result(
                success=False,
                latency_seconds=time.monotonic() - _start,
                error_message="MiniMax Music 返回空音频",
            )
            raise RuntimeError("MiniMax Music 返回空音频")

        final_path = os.path.join(output_dir, f"{request_id}.wav")
        if abs(raw_duration - target_duration) > 2.0:
            self.loop_to_duration(raw_path, final_path, target_duration)
        else:
            final_path = raw_path

        measured_duration = self.measure_duration(final_path)

        sections = self._estimate_sections(measured_duration, lyrics)

        self._report_call_result(
            success=True, latency_seconds=time.monotonic() - _start,
        )

        logger.info(
            "MiniMax Music 完成: raw=%.1fs, final=%.1fs, target=%.1fs, path=%s",
            raw_duration, measured_duration, target_duration, final_path,
        )

        return MusicResult(
            audio_path=final_path,
            measured_duration=measured_duration,
            bpm=bpm or 0.0,
            sections=sections,
            sample_rate=44100,
            raw_metadata={
                "request_id": request_id,
                "prompt": final_prompt,
                "raw_duration": raw_duration,
                "model": self.model,
            },
        )

    def _call_api(self, prompt: str, lyrics: str, output_path: str) -> str:
        """调用 MiniMax music_generation API"""
        payload = {
            "model": self.model,
            "prompt": prompt,
            "lyrics": lyrics,
            "audio_setting": {
                "sample_rate": 44100,
                "bitrate": 256000,
                "format": "wav",
            },
        }

        response = requests.post(
            self.api_url,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.api_key}",
            },
            json=payload,
            timeout=self.timeout_seconds,
        )

        if response.status_code != 200:
            raise RuntimeError(
                f"MiniMax API 返回 {response.status_code}: {response.text[:500]}"
            )

        data = response.json()

        audio_data = self._extract_audio(data)
        with open(output_path, "wb") as f:
            f.write(audio_data)

        return output_path

    def _extract_audio(self, data: dict) -> bytes:
        """
        从 API 响应中提取音频数据。

        MiniMax 返回格式：
          - data.audio_hex: hex 编码的音频二进制
          - 或 data.audio_url: 下载链接
        """
        if "data" in data and isinstance(data["data"], dict):
            inner = data["data"]
            audio_hex = inner.get("audio_hex") or inner.get("audio")
            if audio_hex and isinstance(audio_hex, str):
                return bytes.fromhex(audio_hex)

            audio_url = inner.get("audio_url")
            if audio_url:
                resp = requests.get(audio_url, timeout=60)
                resp.raise_for_status()
                return resp.content

        audio_hex = data.get("audio_hex") or data.get("audio")
        if audio_hex and isinstance(audio_hex, str):
            return bytes.fromhex(audio_hex)

        audio_url = data.get("audio_url")
        if audio_url:
            resp = requests.get(audio_url, timeout=60)
            resp.raise_for_status()
            return resp.content

        raise RuntimeError(
            f"MiniMax 响应中未找到音频数据: {json.dumps(data, ensure_ascii=False)[:500]}"
        )

    @staticmethod
    def _estimate_sections(duration: float, lyrics: str) -> list[MusicSection]:
        """
        根据 lyrics 结构标签估算各段时间位置。
        不是精确的，仅供 Orchestrator 做粗粒度参考。
        """
        tags = []
        for line in lyrics.split("\n"):
            line = line.strip()
            if line.startswith("[") and line.endswith("]"):
                tag = line[1:-1].lower().replace(" ", "_")
                if tag != "inst":
                    tags.append(tag)

        if not tags:
            return [MusicSection(type="verse", start=0, end=duration, energy=0.5)]

        section_dur = duration / len(tags)
        energy_map = {
            "intro": 0.3, "verse": 0.5, "build_up": 0.7,
            "chorus": 0.9, "drop": 1.0, "bridge": 0.6, "outro": 0.3,
        }

        sections = []
        for i, tag in enumerate(tags):
            sections.append(MusicSection(
                type=tag.replace("_", "-") if tag in ("build_up",) else tag,
                start=round(i * section_dur, 2),
                end=round((i + 1) * section_dur, 2),
                energy=energy_map.get(tag, 0.5),
            ))

        return sections


# 向后兼容别名
MiniMaxBGMService = MiniMaxMusicService
