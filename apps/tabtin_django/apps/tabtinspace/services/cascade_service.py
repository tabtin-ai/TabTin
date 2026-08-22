"""
Wave 5 § 7 + ：OrganizationMember 离队级联

当 admin 移除某个用户出 organization 时（post_delete signal）：

1. 失活该用户在该 organization 下所有 Document / Table 的 active permission，并通知：
   - 离队用户本人：每个失活资源一条 ``auto_removed`` 通知（D7 5 分钟去重窗口）。
   - 每个受影响的资源 owner（按 owner_id 分组）：一条 ``resource_shared``
     汇总通知，列出该 owner 名下被失活的资源标题。

2. ：将该用户在本组织下作为 ``owner_id`` 的云资源批量改挂组织 Owner，
   并给组织 Owner 发一条 ``owner_reassigned_summary`` 汇总通知（飞书式交接）。
   不转交个人 Space / 设备目录。

跨库注意：
- Document / DocumentPermission 在 ``postgresql`` alias；
- Table / TablePermission 在 ``TABDATA_DB_ALIAS``（实际同样指向 ``postgresql``）；
- User 在 ``default`` alias。
所有查询显式 ``.using(...)``，绝不依赖 select_related 触发跨库 join。

汇报：参考 PRD §五块 7；产品口径见 GitHub 。
"""
from __future__ import annotations

import logging
from collections import defaultdict
from typing import Iterable

from django.db import transaction

from apps.services.common.db_router import postgres_app_db_alias


logger = logging.getLogger("tabtinspace.cascade")


# Notification 与 user 都在 default alias；
# DocumentPermission / TablePermission 路由到 postgres_app_db_alias()（single_pg 即 default）。
_TABDOC_DB = postgres_app_db_alias()


def _resolve_organization_name(organization_id: str) -> str:
    """取组织展示名；查不到时返回空串，由调用方决定文案回退。"""
    from apps.tabtinspace.models import Organization

    org = (
        Organization.objects.using(postgres_app_db_alias())
        .filter(id=organization_id)
        .only("name")
        .first()
    )
    if org is None:
        return ""
    return (org.name or "").strip()


def _resolve_user_display_name(user_id: str) -> str:
    """从 default 库取一个稳定的 display 字符串，避免在通知文案里出现 UUID。"""
    from django.contrib.auth import get_user_model

    User = get_user_model()
    user = User.objects.using("default").filter(id=user_id).first()
    if user is None:
        return ""
    nickname = getattr(user, "nickname", "") or getattr(user, "username", "")
    if nickname:
        return nickname
    email = getattr(user, "email", "") or ""
    if email and "@" in email:
        return email.split("@", 1)[0]
    return str(user_id)[:8]


def _join_titles(titles: Iterable[str], limit: int = 5) -> str:
    """汇总通知 body 用：最多列前 limit 个，多出来折叠为 ``、…等 N 个``。"""
    items = [t or "（未命名）" for t in titles]
    if not items:
        return ""
    if len(items) <= limit:
        return "、".join(f"《{t}》" for t in items)
    head = "、".join(f"《{t}》" for t in items[:limit])
    return f"{head} 等 {len(items)} 个"


