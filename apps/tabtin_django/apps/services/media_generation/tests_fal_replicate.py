"""
fal.ai / Replicate 媒体生成服务单元测试

测试 4 个新 Provider 的 submit_task / poll_task / cancel_task，
所有 HTTP 调用通过 mock 注入。
"""

from django.test import TestCase
from unittest.mock import patch, MagicMock
from types import SimpleNamespace

from apps.services.media_generation.services.base import MediaRequest
from apps.services.media_generation.errors import MediaErrorCode, MediaServiceError

_FAL_REQUESTS = "apps.services.media_generation.services.fal_base.requests"
_REPLICATE_REQUESTS = "apps.services.media_generation.services.replicate_base.requests"
_VOLCENGINE_REQUESTS = (
    "apps.services.media_generation.services.image.volcengine_image_service.requests"
)


def _base_config(**overrides):
    cfg = {
        "name": overrides.pop("name", "test"),
        "api_key": "test-key",
        "base_url": overrides.pop("base_url", ""),
        "provider_obj": None,
        "model_obj": None,
    }
    cfg.update(overrides)
    return cfg


def _image_request(**kw):
    defaults = {
        "task_type": "text2image",
        "prompt": "a sunset over mountains",
        "model_name": "fal-ai/flux/dev",
    }
    defaults.update(kw)
    return MediaRequest(**defaults)


def _video_request(**kw):
    defaults = {
        "task_type": "text2video",
        "prompt": "ocean waves at sunset",
        "model_name": "fal-ai/kling-video/v1/standard",
        "duration": 5,
    }
    defaults.update(kw)
    return MediaRequest(**defaults)


# ──────────────────────────────────────────────────────────
# fal.ai Image
# ──────────────────────────────────────────────────────────

class FalImageServiceSubmitTest(TestCase):

    @patch(f"{_FAL_REQUESTS}.post")
    def test_submit_success(self, mock_post):
        from apps.services.media_generation.services.image.fal_image_service import FalImageService

        mock_post.return_value = MagicMock(
            status_code=200,
            json=lambda: {
                "request_id": "req-abc-123",
                "status_url": "https://queue.fal.run/fal-ai/flux/dev/requests/req-abc-123/status",
                "response_url": "https://queue.fal.run/fal-ai/flux/dev/requests/req-abc-123",
                "cancel_url": "https://queue.fal.run/fal-ai/flux/dev/requests/req-abc-123/cancel",
            },
        )

        service = FalImageService(_base_config(name="fal", base_url="https://queue.fal.run"))
        result = service.submit_task(_image_request())

        self.assertEqual(result.provider_task_id, "req-abc-123")
        self.assertEqual(result.status, "pending")
        self.assertEqual(result.metadata["model_path"], "fal-ai/flux/dev")

        call_args = mock_post.call_args
        self.assertIn("fal-ai/flux/dev", call_args[0][0])
        self.assertIn("Key test-key", call_args[1]["headers"]["Authorization"])

    @patch(f"{_FAL_REQUESTS}.post")
    def test_submit_auth_failure(self, mock_post):
        from apps.services.media_generation.services.image.fal_image_service import FalImageService

        mock_post.return_value = MagicMock(
            status_code=401,
            json=lambda: {"detail": "Invalid API key"},
            text="Invalid API key",
        )

        service = FalImageService(_base_config(name="fal", base_url="https://queue.fal.run"))
        with self.assertRaises(MediaServiceError) as ctx:
            service.submit_task(_image_request())

        self.assertEqual(ctx.exception.code, MediaErrorCode.AUTH_FAILED)

    @patch(f"{_FAL_REQUESTS}.post")
    def test_submit_includes_size(self, mock_post):
        from apps.services.media_generation.services.image.fal_image_service import FalImageService

        mock_post.return_value = MagicMock(
            status_code=200,
            json=lambda: {"request_id": "req-1"},
        )

        service = FalImageService(_base_config(name="fal", base_url="https://queue.fal.run"))
        service.submit_task(_image_request(size="1024*1024"))

        body = mock_post.call_args[1]["json"]
        self.assertEqual(body["image_size"], {"width": 1024, "height": 1024})


