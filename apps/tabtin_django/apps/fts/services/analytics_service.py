"""SearchAnalytics 写入服务（Wave 5 PRD 6.4）。

设计要点：
    - **零侵入**：API 层 try/except swallow，分析失败不挡搜索成功响应
    - **同步写**：当前简单写入（PG 单插）；如果 QPS 飙到 > 1000/s 再考虑用
      Celery `transaction.on_commit` 异步入库（避免 API 端点同步等 PG）
    - **隐私收紧**：query 落库前**不**截断（管理后台需要看到原始 query 排查
      零结果），但调用方应在 PRD 5.5 评审后决定是否额外脱敏
    - **GDPR**：用户删除账号时，`fts_forget_user` 命令清理本表的 user_id 行

集成点：
    - `apps/fts/api.py:unified_search` 末尾调 `record_search_event(...)`
    - `apps/fts/api.py:click_log` 端点调 `record_click(...)`
"""
from __future__ import annotations

import logging
from typing import Any

from django.db import transaction

logger = logging.getLogger(__name__)


def record_search_event(
    *,
    user_id: str,
    organization_id: str,
    query: str,
    types: str,
    response: Any,
) -> None:
    """记录一次搜索事件。

    Args:
        response: SearchResponse 实例；读取 results / total / took_ms / degraded / notice
    """
    if not user_id or not organization_id:
        # 缺身份不写（避免污染分析）；上层 API 已处理这种情况
        return

    try:
        from apps.fts.models import SearchAnalytics
        # 用 transaction.on_commit 让分析写入与请求事务解耦：失败不影响响应
        # 注意：HTTP 视图本身没有显式事务（ATOMIC_REQUESTS 默认 false），
        # 直接 .create() 即可立即落库
        result_count = int(getattr(response, "total", 0) or 0)
        took_ms = int(getattr(response, "took_ms", 0) or 0)
        degraded = bool(getattr(response, "degraded", False))
        notice = getattr(response, "notice", None) or None

        SearchAnalytics.objects.using("postgresql").create(
            user_id=user_id,
            organization_id=organization_id,
            query=(query or "")[:2000],  # 防御性截断
            types=(types or "")[:64],
            result_count=result_count,
            took_ms=took_ms,
            degraded=degraded,
            notice=notice,
        )
    except Exception:  # pragma: no cover - 分析失败不阻塞业务
        logger.warning("[FTS][analytics] record_search_event failed", exc_info=True)


def record_click(
    *,
    user_id: str,
    organization_id: str,
    query: str,
    clicked_result_id: str,
    clicked_result_type: str,
    clicked_position: int,
) -> None:
    """记录用户点击搜索结果。

    简化策略：找最近 5 分钟内同 user + organization + query 的最新一条 SearchAnalytics，
    更新 clicked_* 字段。找不到（用户在历史搜索界面点击 / 隔太久）则忽略。
    """
    if not user_id or not organization_id:
        return
    try:
        from datetime import timedelta
        from django.utils import timezone

        from apps.fts.models import SearchAnalytics

        cutoff = timezone.now() - timedelta(minutes=5)
        row = (
            SearchAnalytics.objects
            .using("postgresql")
            .filter(
                user_id=user_id,
                organization_id=organization_id,
                query=(query or "")[:2000],
                created_at__gte=cutoff,
            )
            .order_by("-created_at")
            .first()
        )
        if row is None:
            return  # 5min 内无对应搜索记录，忽略
        row.clicked_result_id = (clicked_result_id or "")[:64]
        row.clicked_result_type = (clicked_result_type or "")[:32]
        row.clicked_position = int(clicked_position)
        row.save(
            using="postgresql",
            update_fields=["clicked_result_id", "clicked_result_type", "clicked_position"],
        )
    except Exception:  # pragma: no cover
        logger.warning("[FTS][analytics] record_click failed", exc_info=True)


def forget_user(*, user_id: str) -> int:
    """GDPR 合规：删除某用户的全部 SearchAnalytics 行。

    Returns: 删除的行数。
    """
    if not user_id:
        return 0
    try:
        from apps.fts.models import SearchAnalytics
        deleted, _ = (
            SearchAnalytics.objects
            .using("postgresql")
            .filter(user_id=user_id)
            .delete()
        )
        return int(deleted or 0)
    except Exception:  # pragma: no cover
        logger.warning("[FTS][analytics] forget_user failed", exc_info=True)
        return 0


__all__ = ["record_search_event", "record_click", "forget_user"]
