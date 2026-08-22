"""
TabMemo REST API

薄 API 层：参数解析 → 调用 MemoService → 格式化响应。
"""

from __future__ import annotations

import logging
import uuid as _uuid
from html.parser import HTMLParser
from urllib.parse import urlparse as _urlparse

from ninja import Router

from apps.users.auth.permissions import JWTAuth

from apps.i18n.response import (
    success_response,
    error_response_with_status,
    validation_error_response,
)
from apps.tabmemo.models import (
    Memo,
    MemoCollection,
    MemoCollectionMembership,
)
from apps.tabmemo.schemas import (
    AttachmentAddRequest,
    AttachmentOut,
    BookmarkPreviewOut,
    BookmarkPreviewRequest,
    CollectionAddMemosRequest,
    CollectionBriefOut,
    CollectionCreateRequest,
    CollectionOut,
    CollectionUpdateRequest,
    MemoBatchRequest,
    MemoCreateRequest,
    MemoDetail,
    MemoGrantCreateRequest,
    MemoGrantOut,
    MemoPinRequest,
    MemoSummary,
    MemoUpdateRequest,
    RecordStyleUpdateRequest,
)
from apps.tabmemo.constants import (
    BOOKMARK_MAX_READ_BYTES,
    BOOKMARK_TIMEOUT_SECONDS,
    DEFAULT_PAGE_SIZE,
)
from apps.tabmemo.error_codes import ErrorCode
from apps.tabmemo.services.memo_service import MemoService

logger = logging.getLogger(__name__)

router = Router(tags=["TabMemo"])

jwt_auth = JWTAuth()

CREATED_RESPONSE_SCHEMA = {
    201: dict,
    400: dict,
    401: dict,
    403: dict,
    404: dict,
    429: dict,
    500: dict,
}


# ── 序列化工具 ──


def _serialize_summary(m: Memo) -> dict:
    attachment_count = getattr(m, "attachment_count", None)
    if attachment_count is None:
        attachment_count = m.attachments.count() if m.pk else 0
    return MemoSummary(
        id=str(m.id),
        space_id=str(m.space_id) if m.space_id else None,
        agent_id=str(m.agent_id) if getattr(m, "agent_id", None) else None,
        memo_type=m.memo_type or "note",
        importance=m.importance,
        content_plaintext=_truncate_plaintext((m.content_plaintext or ""), 200),
        content_markdown=_truncate_plaintext((m.content_markdown or ""), 500),
        tags=m.tags or [],
        ai_tags=m.ai_tags or [],
        color=m.color or "",
        source=m.source or "manual",
        status=m.status or "active",
        is_pinned=m.is_pinned,
        bookmark_url=m.bookmark_url or "",
        bookmark_title=m.bookmark_title or "",
        bookmark_image=m.bookmark_image or "",
        attachment_count=attachment_count,
        created_at=m.created_at.isoformat(),
        updated_at=m.updated_at.isoformat(),
    ).dict()


def _truncate_plaintext(text: str, max_len: int) -> str:
    """截断文本并在超长时添加省略标记。"""
    if len(text) <= max_len:
        return text
    return text[:max_len] + "..."


def _maybe_presign_url(file_url: str) -> str:
    """TMEMO-3: 若 file_url 是 OSS access_url（非 CDN），尝试生成 presigned URL，
    确保私有 Bucket 下附件可正常访问。公开 Bucket 或外部 URL 原样返回。"""
    if not file_url:
        return file_url
    try:
        from urllib.parse import urlparse
        parsed = urlparse(file_url)
        hostname = parsed.hostname or ''
        if '.aliyuncs.com' in hostname or '.oss-cn-' in hostname:
            object_key = parsed.path.lstrip('/')
            from apps.services.oss.services.factory import get_oss_service
            oss = get_oss_service()
            url = oss.generate_presigned_url(object_key, expiration=3600)
            if url:
                return url
    except Exception:
        pass
    return file_url


def _serialize_detail(m: Memo, *, viewer_user_id: str | None = None) -> dict:
    attachments = [
        AttachmentOut(
            id=str(a.id),
            file_type=a.file_type,
            file_url=_maybe_presign_url(a.file_url),
            file_name=a.file_name,
            file_size=a.file_size,
            mime_type=a.mime_type or "",
            thumbnail_url=a.thumbnail_url or "",
            sort_order=a.sort_order,
            created_at=a.created_at.isoformat(),
        ).dict()
        for a in m.attachments.all()
    ]

    memberships = m.collection_memberships.all()
    collections = [
        CollectionBriefOut(
            id=str(ms.collection.id),
            title=ms.collection.title,
            icon=ms.collection.icon or "",
            color=ms.collection.color or "",
        ).dict()
        for ms in memberships
        # BI-39: 只返回请求者自己的或同 space 下的 collection
        if not viewer_user_id or (
            str(ms.collection.created_by_id) == viewer_user_id
            or (m.space_id and ms.collection.space_id and str(ms.collection.space_id) == str(m.space_id))
        )
    ]

    return MemoDetail(
        id=str(m.id),
        space_id=str(m.space_id) if m.space_id else None,
        agent_id=str(m.agent_id) if getattr(m, "agent_id", None) else None,
        memo_type=m.memo_type or "note",
        importance=m.importance,
        content_plaintext=m.content_plaintext or "",
        content_json=m.content_json or {},
        content_markdown=m.content_markdown or "",
        tags=m.tags or [],
        ai_tags=m.ai_tags or [],
        color=m.color or "",
        source=m.source or "manual",
        status=m.status or "active",
        source_url=m.source_url or "",
        is_pinned=m.is_pinned,
        bookmark_url=m.bookmark_url or "",
        bookmark_title=m.bookmark_title or "",
        bookmark_image=m.bookmark_image or "",
        bookmark_description=m.bookmark_description or "",
        attachment_count=len(attachments),
        attachments=attachments,
        collections=collections,
        created_at=m.created_at.isoformat(),
        updated_at=m.updated_at.isoformat(),
    ).dict()


