"""Embedding 配置 API — v0.1 AdminDash

- 8 个 embedding scene 默认配置一览
- 7 张物理表索引状态（rag_table / rag_record / rag_document / rag_code_chunk
  / rag_skill / capabilities_tool / tabmail_mail）
- 重建索引 v0.1 stub（产品没上线，提交即返回 422 FEATURE_NOT_IMPLEMENTED）
"""

from __future__ import annotations

import logging
from typing import Optional

from django.apps import apps
from django.utils import timezone
from ninja import Router, Schema

from apps.i18n.response import error_response_with_status, success_response
from apps.users.auth.permissions import StaffAuth

from ..models import LLMSceneBinding
from ..scenes.registry import SCENES

logger = logging.getLogger(__name__)

router = Router(tags=["Admin Embedding"], auth=StaffAuth())


# ─── 当前在役物理 embedding 表（宪法 §6.1.4）──────────────────────────────
# (app_label, model_name, table_name, display_name, default_dimensions)
# 用 Django apps.get_model 按 app_label.model_name 拿模型，避免直接 import 环依赖
EMBEDDING_TABLES: tuple[tuple[str, str, str, str, int], ...] = (
    ("rag", "TableEmbedding", "rag_table_embedding", "数据表 Embedding", 1024),
    ("rag", "RecordEmbedding", "rag_record_embedding", "记录行 Embedding", 1024),
    ("rag", "DocumentEmbedding", "rag_document_embedding", "文档 Embedding", 1024),
    ("rag", "SkillEmbedding", "rag_skill_embedding", "Skill Embedding", 1024),
    ("capabilities", "ToolEmbedding", "capabilities_tool_embedding", "工具 Embedding", 1024),
    ("tabmail", "MailEmbedding", "tabmail_mail_embedding", "邮件 Embedding", 1024),
)

# scene_key → (app_label, model_name)：用于 Tab 1 拿真实的索引文档数。
# 7 个索引类 scene 各自对应一张物理表；rag_search_query 是查询类无物理表 → None。
SCENE_TO_PHYSICAL_TABLE: dict[str, Optional[tuple[str, str]]] = {
    "rag_index_table": ("rag", "TableEmbedding"),
    "rag_index_record": ("rag", "RecordEmbedding"),
    "rag_index_document": ("rag", "DocumentEmbedding"),
    "rag_index_skill": ("rag", "SkillEmbedding"),
    "rag_index_tool": ("capabilities", "ToolEmbedding"),
    "rag_index_mail": ("tabmail", "MailEmbedding"),
    "rag_search_query": None,  # 查询类 scene，没有物理表
}


def _get_indexed_documents(app_label: str, model_name: str) -> int:
    """返回某张物理 embedding 表当前文档数；模型不存在或异常时返回 0。"""
    try:
        model_cls = apps.get_model(app_label, model_name)
        return model_cls.objects.count()
    except Exception:
        return 0


def _get_last_rebuild(app_label: str, model_name: str) -> Optional[str]:
    """v0.1 没有真实 rebuild 任务表，永远返回 None（保留接口便于 v0.2 接入）。"""
    return None


