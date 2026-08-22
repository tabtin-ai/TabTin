"""
字节跳动 / 火山引擎 ASR Provider

支持三种模式：
  - flash: 极速版（单次 HTTP，≤2h，≤100MB）
  - standard: 标准版（submit + query 轮询，≤5h，≤512MB）
  - streaming: 流式版（WebSocket 二进制协议，实时 / 流式输入）
"""

from .flash import ByteDanceFlashASR
from .standard import ByteDanceStandardASR
from .streaming import ByteDanceStreamingASR

__all__ = [
    "ByteDanceFlashASR",
    "ByteDanceStandardASR",
    "ByteDanceStreamingASR",
]