def _serialize_collection(c: MemoCollection) -> dict:
    memo_count = getattr(c, "memo_count", 0)
    return CollectionOut(
        id=str(c.id),
        title=c.title,
        description=c.description or "",
        icon=c.icon or "",
        color=c.color or "",
        is_smart=c.is_smart,
        smart_filter=c.smart_filter or {},
        memo_count=memo_count,
        sort_order=c.sort_order,
        created_at=c.created_at.isoformat(),
        updated_at=c.updated_at.isoformat(),
    ).dict()


def _svc(request) -> MemoService:
    return MemoService(user=request.auth)


def _check_uuid(value: str, field_name: str = "id"):
    """校验 UUID 格式，非法时返回 validation_error_response，合法时返回 None。"""
    try:
        _uuid.UUID(value)
        return None
    except (TypeError, ValueError):
        return validation_error_response(f"{field_name} 格式非法")


# ── Memo CRUD ──


@router.post(
    "/memos/",
    auth=jwt_auth,
    response=CREATED_RESPONSE_SCHEMA,
)
def create_memo(request, payload: MemoCreateRequest):
    from apps.services.common.utils import is_rate_limited

    user_id = str(request.auth.id)
    if is_rate_limited(f"tabmemo:create:user:{user_id}", limit=30, window=60):
        return error_response_with_status(
            ErrorCode.RATE_LIMIT_EXCEEDED, "操作过于频繁，请稍后再试", status_code=429
        )

    # BI-40: SSRF 校验 bookmark_url / source_url
    if payload.bookmark_url and not _is_safe_url(payload.bookmark_url):
        return validation_error_response("bookmark_url 不允许访问内部地址")
    if payload.source_url and not _is_safe_url(payload.source_url):
        return validation_error_response("source_url 不允许访问内部地址")

    # ：Agent 记忆已迁入 /agent-memory；禁止再经 TabMemo 写入 source=agent。
    if payload.source == "agent":
        return error_response_with_status(
            "AGENT_MEMORY_MOVED",
            "Agent 记忆请使用 /api/agent-memory，不再经 /tabmemo 写入",
            status_code=400,
        )

    from apps.tabtinspace.services.organization_control_guard import (
        OrganizationControlBlockedError,
        organization_control_blocked_response,
    )

    svc = _svc(request)
    try:
        memo = svc.create_memo(
            organization_id=payload.organization_id,
            space_id=payload.space_id,
            agent_id=payload.agent_id,
            content_json=payload.content_json,
            content_markdown=payload.content_markdown,
            tags=payload.tags,
            color=payload.color,
            memo_type=payload.memo_type,
            importance=payload.importance,
            source=payload.source,
            source_url=payload.source_url,
            bookmark_url=payload.bookmark_url,
            collection_id=payload.collection_id,
        )
    except OrganizationControlBlockedError as exc:
        return organization_control_blocked_response(exc)
    # BC-36: 创建端点返回 201
    return 201, success_response(_serialize_summary(memo))


# ── 记录风格偏好（per-(user, organization)）──


@router.get("/record-style/", auth=jwt_auth)
def get_record_style(request, organization_id: str):
    """读当前用户在指定 Organization 的 Agent 笔记记录风格（缺记录返回默认）。"""
    if err := _check_uuid(organization_id, "organization_id"):
        return err
    from apps.tabmemo.services.record_style_service import RecordStyleService
    svc = RecordStyleService(user=request.auth)
    return success_response(svc.get_style(organization_id=organization_id))


@router.patch("/record-style/", auth=jwt_auth)
def update_record_style(request, organization_id: str, payload: RecordStyleUpdateRequest):
    """更新当前用户在指定 Organization 的记录风格（per-(user, organization)）。"""
    if err := _check_uuid(organization_id, "organization_id"):
        return err
    from apps.tabmemo.services.record_style_service import RecordStyleService
    svc = RecordStyleService(user=request.auth)
    cfg = svc.update_style(
        organization_id=organization_id,
        enabled=payload.enabled,
        style=payload.style,
        custom_config=payload.custom_config,
        extra_preference=payload.extra_preference,
    )
    return success_response(cfg)


@router.get("/stats/", auth=jwt_auth)
def agent_memo_stats(request, organization_id: str, space_id: str):
    """按 memo_type 统计 Agent 写入的活跃记忆条数。"""
    if err := _check_uuid(organization_id, "organization_id"):
        return err
    if err := _check_uuid(space_id, "space_id"):
        return err
    svc = _svc(request)
    stats = svc.get_agent_memo_stats(organization_id=organization_id, space_id=space_id)
    return success_response(stats)