class FalImageServicePollTest(TestCase):

    @patch(f"{_FAL_REQUESTS}.get")
    def test_poll_in_progress(self, mock_get):
        from apps.services.media_generation.services.image.fal_image_service import FalImageService

        mock_get.return_value = MagicMock(
            status_code=200,
            json=lambda: {"status": "IN_PROGRESS", "request_id": "req-1"},
        )

        model_obj = MagicMock()
        model_obj.model_name = "fal-ai/flux/dev"
        service = FalImageService(_base_config(name="fal", base_url="https://queue.fal.run", model_obj=model_obj))
        result = service.poll_task("req-1")

        self.assertEqual(result.status, "running")
        self.assertEqual(result.result_urls, [])

    @patch(f"{_FAL_REQUESTS}.get")
    def test_poll_completed_fetches_result(self, mock_get):
        from apps.services.media_generation.services.image.fal_image_service import FalImageService

        status_resp = MagicMock(
            status_code=200,
            json=lambda: {"status": "COMPLETED", "metrics": {"inference_time": 2.5}},
        )
        result_resp = MagicMock(
            status_code=200,
            json=lambda: {
                "images": [
                    {"url": "https://fal-cdn.net/img1.png"},
                    {"url": "https://fal-cdn.net/img2.png"},
                ],
                "seed": 42,
            },
        )
        mock_get.side_effect = [status_resp, result_resp]

        model_obj = MagicMock()
        model_obj.model_name = "fal-ai/flux/dev"
        service = FalImageService(_base_config(name="fal", base_url="https://queue.fal.run", model_obj=model_obj))
        result = service.poll_task("req-1")

        self.assertEqual(result.status, "succeeded")
        self.assertEqual(len(result.result_urls), 2)
        self.assertEqual(result.metadata["seed"], 42)


# ──────────────────────────────────────────────────────────
# fal.ai Video
# ──────────────────────────────────────────────────────────

class FalVideoServiceSubmitTest(TestCase):

    @patch(f"{_FAL_REQUESTS}.post")
    def test_submit_success(self, mock_post):
        from apps.services.media_generation.services.video.fal_video_service import FalVideoService

        mock_post.return_value = MagicMock(
            status_code=200,
            json=lambda: {
                "request_id": "vid-req-456",
                "status_url": "https://queue.fal.run/.../status",
            },
        )

        service = FalVideoService(_base_config(name="fal", base_url="https://queue.fal.run"))
        result = service.submit_task(_video_request())

        self.assertEqual(result.provider_task_id, "vid-req-456")

        body = mock_post.call_args[1]["json"]
        self.assertEqual(body["prompt"], "ocean waves at sunset")
        self.assertEqual(body["duration"], 5)

    @patch(f"{_FAL_REQUESTS}.post")
    def test_submit_with_image_url(self, mock_post):
        from apps.services.media_generation.services.video.fal_video_service import FalVideoService

        mock_post.return_value = MagicMock(
            status_code=200,
            json=lambda: {"request_id": "vid-2"},
        )

        service = FalVideoService(_base_config(name="fal", base_url="https://queue.fal.run"))
        service.submit_task(_video_request(
            task_type="image2video",
            input_image_url="https://example.com/first-frame.png",
        ))

        body = mock_post.call_args[1]["json"]
        self.assertEqual(body["image_url"], "https://example.com/first-frame.png")


