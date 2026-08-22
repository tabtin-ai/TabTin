"""
fal.ai 视频生成服务

支持模型（通过 LLMModel 配置）：
- fal-ai/kling-video/v1/standard, fal-ai/kling-video/v1/pro
- fal-ai/luma-dream-machine, fal-ai/minimax-video
- fal-ai/magi/image-to-video, fal-ai/ltx-2/image-to-video 等

API 模式：异步队列（submit → poll status → fetch result）
认证: Authorization: Key {FAL_KEY}
"""

import logging
from typing import Any, Dict, List

from ..fal_base import BaseFalService
from ..base import MediaRequest, SubmitResult

logger = logging.getLogger(__name__)


class FalVideoService(BaseFalService):
    """fal.ai 视频生成服务"""

    @property
    def _media_type(self) -> str:
        return "Video"

    def submit_task(self, request: MediaRequest) -> SubmitResult:
        model_path = self._model_path(request.model_name)

        body: Dict[str, Any] = {"prompt": request.prompt}

        if request.negative_prompt:
            body["negative_prompt"] = request.negative_prompt

        if request.input_image_url:
            body["image_url"] = request.input_image_url

        if request.input_audio_url:
            body["audio_url"] = request.input_audio_url

        if request.duration and request.duration > 0:
            body["duration"] = request.duration

        if request.size:
            body["aspect_ratio"] = self._parse_aspect_ratio(request.size)

        if request.seed is not None:
            body["seed"] = request.seed

        extra = request.extra_params or {}
        for key in ("aspect_ratio", "resolution", "num_inference_steps",
                     "guidance_scale", "output_format", "fps"):
            if key in extra:
                body[key] = extra[key]

        logger.info(
            "[fal Video] 提交任务: model=%s, type=%s, prompt=%s",
            model_path, request.task_type, request.prompt[:80],
        )

        return self._submit_to_queue(model_path, body, "fal Video")

    def _extract_result_urls(self, data: Dict[str, Any]) -> List[str]:
        result_urls = []
        if data.get("video", {}).get("url"):
            result_urls.append(data["video"]["url"])
        elif data.get("video_url"):
            result_urls.append(data["video_url"])
        return result_urls

    def _enrich_metadata(self, data: Dict[str, Any], metadata: Dict[str, Any]) -> None:
        video_meta = data.get("video", {})
        if video_meta.get("duration"):
            metadata["task_metrics"] = {"duration": video_meta["duration"]}