@router.get("/stats/heatmap/", auth=jwt_auth)
def memo_heatmap_stats(request, organization_id: str, days: int = 84):
    """
    PRD v1.1 Phase 3：当前用户的写作热力图聚合。

    返回当前用户在指定 Organization 内最近 `days` 天每天的 memo 创建数量。
    用 PostgreSQL `TruncDate` 后端聚合避免前端 reduce 全量 memo。

    权限模型（per-user，与 list_memos 个人视图保持一致）：
    - 必须是 Organization 成员（check_organization_permission）
    - 只统计 owner_id | created_by_id = 当前用户的 memo（与 list 同口径）
    - 不含其他成员或 Agent 写给团队的 memo

    返回格式：
      {
        "buckets": [
          {"date": "2026-05-20", "count": 3},
          {"date": "2026-05-19", "count": 0},
          ...
        ],
        "total": <最近 N 天累计>,
        "days": 84,
      }

    - 不含已删除的 memo（status='trashed' 排除）
    - 不含归档（status='active' 才计）
    - 时区：服务端 timezone（与 `created_at` 默认存储一致）；客户端展示时直接
      消费 `buckets[].date` 字符串，不要再用 browser Date 倒推日期，避免跨时
      区错位
    - days 范围 1-365，避免大范围聚合慢
    """
    from datetime import timedelta
    from django.db.models import Count
    from django.db.models.functions import TruncDate
    from django.utils import timezone
    from apps.tabmemo.models import Memo
    from apps.tabmemo.constants import TABMEMO_DB

    if err := _check_uuid(organization_id, "organization_id"):
        return err
    if days < 1 or days > 365:
        return validation_error_response("days 必须在 1-365 之间")

    user_id = str(request.auth.id)

    # 权限校验：必须是 Organization 成员（与 list_memos 行为一致）
    svc = _svc(request)
    if not svc.check_organization_permission(organization_id):
        return validation_error_response("无权访问此 Organization")

    end = timezone.now()
    start = (end - timedelta(days=days - 1)).replace(hour=0, minute=0, second=0, microsecond=0)

    # ownership 与 list_memos 个人视图同口径：owner_id | created_by_id，
    # 避免历史行只落 created_by 时出现「列表有、热力图没有」。
    from django.db.models import Q

    qs = (
        Memo.objects.using(TABMEMO_DB)
        .filter(
            organization_id=organization_id,
            status="active",
            created_at__gte=start,
        )
        .filter(Q(owner_id=user_id) | Q(created_by_id=user_id))
        .annotate(d=TruncDate("created_at"))
        .values("d")
        .annotate(c=Count("id"))
        .order_by("d")
    )

    by_date: dict[str, int] = {row["d"].isoformat(): row["c"] for row in qs if row["d"]}
    buckets = []
    total = 0
    for i in range(days):
        d = (start + timedelta(days=i)).date()
        c = by_date.get(d.isoformat(), 0)
        buckets.append({"date": d.isoformat(), "count": c})
        total += c

    return success_response({"buckets": buckets, "total": total, "days": days})


@router.get("/tags/stats/", auth=jwt_auth)
def tag_stats(request, organization_id: str):
    """
    PRD v1.1 Phase 4：返回当前用户在指定 Organization 内所有 tag 的聚合计数。

    用于侧栏 SidebarMemoPanel TAGS 段——避免前端 reduce 受 PAGE_SIZE=30
    限制导致计数偏低 / tag 缺失。

    返回格式：
      {
        "tags": [
          {"name": "PM", "count": 12, "ai_only": false},
          {"name": "工作/PM", "count": 5, "ai_only": false},
          {"name": "灵感", "count": 23, "ai_only": false},
          {"name": "AI 自动标的", "count": 3, "ai_only": true},
          ...
        ],
        "total_user_tags": 12,
        "total_ai_tags": 8,
      }

    - 只统计 owner_id | created_by_id = 当前用户 + status='active'（跟 list/heatmap 同 scope）
    - user tag 和 ai tag 在同一 name 上视为同一个，count 合并；只在用户
      没贴这个 tag 但 AI 贴了时才标 `ai_only=true`
    - 按 count 降序、name 升序排序
    """
    from collections import Counter
    from django.db.models import Q
    from apps.tabmemo.models import Memo
    from apps.tabmemo.constants import TABMEMO_DB

    if err := _check_uuid(organization_id, "organization_id"):
        return err

    user_id = str(request.auth.id)
    svc = _svc(request)
    if not svc.check_organization_permission(organization_id):
        return validation_error_response("无权访问此 Organization")

    # 只取必要字段——避免拉整个 memo
    qs = (
        Memo.objects.using(TABMEMO_DB)
        .filter(
            organization_id=organization_id,
            status="active",
        )
        .filter(Q(owner_id=user_id) | Q(created_by_id=user_id))
        .values_list("tags", "ai_tags")
    )

    user_counter: Counter = Counter()
    ai_counter: Counter = Counter()

    def _is_machine_tag(name: str) -> bool:
        return (
            not name
            or name in {"task_summary", "diary"}
            or name.startswith(("emotion:", "outcome:"))
        )

    for user_tags, ai_tags in qs:
        u_set = {t for t in (user_tags or []) if not _is_machine_tag(t)}
        a_set = {t for t in (ai_tags or []) if not _is_machine_tag(t)}
        for t in u_set:
            user_counter[t] += 1
        for t in a_set:
            if t not in u_set:
                ai_counter[t] += 1

    all_names = set(user_counter.keys()) | set(ai_counter.keys())
    items = []
    for name in all_names:
        u = user_counter.get(name, 0)
        a = ai_counter.get(name, 0)
        items.append({"name": name, "count": u + a, "ai_only": u == 0 and a > 0})
    # 按 count 降序、name 升序排序
    items.sort(key=lambda x: (-x["count"], x["name"]))

    return success_response({
        "tags": items,
        "total_user_tags": len(user_counter),
        "total_ai_tags": len(ai_counter),
    })