def cascade_deactivate_resource_permissions(
    organization_id: str,
    user_id: str,
    user_name: str = "",
) -> dict:
    """离队级联失活资源权限 + 触发汇总通知。

    参数：
        organization_id: 触发离队的 organization UUID（字符串）。
        user_id:     离队的用户 UUID（字符串）。
        user_name:   离队用户的展示名（可选；未传时尝试从 default 库回查）。

    返回：
        ``{'deactivated_docs': int, 'deactivated_tables': int,
           'owner_notified': int, 'user_notified': int}`` —— 仅用于日志与测试断言。

    本函数自身不抛异常：任一子步骤失败均记 warning 后继续，
    确保 admin 删成员的主事务不会因为通知 / 跨库查询波动被回滚。
    """
    organization_id_str = str(organization_id) if organization_id else ""
    user_id_str = str(user_id) if user_id else ""

    if not organization_id_str or not user_id_str:
        return {
            "deactivated_docs": 0,
            "deactivated_tables": 0,
            "owner_notified": 0,
            "user_notified": 0,
        }

    if not user_name:
        try:
            user_name = _resolve_user_display_name(user_id_str)
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning("[cascade] resolve user_name 失败: %s", exc)
            user_name = ""

    deactivated_docs, doc_items_by_owner, doc_items_for_user = (
        _deactivate_doc_permissions(organization_id_str, user_id_str)
    )
    deactivated_tables, table_items_by_owner, table_items_for_user = (
        _deactivate_table_permissions(organization_id_str, user_id_str)
    )

    # 给离队用户本人逐条 auto_removed（复用 share_service _schedule_notify）。
    user_notified = _notify_leaving_user(
        user_id_str, doc_items_for_user, table_items_for_user, organization_id_str,
    )

    # 给每个受影响的 owner 一条汇总通知（doc + table 合并到同一 owner_id 下）。
    owner_notified = _notify_owners_summary(
        organization_id_str, user_id_str, user_name,
        doc_items_by_owner, table_items_by_owner,
    )

    return {
        "deactivated_docs": deactivated_docs,
        "deactivated_tables": deactivated_tables,
        "owner_notified": owner_notified,
        "user_notified": user_notified,
    }


def _deactivate_doc_permissions(
    organization_id: str, user_id: str,
) -> tuple[int, dict[str, list[dict]], list[dict]]:
    """失活该 user 在该 organization 下所有 active DocumentPermission。

    返回 (失活数, {owner_id: [{doc, ...}]}, [{doc, ...}] 给离队用户用)
    """
    from apps.tabdoc.models import Document, DocumentPermission

    perms = list(
        DocumentPermission.objects.using(_TABDOC_DB)
        .filter(
            is_active=True,
            subject_type="user",
            subject_id=user_id,
            document__organization_id=organization_id,
        )
        .select_related("document")
    )

    if not perms:
        return 0, {}, []

    by_owner: dict[str, list[dict]] = defaultdict(list)
    for_user: list[dict] = []

    deactivated = 0
    with transaction.atomic(using=_TABDOC_DB):
        for p in perms:
            try:
                doc: Document = p.document
                p.is_active = False
                p.save(using=_TABDOC_DB, update_fields=["is_active", "updated_at"])
                deactivated += 1

                owner_id = str(getattr(doc, "owner_id", "") or "")
                item = {
                    "resource_type": "doc",
                    "resource_id": str(doc.id),
                    "resource_title": doc.title or "",
                    "organization_id": str(getattr(doc, "organization_id", "") or organization_id),
                    "space_id": str(getattr(doc, "space_id", "") or ""),
                    "permission_from": p.permission,
                }
                if owner_id and owner_id != user_id:
                    by_owner[owner_id].append(item)
                for_user.append(item)
            except Exception as exc:
                logger.warning(
                    "[cascade] 失活 DocumentPermission %s 失败: %s",
                    getattr(p, "id", "?"), exc,
                )

    return deactivated, dict(by_owner), for_user


def _deactivate_table_permissions(
    organization_id: str, user_id: str,
) -> tuple[int, dict[str, list[dict]], list[dict]]:
    """失活该 user 在该 organization 下所有 active TablePermission。"""
    from apps.tabdata.constants import TABDATA_DB_ALIAS
    from apps.tabdata.models import Table, TablePermission

    perms = list(
        TablePermission.objects.using(TABDATA_DB_ALIAS)
        .filter(
            is_active=True,
            subject_type="user",
            subject_id=user_id,
            table__organization_id=organization_id,
        )
        .select_related("table")
    )

    if not perms:
        return 0, {}, []

    by_owner: dict[str, list[dict]] = defaultdict(list)
    for_user: list[dict] = []

    deactivated = 0
    with transaction.atomic(using=TABDATA_DB_ALIAS):
        for p in perms:
            try:
                table: Table = p.table
                p.is_active = False
                p.save(using=TABDATA_DB_ALIAS, update_fields=["is_active", "updated_at"])
                deactivated += 1

                owner_id = str(getattr(table, "owner_id", "") or "")
                item = {
                    "resource_type": "table",
                    "resource_id": str(table.id),
                    "resource_title": getattr(table, "name", "") or "",
                    "organization_id": str(getattr(table, "organization_id", "") or organization_id),
                    "space_id": str(getattr(table, "space_id", "") or ""),
                    "permission_from": p.permission,
                }
                if owner_id and owner_id != user_id:
                    by_owner[owner_id].append(item)
                for_user.append(item)
            except Exception as exc:
                logger.warning(
                    "[cascade] 失活 TablePermission %s 失败: %s",
                    getattr(p, "id", "?"), exc,
                )

    return deactivated, dict(by_owner), for_user