@router.get("/admin/embedding/overview")
def embedding_overview(request):
    """Embedding 总览 — Tab 1（默认配置）+ Tab 2（索引状态）共用数据源。

    返回：
      - scenes: 8 个 embedding scene 的 binding 一览（每行一个 scene_key）
      - tables: 7 张物理表的 dimensions/文档数/最近 rebuild 时间
    """
    embedding_scenes = [
        spec for spec in SCENES.values()
        if spec.capability_domain == "embedding"
    ]

    bindings = {
        b.scene_key: b
        for b in LLMSceneBinding.objects.select_related('primary_model').filter(
            capability_domain='embedding',
        )
    }

    scenes_data: list[dict] = []
    for spec in embedding_scenes:
        binding = bindings.get(spec.scene_key)
        model_info = None
        if binding and binding.primary_model:
            caps = binding.primary_model.capabilities_config or {}
            embedding_cfg = caps.get("embedding") if isinstance(caps.get("embedding"), dict) else {}
            dims = (
                embedding_cfg.get("dimensions")
                or caps.get("embedding_dimensions")
                or spec.capability_requirements.get("embedding_dimensions", 0)
            )
            model_info = {
                "id": str(binding.primary_model.id),
                "model_name": binding.primary_model.model_name,
                "display_name": binding.primary_model.display_name,
                "dimensions": int(dims or 0),
            }

        physical = SCENE_TO_PHYSICAL_TABLE.get(spec.scene_key)
        if physical is not None:
            indexed_count: Optional[int] = _get_indexed_documents(*physical)
            last_rebuild = _get_last_rebuild(*physical)
        else:
            # rag_search_query 等查询类 scene 没有物理表 — 显式 null 而非 0
            indexed_count = None
            last_rebuild = None

        scenes_data.append({
            "scene_key": spec.scene_key,
            "display_name": spec.display_name,
            "description": spec.description,
            "primary_model": model_info,
            "indexed_documents": indexed_count,
            "last_rebuild_at": last_rebuild,
            "rebuild_in_progress": False,
            "has_physical_table": physical is not None,
        })

    tables_data: list[dict] = []
    for app_label, model_name, table_name, display_name, default_dims in EMBEDDING_TABLES:
        tables_data.append({
            "table_name": table_name,
            "display_name": display_name,
            "dimensions": default_dims,
            "indexed_documents": _get_indexed_documents(app_label, model_name),
            "last_rebuild_at": _get_last_rebuild(app_label, model_name),
            "rebuild_in_progress": False,
        })

    return success_response(data={
        "scenes": scenes_data,
        "tables": tables_data,
        "generated_at": timezone.now().isoformat(),
    })


# ─── Tab 3：重建索引（v0.1 stub）──────────────────────────────────────────


class RebuildIndexPayload(Schema):
    new_model_id: str
    confirm_scene_key: str
    # 宪法 §5.6：reason 必填（写入 audit）。Schema 默认空字符串便于 v0.1 stub 调试，
    # 但下面 rebuild_index() 会显式拒绝空 reason。
    reason: str = ""


@router.post("/admin/embedding/scenes/{scene_key}/rebuild")
def rebuild_index(request, scene_key: str, payload: RebuildIndexPayload):
    """v0.1 stub — 重建索引 Celery 任务尚未实现。

    v0.1 没上线没数据需要 rebuild，
    本端点保留接口形状但永远返回 422 FEATURE_NOT_IMPLEMENTED，等 v0.2 实装。

    校验顺序：
      1. scene_key 必须存在且 capability_domain == 'embedding'
      2. confirm_scene_key 必须等于 path 参数（防误操作）
      3. 通过校验后仍返回 422（v0.1 stub 不真实施）
    """
    spec = SCENES.get(scene_key)
    if spec is None or spec.capability_domain != "embedding":
        return error_response_with_status(
            code="SCENE_NOT_FOUND",
            message=f"scene_key '{scene_key}' 不存在或不属于 embedding domain",
            status_code=404,
        )

    if payload.confirm_scene_key != scene_key:
        return error_response_with_status(
            code="CONFIRM_SCENE_KEY_MISMATCH",
            message="confirm_scene_key 必须等于 URL path 参数",
            status_code=400,
        )

    # 宪法 §5.6：reason 必填（写入 audit）
    if not payload.reason or not payload.reason.strip():
        return error_response_with_status(
            code="REASON_REQUIRED",
            message="reason 必填（用于审计记录）",
            status_code=400,
        )

    logger.warning(
        "[embedding.rebuild] v0.1 stub rejected — scene_key=%s new_model_id=%s reason=%s",
        scene_key, payload.new_model_id, (payload.reason or "")[:200],
    )

    return error_response_with_status(
        code="FEATURE_NOT_IMPLEMENTED",
        message=(
            "重建索引功能未在 v0.1 启用。"
            "宪法 v0.1 §1.5.3：产品上线前没有真实数据需要重建索引，"
            "rebuild 任务推迟到 v0.2 真实施。"
        ),
        status_code=422,
        data={
            "scene_key": scene_key,
            "new_model_id": payload.new_model_id,
            "estimated_release": "v0.2",
        },
    )