@router.patch("/tags/", auth=jwt_auth)
def rename_tag(request, payload: dict):
    """
    PRD v1.1 Phase 4：批量重命名 tag。

    Body: {"organization_id": "...", "old": "工作/PM", "new": "工作/产品"}

    - 只改当前用户的 memo（owner_id = 当前用户）
    - 同时更新 `tags` 字段中的所有出现
    - 原子事务：要么全改、要么全不改
    - 不动 ai_tags（AI 标的不该跟用户合并/重命名混淆）
    """
    from django.db import transaction
    from apps.tabmemo.models import Memo
    from apps.tabmemo.constants import TABMEMO_DB

    organization_id = payload.get("organization_id", "")
    old_tag = (payload.get("old") or "").strip()
    new_tag = (payload.get("new") or "").strip()
    if err := _check_uuid(organization_id, "organization_id"):
        return err
    if not old_tag or not new_tag:
        return validation_error_response("old 和 new 必须非空")
    if old_tag == new_tag:
        return success_response({"updated": 0, "skipped": "old equals new"})
    if len(new_tag) > 50:
        return validation_error_response("new tag 长度不能超过 50 字符")

    user_id = str(request.auth.id)
    svc = _svc(request)
    if not svc.check_organization_permission(organization_id):
        return validation_error_response("无权访问此 Organization")

    # 与 tag_stats 口径对齐：只改 active 状态的 memo
    # （归档 / 回收站 memo 的 tag 不动，避免"被静默修改"）
    qs = Memo.objects.using(TABMEMO_DB).filter(
        organization_id=organization_id,
        owner_id=user_id,
        status="active",
        tags__contains=[old_tag],
    )

    from apps.tabmemo.search import refresh_search_vector
    updated = 0
    affected_memos = []
    with transaction.atomic(using=TABMEMO_DB):
        for memo in qs.select_for_update():
            new_tags = [new_tag if t == old_tag else t for t in (memo.tags or [])]
            # 去重保序
            seen = set()
            deduped = []
            for t in new_tags:
                if t in seen:
                    continue
                seen.add(t)
                deduped.append(t)
            memo.tags = deduped
            memo.save(using=TABMEMO_DB, update_fields=["tags", "updated_at"])
            affected_memos.append(memo)
            updated += 1
        # 批量改完一次性刷 search_vector，避免全文搜索 tag 词滞后
        for memo in affected_memos:
            try:
                refresh_search_vector(memo)
            except Exception:
                pass

    return success_response({"updated": updated, "old": old_tag, "new": new_tag})


@router.post("/tags/merge/", auth=jwt_auth)
def merge_tags(request, payload: dict):
    """
    PRD v1.1 Phase 4：批量合并多个 tag 到一个目标 tag。

    Body: {"organization_id": "...", "source_tags": ["PM", "产品"], "target_tag": "产品管理"}

    - 只改当前用户的 memo
    - 把所有 source_tags 替换为 target_tag，自动去重
    - 原子事务
    """
    from django.db import transaction
    from apps.tabmemo.models import Memo
    from apps.tabmemo.constants import TABMEMO_DB

    organization_id = payload.get("organization_id", "")
    source_tags = payload.get("source_tags") or []
    target_tag = (payload.get("target_tag") or "").strip()
    if err := _check_uuid(organization_id, "organization_id"):
        return err
    if not isinstance(source_tags, list) or not source_tags:
        return validation_error_response("source_tags 必须是非空 list")
    if not target_tag:
        return validation_error_response("target_tag 必须非空")
    if len(target_tag) > 50:
        return validation_error_response("target_tag 长度不能超过 50 字符")

    source_set = {(t or "").strip() for t in source_tags if (t or "").strip()}
    if not source_set:
        return validation_error_response("source_tags 不能全空")

    user_id = str(request.auth.id)
    svc = _svc(request)
    if not svc.check_organization_permission(organization_id):
        return validation_error_response("无权访问此 Organization")

    qs = Memo.objects.using(TABMEMO_DB).filter(
        organization_id=organization_id,
        owner_id=user_id,
        status="active",
        tags__overlap=list(source_set),
    )

    from apps.tabmemo.search import refresh_search_vector
    updated = 0
    affected_memos = []
    with transaction.atomic(using=TABMEMO_DB):
        for memo in qs.select_for_update():
            new_tags = [target_tag if t in source_set else t for t in (memo.tags or [])]
            seen = set()
            deduped = []
            for t in new_tags:
                if t in seen:
                    continue
                seen.add(t)
                deduped.append(t)
            memo.tags = deduped
            memo.save(using=TABMEMO_DB, update_fields=["tags", "updated_at"])
            affected_memos.append(memo)
            updated += 1
        for memo in affected_memos:
            try:
                refresh_search_vector(memo)
            except Exception:
                pass

    return success_response({
        "updated": updated,
        "source_tags": list(source_set),
        "target_tag": target_tag,
    })


@router.delete("/tags/", auth=jwt_auth)
def delete_tag(request, organization_id: str, name: str):
    """
    PRD v1.1 Phase 4：批量从所有 memo 移除某个 tag。

    Query: organization_id, name
    - 只改当前用户的 memo
    - 笔记本身保留，只是 detach 这个 tag
    """
    from django.db import transaction
    from apps.tabmemo.models import Memo
    from apps.tabmemo.constants import TABMEMO_DB

    if err := _check_uuid(organization_id, "organization_id"):
        return err
    name = (name or "").strip()
    if not name:
        return validation_error_response("name 必须非空")

    user_id = str(request.auth.id)
    svc = _svc(request)
    if not svc.check_organization_permission(organization_id):
        return validation_error_response("无权访问此 Organization")

    qs = Memo.objects.using(TABMEMO_DB).filter(
        organization_id=organization_id,
        owner_id=user_id,
        status="active",
        tags__contains=[name],
    )

    from apps.tabmemo.search import refresh_search_vector
    updated = 0
    affected_memos = []
    with transaction.atomic(using=TABMEMO_DB):
        for memo in qs.select_for_update():
            memo.tags = [t for t in (memo.tags or []) if t != name]
            memo.save(using=TABMEMO_DB, update_fields=["tags", "updated_at"])
            affected_memos.append(memo)
            updated += 1
        for memo in affected_memos:
            try:
                refresh_search_vector(memo)
            except Exception:
                pass

    return success_response({"updated": updated, "name": name})


