"""
fal.ai 图片生成服务

支持模型（通过 LLMModel 配置）：
- fal-ai/flux/dev, fal-ai/flux/schnell, fal-ai/flux-pro
- fal-ai/stable-diffusion-xl, fal-ai/recraft-v3 等

API 模式：异步队列（submit → poll status → fetch result）
认证: Authorization: Key {FAL_KEY}
"""

import logging
from typing import Any, Dict, List

from ..fal_base import BaseFalService
from ..base import MediaRequest, SubmitResult

logger = logging.getLogger(__name__)


class FalImageService(BaseFalService):
    """fal.ai 图片生成服务"""

    @property
    def _media_type(self) -> str:
        return "Image"

    def submit_task(self, request: MediaRequest) -> SubmitResult:
        model_path = self._model_path(request.model_name)

        body: Dict[str, Any] = {"prompt": request.prompt}

        if request.negative_prompt:
            body["negative_prompt"] = request.negative_prompt

        if request.size:
            parsed = self._parse_size(request.size)
            if parsed:
                body["image_size"] = parsed

        extra = request.extra_params or {}
        n = extra.get("n", 1)
        if n and n > 1:
            body["num_images"] = n

        if request.seed is not None:
            body["seed"] = request.seed

        for key in ("num_inference_steps", "guidance_scale", "output_format",
                     "aspect_ratio", "style"):
            if key in extra:
                body[key] = extra[key]

        if request.input_image_url:
            body["image_url"] = request.input_image_url

        logger.info(
            "[fal Image] 提交任务: model=%s, prompt=%s",
            model_path, request.prompt[:80],
        )

        return self._submit_to_queue(model_path, body, "fal Image")

    def _extract_result_urls(self, data: Dict[str, Any]) -> List[str]:
        images = data.get("images", [])
        return [img["url"] for img in images if img.get("url")]

    def _enrich_metadata(self, data: Dict[str, Any], metadata: Dict[str, Any]) -> None:
        if data.get("prompt"):
            metadata["revised_prompt"] = data["prompt"]
        if data.get("has_nsfw_concepts") is not None:
            metadata["has_nsfw_concepts"] = data["has_nsfw_concepts"]
