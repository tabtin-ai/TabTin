"""
TabMemo 全文搜索向量维护

将 search_vector 更新逻辑统一到此模块，供 tasks.py 和 memo_service.py 共用。
"""

from __future__ import annotations

import logging

from apps.tabmemo.constants import SEARCH_VECTOR_MAX_LEN, TABMEMO_DB

logger = logging.getLogger(__name__)


def refresh_search_vector(memo) -> None:
    """更新 memo 的 PostgreSQL 全文搜索向量。

    合并 plaintext / markdown / bookmark / tags / ai_tags 为一个 tsvector，
    截断至 SEARCH_VECTOR_MAX_LEN 字符以控制索引大小。
    """
    from django.db import connections

    try:
        plaintext = memo.content_plaintext or ""
        markdown = memo.content_markdown or ""
        bookmark_text = " ".join(
            filter(None, [memo.bookmark_title, memo.bookmark_description])
        )
        tags_text = " ".join(memo.tags or [])
        ai_tags_text = " ".join(memo.ai_tags or [])
        combined = " ".join(filter(None, [plaintext, markdown, bookmark_text, tags_text, ai_tags_text]))

        if not combined.strip():
            return

        truncated = combined[:SEARCH_VECTOR_MAX_LEN]
        conn = connections[TABMEMO_DB]
        if conn.vendor != "postgresql":
            return

        with conn.cursor() as cursor:
            cursor.execute(
                """
                UPDATE tabmemo_memo
                SET search_vector = to_tsvector('simple', %s)
                WHERE id = %s
                """,
                [truncated, str(memo.pk)],
            )
    except Exception:
        logger.error(
            "search_vector 更新失败 memo %s", memo.pk, exc_info=True
        )