@router.post("/memos/{memo_id}/adopt-ai-tag/", auth=jwt_auth)
def adopt_ai_tag(request, memo_id: str, payload: dict):
    """
    PRD v1.1 Phase 4：把某个 ai_tag 提升为用户 tag。

    Body: {"tag": "xxx"}（可选 `tags: [...]` 批量）

    - 原子：从 `ai_tags` 移除 + 加入 `tags`
    - 防并发：用 select_for_update
    """
    from django.db import transaction
    from apps.tabmemo.models import Memo
    from apps.tabmemo.constants import TABMEMO_DB

    if err := _check_uuid(memo_id, "memo_id"):
        return err

    tags_to_adopt = payload.get("tags")
    if not tags_to_adopt:
        single = payload.get("tag")
        if not single:
            return validation_error_response("必须传 tag 或 tags")
        tags_to_adopt = [single]
    tags_to_adopt = [t for t in (tags_to_adopt or []) if isinstance(t, str) and t.strip()]
    if not tags_to_adopt:
        return validation_error_response("tag 列表不能全空")

    user_id = str(request.auth.id)

    with transaction.atomic(using=TABMEMO_DB):
        try:
            memo = (
                Memo.objects.using(TABMEMO_DB)
                .select_for_update()
                .get(id=memo_id, owner_id=user_id)
            )
        except Memo.DoesNotExist:
            return validation_error_response("memo 不存在或无权操作")

        cur_user_tags = list(memo.tags or [])
        cur_ai_tags = list(memo.ai_tags or [])
        user_set = set(cur_user_tags)
        adopted = []
        for t in tags_to_adopt:
            if t in cur_ai_tags and t not in user_set:
                cur_user_tags.append(t)
                user_set.add(t)
                adopted.append(t)
            cur_ai_tags = [x for x in cur_ai_tags if x != t]
        memo.tags = cur_user_tags
        memo.ai_tags = cur_ai_tags
        memo.save(using=TABMEMO_DB, update_fields=["tags", "ai_tags", "updated_at"])

    return success_response({"memo_id": memo_id, "adopted": adopted, "tags": cur_user_tags, "ai_tags": cur_ai_tags})


@router.get("/memos/", auth=jwt_auth)
def list_memos(
    request,
    organization_id: str,
    space_id: str = "",  # 变为可选，默认空字符串
    search: str = "",
    tags: str = "",
    color: str = "",
    memo_type: str = "",
    agent_id: str = "",
    collection_id: str = "",
    status: str = "active",
    sort: str = "-created_at",
    cursor: str = "",
    limit: int = DEFAULT_PAGE_SIZE,
    source: str = "",
    # Phase 1：「今日回顾」等基于时间的视图，前端传 ISO 8601 字符串
    # `memo_service.list_memos` 已早就支持，这里把入参暴露到 HTTP 层
    created_after: str = "",
    created_before: str = "",
    # ：仅 Agent 真正的召回注入 / memory_search 工具传 for_recall=true，
    # 命中 memo 才递增 access_count；用户 UI 浏览（含 Agent 日记视图）不传，默认 false。
    for_recall: bool = False,
):
    # BC-11: 查询参数格式校验
    if err := _check_uuid(organization_id, "organization_id"):
        return err
    if collection_id:
        if err := _check_uuid(collection_id, "collection_id"):
            return err
    if agent_id:
        if err := _check_uuid(agent_id, "agent_id"):
            return err
    _VALID_STATUS = {"active", "archived", "trashed"}
    _VALID_SORT = {"-created_at", "created_at", "-updated_at", "updated_at"}
    _VALID_MEMO_TYPE = {"note", "bookmark", "about_you", "insight", "task_summary", "diary"}
    _VALID_COLOR = {"", "yellow", "blue", "green", "pink", "purple", "orange", "gray"}
    # W13c D7.1：source 取值校验。
    # 'agent' / 'user' 是聚合视图；其余枚举来自 Memo.Source.choices。
    _VALID_SOURCE = {"", "agent", "user", "manual", "browser", "share", "api", "voice"}
    if source and source not in _VALID_SOURCE:
        return validation_error_response(
            f"source 值非法，允许: {', '.join(sorted(s for s in _VALID_SOURCE if s))}"
        )
    if status and status not in _VALID_STATUS:
        return validation_error_response(f"status 值非法，允许: {', '.join(sorted(_VALID_STATUS))}")
    if sort and sort not in _VALID_SORT:
        return validation_error_response(f"sort 值非法，允许: {', '.join(sorted(_VALID_SORT))}")
    if memo_type and ',' in memo_type:
        memo_types = [t.strip() for t in memo_type.split(',')]
        invalid = [t for t in memo_types if t not in _VALID_MEMO_TYPE]
        if invalid:
            return validation_error_response(f"memo_type 值非法: {', '.join(invalid)}，允许: {', '.join(sorted(_VALID_MEMO_TYPE))}")
    elif memo_type and memo_type not in _VALID_MEMO_TYPE:
        return validation_error_response(f"memo_type 值非法，允许: {', '.join(sorted(_VALID_MEMO_TYPE))}")
    if color and color not in _VALID_COLOR:
        return validation_error_response(f"color 值非法，允许: {', '.join(sorted(_VALID_COLOR - {''}))}")

    # BI-36: search 参数长度限制
    if search and len(search) > 500:
        return validation_error_response("search 参数长度不能超过 500 个字符")

    # Phase 1: created_after / created_before 必须是合法的 ISO 8601 字符串
    # 否则直接进 ORM 会抛 500 而不是 400，体验差
    from datetime import datetime
    for ts_param_name, ts_value in (("created_after", created_after), ("created_before", created_before)):
        if not ts_value:
            continue
        try:
            datetime.fromisoformat(ts_value.replace("Z", "+00:00"))
        except ValueError:
            return validation_error_response(
                f"{ts_param_name} 必须是合法的 ISO 8601 时间字符串"
            )

    svc = _svc(request)

    # BC-23: 支持重复 query param（tags=a&tags=b），同时向后兼容逗号格式
    tag_values = request.GET.getlist("tags")
    tag_list = []
    for t in tag_values:
        tag_list.extend(t2.strip() for t2 in t.split(",") if t2.strip())

    result = svc.list_memos(
        organization_id=organization_id,
        space_id=space_id or None,
        search=search,
        tags=tag_list,
        color=color,
        memo_type=memo_type,
        agent_id=agent_id or None,
        collection_id=collection_id,
        status=status,
        sort=sort,
        cursor=cursor,
        limit=limit,
        source=source or None,
        created_after=created_after or None,
        created_before=created_before or None,
        for_recall=for_recall,
    )
    return success_response({
        "items": [_serialize_summary(m) for m in result["items"]],
        "next_cursor": result["next_cursor"],
        "has_more": result["has_more"],
    })


