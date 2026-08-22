from __future__ import annotations

from typing import Any, Dict, List, Optional
from uuid import UUID

from ninja import Schema


class ConnectionOut(Schema):
    connected: bool
    display_name: Optional[str] = None
    open_id: Optional[str] = None
    updated_at: Optional[str] = None
    provider_configured: bool = False
    provider_status: Optional[str] = None
    can_manage_provider: bool = False
    provider_app_id: Optional[str] = None


class OAuthProviderIn(Schema):
    organization_id: UUID
    app_id: str
    app_secret: str


class OAuthProviderOut(Schema):
    configured: bool
    can_manage: bool
    app_id: Optional[str] = None
    status: Optional[str] = None
    verified_at: Optional[str] = None


class AuthorizeUrlOut(Schema):
    authorize_url: str


class BitableAppOut(Schema):
    app_token: str
    name: str


class ImportableResourceOut(Schema):
    """同通道可导入资源：kind=bitable|docx。"""

    token: str
    name: str
    kind: str
    wiki_node_token: Optional[str] = None


class BitableTableOut(Schema):
    table_id: str
    name: str


class ImportTableIn(Schema):
    app_token: str
    table_id: str
    name: Optional[str] = None


class ImportDocumentIn(Schema):
    doc_token: str
    name: Optional[str] = None
    doc_type: str = "docx"


class ImportRequestIn(Schema):
    organization_id: UUID
    space_id: UUID
    collection_id: Optional[UUID] = None
    tables: List[ImportTableIn] = []
    documents: List[ImportDocumentIn] = []
    include_attachments: bool = False


class ImportPreviewIn(Schema):
    organization_id: UUID
    tables: List[ImportTableIn]


class ImportPreviewTableOut(Schema):
    app_token: str
    table_id: str
    name: str
    selected: bool = False
    auto_included: bool = False


class ImportPreviewEdgeOut(Schema):
    app_token: str
    from_table_id: str
    from_table_name: str
    field_name: str
    to_table_id: str
    to_table_name: str
    duplex: bool = False
    same_base: bool = True


class ImportPreviewOut(Schema):
    tables: List[ImportPreviewTableOut]
    edges: List[ImportPreviewEdgeOut]
    warnings: List[str]
    has_attachments: bool = False


class ImportStartOut(Schema):
    task_id: str


class ImportStatusOut(Schema):
    task_id: str
    status: str
    result: Optional[Dict[str, Any]] = None
    error: Optional[str] = None


class ImportTableActionIn(Schema):
    app_token: str
    table_id: str


class ImportTableActionOut(Schema):
    ok: bool = True


class ResolveUrlsIn(Schema):
    organization_id: UUID
    urls: List[str]


class ParseFlowIn(Schema):
    organization_id: UUID
    url: str


class ResolveUrlItemOut(Schema):
    url: str
    kind: str  # bitable | docx | wiki_node | unsupported
    token: Optional[str] = None
    table_id: Optional[str] = None
    name: Optional[str] = None
    accessible: Optional[bool] = None
    table_count: Optional[int] = None
    error: Optional[str] = None
    # wiki 容器节点：供 Agent 用 wiki nodes 展开（不要改走浏览器）
    space_id: Optional[str] = None
    node_token: Optional[str] = None
    has_child: Optional[bool] = None
    expandable: Optional[bool] = None
    next_action: Optional[str] = None  # wiki_nodes | bitable_tables | import
    hint: Optional[str] = None


class ResolveUrlsOut(Schema):
    items: List[ResolveUrlItemOut]


class BrowseNodeOut(Schema):
    """飞书导入树节点（云盘文件夹 / 知识库空间与节点 / 可导入叶子）。"""

    id: str
    name: str
    node_kind: str  # folder | wiki_space | wiki_node | bitable | docx
    selectable: bool = False
    expandable: bool = False
    token: Optional[str] = None
    import_kind: Optional[str] = None  # bitable | docx
    folder_token: Optional[str] = None
    space_id: Optional[str] = None
    node_token: Optional[str] = None
    has_child: Optional[bool] = None


class BrowseChildrenOut(Schema):
    items: List[BrowseNodeOut]
    next_page_token: Optional[str] = None
    has_more: bool = False
