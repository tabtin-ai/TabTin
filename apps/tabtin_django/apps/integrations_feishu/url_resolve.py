"""飞书资源 URL → kind / token 解析（供 Agent 贴链接导入）。"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional
from urllib.parse import parse_qs, unquote, urlparse

from .constants import RESOURCE_KIND_BITABLE, RESOURCE_KIND_DOCX

# 路径段：/base/<token>、/docx/<token>；兼容 wiki / sheets / docs 标 unsupported
_PATH_KIND_RE = re.compile(
    r"/(?P<kind>base|bitable|docx|wiki|sheets|sheet|docs|doc)/(?P<token>[A-Za-z0-9_-]+)",
    re.IGNORECASE,
)

_SUPPORTED_HOST_SUFFIXES = (
    "feishu.cn",
    "larksuite.com",
    "larkoffice.com",
)

_UNSUPPORTED_REASONS = {
    "sheets": "飞书电子表格 Sheets 首期不支持，请导出后走 table import，或改用多维表",
    "sheet": "飞书电子表格 Sheets 首期不支持，请导出后走 table import，或改用多维表",
    "docs": "旧版云文档 Doc 首期不支持，请使用新版 Docx 链接",
    "doc": "旧版云文档 Doc 首期不支持，请使用新版 Docx 链接",
}


def _normalize_kind(path_kind: str) -> str:
    k = (path_kind or "").strip().lower()
    if k in ("base", "bitable"):
        return RESOURCE_KIND_BITABLE
    if k == "docx":
        return RESOURCE_KIND_DOCX
    return k


def parse_feishu_resource_url(raw: str) -> Dict[str, Any]:
    """解析单条飞书链接或裸 token。

    返回 dict：
      url, kind (bitable|docx|unsupported), token?, table_id?, error?
    不访问网络。
    """
    text = unquote((raw or "").strip())
    if not text:
        return {
            "url": raw or "",
            "kind": "unsupported",
            "token": None,
            "table_id": None,
            "error": "空链接",
        }

    # 允许裸 token：base/docx 风格的 token（长度启发式）
    if "://" not in text and "/" not in text and re.fullmatch(r"[A-Za-z0-9_-]{10,}", text):
        # 裸 token 无法区分 bitable/docx，标 unsupported 并提示
        return {
            "url": text,
            "kind": "unsupported",
            "token": text,
            "table_id": None,
            "error": "无法从裸 token 判断类型，请粘贴完整飞书链接（含 /base/ 或 /docx/）",
        }

    # 缺 scheme 时补 https，便于 urlparse
    candidate = text if "://" in text else f"https://{text.lstrip('/')}"

    parsed = urlparse(candidate)
    host = (parsed.netloc or "").lower()
    path = parsed.path or ""

    if host and not any(host == s or host.endswith("." + s) for s in _SUPPORTED_HOST_SUFFIXES):
        # 仍尝试从 path 解析（有人贴相对路径）；host 陌生则提示
        if not _PATH_KIND_RE.search(path):
            return {
                "url": text,
                "kind": "unsupported",
                "token": None,
                "table_id": None,
                "error": f"非飞书域名：{host or '(empty)'}",
            }

    match = _PATH_KIND_RE.search(path)
    if not match:
        return {
            "url": text,
            "kind": "unsupported",
            "token": None,
            "table_id": None,
            "error": "无法识别资源类型，请使用含 /base/ 或 /docx/ 的飞书链接",
        }

    path_kind = match.group("kind").lower()
    token = match.group("token")
    kind = _normalize_kind(path_kind)

    qs = parse_qs(parsed.query or "")
    table_id = None
    for key in ("table", "tableId", "table_id"):
        vals = qs.get(key) or []
        if vals and vals[0]:
            table_id = vals[0].strip()
            break

    # wiki：解析阶段先保留 token，enrich 时用 get_node 解析成 docx/bitable
    if kind == "wiki":
        return {
            "url": text,
            "kind": "wiki",
            "token": token,
            "table_id": table_id,
            "error": None,
        }

    if kind in _UNSUPPORTED_REASONS:
        return {
            "url": text,
            "kind": "unsupported",
            "token": token,
            "table_id": table_id,
            "error": _UNSUPPORTED_REASONS[kind if kind in _UNSUPPORTED_REASONS else path_kind],
        }

    if kind not in (RESOURCE_KIND_BITABLE, RESOURCE_KIND_DOCX):
        return {
            "url": text,
            "kind": "unsupported",
            "token": token,
            "table_id": table_id,
            "error": _UNSUPPORTED_REASONS.get(path_kind, f"不支持的资源类型：{path_kind}"),
        }

    return {
        "url": text,
        "kind": kind,
        "token": token,
        "table_id": table_id,
        "error": None,
    }


def enrich_resolved_with_access(
    client,
    access_token: str,
    item: Dict[str, Any],
) -> Dict[str, Any]:
    """用当前 OAuth 连接探测资源是否可见，并尽量补 name。

    ``client`` 为 ``FeishuClient`` 实例。失败不抛到上层，写入 accessible/error。
    wiki 节点会先 get_node 解析为 docx/bitable obj_token。
    """
    from .client import FeishuAPIError

    out = dict(item)
    kind = out.get("kind")
    token = out.get("token") or ""

    if kind == "wiki" and token:
        node = client.get_wiki_node(access_token, token)
        if not node:
            out["kind"] = "unsupported"
            out["accessible"] = False
            out["next_action"] = "reauth"
            out["error"] = (
                "无法解析该知识库节点（无权限或不存在）。"
                "请确认开放平台已开通 wiki:wiki:readonly（或 wiki:node:read），"
                "然后执行 tabtin feishu connection disconnect --yes 后重新 oauth start 授权"
            )
            out["hint"] = out["error"]
            return out
        if not node.get("selectable"):
            # 目录/容器：可见但不可直接 import；返回展开参数给 CLI/Agent
            space_id = str(node.get("space_id") or "").strip()
            node_token = str(node.get("node_token") or token).strip()
            has_child = bool(node.get("has_child"))
            expandable = bool(node.get("expandable") or has_child)
            out["kind"] = "wiki_node"
            out["name"] = node.get("name") or out.get("name")
            out["token"] = node_token
            out["space_id"] = space_id or None
            out["node_token"] = node_token
            out["has_child"] = has_child
            out["expandable"] = expandable
            if expandable and space_id:
                out["accessible"] = True
                out["error"] = None
                out["next_action"] = "wiki_nodes"
                out["hint"] = (
                    "这是知识库目录/容器节点，不能直接 import。"
                    f"请执行：tabtin feishu wiki nodes --space-id {space_id} "
                    f"--parent-node-token {node_token} --format json；"
                    "在返回项中选 selectable=true 且 import_kind 为 docx/bitable 的节点，"
                    "再用其 token 走 import（禁止用 browser/fetch 打开飞书网页）"
                )
            else:
                out["accessible"] = False
                out["error"] = (
                    "该知识库节点未挂载可导入的云文档或多维表，且无子节点可展开；"
                    "请在飞书中打开后复制具体的 /docx/ 或 /base/ 链接"
                )
                out["next_action"] = None
                out["hint"] = out["error"]
            return out
        out["kind"] = node["import_kind"]
        out["token"] = node["token"]
        out["name"] = node.get("name") or out.get("name")
        out["space_id"] = node.get("space_id")
        out["node_token"] = node.get("node_token") or token
        out["next_action"] = (
            "bitable_tables" if out["kind"] == RESOURCE_KIND_BITABLE else "import"
        )
        out["hint"] = (
            "已从知识库节点解析为可导入对象；"
            + (
                "请先 bitable tables 勾选表再 import preview/start"
                if out["kind"] == RESOURCE_KIND_BITABLE
                else "可直接写入 documents 列表后 import start"
            )
        )
        kind = out["kind"]
        token = out["token"]

    if kind not in (RESOURCE_KIND_BITABLE, RESOURCE_KIND_DOCX) or not token:
        out.setdefault("accessible", None)
        out.setdefault("name", None)
        return out

    try:
        if kind == RESOURCE_KIND_BITABLE:
            name = client.get_bitable_app_name(access_token, token)
            # list_tables 再确认可读
            tables = client.list_tables(access_token, token)
            out["accessible"] = True
            out["name"] = name or out.get("name")
            out["table_count"] = len(tables)
            if out.get("table_id"):
                ids = {t["table_id"] for t in tables}
                if out["table_id"] not in ids:
                    out["accessible"] = False
                    out["error"] = f"链接中的数据表 {out['table_id']} 在该 Base 下不可见或不存在"
        else:
            name = client.get_drive_file_name(access_token, token, doc_type="docx")
            if name is None:
                # meta 失败时用 content API 做存在性探活，但不保留正文
                client.get_docx_markdown(access_token, token)
                name = token
            out["accessible"] = True
            out["name"] = name
    except FeishuAPIError as exc:
        out["accessible"] = False
        out["name"] = out.get("name")
        out["error"] = f"当前飞书账号无法访问该资源：{exc}"
    return out


def resolve_feishu_urls(
    urls: List[str],
    *,
    client=None,
    access_token: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """批量解析；若提供 client + access_token 则做可见性探测。"""
    results: List[Dict[str, Any]] = []
    for raw in urls:
        parsed = parse_feishu_resource_url(raw)
        if (
            client is not None
            and access_token
            and parsed.get("kind") in (RESOURCE_KIND_BITABLE, RESOURCE_KIND_DOCX, "wiki")
            and not parsed.get("error")
        ):
            parsed = enrich_resolved_with_access(client, access_token, parsed)
        elif parsed.get("kind") == "wiki" and not (client and access_token):
            parsed = {
                **parsed,
                "kind": "unsupported",
                "error": (
                    "知识库链接需登录飞书连接后解析；"
                    "也可在导入弹窗「我的文档库 / 知识库」树中展开选择"
                ),
            }
        else:
            parsed.setdefault("accessible", None)
            parsed.setdefault("name", None)
        results.append(parsed)
    return results