# ⚠️ 路由顺序：``/memos/batch/`` 必须在 ``/memos/{memo_id}/`` 通配符**之前**注册
# （详见 approval_memo.py 同类注释）。否则 POST /memos/batch/ 会被 ninja 当成
# memo_id=batch 的请求，命中只有 GET/PATCH/DELETE 的 /{memo_id} 路由 → 405。
@router.post("/memos/batch/", auth=jwt_auth)
def batch_operate_memos(request, payload: MemoBatchRequest):
    svc = _svc(request)
    result = svc.batch_operate_memos(
        organization_id=payload.organization_id,
        space_id=payload.space_id,  # 可能为 None
        memo_ids=payload.memo_ids,
        action=payload.action,
        tags=payload.tags,
        collection_id=payload.collection_id,
    )
    return success_response(result)


@router.get("/memos/{memo_id}/", auth=jwt_auth)
def get_memo(request, memo_id: str, include_trashed: bool = False):
    if err := _check_uuid(memo_id, "memo_id"):
        return err
    svc = _svc(request)
    memo = svc.get_memo_detail(memo_id, include_trashed=include_trashed)
    return success_response(_serialize_detail(memo, viewer_user_id=str(request.auth.id)))


@router.patch("/memos/{memo_id}/", auth=jwt_auth)
def update_memo(request, memo_id: str, payload: MemoUpdateRequest):
    if err := _check_uuid(memo_id, "memo_id"):
        return err

    # BI-40: SSRF 校验 bookmark_url / source_url（仅在有值时检查）
    if payload.bookmark_url is not None and payload.bookmark_url and not _is_safe_url(payload.bookmark_url):
        return validation_error_response("bookmark_url 不允许访问内部地址")
    if payload.source_url is not None and payload.source_url and not _is_safe_url(payload.source_url):
        return validation_error_response("source_url 不允许访问内部地址")

    svc = _svc(request)
    memo = svc.update_memo(
        memo_id=memo_id,
        content_json=payload.content_json,
        content_markdown=payload.content_markdown,
        tags=payload.tags,
        color=payload.color,
        is_pinned=payload.is_pinned,
        memo_type=payload.memo_type,
        importance=payload.importance,
        bookmark_url=payload.bookmark_url,
        bookmark_title=payload.bookmark_title,
        bookmark_description=payload.bookmark_description,
        bookmark_image=payload.bookmark_image,
        source_url=payload.source_url,
    )
    return success_response(_serialize_summary(memo))


@router.delete("/memos/{memo_id}/", auth=jwt_auth)
def delete_memo(request, memo_id: str):
    """DELETE 语义：移入回收站（破坏性操作）。"""
    if err := _check_uuid(memo_id, "memo_id"):
        return err
    svc = _svc(request)
    svc.trash_memo(memo_id)
    return success_response({"trashed": True})


@router.post("/memos/{memo_id}/archive/", auth=jwt_auth, summary="归档 memo")
def archive_memo(request, memo_id: str):
    if err := _check_uuid(memo_id, "memo_id"):
        return err
    svc = _svc(request)
    svc.archive_memo(memo_id)
    return success_response({"archived": True})


@router.post("/memos/{memo_id}/restore/", auth=jwt_auth)
def restore_memo(request, memo_id: str):
    if err := _check_uuid(memo_id, "memo_id"):
        return err
    svc = _svc(request)
    memo = svc.restore_memo(memo_id)
    return success_response(_serialize_summary(memo))


@router.post("/memos/{memo_id}/trash/", auth=jwt_auth, summary="移入回收站")
def trash_memo(request, memo_id: str):
    if err := _check_uuid(memo_id, "memo_id"):
        return err
    svc = _svc(request)
    svc.trash_memo(memo_id)
    return success_response({"trashed": True})


@router.post("/memos/{memo_id}/restore-from-trash/", auth=jwt_auth, summary="从回收站恢复")
def restore_memo_from_trash(request, memo_id: str):
    if err := _check_uuid(memo_id, "memo_id"):
        return err
    svc = _svc(request)
    memo = svc.restore_memo_from_trash(memo_id)
    return success_response(_serialize_summary(memo))


@router.delete("/memos/{memo_id}/permanent/", auth=jwt_auth, summary="永久删除")
def permanent_delete_memo(request, memo_id: str):
    if err := _check_uuid(memo_id, "memo_id"):
        return err
    svc = _svc(request)
    svc.permanent_delete_memo(memo_id)
    return success_response({"deleted": True})


@router.post("/memos/{memo_id}/pin/", auth=jwt_auth)
def pin_memo(request, memo_id: str, payload: MemoPinRequest):
    if err := _check_uuid(memo_id, "memo_id"):
        return err
    svc = _svc(request)
    memo = svc.pin_memo(memo_id, payload.pinned)
    return success_response(_serialize_summary(memo))


# ── AI Tagging ──


@router.post("/memos/{memo_id}/retag/", auth=jwt_auth)
def retag_memo(request, memo_id: str):
    if err := _check_uuid(memo_id, "memo_id"):
        return err

    from apps.services.common.utils import is_rate_limited

    user_id = str(request.auth.id)
    if is_rate_limited(f"tabmemo:retag:user:{user_id}", limit=20, window=60):
        return error_response_with_status(
            ErrorCode.RATE_LIMIT_EXCEEDED, "操作过于频繁，请稍后再试", status_code=429
        )

    svc = _svc(request)
    svc.retag_memo(memo_id)
    return success_response({"memo_id": memo_id, "status": "queued"})


