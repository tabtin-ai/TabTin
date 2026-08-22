"""
Replicate 图片生成服务

支持模型（通过 LLMModel 配置）：
- black-forest-labs/flux-schnell, black-forest-labs/flux-1.1-pro
- stability-ai/sdxl, stability-ai/stable-diffusion-3
- recraft-ai/recraft-v3 等

API 模式：异步预测（create prediction → poll → get result）
认证: Authorization: Bearer {REPLICATE_API_TOKEN}
"""

import logging
from typing import Any, Dict, List

from ..replicate_base import BaseReplicateService
from ..base import MediaRequest, SubmitResult

logger = logging.getLogger(__name__)


class ReplicateImageService(BaseReplicateService):
    """Replicate 图片生成服务"""

    @property
    def _media_type(self) -> str:
        return "Image"

    def submit_task(self, request: MediaRequest) -> SubmitResult:
        input_data: Dict[str, Any] = {"prompt": request.prompt}

        if request.negative_prompt:
            input_data["negative_prompt"] = request.negative_prompt

        if request.size:
            parsed = self._parse_aspect_ratio(request.size)
            if ":" in parsed:
                input_data["aspect_ratio"] = parsed
            else:
                input_data["width"], input_data["height"] = self._parse_dimensions(request.size)

        if request.seed is not None:
            input_data["seed"] = request.seed

        extra = request.extra_params or {}
        n = extra.get("n", 1)
        if n and n > 1:
            input_data["num_outputs"] = n

        for key in ("num_inference_steps", "guidance_scale", "guidance",
                     "output_format", "output_quality", "steps"):
            if key in extra:
                input_data[key] = extra[key]

        if request.input_image_url:
            input_data["image"] = request.input_image_url

        logger.info(
            "[Replicate Image] 提交任务: model=%s, prompt=%s",
            request.model_name, request.prompt[:80],
        )

        return self._submit_prediction(
            request.model_name, input_data, extra, "Replicate Image",
        )

    def _extract_result_urls(self, output: Any) -> List[str]:
        return self._extract_urls_from_output(output)