def _notify_leaving_user(
    user_id: str,
    doc_items: list[dict],
    table_items: list[dict],
    organization_id: str,
) -> int:
    """对离队用户：每个失活资源一条 auto_removed 通知（复用 share_service D7 去重）。"""
    if not doc_items and not table_items:
        return 0

    from apps.services.notification.services.notification_service import NotificationService

    count = 0

    def _push(item: dict, resource_type: str) -> None:
        # 不走 share_service._schedule_notify —— 那个 helper 要求传 Document / Table 对象；
        # 这里我们已经把所有需要的字段都装进 item dict，直接组装通知 metadata 即可。
        metadata = {
            "resource_type": resource_type,
            "resource_id": item["resource_id"],
            "resource_title": item["resource_title"],
            "action": "auto_removed",
            "permission_from": item.get("permission_from"),
            "permission_to": None,
            "inviter_id": "",
            "inviter_name": "",
            "organization_id": item.get("organization_id", "") or organization_id,
            "space_id": item.get("space_id", "") or "",
            "behavior": "notification_only",
        }
        title = (
            f"因离开组织，你已从《{item['resource_title'] or '（未命名）'}》移除"
        )
        try:
            NotificationService.notify(
                user_id=str(user_id),
                type="resource_shared",
                title=title,
                body="",
                metadata=metadata,
                organization_id=metadata["organization_id"],
            )
            return True
        except Exception as exc:
            logger.warning("[cascade] auto_removed 通知失败 (user=%s): %s", user_id, exc)
            return False

    for item in doc_items:
        if _push(item, "doc"):
            count += 1
    for item in table_items:
        if _push(item, "table"):
            count += 1

    return count


def _notify_owners_summary(
    organization_id: str,
    user_id: str,
    user_name: str,
    doc_items_by_owner: dict[str, list[dict]],
    table_items_by_owner: dict[str, list[dict]],
) -> int:
    """给每个受影响的 owner 一条汇总通知。

    Doc + Table 合并到同一个 owner_id（owner 可能同时拥有 doc 和 table）。
    使用 NotificationService.notify 直接发，type='resource_shared'。
    """
    if not doc_items_by_owner and not table_items_by_owner:
        return 0

    from apps.services.notification.services.notification_service import NotificationService

    combined: dict[str, dict] = defaultdict(lambda: {"docs": [], "tables": []})
    for owner_id, items in doc_items_by_owner.items():
        combined[owner_id]["docs"].extend(items)
    for owner_id, items in table_items_by_owner.items():
        combined[owner_id]["tables"].extend(items)

    notified = 0
    display_user = user_name or "（已离队成员）"

    for owner_id, bucket in combined.items():
        docs = bucket["docs"]
        tables = bucket["tables"]
        total = len(docs) + len(tables)
        if total == 0:
            continue

        # 合并所有 title 用于 body 文案；resource_type 用 'mixed' 表示同时含 doc/table。
        all_titles = [it["resource_title"] for it in docs] + [it["resource_title"] for it in tables]
        title_list = _join_titles(all_titles)

        # 取一个 space_id 用于通知顶层字段（NotificationService 会把 metadata.space_id 提到列）。
        # 优先 doc[0] → table[0]，都没有就空串。
        space_id = ""
        for it in docs + tables:
            if it.get("space_id"):
                space_id = it["space_id"]
                break

        title = f"{display_user} 离开了组织"
        body = f"已自动从 {total} 个资源移除：{title_list}" if title_list else f"已自动从 {total} 个资源移除"

        # 拆分给 metadata 用：让前端可以选择跳到任一资源。
        resources_brief = [
            {
                "resource_type": it["resource_type"],
                "resource_id": it["resource_id"],
                "resource_title": it["resource_title"],
            }
            for it in (docs + tables)
        ]

        metadata = {
            "resource_type": "mixed" if docs and tables else (docs[0]["resource_type"] if docs else tables[0]["resource_type"]),
            "resource_id": (docs[0]["resource_id"] if docs else tables[0]["resource_id"]),
            "resource_title": (docs[0]["resource_title"] if docs else tables[0]["resource_title"]),
            "action": "auto_removed_summary",
            "removed_user_id": str(user_id),
            "removed_user_name": display_user,
            "organization_id": organization_id,
            "space_id": space_id,
            "resources": resources_brief,
            "total_removed": total,
            "behavior": "notification_only",
        }

        try:
            NotificationService.notify(
                user_id=str(owner_id),
                type="resource_shared",
                title=title,
                body=body,
                metadata=metadata,
                organization_id=organization_id,
            )
            notified += 1
        except Exception as exc:
            logger.warning("[cascade] owner 汇总通知失败 (owner=%s): %s", owner_id, exc)

    return notified