# ── Batch Operations 已移到 ``/memos/{memo_id}/`` 通配符之前注册 ──
# 见上方 batch_operate_memos 定义。这里保留分隔注释方便检索历史 PR。


# ── Attachment ──


@router.post("/memos/{memo_id}/attachments/", auth=jwt_auth)
def add_attachment(request, memo_id: str, payload: AttachmentAddRequest):
    if err := _check_uuid(memo_id, "memo_id"):
        return err
    svc = _svc(request)
    att = svc.add_attachment(
        memo_id=memo_id,
        file_record_id=payload.file_record_id,
        file_type=payload.file_type,
        sort_order=payload.sort_order,
    )
    return success_response(
        AttachmentOut(
            id=str(att.id),
            file_type=att.file_type,
            file_url=att.file_url,
            file_name=att.file_name,
            file_size=att.file_size,
            mime_type=att.mime_type or "",
            thumbnail_url=att.thumbnail_url or "",
            sort_order=att.sort_order,
            created_at=att.created_at.isoformat(),
        ).dict()
    )


@router.delete("/memos/{memo_id}/attachments/{attachment_id}/", auth=jwt_auth)
def delete_attachment(request, memo_id: str, attachment_id: str):
    if err := _check_uuid(memo_id, "memo_id"):
        return err
    if err := _check_uuid(attachment_id, "attachment_id"):
        return err
    svc = _svc(request)
    svc.delete_attachment(memo_id, attachment_id)
    return success_response()


# ── URL 书签预览 ──


def _resolve_and_check_url(url: str) -> tuple[bool, str]:
    """校验 URL 安全性并返回 (is_safe, ip_resolved_url)。

    委托 url_security.resolve_and_validate 执行 DNS 解析、IP 校验、pinned URL 生成，
    消除 TOCTOU（DNS rebinding）窗口。
    任何异常（含 DNS 解析 OSError）均视为不安全。
    """
    from apps.services.common.url_security import resolve_and_validate

    try:
        resolved = resolve_and_validate(url)
        return True, resolved.pinned_url
    except Exception:
        return False, ""


def _is_safe_url(url: str) -> bool:
    """向后兼容的简单安全检查接口。"""
    safe, _ = _resolve_and_check_url(url)
    return safe


class _OGMetaParser(HTMLParser):
    """FI-42: 使用 html.parser 替代正则提取 OG 元数据，正确处理属性顺序。"""

    def __init__(self):
        super().__init__()
        self.og: dict[str, str] = {}
        self.title = ""
        self._in_title = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]):
        if tag == "title":
            self._in_title = True
            return
        if tag != "meta":
            return
        attr_dict = {k: (v or "") for k, v in attrs}
        prop = attr_dict.get("property", "")
        if prop.startswith("og:") and "content" in attr_dict:
            key = prop[3:]
            if key not in self.og:  # 首次出现优先
                self.og[key] = attr_dict["content"]

    def handle_data(self, data: str):
        if self._in_title:
            self.title += data

    def handle_endtag(self, tag: str):
        if tag == "title":
            self._in_title = False


@router.post("/bookmark-preview/", auth=jwt_auth)
def bookmark_preview(request, payload: BookmarkPreviewRequest):
    """解析 URL 的 Open Graph 信息，返回标题/描述/缩略图。

    通过 ssrf_safe_request (resolve-and-pin) 发起请求，每次重定向都
    重新解析 DNS 并校验目标 IP，彻底消除 TOCTOU/DNS-rebinding 窗口。
    FI-42: 使用 html.parser 替代正则提取 OG 元数据。
    BC-42: 细化异常类型，区分超时、连接错误和解析错误。
    """
    import requests as _requests

    from apps.services.common.url_security import ssrf_safe_request
    from apps.services.common.utils import is_rate_limited

    user_id = str(request.auth.id)
    if is_rate_limited(f"tabmemo:bookmark_preview:{user_id}", limit=10, window=60):
        return error_response_with_status(
            ErrorCode.RATE_LIMIT_EXCEEDED, "请求过于频繁，请稍后再试", status_code=429
        )

    url = payload.url

    try:
        resp = ssrf_safe_request(
            "GET", url,
            timeout=3,
            allow_redirects=True,
            max_redirects=5,
            stream=True,
            headers={"User-Agent": "TabTin-Bot/1.0"},
        )
        resp.raise_for_status()

        chunks = []
        total = 0
        for chunk in resp.iter_content(chunk_size=8192):
            chunks.append(chunk)
            total += len(chunk)
            if total >= BOOKMARK_MAX_READ_BYTES:
                break
        html = b"".join(chunks)[:BOOKMARK_MAX_READ_BYTES].decode("utf-8", errors="ignore")

        parser = _OGMetaParser()
        try:
            parser.feed(html)
        except Exception:
            pass

        title = parser.og.get("title", "") or parser.title.strip()

        return success_response(
            BookmarkPreviewOut(
                url=url,
                title=title,
                description=parser.og.get("description", ""),
                image=parser.og.get("image", ""),
            ).dict()
        )
    except ValueError as exc:
        logger.warning("Bookmark preview SSRF blocked for %s: %s", payload.url, exc)
        return validation_error_response("该 URL 不允许访问")
    except _requests.Timeout:
        logger.warning("Bookmark preview timeout for %s", payload.url)
        return error_response_with_status(
            ErrorCode.BOOKMARK_FETCH_FAILED, "书签预览请求超时", status_code=504
        )
    except _requests.TooManyRedirects as exc:
        logger.warning("Bookmark preview redirect blocked for %s: %s", payload.url, exc)
        return validation_error_response("书签预览重定向被阻止")
    except _requests.HTTPError as exc:
        logger.warning("Bookmark preview HTTP error for %s: %s", payload.url, exc)
        status = getattr(getattr(exc, "response", None), "status_code", 500)
        if 400 <= status < 500:
            return error_response_with_status(
                ErrorCode.BOOKMARK_FETCH_FAILED, f"目标网站返回 {status} 错误", status_code=502
            )
        return error_response_with_status(
            ErrorCode.BOOKMARK_FETCH_FAILED, "目标网站服务端错误", status_code=502
        )
    except _requests.ConnectionError:
        logger.warning("Bookmark preview connect error for %s", payload.url)
        return error_response_with_status(
            ErrorCode.BOOKMARK_FETCH_FAILED, "无法连接到目标网站", status_code=502
        )
    except Exception as exc:
        logger.warning("Bookmark preview failed for %s: %s", payload.url, exc)
        return error_response_with_status(
            ErrorCode.BOOKMARK_FETCH_FAILED, "书签预览获取失败", status_code=502
        )


