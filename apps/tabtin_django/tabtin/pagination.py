"""共享分页工具，供各 Django App 的 Admin API 使用。"""

from __future__ import annotations

from typing import Any


def paginate_queryset(
    qs,
    page: int = 1,
    page_size: int = 20,
    max_size: int = 200,
) -> tuple[list[Any], dict[str, int]]:
    """对 QuerySet 分页，返回 ``(items, pagination_meta)``。

    ``pagination_meta`` 包含 ``total``, ``page``, ``page_size``, ``total_pages``。
    """
    page = max(1, page)
    page_size = max(1, min(page_size, max_size))
    total = qs.count()
    offset = (page - 1) * page_size
    items = list(qs[offset: offset + page_size])
    total_pages = (total + page_size - 1) // page_size if total else 0
    return items, {
        "total": total,
        "page": page,
        "page_size": page_size,
        "total_pages": total_pages,
    }
