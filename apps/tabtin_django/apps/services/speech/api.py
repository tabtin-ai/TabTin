"""
Speech Services API — Django Ninja Router

端点:
  POST /recognize/              极速版同步识别（flash）
  POST /submit/                 标准版提交任务
  POST /query/                  标准版查询结果
  GET  /providers/              获取可用 Provider 和模式列表
  POST /tts/synthesize/         TTS 合成
  GET  /tts/voices/             查询可用音色
  POST /tts/voices/sync/        批量导入音色（管理员）
"""


import hashlib
import logging
import uuid as _uuid_mod
from decimal import Decimal
from typing import Any

from django.http import HttpRequest
from ninja import Router

from apps.i18n.response import (
    error_response_with_status as error_response,
    success_response,
    validation_error_response,
)
from apps.services.common.base_schemas import ErrorResponse
from apps.users.auth.permissions import JWTAuth

from .asr.factory import ASRServiceFactory, get_asr_service
from .exceptions import SpeechConfigError, SpeechUpstreamError
from .schemas import (
    ASRQueryRequest,
    ASRRecognizeRequest,
    ASRSubmitRequest,
    TTSSynthesizeRequest,
    TTSVoiceSyncRequest,
)
from .tts.factory import TTSServiceFactory, get_tts_service
from apps.services.billing.decorators import billing_required

logger = logging.getLogger(__name__)
router = Router(tags=["Speech Services"])
jwt_auth = JWTAuth()


def _charge_speech_usage(
    *,
    user_id: str,
    organization_id: str | None,
    meter_key: str,
    quantity: Decimal,
    unit: str,
    provider: str = "bytedance",
    biz_type: str = "",
    biz_id: str = "",
    idempotency_key: str = "",
) -> None:
    """Speech 计费统一入口（ASR/TTS），失败不中断主流程。

    W3-4: TTS (speech.tts.characters) 按金额阈值动态分流——
    预估金额 >= sync_charge_threshold_credits 走同步扣款，否则仅写 pending 事件。
    ASR 等其他 meter 保持同步路径。
    """
    if not user_id or quantity <= 0:
        return
    try:
        from apps.users.wallet.services import CreditsService
        if not idempotency_key:
            if biz_id:
                idempotency_key = f"speech:{biz_type}:{biz_id}"
            else:
                logger.warning(
                    "[SpeechBilling] biz_id 和 idempotency_key 均为空，"
                    "退避使用随机 uuid 兜底（存在重复计费风险）: biz_type=%s meter_key=%s",
                    biz_type, meter_key,
                )
                idempotency_key = f"speech:{biz_type}:{_uuid_mod.uuid4().hex[:12]}"

        use_async = False
        if meter_key == "speech.tts.characters":
            try:
                from apps.services.billing.services.pricing_service import MeterPricingService
                from apps.services.billing.models import BillingRuntimeConfig
                unit_price = MeterPricingService.get_unit_price(
                    meter_key,
                    organization_id=organization_id or None,
                    provider_key=provider,
                    default_price=Decimal("0"),
                ) or Decimal("0")
                estimated_amount = quantity * unit_price
                threshold = Decimal(str(
                    BillingRuntimeConfig.get_instance().sync_charge_threshold_credits
                ))
                use_async = estimated_amount < threshold
            except Exception:
                pass

        if use_async:
            from apps.services.billing.services import BillingUsageService
            BillingUsageService.record_event(
                organization_id=organization_id or "",
                user_id=user_id,
                meter_key=meter_key,
                quantity=quantity,
                unit=unit,
                unit_price=unit_price,
                amount=estimated_amount,
                currency="CREDITS",
                provider_key=provider,
                biz_type=biz_type,
                biz_id=biz_id or idempotency_key,
                idempotency_key=idempotency_key,
                charge_status="pending",
            )
        else:
            CreditsService.consume_credits(
                user_id=user_id,
                organization_id=organization_id,
                meter_key=meter_key,
                quantity=quantity,
                unit=unit,
                provider_key=provider,
                biz_type=biz_type,
                biz_id=biz_id or idempotency_key,
                idempotency_key=idempotency_key,
            )
    except Exception as exc:
        logger.warning("[SpeechBilling] 计费失败（不中断主流程）: %s", exc)
        try:
            from apps.services.billing.services.degradation_tracker import track_billing_degradation
            track_billing_degradation(meter_key="speech.billing", organization_id=organization_id or "", biz_type=biz_type, error=str(exc))
        except Exception:
            pass