# ── Collection ──


@router.get("/collections/", auth=jwt_auth)
def list_collections(
    request,
    organization_id: str,
    space_id: str = "",
    limit: int = 50,
    offset: int = 0,
):
    # BC-41: UUID 格式校验
    if err := _check_uuid(organization_id, "organization_id"):
        return err

    # BC-15: 分页参数规范化
    limit = max(1, min(limit, 100))
    offset = max(0, offset)

    svc = _svc(request)
    collections = svc.list_collections(organization_id, space_id or None)

    # BC-15: 返回分页结果
    total = len(collections)
    page = collections[offset:offset + limit]
    return success_response({
        "items": [_serialize_collection(c) for c in page],
        "total": total,
        "limit": limit,
        "offset": offset,
    })


@router.post("/collections/", auth=jwt_auth, response=CREATED_RESPONSE_SCHEMA)
def create_collection(request, payload: CollectionCreateRequest):
    svc = _svc(request)
    coll = svc.create_collection(
        organization_id=payload.organization_id,
        space_id=payload.space_id,
        title=payload.title,
        description=payload.description,
        icon=payload.icon,
        color=payload.color,
        is_smart=payload.is_smart,
        smart_filter=payload.smart_filter,
    )
    # BC-36: 创建端点返回 201
    return 201, success_response(_serialize_collection(coll))


@router.patch("/collections/{collection_id}/", auth=jwt_auth)
def update_collection(request, collection_id: str, payload: CollectionUpdateRequest):
    if err := _check_uuid(collection_id, "collection_id"):
        return err
    svc = _svc(request)
    coll = svc.update_collection(
        collection_id=collection_id,
        title=payload.title,
        description=payload.description,
        icon=payload.icon,
        color=payload.color,
        is_smart=payload.is_smart,
        smart_filter=payload.smart_filter,
    )
    return success_response(_serialize_collection(coll))


@router.delete("/collections/{collection_id}/", auth=jwt_auth)
def delete_collection(request, collection_id: str):
    if err := _check_uuid(collection_id, "collection_id"):
        return err
    svc = _svc(request)
    svc.delete_collection(collection_id)
    return success_response()


@router.post("/collections/{collection_id}/memos/", auth=jwt_auth)
def add_memos_to_collection(
    request, collection_id: str, payload: CollectionAddMemosRequest
):
    if err := _check_uuid(collection_id, "collection_id"):
        return err
    svc = _svc(request)
    added = svc.add_memos_to_collection(collection_id, payload.memo_ids)
    return success_response({"added": added})


@router.delete(
    "/collections/{collection_id}/memos/{memo_id}/", auth=jwt_auth
)
def remove_memo_from_collection(
    request, collection_id: str, memo_id: str
):
    if err := _check_uuid(collection_id, "collection_id"):
        return err
    if err := _check_uuid(memo_id, "memo_id"):
        return err
    svc = _svc(request)
    svc.remove_memo_from_collection(collection_id, memo_id)
    return success_response()


# ── Agent Grant ──


@router.post("/grants/", auth=jwt_auth, response=CREATED_RESPONSE_SCHEMA)
def create_grants(request, payload: MemoGrantCreateRequest):
    svc = _svc(request)
    grants = svc.create_grants(
        organization_id=payload.organization_id,
        target_space_id=payload.target_space_id,
        memo_ids=payload.memo_ids,
        collection_ids=payload.collection_ids,
        permission=payload.permission,
    )
    # BC-36: 创建端点返回 201
    return 201, success_response([
        MemoGrantOut(
            id=str(g.id),
            memo_id=str(g.memo_id) if g.memo_id else None,
            collection_id=str(g.collection_id) if g.collection_id else None,
            target_space_id=str(g.target_space_id),
            permission=g.permission,
            created_at=g.created_at.isoformat(),
        ).dict()
        for g in grants
    ])


@router.get("/grants/", auth=jwt_auth)
def list_grants(request, organization_id: str, space_id: str | None = None):
    # BC-41: UUID 格式校验
    if err := _check_uuid(organization_id, "organization_id"):
        return err
    if space_id:
        if err := _check_uuid(space_id, "space_id"):
            return err
    svc = _svc(request)
    grants = svc.list_grants(organization_id, space_id=space_id)
    return success_response([
        MemoGrantOut(
            id=str(g.id),
            memo_id=str(g.memo_id) if g.memo_id else None,
            collection_id=str(g.collection_id) if g.collection_id else None,
            target_space_id=str(g.target_space_id),
            permission=g.permission,
            created_at=g.created_at.isoformat(),
        ).dict()
        for g in grants
    ])


@router.delete("/grants/{grant_id}/", auth=jwt_auth)
def delete_grant(request, grant_id: str):
    if err := _check_uuid(grant_id, "grant_id"):
        return err
    svc = _svc(request)
    svc.delete_grant(grant_id)
    return success_response()
