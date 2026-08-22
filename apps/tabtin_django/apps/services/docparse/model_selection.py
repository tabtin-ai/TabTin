"""DocParse Vision 模型选择的 trigger-time 快照契约。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping
from uuid import UUID

MODEL_SELECTION_SOURCE_EXPLICIT = "explicit"
MODEL_SELECTION_SOURCE_OFFICIAL_DEFAULT = "official_default"


@dataclass(frozen=True)
class DocumentVisionModelSelection:
    """一次文档解析操作冻结的模型选择。"""

    selected_model_id: str | None
    source: str


def normalize_selected_model_id(selected_model_id: object | None) -> str | None:
    """只接受 LLMModel UUID；禁止从 legacy model name 反查。"""

    if selected_model_id is None:
        return None
    try:
        return str(UUID(str(selected_model_id)))
    except (AttributeError, TypeError, ValueError) as exc:
        raise ValueError("selected_model_id 必须是 LLMModel UUID") from exc


def build_model_selection_snapshot(selected_model_id: object | None) -> dict[str, str]:
    """构造写入 DocumentImportJob.request_payload 的不可变选择快照。"""

    normalized_model_id = normalize_selected_model_id(selected_model_id)
    if normalized_model_id is None:
        return {"model_selection_source": MODEL_SELECTION_SOURCE_OFFICIAL_DEFAULT}
    return {
        "selected_model_id": normalized_model_id,
        "model_selection_source": MODEL_SELECTION_SOURCE_EXPLICIT,
    }


def resolve_model_selection_snapshot(
    request_payload: Mapping[str, Any] | None,
) -> DocumentVisionModelSelection:
    """恢复 Job 快照；旧 Job 缺字段时保持 official default。"""

    payload = request_payload if isinstance(request_payload, Mapping) else {}
    source = payload.get("model_selection_source")
    raw_model_id = payload.get("selected_model_id")

    if source is None and raw_model_id is None:
        return DocumentVisionModelSelection(
            selected_model_id=None,
            source=MODEL_SELECTION_SOURCE_OFFICIAL_DEFAULT,
        )
    if source == MODEL_SELECTION_SOURCE_OFFICIAL_DEFAULT:
        if raw_model_id is not None:
            raise ValueError("official_default Job 不能携带 selected_model_id")
        return DocumentVisionModelSelection(selected_model_id=None, source=source)
    if source == MODEL_SELECTION_SOURCE_EXPLICIT:
        if raw_model_id is None:
            raise ValueError("explicit Job 缺少 selected_model_id")
        return DocumentVisionModelSelection(
            selected_model_id=normalize_selected_model_id(raw_model_id),
            source=source,
        )
    raise ValueError("未知 model_selection_source，拒绝执行文档解析")


def assert_model_selection_matches(
    request_payload: Mapping[str, Any] | None,
    selected_model_id: object | None,
) -> DocumentVisionModelSelection:
    """幂等复用同一 Job 时禁止悄悄切换模型。"""

    existing = resolve_model_selection_snapshot(request_payload)
    requested = resolve_model_selection_snapshot(
        build_model_selection_snapshot(selected_model_id),
    )
    if existing != requested:
        raise ValueError("同一 DocumentImportJob 不能更改 selected_model_id")
    return existing


def build_document_page_vision_invocation(
    *,
    job_id: object,
    page_number: int,
    parser_version: str,
    organization_id: str,
    user_id: str,
    selected_model_id: object | None,
):
    """为未来父 Worker Vision stage 构造可重投的页级身份。

    当前 streaming PDF 尚未调用这个 helper；它只固定 operation identity
    契约，防止后续实现退化为 document_id + page 或在重投时重新选模。
    """

    from apps.services.llm.services._runtime.invocation import SceneInvocationContext

    normalized_job_id = str(job_id or "").strip()
    normalized_parser_version = str(parser_version or "").strip()
    if not normalized_job_id:
        raise ValueError("Vision invocation 缺少 DocumentImportJob.id")
    if page_number < 1:
        raise ValueError("Vision invocation page_number 必须大于 0")
    if not normalized_parser_version:
        raise ValueError("Vision invocation 缺少 parser_version")

    page_identity = f"{normalized_job_id}:{page_number}:{normalized_parser_version}"
    return SceneInvocationContext.stable(
        invocation_id=f"docparse-vision:{page_identity}",
        scene_key="vision_parse_document",
        execution_key="vision_parse_document",
        organization_id=organization_id,
        user_id=user_id,
        selected_model_id=normalize_selected_model_id(selected_model_id) or "",
        business_object_type="document_import_page",
        business_object_id=page_identity,
        task_id=normalized_job_id,
    )


__all__ = [
    "DocumentVisionModelSelection",
    "MODEL_SELECTION_SOURCE_EXPLICIT",
    "MODEL_SELECTION_SOURCE_OFFICIAL_DEFAULT",
    "assert_model_selection_matches",
    "build_document_page_vision_invocation",
    "build_model_selection_snapshot",
    "normalize_selected_model_id",
    "resolve_model_selection_snapshot",
]
