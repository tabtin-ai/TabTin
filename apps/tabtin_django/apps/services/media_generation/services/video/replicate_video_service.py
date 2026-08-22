"""
Replicate 视频生成服务

支持模型（通过 LLMModel 配置）：
- bytedance/seedance-1-pro (文生视频 / 图生视频)
- minimax/video-01 (文生视频)
- tencent/hunyuan-video (文生视频)
- luma/ray (文生视频 / 图生视频) 等

API 模式：异步预测（create prediction → poll → get result）
认证: Authorization: Bearer {REPLICATE_API_TOKEN}
"""

import logging
from typing import Any, Dict, List

from ..replicate_base import BaseReplicateService
from ..base import MediaRequest, SubmitResult

logger = logging.getLogger(__name__)


class ReplicateVideoService(BaseReplicateService):
    """Replicate 视频生成服务"""

    @property
    def _media_type(self) -> str:
        return "Video"

    def submit_task(self, request: MediaRequest) -> SubmitResult:
        input_data: Dict[str, Any] = {"prompt": request.prompt}

        if request.negative_prompt:
            input_data["negative_prompt"] = request.negative_prompt

        if request.input_image_url:
            input_data["image"] = request.input_image_url
            if "first_frame_image" not in input_data:
                input_data["first_frame_image"] = request.input_image_url

        if request.input_audio_url:
            input_data["audio"] = request.input_audio_url

        if request.duration and request.duration > 0:
            input_data["duration"] = request.duration

        if request.size:
            input_data["aspect_ratio"] = self._parse_aspect_ratio(request.size)

        if request.seed is not None:
            input_data["seed"] = request.seed

        extra = request.extra_params or {}
        for key in ("num_inference_steps", "guidance_scale", "resolution",
                     "fps", "output_format", "aspect_ratio"):
            if key in extra:
                input_data[key] = extra[key]

        logger.info(
            "[Replicate Video] 提交任务: model=%s, type=%s, prompt=%s",
            request.model_name, request.task_type, request.prompt[:80],
        )

        return self._submit_prediction(
            request.model_name, input_data, extra, "Replicate Video",
        )

    def _extract_result_urls(self, output: Any) -> List[str]:
        return self._extract_urls_from_output(output)