# ── ：离队时将离队者拥有的组织云资源转交组织 Owner ──


def _get_reassignable_resource_specs() -> list[tuple[str, type, str, str]]:
    """可转交的组织云资源：(resource_type, Model, db_alias, title_field)。

    覆盖 ``_get_organization_resource_models()`` 中有 owner 的模型，并补上
    MemoCollection / Site。不含个人 Space、Tin、ContextItem 等无 owner 语义的实体。

    按 ``get_model`` 跳过未装载的 app（如 ``settings_share_test`` 仅含
    tabdoc/tabdata），避免一次 LookupError 打挂整段转交。
    """
    from django.apps import apps as django_apps

    from apps.tabdata.constants import TABDATA_DB_ALIAS

    db = _TABDOC_DB
    specs: list[tuple[str, type, str, str]] = []

    candidates: list[tuple[str, str, str, str, str]] = [
        # resource_type, app_label, model_name, db_alias, title_field
        ("doc", "tabdoc", "Document", db, "title"),
        ("table", "tabdata", "Table", TABDATA_DB_ALIAS, "name"),
        ("slide", "tabslide", "SlideProject", db, "name"),
        ("video", "tabvideo", "VideoProject", db, "name"),
        ("canvas", "tabwhiteboard", "Canvas", db, "name"),
        ("memo", "tabmemo", "Memo", db, "content_plaintext"),
        ("memo_collection", "tabmemo", "MemoCollection", db, "title"),
        ("site", "tabsite", "Site", db, "name"),
    ]

    for resource_type, app_label, model_name, alias, title_field in candidates:
        try:
            model = django_apps.get_model(app_label, model_name)
        except LookupError:
            continue
        specs.append((resource_type, model, alias, title_field))
    return specs


def _resource_display_title(resource_type: str, row: dict, title_field: str) -> str:
    raw = (row.get(title_field) or "").strip()
    if resource_type == "memo":
        if raw:
            first_line = raw.split("\n", 1)[0]
            return first_line[:50]
        bookmark = (row.get("bookmark_title") or "").strip()
        if bookmark:
            return bookmark[:50]
        return "未命名碎片"
    return raw or "（未命名）"