def _resolve_authorized_organization_id(request: HttpRequest, payload) -> tuple[str, Any | None]:
    """解析并校验 Speech 请求的计费团队，避免信任前端传入的 organization_id。"""
    organization_id = str(
        getattr(request, "_billing_organization_id", "") or getattr(payload, "organization_id", "") or ""
    ).strip()
    if not organization_id:
        return "", error_response("ORGANIZATION_REQUIRED", message="organization_id 不能为空", status_code=400)

    from apps.tabtinspace.services.base import BaseService
    if not BaseService(user=request.auth).check_organization_permission(organization_id, "viewer"):
        return "", error_response("FORBIDDEN", message="无权使用该组织", status_code=403)

    request._billing_organization_id = organization_id
    return organization_id, None


# ── 极速版同步识别 ─────────────────────────────────────────────────


@router.post("/recognize/", auth=jwt_auth, response={200: dict, 400: ErrorResponse, 500: ErrorResponse, 502: ErrorResponse})
@billing_required(service_key="speech.asr", enforce_organization_permission=True)
def asr_recognize(request: HttpRequest, payload: ASRRecognizeRequest):
    """
    ASR 同步识别（极速版 flash）

    一次请求返回完整识别结果。
    支持 audio_url（推荐，直接传 OSS CDN 链接）或 audio_data（base64）。
    """
    try:
        if not payload.audio_url and not payload.audio_data:
            return validation_error_response("audio_url 或 audio_data 至少传一个")

        if payload.audio_data and len(payload.audio_data) > 20 * 1024 * 1024:
            return validation_error_response("audio_data 大小超限（最大 20 MB base64）")

        effective_wt, auth_error = _resolve_authorized_organization_id(request, payload)
        if auth_error:
            return auth_error

        svc = get_asr_service(
            provider=payload.provider,
            mode=payload.mode,
        )

        kwargs = _extract_asr_params(payload)

        result = svc.recognize(
            audio_url=payload.audio_url,
            audio_data=payload.audio_data,
            language=payload.language,
            audio_format=payload.audio_format,
            **kwargs,
        )

        duration_ms = getattr(result.audio_info, "duration", 0) if result.audio_info else 0
        if duration_ms > 0:
            audio_source = payload.audio_url or payload.audio_data or ""
            audio_hash = hashlib.md5(audio_source.encode()).hexdigest()[:16]
            asr_user_id = str(getattr(request.auth, "id", ""))
            _charge_speech_usage(
                user_id=asr_user_id,
                organization_id=effective_wt,
                meter_key="speech.asr.seconds",
                quantity=Decimal(str(max(duration_ms / 1000, 1))),
                unit="seconds",
                provider=payload.provider,
                biz_type="asr_recognize",
                idempotency_key=f"speech:asr_recognize:{asr_user_id}:{audio_hash}",
            )

        return success_response(result.to_dict())

    except SpeechConfigError as e:
        logger.warning("ASR config error: %s", e)
        return error_response("ASR_NOT_CONFIGURED", message="语音识别服务未配置，请联系管理员")
    except ValueError as e:
        return validation_error_response(str(e))
    except SpeechUpstreamError as e:
        logger.exception("ASR recognize upstream error: %s", e)
        return error_response("ASR_RECOGNIZE_FAILED", message="语音识别服务暂时不可用，请稍后重试", status_code=502)
    except Exception as e:
        logger.exception("ASR recognize unexpected error")
        return error_response("INTERNAL_ERROR", message="语音识别服务暂时不可用，请稍后重试", status_code=500)


# ── 标准版提交任务 ─────────────────────────────────────────────────


@router.post("/submit/", auth=jwt_auth, response={200: dict, 400: ErrorResponse, 500: ErrorResponse, 502: ErrorResponse})
@billing_required(service_key="speech.asr", enforce_organization_permission=True)
def asr_submit(request: HttpRequest, payload: ASRSubmitRequest):
    """
    ASR 异步提交任务（标准版 standard）

    提交音频 URL 开始识别，返回 task_id 用于后续 query。
    适合长音频（≤5h）和需要说话人分离等高级功能的场景。
    """
    try:
        if not payload.audio_url:
            return validation_error_response("audio_url 不能为空")

        effective_wt, auth_error = _resolve_authorized_organization_id(request, payload)
        if auth_error:
            return auth_error

        svc = get_asr_service(
            provider=payload.provider,
            mode="standard",
        )

        kwargs = _extract_submit_params(payload)

        task_status = svc.submit(
            audio_url=payload.audio_url,
            language=payload.language,
            audio_format=payload.audio_format,
            callback_url=payload.callback_url,
            callback_data=payload.callback_data,
            **kwargs,
        )

        return success_response(task_status.to_dict())

    except SpeechConfigError as e:
        logger.warning("ASR config error: %s", e)
        return error_response("ASR_NOT_CONFIGURED", message="语音识别服务未配置，请联系管理员")
    except ValueError as e:
        return validation_error_response(str(e))
    except SpeechUpstreamError as e:
        logger.exception("ASR submit upstream error: %s", e)
        return error_response("ASR_SUBMIT_FAILED", message="语音识别服务暂时不可用，请稍后重试", status_code=502)
    except Exception as e:
        logger.exception("ASR submit unexpected error")
        return error_response("INTERNAL_ERROR", message="语音识别服务暂时不可用，请稍后重试", status_code=500)


