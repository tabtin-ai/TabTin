"""
OrganizationContext — 封装 WS 连接的 organization 身份集合。

用户级连接持有所有 membership 的 organization id（owner + member），
channel/open_api 角色仍为单 organization。
"""

from __future__ import annotations

from typing import FrozenSet, Iterator, Optional, Set


class OrganizationContext:
    """WS 连接的 organization 身份上下文。

    ``primary_id``  —— auth 时客户端声明的"默认前台" organization（可选）。
    ``all_ids``     —— 用户所属全部 organization id 的不可变集合。
    ``is_member()`` —— 统一的归属校验入口，所有 validator/handler 必须调用此方法。
    """

    __slots__ = ("_primary", "_all")

    def __init__(self, primary_id: Optional[str], all_ids: Set[str]):
        self._primary = primary_id
        self._all: FrozenSet[str] = frozenset(str(i) for i in all_ids)

    @property
    def primary_id(self) -> Optional[str]:
        return self._primary

    @property
    def all_ids(self) -> FrozenSet[str]:
        return self._all

    def is_member(self, organization_id: str) -> bool:
        return str(organization_id) in self._all

    def __iter__(self) -> Iterator[str]:
        return iter(self._all)

    def __bool__(self) -> bool:
        return bool(self._all)

    def __repr__(self) -> str:
        return f"OrganizationContext(primary={self._primary!r}, count={len(self._all)})"