def cascade_reassign_owned_resources(
    organization_id: str,
    user_id: str,
    org_owner_id: str,
    user_name: str = "",
) -> dict:
    """将离队用户在本组织下拥有的云资源 ``owner_id`` 改挂组织 Owner，并通知 Owner。

    参数：
        organization_id: 组织 UUID 字符串。
        user_id: 离队用户 UUID 字符串。
        org_owner_id: 组织 Owner 的 user UUID 字符串（接手人）。
        user_name: 离队用户展示名（可选）。

    返回：
        ``{'reassigned': int, 'by_type': {resource_type: int}, 'owner_notified': int}``

    本函数自身不抛异常：单模型失败记 warning 后继续，不回滚成员删除。
    """
    organization_id_str = str(organization_id) if organization_id else ""
    user_id_str = str(user_id) if user_id else ""
    org_owner_id_str = str(org_owner_id) if org_owner_id else ""

    empty = {"reassigned": 0, "by_type": {}, "owner_notified": 0}
    if not organization_id_str or not user_id_str or not org_owner_id_str:
        return empty
    if user_id_str == org_owner_id_str:
        return empty

    if not user_name:
        try:
            user_name = _resolve_user_display_name(user_id_str)
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning("[cascade] reassign resolve user_name 失败: %s", exc)
            user_name = ""

    reassigned_items: list[dict] = []
    by_type: dict[str, int] = {}

    specs = _get_reassignable_resource_specs()
    if not specs:
        logger.warning(
            "[cascade] 无可转交资源规格 (org=%s user=%s)",
            organization_id_str, user_id_str,
        )
        return empty

    for resource_type, model, db_alias, title_field in specs:
        try:
            qs = model.objects.using(db_alias).filter(
                organization_id=organization_id_str,
                owner_id=user_id_str,
            ).exclude(owner_id=org_owner_id_str)

            value_fields = ["id", title_field]
            if resource_type == "memo" and hasattr(model, "bookmark_title"):
                value_fields.append("bookmark_title")

            rows = list(qs.values(*value_fields))
            if not rows:
                continue

            with transaction.atomic(using=db_alias):
                updated = (
                    model.objects.using(db_alias)
                    .filter(
                        organization_id=organization_id_str,
                        owner_id=user_id_str,
                    )
                    .exclude(owner_id=org_owner_id_str)
                    .update(owner_id=org_owner_id_str)
                )

            if updated:
                by_type[resource_type] = updated
                for row in rows:
                    reassigned_items.append(
                        {
                            "resource_type": resource_type,
                            "resource_id": str(row["id"]),
                            "resource_title": _resource_display_title(
                                resource_type, row, title_field,
                            ),
                        }
                    )
        except Exception as exc:
            logger.warning(
                "[cascade] 转交 %s owner 失败 (org=%s user=%s): %s",
                resource_type, organization_id_str, user_id_str, exc,
            )

    owner_notified = 0
    if reassigned_items:
        owner_notified = _notify_org_owner_reassign_summary(
            organization_id=organization_id_str,
            leaving_user_id=user_id_str,
            org_owner_id=org_owner_id_str,
            user_name=user_name,
            items=reassigned_items,
        )

    return {
        "reassigned": len(reassigned_items),
        "by_type": by_type,
        "owner_notified": owner_notified,
    }


def _notify_org_owner_reassign_summary(
    organization_id: str,
    leaving_user_id: str,
    org_owner_id: str,
    user_name: str,
    items: list[dict],
) -> int:
    """给组织 Owner 发一条飞书式转交汇总通知。"""
    if not items:
        return 0

    from apps.services.notification.services.notification_service import NotificationService

    display_user = user_name or "（已离队成员）"
    try:
        organization_name = _resolve_organization_name(organization_id)
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning(
            "[cascade] reassign resolve organization_name 失败 (org=%s): %s",
            organization_id, exc,
        )
        organization_name = ""
    total = len(items)
    title_list = _join_titles(it["resource_title"] for it in items)
    if organization_name:
        title = f"{display_user}从组织{organization_name}移除，已将创建的资料转移到你的名下"
    else:
        title = f"{display_user}从组织移除，已将创建的资料转移到你的名下"
    body = (
        f"共 {total} 项：{title_list}" if title_list else f"共 {total} 项资料已转交"
    )

    resources_brief = [
        {
            "resource_type": it["resource_type"],
            "resource_id": it["resource_id"],
            "resource_title": it["resource_title"],
        }
        for it in items
    ]

    metadata = {
        "resource_type": "mixed" if len({it["resource_type"] for it in items}) > 1 else items[0]["resource_type"],
        "resource_id": items[0]["resource_id"],
        "resource_title": items[0]["resource_title"],
        "action": "owner_reassigned_summary",
        "reassigned_user_id": str(leaving_user_id),
        "reassigned_user_name": display_user,
        "new_owner_id": str(org_owner_id),
        "organization_id": organization_id,
        "organization_name": organization_name,
        "resources": resources_brief,
        "total_reassigned": total,
        "behavior": "notification_only",
    }

    try:
        NotificationService.notify(
            user_id=str(org_owner_id),
            type="resource_shared",
            title=title,
            body=body,
            metadata=metadata,
            organization_id=organization_id,
        )
        return 1
    except Exception as exc:
        logger.warning(
            "[cascade] org owner 转交通知失败 (owner=%s): %s",
            org_owner_id, exc,
        )
        return 0
