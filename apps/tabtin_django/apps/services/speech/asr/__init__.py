"""
ASR (Automatic Speech Recognition) 服务

Usage:
    from apps.services.speech.asr import get_asr_service

    # 极速版（≤2h，同步返回）
    svc = get_asr_service(provider="bytedance", mode="flash")
    result = svc.recognize(audio_url="https://...")

    # 标准版（≤5h，异步 submit/query）
    svc = get_asr_service(provider="bytedance", mode="standard")
    task_id = svc.submit(audio_url="https://...")
    result = svc.query(task_id)

    # 流式版（WebSocket）
    svc = get_asr_service(provider="bytedance", mode="streaming")
    async for partial in svc.stream(audio_data):
        print(partial.text)
"""

from .base import BaseASRService
from .types import ASRResult, ASRUtterance, ASRWord
from .factory import get_asr_service, ASRServiceFactory, ASRConfigError, ASRUpstreamError

__all__ = [
    "BaseASRService",
    "ASRResult",
    "ASRUtterance",
    "ASRWord",
    "get_asr_service",
    "ASRServiceFactory",
    "ASRConfigError",
    "ASRUpstreamError",
]