class FalVideoServicePollTest(TestCase):

    @patch(f"{_FAL_REQUESTS}.get")
    def test_poll_completed(self, mock_get):
        from apps.services.media_generation.services.video.fal_video_service import FalVideoService

        status_resp = MagicMock(
            status_code=200,
            json=lambda: {"status": "COMPLETED", "metrics": {"inference_time": 45.0}},
        )
        result_resp = MagicMock(
            status_code=200,
            json=lambda: {
                "video": {"url": "https://fal-cdn.net/video.mp4", "duration": 5},
            },
        )
        mock_get.side_effect = [status_resp, result_resp]

        model_obj = MagicMock()
        model_obj.model_name = "fal-ai/kling-video/v1/standard"
        service = FalVideoService(_base_config(name="fal", base_url="https://queue.fal.run", model_obj=model_obj))
        result = service.poll_task("vid-req-456")

        self.assertEqual(result.status, "succeeded")
        self.assertEqual(result.result_urls, ["https://fal-cdn.net/video.mp4"])
        self.assertEqual(result.metadata["task_metrics"]["duration"], 5)


# ──────────────────────────────────────────────────────────
# Replicate Image
# ──────────────────────────────────────────────────────────

class ReplicateImageServiceSubmitTest(TestCase):

    @patch(f"{_REPLICATE_REQUESTS}.post")
    def test_submit_official_model(self, mock_post):
        from apps.services.media_generation.services.image.replicate_image_service import ReplicateImageService

        mock_post.return_value = MagicMock(
            status_code=201,
            json=lambda: {
                "id": "pred-abc-123",
                "status": "starting",
                "urls": {
                    "get": "https://api.replicate.com/v1/predictions/pred-abc-123",
                    "cancel": "https://api.replicate.com/v1/predictions/pred-abc-123/cancel",
                },
            },
        )

        service = ReplicateImageService(_base_config(
            name="replicate", base_url="https://api.replicate.com/v1",
        ))
        result = service.submit_task(_image_request(model_name="black-forest-labs/flux-schnell"))

        self.assertEqual(result.provider_task_id, "pred-abc-123")
        self.assertEqual(result.status, "pending")

        url = mock_post.call_args[0][0]
        self.assertIn("models/black-forest-labs/flux-schnell/predictions", url)
        headers = mock_post.call_args[1]["headers"]
        self.assertIn("Bearer test-key", headers["Authorization"])

    @patch(f"{_REPLICATE_REQUESTS}.post")
    def test_submit_community_model_with_version(self, mock_post):
        from apps.services.media_generation.services.image.replicate_image_service import ReplicateImageService

        mock_post.return_value = MagicMock(
            status_code=201,
            json=lambda: {"id": "pred-2", "status": "starting", "urls": {}},
        )

        model_obj = MagicMock()
        model_obj.model_name = "stability-ai/sdxl"
        model_obj.capabilities_config = {"version": "abc123def456"}

        service = ReplicateImageService(_base_config(
            name="replicate",
            base_url="https://api.replicate.com/v1",
            model_obj=model_obj,
        ))
        service.submit_task(_image_request(model_name="stability-ai/sdxl"))

        url = mock_post.call_args[0][0]
        self.assertTrue(url.endswith("/predictions"))
        body = mock_post.call_args[1]["json"]
        self.assertEqual(body["version"], "abc123def456")

    @patch(f"{_REPLICATE_REQUESTS}.post")
    def test_submit_model_not_found(self, mock_post):
        from apps.services.media_generation.services.image.replicate_image_service import ReplicateImageService

        mock_post.return_value = MagicMock(
            status_code=404,
            json=lambda: {"detail": "Model not found"},
            text="Model not found",
        )

        service = ReplicateImageService(_base_config(
            name="replicate", base_url="https://api.replicate.com/v1",
        ))
        with self.assertRaises(MediaServiceError) as ctx:
            service.submit_task(_image_request(model_name="nonexistent/model"))

        self.assertEqual(ctx.exception.code, MediaErrorCode.MODEL_NOT_FOUND)


