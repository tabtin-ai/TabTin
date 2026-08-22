"""TabCode AI 提交信息生成。

同步调用 unified_llm_call(scene_key="commit_message_generation")。
"""

from __future__ import annotations

import logging
import re
from typing import Optional, Sequence

logger = logging.getLogger(__name__)

SCENE_KEY = "commit_message_generation"
MAX_COMMIT_MESSAGE_CHARS = 120
_META_PREFIXES = (
    "commit message",
    "提交信息",
    "生成提交",
    "here is",
)


def clean_commit_message(raw: str, *, max_length: int = MAX_COMMIT_MESSAGE_CHARS) -> Optional[str]:
    """轻量清洗：取首个非空行、去引号、限长。"""
    if not raw:
        return None
    for line in raw.splitlines():
        text = line.strip().strip("`").strip().strip('"').strip("'")
        if not text:
            continue
        lowered = text.lower()
        if any(lowered.startswith(prefix) for prefix in _META_PREFIXES):
            continue
        # 去掉模型偶发的编号前缀
        text = re.sub(r"^\d+[\).\s]+", "", text).strip()
        if len(text) > max_length:
            text = text[:max_length].rstrip()
        return text or None
    return None


def generate_commit_message(
    *,
    files: Sequence[str],
    diff_excerpt: str,
    truncated: bool,
    user_id: str,
    organization_id: str,
    selected_model_id: str | None = None,
) -> Optional[str]:
    from apps.services.llm.services.chat import unified_llm_call

    result = unified_llm_call(
        scene_key=SCENE_KEY,
        variables={
            "files": list(files),
            "diff_excerpt": diff_excerpt,
            "truncated": bool(truncated),
        },
        user_id=user_id,
        organization_id=organization_id,
        selected_model_id=selected_model_id,
    )
    cleaned = clean_commit_message(result.content or "")
    if not cleaned:
        logger.warning(
            "[CommitMessageGenerator] empty cleaned message org=%s files=%s",
            organization_id,
            len(files),
        )
    return cleaned
