"""飞书导入前关联闭包分析（纯逻辑 + client 拉字段）。"""

from __future__ import annotations

from typing import Any, Dict, List, Set, Tuple

from .field_mapping import (
    FEISHU_TYPE_ATTACHMENT,
    feishu_type_int,
    link_target_table_ids,
)


def extract_link_targets(field: Dict[str, Any]) -> Tuple[List[str], bool]:
    """从飞书 Link 字段解析目标 table_id 列表与是否双向。"""
    return link_target_table_ids(field)


def build_import_preview(
    *,
    selected: List[Dict[str, str]],
    tables_by_app: Dict[str, List[Dict[str, str]]],
    fields_by_table: Dict[Tuple[str, str], List[Dict[str, Any]]],
) -> Dict[str, Any]:
    """根据已选表与字段元数据计算闭包、边与警告。

    selected: [{app_token, table_id, name?}]
    tables_by_app: app_token → [{table_id, name}]
    fields_by_table: (app_token, table_id) → 飞书 fields
    """
    name_index: Dict[Tuple[str, str], str] = {}
    for app_token, tables in tables_by_app.items():
        for t in tables:
            tid = t.get("table_id") or ""
            if tid:
                name_index[(app_token, tid)] = t.get("name") or tid

    selected_keys: Set[Tuple[str, str]] = set()
    seed: List[Tuple[str, str]] = []
    for row in selected:
        app = row.get("app_token") or ""
        tid = row.get("table_id") or ""
        if not app or not tid:
            continue
        key = (app, tid)
        if key in selected_keys:
            continue
        selected_keys.add(key)
        seed.append(key)
        # 客户端若尚不知表名，常把 table_id 当 name 传来；勿覆盖 list_tables 的真名
        preferred = str(row.get("name") or "").strip()
        if preferred and preferred != tid:
            name_index[key] = preferred

    # BFS 同 Base 闭包
    closure: Set[Tuple[str, str]] = set(selected_keys)
    queue = list(seed)
    edges: List[Dict[str, Any]] = []
    warnings: List[str] = []
    seen_edge: Set[Tuple[str, str, str, str]] = set()

    while queue:
        app_token, table_id = queue.pop(0)
        fields = fields_by_table.get((app_token, table_id)) or []
        for field in fields:
            targets, duplex = extract_link_targets(field)
            field_name = (field.get("field_name") or field.get("name") or "").strip() or "关联"
            for target_id in targets:
                # 飞书 Link 目标通常同 Base；若带 app 信息则另议
                target_key = (app_token, target_id)
                edge_key = (app_token, table_id, target_id, field_name)
                if edge_key not in seen_edge:
                    seen_edge.add(edge_key)
                    known = target_id in {t.get("table_id") for t in tables_by_app.get(app_token) or []}
                    edges.append(
                        {
                            "app_token": app_token,
                            "from_table_id": table_id,
                            "from_table_name": name_index.get((app_token, table_id), table_id),
                            "field_name": field_name,
                            "to_table_id": target_id,
                            "to_table_name": name_index.get(target_key, target_id),
                            "duplex": duplex,
                            "same_base": known,
                        }
                    )
                    if not known:
                        warnings.append(
                            f"表「{name_index.get((app_token, table_id), table_id)}」的关联"
                            f"「{field_name}」指向未知表 {target_id}，将降级为文本"
                        )
                        continue
                if target_key not in closure:
                    closure.add(target_key)
                    queue.append(target_key)

    tables_out: List[Dict[str, Any]] = []
    for app_token, table_id in sorted(closure, key=lambda k: (k[0], name_index.get(k, k[1]))):
        tables_out.append(
            {
                "app_token": app_token,
                "table_id": table_id,
                "name": name_index.get((app_token, table_id), table_id),
                "selected": (app_token, table_id) in selected_keys,
                "auto_included": (app_token, table_id) not in selected_keys,
            }
        )

    has_attachments = False
    for key in closure:
        for field in fields_by_table.get(key) or []:
            if feishu_type_int(field) == FEISHU_TYPE_ATTACHMENT:
                has_attachments = True
                break
        if has_attachments:
            break

    return {
        "tables": tables_out,
        "edges": edges,
        "warnings": warnings,
        "has_attachments": has_attachments,
    }