class ReplicateImageServicePollTest(TestCase):

    @patch(f"{_REPLICATE_REQUESTS}.get")
    def test_poll_processing(self, mock_get):
        from apps.services.media_generation.services.image.replicate_image_service import ReplicateImageService

        mock_get.return_value = MagicMock(
            status_code=200,
            json=lambda: {"status": "processing", "output": None},
        )

        service = ReplicateImageService(_base_config(
            name="replicate", base_url="https://api.replicate.com/v1",
        ))
        result = service.poll_task("pred-1")

        self.assertEqual(result.status, "running")

    @patch(f"{_REPLICATE_REQUESTS}.get")
    def test_poll_succeeded(self, mock_get):
        from apps.services.media_generation.services.image.replicate_image_service import ReplicateImageService

        mock_get.return_value = MagicMock(
            status_code=200,
            json=lambda: {
                "status": "succeeded",
                "output": [
                    "https://replicate.delivery/img1.png",
                    "https://replicate.delivery/img2.png",
                ],
                "metrics": {"predict_time": 3.2, "total_time": 5.0},
            },
        )

        service = ReplicateImageService(_base_config(
            name="replicate", base_url="https://api.replicate.com/v1",
        ))
        result = service.poll_task("pred-1")

        self.assertEqual(result.status, "succeeded")
        self.assertEqual(len(result.result_urls), 2)
        self.assertEqual(result.result_urls[0], "https://replicate.delivery/img1.png")

    @patch(f"{_REPLICATE_REQUESTS}.get")
    def test_poll_failed(self, mock_get):
        from apps.services.media_generation.services.image.replicate_image_service import ReplicateImageService

        mock_get.return_value = MagicMock(
            status_code=200,
            json=lambda: {
                "status": "failed",
                "error": "NSFW content detected",
            },
        )

        service = ReplicateImageService(_base_config(
            name="replicate", base_url="https://api.replicate.com/v1",
        ))
        result = service.poll_task("pred-1")

        self.assertEqual(result.status, "failed")
        self.assertIn("NSFW", result.error_message)

    @patch(f"{_REPLICATE_REQUESTS}.post")
    def test_cancel(self, mock_post):
        from apps.services.media_generation.services.image.replicate_image_service import ReplicateImageService

        mock_post.return_value = MagicMock(status_code=200)

        service = ReplicateImageService(_base_config(
            name="replicate", base_url="https://api.replicate.com/v1",
        ))
        ok = service.cancel_task("pred-1")

        self.assertTrue(ok)
        self.assertIn("cancel", mock_post.call_args[0][0])


# ──────────────────────────────────────────────────────────
# Replicate Video
# ──────────────────────────────────────────────────────────

class ReplicateVideoServiceSubmitTest(TestCase):

    @patch(f"{_REPLICATE_REQUESTS}.post")
    def test_submit_success(self, mock_post):
        from apps.services.media_generation.services.video.replicate_video_service import ReplicateVideoService

        mock_post.return_value = MagicMock(
            status_code=201,
            json=lambda: {
                "id": "vidpred-789",
                "status": "starting",
                "urls": {
                    "get": "https://api.replicate.com/v1/predictions/vidpred-789",
                    "cancel": "https://api.replicate.com/v1/predictions/vidpred-789/cancel",
                },
            },
        )

        service = ReplicateVideoService(_base_config(
            name="replicate", base_url="https://api.replicate.com/v1",
        ))
        result = service.submit_task(_video_request(model_name="bytedance/seedance-1-pro"))

        self.assertEqual(result.provider_task_id, "vidpred-789")

        body = mock_post.call_args[1]["json"]
        self.assertEqual(body["input"]["prompt"], "ocean waves at sunset")
        self.assertEqual(body["input"]["duration"], 5)

    @patch(f"{_REPLICATE_REQUESTS}.post")
    def test_submit_with_image(self, mock_post):
        from apps.services.media_generation.services.video.replicate_video_service import ReplicateVideoService

        mock_post.return_value = MagicMock(
            status_code=201,
            json=lambda: {"id": "vidpred-2", "status": "starting", "urls": {}},
        )

        service = ReplicateVideoService(_base_config(
            name="replicate", base_url="https://api.replicate.com/v1",
        ))
        service.submit_task(_video_request(
            task_type="image2video",
            model_name="luma/ray",
            input_image_url="https://example.com/frame.jpg",
        ))

        body = mock_post.call_args[1]["json"]
        self.assertEqual(body["input"]["image"], "https://example.com/frame.jpg")
        self.assertEqual(body["input"]["first_frame_image"], "https://example.com/frame.jpg")


