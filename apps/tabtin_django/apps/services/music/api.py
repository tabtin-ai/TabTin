"""
Music Generation API — Django Ninja Router

端点:
  POST /generate/     同步生成 BGM（返回 base64 音频 + 元数据）
  GET  /providers/    获取可用 Provider 列表
"""

import base64
import hashlib
import logging
import tempfile
import uuid as _uuid_mod
from decimal import Decimal
from typing import Optional

from django.http import HttpRequest
from ninja import Router, Schema

from apps.i18n.response import (
    error_response_with_status as error_response,
    success_response,
    validation_error_response,
)
from apps.services.billing.decorators import billing_required
from apps.services.common.base_schemas import ErrorResponse
from apps.users.auth.permissions import JWTAuth

from .factory import MusicServiceFactory, get_music_service

logger = logging.getLogger(__name__)
router = Router(tags=["Music Services"])
jwt_auth = JWTAuth()


def _charge_music_usage(
    *,
    user_id: str,
    organization_id: str | None,
    duration_seconds: float,
    provider: str = "minimax",
    idempotency_key: str = "",
) -> None:
    """BGM 按秒计费（失败不中断主流程）"""
    if not user_id or duration_seconds <= 0:
        return
    try:
        from apps.users.wallet.services import CreditsService
        if not idempotency_key:
            idempotency_key = f"music:bgm_generate:{_uuid_mod.uuid4().hex[:12]}"
        CreditsService.consume_credits(
            user_id=user_id,
            organization_id=organization_id,
            meter_key="media.bgm.seconds",
            quantity=Decimal(str(max(duration_seconds, 1))),
            unit="seconds",
            provider_key=provider,
            biz_type="bgm_generate",
            biz_id=idempotency_key,
            idempotency_key=idempotency_key,
        )
    except Exception as exc:
        logger.warning("[MusicBilling] BGM 计费失败（不中断主流程）: %s", exc)


class MusicGenerateRequest(Schema):
    prompt: str = ""
    style: str = ""
    target_duration: float = 60.0
    bpm: Optional[int] = None
    provider: str = "minimax"
    organization_id: str = ""


@router.post(
    "/generate/",
    auth=jwt_auth,
    response={200: dict, 400: ErrorResponse, 500: ErrorResponse, 502: ErrorResponse},
)
@billing_required(
    service_key="media.audio",
    scene_key="media_bgm_generate",
)
def music_generate(request: HttpRequest, payload: MusicGenerateRequest):
    """
    同步生成背景音乐

    返回 base64 编码的 WAV 音频 + 元数据（时长、BPM、sections）。
    用于 CLI/Daemon 本地视频编排管线。
    """
    try:
        if not payload.prompt and not payload.style:
            return validation_error_response("prompt 或 style 至少提供一个")

        if payload.target_duration <= 0 or payload.target_duration > 600:
            return validation_error_response("target_duration 范围 (0, 600] 秒")

        svc = get_music_service(provider=payload.provider)

        work_dir = tempfile.mkdtemp(prefix="music_api_")
        try:
            result = svc.generate(
                prompt=payload.prompt,
                target_duration=payload.target_duration,
                style=payload.style,
                bpm=payload.bpm,
                output_dir=work_dir,
            )

            with open(result.audio_path, "rb") as f:
                audio_b64 = base64.b64encode(f.read()).decode("ascii")

            if result.measured_duration > 0:
                prompt_hash = hashlib.md5(
                    (payload.prompt + payload.style).encode()
                ).hexdigest()[:16]
                bgm_user_id = str(getattr(request.auth, "id", ""))
                effective_wt = (
                    getattr(request, "_billing_organization_id", "")
                    or payload.organization_id
                )
                _charge_music_usage(
                    user_id=bgm_user_id,
                    organization_id=effective_wt,
                    duration_seconds=result.measured_duration,
                    provider=payload.provider,
                    idempotency_key=f"music:bgm_generate:{bgm_user_id}:{prompt_hash}",
                )

            return success_response({
                "audioData": audio_b64,
                "measuredDuration": result.measured_duration,
                "bpm": result.bpm,
                "sections": [s.to_dict() for s in result.sections],
                "sampleRate": result.sample_rate,
            })
        finally:
            _cleanup_dir(work_dir)

    except ValueError as e:
        return validation_error_response(str(e))
    except RuntimeError as e:
        logger.exception("Music generate error: %s", e)
        return error_response(
            "MUSIC_GENERATE_FAILED",
            message="音乐生成服务暂时不可用，请稍后重试",
            status_code=502,
        )
    except Exception as e:
        logger.exception("Music generate unexpected error")
        return error_response(
            "INTERNAL_ERROR",
            message="音乐生成服务暂时不可用，请稍后重试",
            status_code=500,
        )


@router.get("/providers/", auth=jwt_auth)
def music_providers(request: HttpRequest):
    """获取可用的音乐生成 Provider 列表"""
    providers = MusicServiceFactory.get_supported_providers()
    return success_response({"providers": providers})


def _cleanup_dir(dir_path: str) -> None:
    """清理临时目录"""
    try:
        import shutil
        shutil.rmtree(dir_path, ignore_errors=True)
    except Exception as exc:
        logger.debug("清理临时目录失败 path=%s: %s", dir_path, exc)