# ── 标准版查询结果 ─────────────────────────────────────────────────


@router.post("/query/", auth=jwt_auth, response={200: dict, 400: ErrorResponse, 500: ErrorResponse, 502: ErrorResponse})
@billing_required(service_key="speech.asr", enforce_organization_permission=True)
def asr_query(request: HttpRequest, payload: ASRQueryRequest):
    """
    ASR 查询任务结果（标准版 standard）

    通过 submit 返回的 task_id 查询识别进度和结果。
    """
    try:
        if not payload.task_id:
            return validation_error_response("task_id 不能为空")

        effective_wt, auth_error = _resolve_authorized_organization_id(request, payload)
        if auth_error:
            return auth_error

        svc = get_asr_service(
            provider=payload.provider,
            mode="standard",
        )

        task_status = svc.query(payload.task_id)

        if task_status.status == "completed" and task_status.result:
            duration_ms = getattr(task_status.result.audio_info, "duration", 0) if task_status.result.audio_info else 0
            if duration_ms > 0:
                _charge_speech_usage(
                    user_id=str(getattr(request.auth, "id", "")),
                    organization_id=effective_wt,
                    meter_key="speech.asr.seconds",
                    quantity=Decimal(str(max(duration_ms / 1000, 1))),
                    unit="seconds",
                    provider=payload.provider,
                    biz_type="asr_query",
                    biz_id=payload.task_id,
                    idempotency_key=f"speech:asr_standard:{payload.task_id}",
                )

        return success_response(task_status.to_dict())

    except SpeechConfigError as e:
        logger.warning("ASR config error: %s", e)
        return error_response("ASR_NOT_CONFIGURED", message="语音识别服务未配置，请联系管理员")
    except ValueError as e:
        return validation_error_response(str(e))
    except SpeechUpstreamError as e:
        logger.exception("ASR query upstream error: %s", e)
        return error_response("ASR_QUERY_FAILED", message="语音识别服务暂时不可用，请稍后重试", status_code=502)
    except Exception as e:
        logger.exception("ASR query unexpected error")
        return error_response("INTERNAL_ERROR", message="语音识别服务暂时不可用，请稍后重试", status_code=500)


# ── Provider 信息 ──────────────────────────────────────────────────


@router.get("/providers/", auth=jwt_auth)
def asr_providers(request: HttpRequest):
    """获取可用的 ASR Provider 和模式列表"""
    providers = ASRServiceFactory.get_supported_providers()
    return success_response(providers)


# ── 内部工具 ───────────────────────────────────────────────────────


def _extract_asr_params(payload: ASRRecognizeRequest) -> dict[str, Any]:
    """从请求 Schema 中提取非 None 的 ASR 参数"""
    params: dict[str, Any] = {}
    optional_fields = [
        "enable_itn", "enable_punc", "enable_ddc", "show_utterances",
        "enable_speaker_info", "enable_channel_split", "enable_lid",
        "enable_emotion_detection", "enable_gender_detection",
        "model_version",
        "boosting_table_name", "correct_table_name", "context",
    ]
    for field in optional_fields:
        value = getattr(payload, field, None)
        if value is not None:
            params[field] = value
    return params


def _extract_submit_params(payload: ASRSubmitRequest) -> dict[str, Any]:
    """从 submit 请求 Schema 中提取非 None 的 ASR 参数"""
    params: dict[str, Any] = {}
    optional_fields = [
        "enable_itn", "enable_punc", "enable_ddc", "show_utterances",
        "enable_speaker_info", "enable_channel_split",
        "show_speech_rate", "show_volume",
        "enable_lid", "enable_emotion_detection", "enable_gender_detection",
        "model_version", "vad_segment", "end_window_size",
        "sensitive_words_filter",
        "boosting_table_name", "correct_table_name", "context",
    ]
    for field in optional_fields:
        value = getattr(payload, field, None)
        if value is not None:
            params[field] = value
    return params


# ── TTS 合成 ─────────────────────────────────────────────────────