class ReplicateVideoServicePollTest(TestCase):

    @patch(f"{_REPLICATE_REQUESTS}.get")
    def test_poll_succeeded_single_url(self, mock_get):
        from apps.services.media_generation.services.video.replicate_video_service import ReplicateVideoService

        mock_get.return_value = MagicMock(
            status_code=200,
            json=lambda: {
                "status": "succeeded",
                "output": "https://replicate.delivery/video.mp4",
                "metrics": {"predict_time": 120.5},
            },
        )

        service = ReplicateVideoService(_base_config(
            name="replicate", base_url="https://api.replicate.com/v1",
        ))
        result = service.poll_task("vidpred-789")

        self.assertEqual(result.status, "succeeded")
        self.assertEqual(result.result_urls, ["https://replicate.delivery/video.mp4"])

    @patch(f"{_REPLICATE_REQUESTS}.get")
    def test_poll_succeeded_list_output(self, mock_get):
        from apps.services.media_generation.services.video.replicate_video_service import ReplicateVideoService

        mock_get.return_value = MagicMock(
            status_code=200,
            json=lambda: {
                "status": "succeeded",
                "output": ["https://replicate.delivery/v1.mp4", "https://replicate.delivery/v2.mp4"],
                "metrics": {"predict_time": 60.0},
            },
        )

        service = ReplicateVideoService(_base_config(
            name="replicate", base_url="https://api.replicate.com/v1",
        ))
        result = service.poll_task("vidpred-2")

        self.assertEqual(result.status, "succeeded")
        self.assertEqual(len(result.result_urls), 2)

    @patch(f"{_REPLICATE_REQUESTS}.get")
    def test_poll_canceled(self, mock_get):
        from apps.services.media_generation.services.video.replicate_video_service import ReplicateVideoService

        mock_get.return_value = MagicMock(
            status_code=200,
            json=lambda: {"status": "canceled"},
        )

        service = ReplicateVideoService(_base_config(
            name="replicate", base_url="https://api.replicate.com/v1",
        ))
        result = service.poll_task("vidpred-3")

        self.assertEqual(result.status, "cancelled")


# ──────────────────────────────────────────────────────────
# Factory integration
# ──────────────────────────────────────────────────────────

class FactoryServiceMapTest(TestCase):

    def test_service_map_has_all_providers(self):
        from apps.services.media_generation.services.factory import SERVICE_MAP
        from apps.services.media_generation.services.image.fal_image_service import FalImageService
        from apps.services.media_generation.services.video.fal_video_service import FalVideoService
        from apps.services.media_generation.services.image.replicate_image_service import ReplicateImageService
        from apps.services.media_generation.services.video.replicate_video_service import ReplicateVideoService
        from apps.services.media_generation.services.image.volcengine_image_service import VolcengineImageService

        self.assertIs(SERVICE_MAP[("fal", "image")], FalImageService)
        self.assertIs(SERVICE_MAP[("fal", "video")], FalVideoService)
        self.assertIs(SERVICE_MAP[("replicate", "image")], ReplicateImageService)
        self.assertIs(SERVICE_MAP[("replicate", "video")], ReplicateVideoService)
        self.assertIs(SERVICE_MAP[("volcengine", "image")], VolcengineImageService)

    def test_all_services_extend_base(self):
        from apps.services.media_generation.services.factory import SERVICE_MAP
        from apps.services.media_generation.services.base import BaseMediaService

        for key, cls in SERVICE_MAP.items():
            self.assertTrue(
                issubclass(cls, BaseMediaService),
                f"{key} -> {cls.__name__} should extend BaseMediaService",
            )

    def test_model_name_uuid_resolves_as_model_id(self):
        """Agent 把 catalog id 塞进 --model 时，能力层会写成 model_name=UUID。"""
        from apps.services.llm.models import LLMModel, LLMProvider
        from apps.services.media_generation.services.factory import get_media_service
        from apps.services.media_generation.services.image.volcengine_image_service import (
            VolcengineImageService,
        )

        provider = LLMProvider.objects.create(
            name="volcengine",
            provider_key="volcengine-uuid-test",
            display_name="Volcengine UUID Test",
            capability_domains=["image_gen"],
            routing_enabled=True,
        )
        model = LLMModel.objects.create(
            provider=provider,
            model_name="doubao-seedream-uuid-probe",
            display_name="UUID Probe",
            base_url="https://ark.example.test/api/v3",
            capability_domain="image_gen",
            context_window_tokens=1,
            capabilities_config={"default_task_type": "text2image", "media_gen": {}},
        )

        service = get_media_service(model_name=str(model.id), task_type="text2image")

        self.assertIsInstance(service, VolcengineImageService)
        self.assertEqual(str(service.model_obj.id), str(model.id))
        self.assertEqual(service.model_obj.model_name, "doubao-seedream-uuid-probe")


class SceneBoundMediaFactoryTest(TestCase):

    def setUp(self):
        from apps.services.llm.models import LLMModel, LLMProvider, LLMSceneBinding

        provider = LLMProvider.objects.create(
            name="volcengine",
            provider_key="volcengine-scene-routing-test",
            display_name="Volcengine Scene Routing Test",
            capability_domains=["image_gen"],
            routing_enabled=True,
            priority=100,
        )
        self.bound_model = LLMModel.objects.create(
            provider=provider,
            model_name="doubao-seedream-4-5-scene-test",
            display_name="Doubao Seedream 4.5 Scene Test",
            base_url="https://ark.example.test/api/v3",
            capability_domain="image_gen",
            context_window_tokens=1,
            capabilities_config={"default_task_type": "text2image", "media_gen": {}},
        )
        self.unbound_model = LLMModel.objects.create(
            provider=provider,
            model_name="doubao-seedream-5-0-pro-scene-test",
            display_name="Doubao Seedream 5.0 Pro Scene Test",
            base_url="https://ark.example.test/api/v3",
            capability_domain="image_gen",
            context_window_tokens=1,
            capabilities_config={
                "default_task_type": "text2image",
                "default_for_task_type": True,
                "media_gen": {},
            },
        )
        LLMSceneBinding.objects.update_or_create(
            scene_key="media_image_generate",
            defaults={
                "display_name": "文生图 / 图生图",
                "capability_domain": "image_gen",
                "primary_model": self.bound_model,
                "fallback_models": [],
            },
        )

    def test_default_image_generation_uses_scene_primary_model(self):
        from apps.services.media_generation.services.factory import get_media_service

        service = get_media_service(
            task_type="text2image",
            scene_key="media_image_generate",
        )

        self.assertEqual(service.model_obj.id, self.bound_model.id)

    def test_explicit_unbound_model_is_rejected(self):
        from apps.services.media_generation.services.factory import get_media_service

        with self.assertRaises(MediaServiceError) as ctx:
            get_media_service(
                model_name=self.unbound_model.model_name,
                task_type="text2image",
                scene_key="media_image_generate",
            )

        self.assertEqual(ctx.exception.code, MediaErrorCode.MODEL_NOT_FOUND)
        self.assertIn("media_image_generate", str(ctx.exception))

    def test_explicit_bound_model_is_allowed(self):
        from apps.services.media_generation.services.factory import get_media_service

        service = get_media_service(
            model_name=self.bound_model.model_name,
            task_type="text2image",
            scene_key="media_image_generate",
        )

        self.assertEqual(service.model_obj.id, self.bound_model.id)