@router.post("/tts/synthesize/", auth=jwt_auth, response={200: dict, 400: ErrorResponse, 500: ErrorResponse, 502: ErrorResponse})
@billing_required(service_key="speech.tts", enforce_organization_permission=True)
def tts_synthesize(request: HttpRequest, payload: TTSSynthesizeRequest):
    """
    TTS 语音合成

    返回 base64 编码的音频数据。
    支持 HTTP 单向 (mode=http) 和 WS 双向 (mode=ws_bidirectional) 两种模式。
    """
    try:
        if not payload.text or not payload.text.strip():
            return validation_error_response("text 不能为空")

        if len(payload.text) > 50000:
            return validation_error_response("text 长度超限（最大 50000 字符）")

        effective_wt, auth_error = _resolve_authorized_organization_id(request, payload)
        if auth_error:
            return auth_error

        svc = get_tts_service(
            provider=payload.provider,
            mode=payload.mode,
        )

        from .tts.factory import run_async

        result = run_async(svc.synthesize(
            payload.text,
            speaker=payload.speaker,
            model=payload.model,
            format=payload.format,
            sample_rate=payload.sample_rate,
            speed_ratio=payload.speed_ratio,
            volume_ratio=payload.volume_ratio,
            pitch=payload.pitch,
            emotion=payload.emotion,
            enable_timestamp=payload.enable_timestamp,
            context_texts=payload.context_texts or None,
        ))

        char_count = len(payload.text.strip())
        if char_count > 0:
            text_hash = hashlib.md5(payload.text.strip().encode()).hexdigest()[:16]
            tts_user_id = str(getattr(request.auth, "id", ""))
            _charge_speech_usage(
                user_id=tts_user_id,
                organization_id=effective_wt,
                meter_key="speech.tts.characters",
                quantity=Decimal(str(char_count)),
                unit="characters",
                provider=payload.provider,
                biz_type="tts_synthesize",
                idempotency_key=f"speech:tts_synthesize:{tts_user_id}:{text_hash}",
            )

        return success_response(result.to_dict())

    except SpeechConfigError as e:
        logger.warning("TTS config error: %s", e)
        return error_response("TTS_NOT_CONFIGURED", message="语音合成服务未配置，请联系管理员")
    except ValueError as e:
        return validation_error_response(str(e))
    except SpeechUpstreamError as e:
        logger.exception("TTS synthesize upstream error: %s", e)
        return error_response("TTS_SYNTHESIZE_FAILED", message="语音合成服务暂时不可用，请稍后重试", status_code=502)
    except Exception as e:
        logger.exception("TTS synthesize unexpected error")
        return error_response("INTERNAL_ERROR", message="语音合成服务暂时不可用，请稍后重试", status_code=500)


# ── TTS 音色 ─────────────────────────────────────────────────────


@router.get("/tts/voices/", auth=jwt_auth)
def tts_voices(request: HttpRequest):
    """查询可用 TTS 音色列表"""
    from .models import TTSVoice

    provider = request.GET.get("provider", "")
    language = request.GET.get("language", "")
    category = request.GET.get("category", "")
    model_version = request.GET.get("model_version", "")

    qs = TTSVoice.objects.filter(is_active=True)
    if provider:
        qs = qs.filter(provider=provider)
    if language:
        qs = qs.filter(language__icontains=language)
    if category:
        qs = qs.filter(category=category)
    if model_version:
        qs = qs.filter(model_version=model_version)

    voices = [v.to_dict() for v in qs[:500]]
    return success_response({
        "voices": voices,
        "total": len(voices),
    })


@router.post("/tts/voices/sync/", auth=jwt_auth)
def tts_voices_sync(request: HttpRequest, payload: TTSVoiceSyncRequest):
    """
    批量同步/导入 TTS 音色（管理员）

    每条记录需包含 voice_type（唯一键），其他字段可选。
    已存在的 voice_type 会更新，不存在的会创建。
    """
    user = request.auth
    if not user or not user.is_superuser:
        return error_response("FORBIDDEN", message="此操作需要超级管理员权限", status_code=403)

    from django.db import transaction
    from .models import TTSVoice

    created = 0
    updated = 0

    with transaction.atomic():
        for voice_item in payload.voices:
            if not voice_item.voice_type:
                continue

            d = voice_item.model_dump()
            defaults = {
                "name": d.get("name") or voice_item.voice_type,
                "provider": d["provider"],
                "language": d["language"],
                "category": d["category"],
                "model_version": d["model_version"],
                "emotions": d["emotions"],
                "supports_mix": d["supports_mix"],
                "supports_bidirectional": d["supports_bidirectional"],
                "is_active": d["is_active"],
                "extra": d["extra"],
            }

            _, was_created = TTSVoice.objects.update_or_create(
                voice_type=voice_item.voice_type,
                defaults=defaults,
            )
            if was_created:
                created += 1
            else:
                updated += 1

    return success_response({
        "created": created,
        "updated": updated,
        "total": created + updated,
    })


# ── TTS Provider 信息 ────────────────────────────────────────────


@router.get("/tts/providers/", auth=jwt_auth)
def tts_providers(request: HttpRequest):
    """获取可用的 TTS Provider 和模式列表"""
    providers = TTSServiceFactory.get_supported_providers()
    return success_response(providers)