class GenerateImageRequestAliasTest(TestCase):

    def test_accepts_legacy_model_field(self):
        from apps.services.media_generation.schemas import GenerateImageRequest

        payload = GenerateImageRequest.model_validate(
            {
                "prompt": "a lake",
                "model": "doubao-seedream-5-0-pro-260628",
                "organization_id": "org-1",
            }
        )

        self.assertEqual(payload.model_name, "doubao-seedream-5-0-pro-260628")
        self.assertIsNone(payload.model_id)

    def test_accepts_model_name_keyword(self):
        from apps.services.media_generation.schemas import GenerateImageRequest

        payload = GenerateImageRequest(
            prompt="a lake",
            model_name="doubao-seedream-4-0-250828",
            organization_id="org-1",
        )

        self.assertEqual(payload.model_name, "doubao-seedream-4-0-250828")


# ──────────────────────────────────────────────────────────
# Volcengine Seedream Image
# ──────────────────────────────────────────────────────────

class VolcengineImageServiceTest(TestCase):

    @staticmethod
    def _service(*, min_pixels: int = 0):
        from apps.services.media_generation.services.image.volcengine_image_service import VolcengineImageService

        return VolcengineImageService(_base_config(
            name="volcengine",
            base_url="https://ark.cn-beijing.volces.com/api/v3",
            model_obj=SimpleNamespace(
                capabilities_config={"media_gen": {"min_pixels": min_pixels}},
            ),
        ))

    @patch(f"{_VOLCENGINE_REQUESTS}.post")
    def test_submit_returns_synchronous_result_urls(self, mock_post):
        mock_post.return_value = MagicMock(
            status_code=200,
            json=lambda: {
                "id": "ark-request-1",
                "data": [{"url": "https://ark.example.test/image.png"}],
            },
        )

        result = self._service().submit_task(_image_request(
            model_name="doubao-seedream-4-0-250828",
            size="1024*1024",
        ))

        self.assertEqual(result.status, "succeeded")
        self.assertEqual(result.provider_task_id, "ark-request-1")
        self.assertEqual(result.metadata["result_urls"], ["https://ark.example.test/image.png"])
        body = mock_post.call_args.kwargs["json"]
        self.assertEqual(body["size"], "1024x1024")
        self.assertEqual(body["response_format"], "url")

    @patch(f"{_VOLCENGINE_REQUESTS}.post")
    def test_submit_rejects_size_below_model_minimum_pixels(self, mock_post):
        with self.assertRaises(MediaServiceError) as ctx:
            self._service(min_pixels=3_686_400).submit_task(_image_request(
                model_name="doubao-seedream-4-5-251128",
                size="1024x1024",
            ))

        self.assertEqual(ctx.exception.code, MediaErrorCode.INVALID_REQUEST)
        self.assertIn("3686400", str(ctx.exception))
        mock_post.assert_not_called()

    @patch(f"{_VOLCENGINE_REQUESTS}.post")
    def test_submit_maps_provider_error(self, mock_post):
        mock_post.return_value = MagicMock(
            status_code=404,
            text="model missing",
            json=lambda: {
                "error": {
                    "code": "InvalidEndpointOrModel.NotFound",
                    "message": "model missing",
                },
            },
        )

        with self.assertRaises(MediaServiceError) as ctx:
            self._service().submit_task(_image_request(
                model_name="doubao-seedream-4-0-250828",
            ))

        self.assertEqual(ctx.exception.code, MediaErrorCode.MODEL_NOT_FOUND)

    def test_submit_rejects_unverified_negative_prompt_without_calling_provider(self):
        with patch(f"{_VOLCENGINE_REQUESTS}.post") as mock_post:
            with self.assertRaises(MediaServiceError) as ctx:
                self._service().submit_task(_image_request(
                    model_name="doubao-seedream-4-0-250828",
                    negative_prompt="模糊",
                ))

        self.assertEqual(ctx.exception.code, MediaErrorCode.INVALID_REQUEST)
        mock_post.assert_not_called()


class MediaCatalogCapabilitiesTest(TestCase):

    def test_scene_catalog_only_returns_admin_bound_models(self):
        from apps.services.llm.models import LLMModel, LLMProvider, LLMSceneBinding
        from apps.services.media_generation.services.factory import get_available_models

        provider = LLMProvider.objects.create(
            name="volcengine",
            provider_key="volcengine-scene-catalog-test",
            display_name="Volcengine Scene Catalog Test",
            capability_domains=["image_gen"],
            routing_enabled=True,
        )
        bound_model = LLMModel.objects.create(
            provider=provider,
            model_name="doubao-seedream-4-5-bound-test",
            display_name="Doubao Seedream 4.5 Bound Test",
            base_url="https://ark.example.test/api/v3",
            capability_domain="image_gen",
            context_window_tokens=1,
            capabilities_config={"default_task_type": "text2image", "media_gen": {}},
        )
        LLMModel.objects.create(
            provider=provider,
            model_name="doubao-seedream-5-0-pro-unbound-test",
            display_name="Doubao Seedream 5.0 Pro Unbound Test",
            base_url="https://ark.example.test/api/v3",
            capability_domain="image_gen",
            context_window_tokens=1,
            capabilities_config={"default_task_type": "text2image", "media_gen": {}},
        )
        LLMSceneBinding.objects.update_or_create(
            scene_key="media_image_generate",
            defaults={
                "display_name": "文生图 / 图生图",
                "capability_domain": "image_gen",
                "primary_model": bound_model,
                "fallback_models": [],
            },
        )

        models = get_available_models(
            "text2image",
            scene_key="media_image_generate",
        )

        self.assertEqual(
            [model["model_name"] for model in models],
            ["doubao-seedream-4-5-bound-test"],
        )

    def test_catalog_reads_media_gen_capabilities(self):
        from apps.services.llm.models import LLMModel, LLMProvider
        from apps.services.media_generation.services.factory import get_available_models

        provider = LLMProvider.objects.create(
            name="catalog-test",
            provider_key="catalog-test",
            display_name="Catalog Test",
            capability_domains=["image_gen"],
            routing_enabled=True,
        )
        LLMModel.objects.create(
            provider=provider,
            model_name="catalog-seedream",
            display_name="Catalog Seedream",
            base_url="https://ark.example.test/api/v3",
            capability_domain="image_gen",
            context_window_tokens=1,
            billing_type="image_count",
            capabilities_config={
                "default_task_type": "text2image",
                "media_gen": {
                    "supported_sizes": ["1024*1024"],
                    "supports_negative_prompt": True,
                    "supports_audio_input": False,
                    "max_n_per_request": 1,
                },
            },
        )

        model = next(
            item
            for item in get_available_models("text2image")
            if item["model_name"] == "catalog-seedream"
        )

        self.assertEqual(model["supported_sizes"], ["1024*1024"])
        self.assertTrue(model["supports_negative_prompt"])
        self.assertFalse(model["supports_multi_shot"])

    def test_catalog_excludes_non_global_provider(self):
        from apps.services.llm.models import LLMModel, LLMProvider
        from apps.services.media_generation.services.factory import get_available_models

        provider = LLMProvider.objects.create(
            name="organization-media",
            provider_key="organization-media",
            display_name="Organization Media",
            capability_domains=["image_gen"],
            scope="organization",
            organization_id="org-private",
            routing_enabled=True,
        )
        LLMModel.objects.create(
            provider=provider,
            model_name="organization-image-model",
            display_name="Organization Image",
            base_url="https://example.test/api",
            capability_domain="image_gen",
            context_window_tokens=1,
            capabilities_config={"default_task_type": "text2image", "media_gen": {}},
        )

        names = {item["model_name"] for item in get_available_models("text2image")}

        self.assertNotIn("organization-image-model", names)
