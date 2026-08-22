"""Package Registry 核心服务层。

包含所有业务逻辑：创建包、两阶段发布、yank、fork、EventBus 事件等。
OSS 集成走内部 Python 调用，不走公共 HTTP API。
"""

from __future__ import annotations

from django.conf import settings
import hashlib
import logging
import re
import uuid
from typing import Any

from django.db import transaction
from django.db.models import Max
from django.utils import timezone

from apps.services.package_registry.models import Package, PackageFile, PackageVersion

logger = logging.getLogger(__name__)

_USING_DB = ('default' if getattr(settings, 'TABTIN_SINGLE_DATABASE_MODE', False) else 'postgresql')
_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9._-]*$")


def _strip_legacy_init_files(manifest: dict | None) -> dict:
    """W1+W2+W5 蓝绿部署窗口期保护:剥离 manifest 中残留的 _init_files key。

    0003 migration 已把 DB 中所有 manifest._init_files 迁走,但应用进程版本可能
    滞后于 DB schema(蓝绿期间老进程仍按老代码写 manifest._init_files)。
    本函数在 finalize / fork / revert 三个写路径统一调用,确保 published 行 manifest 干净。

    TODO(W5+N): 确认所有 PR 服务进程都重启完成后,删除此函数及调用方。
    下线扳机:`git log --since="X+2 weeks" -- services/package_registry/`,
    确认无新 0003-pre 老进程残留。
    """
    return {k: v for k, v in (manifest or {}).items() if k != "_init_files"}

_PLATFORM_NAMESPACES = frozenset({"platform", "global", "tabtin", "system"})

_MAX_SINGLE_FILE_SIZE = 50 * 1024 * 1024   # 50 MB
_MAX_TOTAL_SIZE = 200 * 1024 * 1024         # 200 MB
_MAX_FILE_COUNT = 500

_ROLES_GTE = {
    "viewer": ["owner", "admin", "editor", "viewer"],
    "editor": ["owner", "admin", "editor"],
    "admin": ["owner", "admin"],
    "owner": ["owner"],
}


def check_package_write_access(
    *, user_id: str, organization_id: str, min_role: str = "editor"
) -> None:
    """校验用户对 organization 下包的写操作权限。

    成员角色优先来自 ``OrganizationMember``；历史数据若缺少 owner 的成员镜像行，
    则回退 ``Organization.owner`` 作为最高权限。两者均通过 Django ORM 默认路由
    查询，不依赖 Package Registry 的 PostgreSQL 事务。
    """
    from apps.tabtinspace.models import Organization, OrganizationMember

    membership = OrganizationMember.objects.filter(
        organization_id=organization_id,
        user_id=user_id,
    ).values_list("role", flat=True).first()
    has_access = (
        membership in _ROLES_GTE[min_role]
        if membership is not None
        else Organization.objects.filter(
            id=organization_id,
            owner_id=user_id,
        ).exists()
    )
    if not has_access:
        raise PermissionError(
            f"PERMISSION_DENIED: user {user_id} is not a {min_role}+ member "
            f"of organization {organization_id}"
        )


def validate_slug(value: str, field_name: str) -> None:
    if not value or not _SLUG_RE.match(value):
        raise ValueError(
            f"INVALID_{field_name.upper()}: '{value}' must match ^[a-z0-9][a-z0-9._-]*$ "
            f"(lowercase alphanumeric start, then lowercase alphanumeric, dot, underscore, or hyphen)"
        )


def _check_namespace_ownership(namespace: str, organization_id: str) -> None:
    """防止抢注别人的 namespace。

    平台官方 namespace 不做归属校验。
    非官方 namespace 下如果已有包，其 organization_id 必须与调用者一致；
    如果尚无包则允许首次占用。
    """
    if namespace in _PLATFORM_NAMESPACES:
        return
    existing_pkg = (
        Package.objects.select_for_update().filter(namespace=namespace).first()
    )
    if existing_pkg and str(existing_pkg.organization_id) != str(organization_id):
        raise PermissionError(
            f"NAMESPACE_CONFLICT: namespace '{namespace}' is already owned "
            f"by another organization"
        )


# ---------------------------------------------------------------------------
# EventBus helpers
# ---------------------------------------------------------------------------

def emit_on_commit(event_type: str, organization_id: str, payload: dict[str, Any]) -> None:
    """在 PostgreSQL 事务提交后通过 EventBus 发布事件。"""

    def _do_emit():
        try:
            from apps.extensions.event_bus import Event, EventBus

            EventBus.emit(Event(
                source="package_registry",
                event_type=event_type,
                organization_id=str(organization_id),
                payload=payload,
            ))
        except Exception as exc:
            logger.warning(
                "[PackageRegistry] EventBus emit failed: %s payload=%s: %s",
                event_type, payload, exc,
            )

    transaction.on_commit(_do_emit, using=_USING_DB)


# W7 P1-1 + W8 P1-2:已知支持 outbox 兜底重试的告警事件类型。
# 其它事件即使 emit 失败也不写 outbox(避免无意义膨胀)。
# Wave 1（PRD V3.3 §11.1）：跨库 ref 表已删除，下面两个 event_type 仅作历史
# outbox 行回放兼容（_retry_managed_skill_ref_* 在 tasks.py 直接返回 done）。
_OUTBOX_SUPPORTED_EVENT_TYPES = frozenset({
    "pkg.package.reverted_sync_failed",
    "pkg.skill.upsert_failed",
    "pkg.gc.scheduling_failed",
    "pkg.managed_skill_ref.create_failed",
    "pkg.managed_skill_ref.delete_failed",
})


def emit_with_outbox_fallback(
    event_type: str, organization_id: str, payload: dict[str, Any],
) -> None:
    """W7 P1-1:emit 告警事件,失败时持久化到 EventOutbox 由 retry 任务兜底。

    使用场景:PR 模块 3 处软依赖告警事件(``pkg.package.reverted_sync_failed`` /
    ``pkg.skill.upsert_failed`` / ``pkg.gc.scheduling_failed``)在跨库写失败 +
    EventBus emit 失败的情况下,持久化到 outbox 表,等待 ``process_event_outbox``
    Celery 任务自动重试。

    设计要点(F-9 闭环):
    - **不阻塞主路径**:任何异常吞掉,主业务不抛
    - **不替代 EventBus 订阅**:运维订阅 EventBus 仍是主告警通道,outbox 仅是
      "emit/业务双双失败" 的二级兜底
    - **只服务 PR 模块的 3 类事件**:其它 event_type 走经典 emit_on_commit
    """
    if event_type not in _OUTBOX_SUPPORTED_EVENT_TYPES:
        # 不在白名单 → 退回到经典 emit_on_commit(纯审计型事件)
        emit_on_commit(event_type, organization_id, payload)
        return

    # 1. 主路径:同 emit_on_commit 同步尝试 EventBus.emit(不走 on_commit,
    #    因为本函数语境是已经处于"emit 失败 + 业务失败"的兜底,主事务可能
    #    已提交或没有事务上下文,直接同步 emit 即可)
    emit_succeeded = False
    try:
        from apps.extensions.event_bus import Event, EventBus

        EventBus.emit(Event(
            source="package_registry",
            event_type=event_type,
            organization_id=str(organization_id or ""),
            payload=payload,
        ))
        emit_succeeded = True
    except Exception as exc:
        logger.warning(
            "[PackageRegistry] outbox-fallback emit %s 失败,准备落库: %s",
            event_type, exc,
        )

    # 2. 即使 emit 成功也写 outbox? 不写 — 业务订阅可能成功消费;outbox 只在
    #    emit 失败或调用方语义上"业务调用本身已失败"时使用,避免重复触发。
    #    本 helper 由调用方在 emit 失败 / 业务失败时统一调用,这里只在 emit
    #    抛异常时写 outbox。
    if emit_succeeded:
        return

    # 3. 持久化到 outbox 等重试
    try:
        from apps.services.package_registry.models import EventOutbox

        EventOutbox.objects.using(_USING_DB).create(
            event_type=event_type,
            organization_id=str(organization_id or ""),
            payload=payload,
        )
        logger.info(
            "[PackageRegistry] 写入 EventOutbox 等待重试: event=%s wt=%s",
            event_type, organization_id,
        )
    except Exception as exc:
        # 连 outbox 都写不进去(PG 故障) → 只能 logger.error,生产监控应已抓
        logger.error(
            "[PackageRegistry] 写入 EventOutbox 失败,事件丢失: event=%s payload=%s: %s",
            event_type, payload, exc, exc_info=True,
        )


def record_event_to_outbox(
    event_type: str, organization_id: str, payload: dict[str, Any], reason: str = "",
) -> None:
    """W7 P1-1:直接落库 outbox(不尝试 emit)。

    用于"业务调用本身已失败"的兜底点 — 调用方知道当前语境下重试需要等条件
    恢复(如跨库连接、broker、Skills 表锁等),emit 一次也大概率失败,不必
    多此一举。

    与 ``emit_with_outbox_fallback`` 区别:本函数不 emit,直接写 outbox。
    主要用于 ``_sync_managed_skill_version_pointer`` / ``_upsert_managed_skill_from_finalize``
    等"业务跨库 update 已失败"的代码路径。
    """
    if event_type not in _OUTBOX_SUPPORTED_EVENT_TYPES:
        logger.warning(
            "[PackageRegistry] record_event_to_outbox 收到未支持事件 %s, 忽略",
            event_type,
        )
        return

    enriched_payload = dict(payload)
    if reason and "reason" not in enriched_payload:
        enriched_payload["reason"] = reason
    try:
        from apps.services.package_registry.models import EventOutbox

        EventOutbox.objects.using(_USING_DB).create(
            event_type=event_type,
            organization_id=str(organization_id or ""),
            payload=enriched_payload,
        )
        logger.info(
            "[PackageRegistry] 写入 EventOutbox 等待重试: event=%s wt=%s reason=%s",
            event_type, organization_id, reason,
        )
    except Exception as exc:
        logger.error(
            "[PackageRegistry] 写入 EventOutbox 失败,事件丢失: event=%s payload=%s: %s",
            event_type, enriched_payload, exc, exc_info=True,
        )


# ---------------------------------------------------------------------------
# OSS helpers
# ---------------------------------------------------------------------------

def _find_existing_file_records_batch(sha_list: list[str]) -> dict[str, Any]:
    """批量按 sha256 查找已有的 FileRecord，返回 {sha256: FileRecord} 映射。"""
    if not sha_list:
        return {}
    from apps.services.oss.models import FileRecord

    return {
        r.file_hash: r
        for r in FileRecord.objects.filter(
            file_hash__in=sha_list, hash_algorithm="sha256", status="completed",
        )
    }


def _generate_presigned_put_url(object_key: str, content_type: str | None = None) -> str:
    from apps.services.oss.services.factory import get_oss_service

    return get_oss_service().generate_presigned_url(
        object_key, method="PUT", content_type=content_type,
    )


def _generate_presigned_get_url(object_key: str) -> str:
    from apps.services.oss.services.factory import get_oss_service

    return get_oss_service().generate_presigned_url(object_key, method="GET")


def _make_object_key(package_id: uuid.UUID, sha256: str) -> str:
    return f"package_registry/{package_id}/{sha256[:2]}/{sha256}"


def _register_file_record(
    *,
    object_key: str,
    file_name: str,
    file_size: int,
    content_type: str,
    sha256: str,
    user_id: str,
    organization_id: str,
    context_id: str,
) -> Any:
    """为已上传完成的文件创建 FileRecord。"""
    from apps.services.oss.services.file_registry import FileRegistryService

    return FileRegistryService.register_uploaded_file(
        object_key=object_key,
        file_name=file_name,
        file_size=file_size,
        content_type=content_type or "application/octet-stream",
        module="package_registry",
        user_id=user_id,
        organization_id=organization_id,
        context_type="package_file",
        context_id=context_id,
        file_hash=sha256,
        hash_algorithm="sha256",
    )


# ---------------------------------------------------------------------------
# Service functions
# ---------------------------------------------------------------------------

def create_package(
    *,
    namespace: str,
    name: str,
    organization_id: str,
    created_by: str,
    metadata: dict | None = None,
    parent_package_id: str | None = None,
) -> Package:
    validate_slug(namespace, "namespace")
    validate_slug(name, "name")
    check_package_write_access(user_id=created_by, organization_id=organization_id, min_role="editor")
    with transaction.atomic(using=_USING_DB):
        _check_namespace_ownership(namespace, organization_id)
        pkg = Package.objects.create(
            namespace=namespace,
            name=name,
            organization_id=organization_id,
            created_by=created_by,
            metadata=metadata or {},
            parent_package_id=parent_package_id,
        )
        emit_on_commit("pkg.package.created", organization_id, {
            "package_id": str(pkg.id),
            "namespace": namespace,
            "name": name,
            "organization_id": organization_id,
            "created_by": created_by,
        })
    return pkg


def init_version(
    *,
    package: Package,
    files: list[dict[str, Any]],
    manifest: dict,
    version_label: str | None,
    user_id: str,
) -> dict[str, Any]:
    """两阶段上传 — 阶段 1：创建 uploading 态 PackageVersion + 返回 presign URL。"""
    check_package_write_access(user_id=user_id, organization_id=str(package.organization_id), min_role="editor")

    if len(files) > _MAX_FILE_COUNT:
        raise ValueError(
            f"FILE_COUNT_EXCEEDED: {len(files)} files exceeds limit of {_MAX_FILE_COUNT}"
        )
    total_size = 0
    for f in files:
        fsize = f.get("size", 0)
        if fsize > _MAX_SINGLE_FILE_SIZE:
            raise ValueError(
                f"FILE_TOO_LARGE: '{f['path']}' is {fsize} bytes, "
                f"exceeds single-file limit of {_MAX_SINGLE_FILE_SIZE} bytes (50 MB)"
            )
        total_size += fsize
    if total_size > _MAX_TOTAL_SIZE:
        raise ValueError(
            f"TOTAL_SIZE_EXCEEDED: {total_size} bytes exceeds limit of "
            f"{_MAX_TOTAL_SIZE} bytes (200 MB)"
        )

    sha_list = [f["sha256"] for f in files]
    existing_map = _find_existing_file_records_batch(sha_list)

    with transaction.atomic(using=_USING_DB):
        # A3: init_files 走独立字段,不再污染 manifest。
        # manifest 仅保存上层业务的不可变快照;init_files 是发布期临时通道。
        version = PackageVersion.objects.create(
            package=package,
            status=PackageVersion.Status.UPLOADING,
            version_label=version_label,
            manifest=dict(manifest),
            init_files=list(files),
            created_by=user_id,
        )

        upload_tasks: list[dict[str, Any]] = []
        for f in files:
            sha256 = f["sha256"]
            path = f["path"]
            content_type = f.get("content_type", "application/octet-stream")

            existing = existing_map.get(sha256)
            if existing:
                upload_tasks.append({
                    "path": path,
                    "sha256": sha256,
                    "action": "reuse",
                    "file_record_id": str(existing.id),
                })
            else:
                object_key = _make_object_key(package.id, sha256)
                presigned_url = _generate_presigned_put_url(object_key, content_type)
                upload_tasks.append({
                    "path": path,
                    "sha256": sha256,
                    "action": "upload",
                    "presigned_url": presigned_url,
                    "oss_object_key": object_key,
                })

    return {
        "version_id": str(version.id),
        "upload_tasks": upload_tasks,
    }


def compute_bundle_sha256(file_entries: list[tuple[str, str]]) -> str:
    """计算 bundle Merkle root：对所有 (path, sha256) 按 path 排序后整体 sha256。"""
    sorted_entries = sorted(file_entries, key=lambda x: x[0])
    hasher = hashlib.sha256()
    for path, sha256 in sorted_entries:
        hasher.update(f"{path}:{sha256}".encode())
    return hasher.hexdigest()


_compute_bundle_sha256 = compute_bundle_sha256


def finalize_version(
    *,
    package: Package,
    version: PackageVersion,
    bundle_sha256: str,
    init_files: list[dict[str, Any]],
    user_id: str,
) -> dict[str, Any]:
    """两阶段上传 — 阶段 3：确认上传、写 PackageFile、分配 version_seq。"""
    check_package_write_access(user_id=user_id, organization_id=str(package.organization_id), min_role="editor")
    if not init_files:
        raise ValueError("FILES_NOT_ALL_UPLOADED: init_files is empty")

    file_entries: list[tuple[str, str]] = []
    pending_files: list[dict[str, Any]] = []
    total_size = 0

    sha_list = [f["sha256"] for f in init_files]
    existing_map = _find_existing_file_records_batch(sha_list)

    for f in init_files:
        sha256 = f["sha256"]
        path = f["path"]
        size = f.get("size", 0)
        content_type = f.get("content_type", "application/octet-stream")

        existing = existing_map.get(sha256)
        if existing:
            oss_key = existing.file_key
            file_record_id = existing.id
        else:
            oss_key = _make_object_key(package.id, sha256)
            file_record_id = None

        pending_files.append({
            "path": path,
            "sha256": sha256,
            "size": size,
            "content_type": content_type,
            "oss_object_key": oss_key,
            "file_record_id": file_record_id,
        })
        file_entries.append((path, sha256))
        total_size += size

    computed = _compute_bundle_sha256(file_entries)
    if computed != bundle_sha256:
        raise ValueError(
            f"BUNDLE_SHA256_MISMATCH: client_provided={bundle_sha256}, server_computed={computed}"
        )

    # 阶段 B：SHA256 校验通过后，在 PostgreSQL 事务中写入
    with transaction.atomic(using=_USING_DB):
        # W2-修2: 锁顺序与 revert / yank / fork 一致 — **先 Package, 后 Version**。
        # 早期实现先 Version 后 Package, 与其它路径相反, 跨路径并发(如同时跑
        # finalize + revert)会构成 AB-BA 循环触发 PostgreSQL DeadlockDetected。
        # 统一锁顺序后, 任何时刻先抢 Package 锁的事务会先执行, 后到的串行等待。
        pkg_locked = Package.objects.select_for_update().get(id=package.id)
        version = PackageVersion.objects.select_for_update().get(id=version.id)
        if version.status != PackageVersion.Status.UPLOADING:
            raise ValueError("VERSION_ALREADY_FINALIZED")

        file_objs = []
        for pf in pending_files:
            frid = pf["file_record_id"]
            if frid is None:
                record = _register_file_record(
                    object_key=pf["oss_object_key"],
                    file_name=pf["path"].split("/")[-1] if "/" in pf["path"] else pf["path"],
                    file_size=pf["size"],
                    content_type=pf["content_type"],
                    sha256=pf["sha256"],
                    user_id=user_id,
                    organization_id=str(package.organization_id),
                    context_id=str(version.id),
                )
                frid = record.id
            file_objs.append(PackageFile(
                version=version,
                path=pf["path"],
                file_record_id=frid,
                oss_object_key=pf["oss_object_key"],
                content_type=pf["content_type"],
                file_size=pf["size"],
                sha256=pf["sha256"],
            ))
        if file_objs:
            PackageFile.objects.bulk_create(file_objs)

        max_seq = (
            PackageVersion.objects
            .filter(package=pkg_locked, status=PackageVersion.Status.PUBLISHED)
            .aggregate(max_seq=Max("version_seq"))
        )["max_seq"] or 0
        new_seq = max_seq + 1

        # A3: init_files 已独立字段化;finalize 时清空即可,manifest 保持纯净。
        # _strip_legacy_init_files 是蓝绿部署窗口期保护(详见函数 docstring 下线扳机)。
        clean_manifest = _strip_legacy_init_files(version.manifest)
        version.version_seq = new_seq
        version.bundle_sha256 = bundle_sha256
        version.file_count = len(file_entries)
        version.total_size = total_size
        version.status = PackageVersion.Status.PUBLISHED
        version.manifest = clean_manifest
        version.init_files = []
        version.save(update_fields=[
            "version_seq", "bundle_sha256", "file_count",
            "total_size", "status", "manifest", "init_files",
        ])

        pkg_locked.latest_version_seq = new_seq
        pkg_locked.save(update_fields=["latest_version_seq", "updated_at"])

        emit_on_commit("pkg.version.published", str(package.organization_id), {
            "package_id": str(package.id),
            "version_id": str(version.id),
            "version_seq": new_seq,
            "bundle_sha256": bundle_sha256,
            "file_count": len(file_entries),
            "total_size": total_size,
        })

    # Wave 1（PRD V3.3 §11.4）：服务端自动登记 Skill 行（PG 同库）。
    # publish 后 Skills 端立即出 Skill 行 + SkillPublishedVersion 行，
    # Agent 通过 /skills/visible 立即可见。
    skill_upsert = _upsert_managed_skill_from_finalize(
        package=package, version=version, user_id=user_id,
    )

    return {
        "version_seq": new_seq,
        "version_label": version.version_label,
        "bundle_sha256": bundle_sha256,
        "file_count": len(file_entries),
        "total_size": total_size,
        "managed_skill": skill_upsert,
    }


def list_versions(
    *,
    package: Package,
    limit: int = 50,
    cursor: int | None = None,
) -> dict[str, Any]:
    limit = min(limit, 200)
    qs = PackageVersion.objects.filter(
        package=package,
        status=PackageVersion.Status.PUBLISHED,
    ).order_by("-version_seq")

    if cursor is not None:
        qs = qs.filter(version_seq__lt=cursor)

    items = list(qs[:limit + 1])
    has_next = len(items) > limit
    if has_next:
        items = items[:limit]

    next_cursor = items[-1].version_seq if has_next and items else None

    return {
        "items": [
            {
                "version_seq": v.version_seq,
                "version_label": v.version_label,
                "bundle_sha256": v.bundle_sha256,
                "is_yanked": v.is_yanked,
                "file_count": v.file_count,
                "total_size": v.total_size,
                "created_at": v.created_at.isoformat(),
                "created_by": str(v.created_by),
            }
            for v in items
        ],
        "next_cursor": next_cursor,
    }


def get_version_files(
    *,
    package: Package,
    version_seq: int,
    include_yanked: bool = False,
) -> dict[str, Any]:
    version = (
        PackageVersion.objects
        .filter(
            package=package,
            version_seq=version_seq,
            status=PackageVersion.Status.PUBLISHED,
        )
        .first()
    )
    if not version:
        raise LookupError("VERSION_NOT_FOUND")

    if version.is_yanked and not include_yanked:
        raise PermissionError("VERSION_YANKED")

    files_qs = PackageFile.objects.filter(version=version)
    files_out: list[dict[str, Any]] = []
    for pf in files_qs:
        oss_key = pf.oss_object_key or _make_object_key(package.id, pf.sha256)
        download_url = _generate_presigned_get_url(oss_key)
        files_out.append({
            "path": pf.path,
            "sha256": pf.sha256,
            "size": pf.file_size,
            "download_url": download_url,
            "content_type": pf.content_type,
        })

    return {
        "version_seq": version.version_seq,
        "version_label": version.version_label,
        "bundle_sha256": version.bundle_sha256,
        "manifest": version.manifest,
        "is_yanked": version.is_yanked,
        "files": files_out,
    }


def yank_version(
    *,
    package: Package,
    version_seq: int,
    reason: str,
    user_id: str,
) -> dict[str, Any]:
    check_package_write_access(user_id=user_id, organization_id=str(package.organization_id), min_role="admin")
    with transaction.atomic(using=_USING_DB):
        version = (
            PackageVersion.objects
            .select_for_update()
            .filter(
                package=package,
                version_seq=version_seq,
                status=PackageVersion.Status.PUBLISHED,
            )
            .first()
        )
        if not version:
            raise LookupError("VERSION_NOT_FOUND")

        now = timezone.now()
        version.is_yanked = True
        version.yanked_at = now
        version.yanked_by = user_id
        version.yanked_reason = reason
        version.save(update_fields=["is_yanked", "yanked_at", "yanked_by", "yanked_reason"])

        emit_on_commit("pkg.version.yanked", str(package.organization_id), {
            "package_id": str(package.id),
            "version_id": str(version.id),
            "version_seq": version_seq,
            "reason": reason,
            "yanked_by": user_id,
        })

    return {"yanked_at": now.isoformat()}


def revert_to_version(
    *,
    package: Package,
    target_version_seq: int,
    user_id: str,
) -> dict[str, Any]:
    """把 Package 回滚到指定 ``target_version_seq``。

    语义(与 git revert 一致):**创建一个新版本**,文件 / manifest / version_label
    都复用目标版本的内容,新版本的 ``version_seq = max+1``。原始的 target 版本
    保持不动(便于审计 / 撤销 revert)。

    Skills 联动:发布完成后通过 EventBus emit ``pkg.version.published`` 与
    ``pkg.package.reverted``,Skills 端订阅后同步 ``Skill.latest_version_seq``
    （Wave 1 PG 同库直接 update，无跨库告警）。

    边界:
    - target version 不存在 → ``LookupError("VERSION_NOT_FOUND")``
    - target version 已 yank → ``PermissionError("VERSION_YANKED")``
    - target version 就是当前 latest → ``ValueError("ALREADY_LATEST")``
    - 调用者非 ``editor+`` → ``PermissionError`` (走 ``check_package_write_access``)

    返回 ``{"new_version_seq", "new_version_id", "target_version_seq",
    "version_label", "synced_skills"}``。

    权限:**editor+**(与 publish / finalize 对齐)。revert 语义是用旧内容新建
    ``version_seq``,与发版一样会推进 ``latest_version_seq``；yank 仍保持
    ``admin+``（下架不可逆,危险性更高）。
    """
    check_package_write_access(
        user_id=user_id, organization_id=str(package.organization_id), min_role="editor",
    )

    with transaction.atomic(using=_USING_DB):
        pkg_locked = Package.objects.select_for_update().get(id=package.id)

        target = (
            PackageVersion.objects
            .select_for_update()
            .filter(
                package=pkg_locked,
                version_seq=target_version_seq,
                status=PackageVersion.Status.PUBLISHED,
            )
            .first()
        )
        if not target:
            raise LookupError("VERSION_NOT_FOUND")
        if target.is_yanked:
            raise PermissionError("VERSION_YANKED")
        if pkg_locked.latest_version_seq == target_version_seq:
            raise ValueError("ALREADY_LATEST")

        max_seq = (
            PackageVersion.objects
            .filter(package=pkg_locked, status=PackageVersion.Status.PUBLISHED)
            .aggregate(max_seq=Max("version_seq"))
        )["max_seq"] or 0
        new_seq = max_seq + 1

        # A3: 复用 _strip_legacy_init_files 清洗,确保 _init_files legacy 残留不传染
        clean_manifest = _strip_legacy_init_files(target.manifest)
        new_version = PackageVersion.objects.create(
            package=pkg_locked,
            version_seq=new_seq,
            version_label=target.version_label,
            bundle_sha256=target.bundle_sha256,
            file_count=target.file_count,
            total_size=target.total_size,
            manifest=clean_manifest,
            init_files=[],
            status=PackageVersion.Status.PUBLISHED,
            created_by=user_id,
        )

        target_files = list(PackageFile.objects.filter(version=target))
        new_files = [
            PackageFile(
                version=new_version,
                path=tf.path,
                file_record_id=tf.file_record_id,
                oss_object_key=tf.oss_object_key,
                content_type=tf.content_type,
                file_size=tf.file_size,
                sha256=tf.sha256,
            )
            for tf in target_files
        ]
        if new_files:
            PackageFile.objects.bulk_create(new_files)

        pkg_locked.latest_version_seq = new_seq
        pkg_locked.save(update_fields=["latest_version_seq", "updated_at"])

        # 复用 published 事件让通用订阅者感知;再 emit revert 专用事件方便审计
        emit_on_commit("pkg.version.published", str(package.organization_id), {
            "package_id": str(package.id),
            "version_id": str(new_version.id),
            "version_seq": new_seq,
            "bundle_sha256": new_version.bundle_sha256,
            "file_count": new_version.file_count,
            "total_size": new_version.total_size,
            "is_revert": True,
        })
        emit_on_commit("pkg.package.reverted", str(package.organization_id), {
            "package_id": str(package.id),
            "target_version_seq": target_version_seq,
            "new_version_seq": new_seq,
            "version_label": target.version_label,
            "user_id": user_id,
        })

    # Skills 联动:同步 Skill.latest_version_seq + 补写 SkillPublishedVersion。
    synced = _sync_managed_skill_version_pointer(
        package_id=package.id,
        version_label=target.version_label,
        new_version_seq=new_seq,
        source_version_seq=target_version_seq,
        bundle_sha256=new_version.bundle_sha256,
        user_id=user_id,
    )

    return {
        "new_version_seq": new_seq,
        "new_version_id": str(new_version.id),
        "target_version_seq": target_version_seq,
        "version_label": target.version_label,
        "synced_skills": synced,
    }


def read_skill_md_content(package_id: uuid.UUID, version: PackageVersion) -> str | None:
    """从 OSS 读 PackageFile(path='SKILL.md') 的内容(utf-8 文本)。

    用于 finalize_version 时自动登记 Skill 行（Wave 1）。OSS 失败 / 无 SKILL.md
    一律返回 None,调用方按"无 SKILL.md"处理(不阻塞 finalize 主路径)。
    """
    skill_pf = (
        PackageFile.objects.filter(version=version, path="SKILL.md").first()
    )
    if not skill_pf:
        return None

    try:
        from apps.services.oss.services.factory import get_oss_service

        oss = get_oss_service()
        result = oss.download_file(skill_pf.oss_object_key)
        # download_file 失败时返回 {success: False, ...},不抛异常
        if isinstance(result, dict):
            if result.get("success") is False:
                logger.info(
                    "[PackageRegistry] SKILL.md OSS download not available "
                    "package_id=%s object_key=%s: %s",
                    package_id, skill_pf.oss_object_key,
                    result.get("message", "unknown"),
                )
                return None
            # 兼容两种返回结构: {data: {content: bytes}} 或 {content: bytes}
            data = result.get("data") if "data" in result else result
            if isinstance(data, dict):
                content = data.get("content")
                if isinstance(content, (bytes, bytearray)):
                    return content.decode("utf-8", errors="replace")
                if isinstance(content, str):
                    return content
        return None
    except Exception as exc:
        logger.warning(
            "[PackageRegistry] read SKILL.md from OSS failed package_id=%s "
            "object_key=%s: %s",
            package_id, skill_pf.oss_object_key, exc,
        )
        return None


def _upsert_managed_skill_from_finalize(
    *,
    package: Package,
    version: PackageVersion,
    user_id: str,
) -> dict[str, Any]:
    """finalize_version 后自动登记 Skill 行（Wave 1，PRD V3.3 §11.4）。

    触发条件（任一满足）:
    - PackageFile 中存在 path='SKILL.md'
    - manifest 中 ``type == 'skill'``

    Wave 1 重构（W0 决策 1 V2）：
    - Skill 表归 PG（同库），不再跨库；操作变成同库 ORM
    - SkillPublishedVersion 行 + Skill.latest_version_seq 同步在此函数完成
    - SKILL.md 解析后 owner = package.created_by，对齐 owner_user_id 单一身份

    返回 ``{"upserted": bool, "skill_id": str|None, "skill_key": str|None,
            "reason": str|None}``。
    """
    manifest = version.manifest if isinstance(version.manifest, dict) else {}
    has_skill_md = PackageFile.objects.filter(
        version=version, path="SKILL.md",
    ).exists()
    is_skill_type = manifest.get("type") == "skill"
    if not (has_skill_md or is_skill_type):
        return {"upserted": False, "skill_id": None, "skill_key": None, "reason": "not_a_skill"}

    parsed: dict[str, Any] = {}
    if has_skill_md:
        skill_md_text = read_skill_md_content(package.id, version)
        if skill_md_text:
            try:
                from apps.skills.services.skill_doc_parser import parse_skill_doc

                parsed = parse_skill_doc(skill_md_text) or {}
            except Exception as exc:
                logger.warning(
                    "[PackageRegistry] parse SKILL.md frontmatter failed "
                    "package_id=%s: %s",
                    package.id, exc,
                )

    raw_name = (parsed.get("name") or manifest.get("name") or package.name).strip()
    if not raw_name:
        return {"upserted": False, "skill_id": None, "skill_key": None, "reason": "missing_skill_key"}

    try:
        from apps.skills.models import Skill, SkillPublishedVersion
        from apps.skills.services.publish_service import _slugify, _resolve_unique_slug

        owner_user_id = str(package.created_by) if package.created_by else (str(user_id) if user_id else None)
        if not owner_user_id:
            return {
                "upserted": False, "skill_id": None, "skill_key": None,
                "reason": "missing_owner",
            }

        slug = _slugify(raw_name)
        # 复用 owner 的 slug；若同 owner 已有相同 slug 则继续使用同一 Skill
        skill = Skill.objects.filter(
            owner_user_id=owner_user_id, slug=slug,
        ).first()
        if skill is None:
            slug = _resolve_unique_slug(owner_user_id=owner_user_id, slug=slug)
            skill = Skill.objects.create(
                owner_user_id=owner_user_id,
                slug=slug,
                name=parsed.get("name") or manifest.get("name") or slug,
                description=parsed.get("description") or manifest.get("description") or "",
                visibility=Skill.VISIBILITY_PRIVATE,
                organization_id=str(package.organization_id) if package.organization_id else None,
                package_id=package.id,
                agents_json=parsed.get("agents_json") or parsed.get("agents") or [],
                latest_version_seq=version.version_seq,
                install_content_hash=version.bundle_sha256 or "",
            )
        else:
            update_fields: list[str] = []
            if skill.package_id != package.id:
                skill.package_id = package.id
                update_fields.append("package_id")
            if skill.latest_version_seq != version.version_seq:
                skill.latest_version_seq = version.version_seq
                update_fields.append("latest_version_seq")
            if skill.install_content_hash != (version.bundle_sha256 or ""):
                skill.install_content_hash = version.bundle_sha256 or ""
                update_fields.append("install_content_hash")
            if update_fields:
                skill.save(update_fields=update_fields + ["updated_at"])

        # Skill PublishedVersion 行（review_status 按 visibility 决定）
        review_status = (
            SkillPublishedVersion.REVIEW_PENDING
            if skill.visibility == Skill.VISIBILITY_PUBLIC
            else SkillPublishedVersion.REVIEW_NOT_REQUIRED
        )
        SkillPublishedVersion.objects.update_or_create(
            skill=skill,
            version_seq=version.version_seq,
            defaults={
                "version_label": version.version_label or "",
                "bundle_sha256": version.bundle_sha256 or "",
                "published_by": owner_user_id,
                "review_status": review_status,
            },
        )

        logger.info(
            "[PackageRegistry] finalize upserted Skill skill_id=%s slug=%s "
            "package_id=%s version_seq=%s",
            skill.skill_id, skill.slug, package.id, version.version_seq,
        )
        return {
            "upserted": True,
            "skill_id": str(skill.skill_id),
            "skill_key": skill.canonical_key,
            "reason": None,
        }
    except Exception as exc:
        # PG 同库 — 失败概率极低；保留告警 emit 兜底。
        logger.error(
            "[PackageRegistry] finalize Skill upsert failed "
            "package_id=%s name=%s: %s",
            package.id, raw_name, exc, exc_info=True,
        )
        try:
            emit_with_outbox_fallback(
                "pkg.skill.upsert_failed",
                str(package.organization_id),
                {
                    "package_id": str(package.id),
                    "version_seq": version.version_seq,
                    "skill_key": raw_name,
                    "reason": str(exc),
                },
            )
        except Exception:
            logger.warning(
                "[PackageRegistry] outbox-fallback emit pkg.skill.upsert_failed 失败 "
                "package_id=%s", package.id, exc_info=True,
            )
        return {
            "upserted": False, "skill_id": None, "skill_key": raw_name,
            "reason": "skill_upsert_failed",
        }


def _sync_managed_skill_version_pointer(
    *,
    package_id: uuid.UUID,
    version_label: str | None,
    new_version_seq: int,
    source_version_seq: int | None = None,
    bundle_sha256: str | None = None,
    user_id: str | None = None,
) -> int:
    """revert 后同步 Skill 指针，并补写 ``SkillPublishedVersion``。

    Wave 1 改动（W0 决策 1 V2）：Skill 表归 PG，跟 Package 同库 → 不再"跨库"
    告警，单库 update。失败概率极低，保留 emit 兜底以便运维感知。

    设计要点：
    - ``Skill.latest_version_seq`` 是云端权威指针，revert 后必须同步到新 seq
    - 前端 ``to_index_entry`` 用 ``published_versions.filter(version_seq=latest)``
      取 ``latest_version_label``；若只改指针不建 SPV，版本号与历史入口会消失
    - 新 SPV 从源版本 SPV 拷贝 ``quick_use_json`` / ``local_content_hash`` 等快照字段
    """
    try:
        from apps.skills.models import Skill, SkillPublishedVersion

        new_pv = (
            PackageVersion.objects
            .filter(package_id=package_id, version_seq=new_version_seq)
            .only("version_label", "bundle_sha256")
            .first()
        )
        label = (version_label or (new_pv.version_label if new_pv else "") or "").strip()
        sha = (bundle_sha256 or (new_pv.bundle_sha256 if new_pv else "") or "").strip()

        skills = list(Skill.objects.filter(package_id=package_id))
        if not skills:
            return 0

        affected = 0
        for skill in skills:
            source_spv = None
            if source_version_seq is not None:
                source_spv = (
                    SkillPublishedVersion.objects
                    .filter(skill=skill, version_seq=source_version_seq)
                    .first()
                )
            if source_spv is None:
                source_spv = (
                    SkillPublishedVersion.objects
                    .filter(skill=skill, version_seq__lt=new_version_seq)
                    .order_by("-version_seq")
                    .first()
                )

            fallback_review = (
                SkillPublishedVersion.REVIEW_PENDING
                if skill.visibility == Skill.VISIBILITY_PUBLIC
                else SkillPublishedVersion.REVIEW_NOT_REQUIRED
            )
            published_by_raw = (
                user_id
                or (str(source_spv.published_by) if source_spv and source_spv.published_by else None)
                or str(skill.owner_user_id)
            )
            try:
                published_by = uuid.UUID(str(published_by_raw))
            except (TypeError, ValueError):
                published_by = skill.owner_user_id

            change_note = ""
            if source_version_seq is not None:
                src_label = (source_spv.version_label if source_spv else "") or f"v{source_version_seq}"
                change_note = f"Reverted to {src_label}"
            elif source_spv and source_spv.change_note:
                change_note = source_spv.change_note

            SkillPublishedVersion.objects.update_or_create(
                skill=skill,
                version_seq=new_version_seq,
                defaults={
                    "version_label": label or (source_spv.version_label if source_spv else ""),
                    "bundle_sha256": sha,
                    "local_content_hash": (
                        source_spv.local_content_hash if source_spv else ""
                    ),
                    "quick_use_json": (
                        list(source_spv.quick_use_json or []) if source_spv else []
                    ),
                    "change_note": change_note,
                    "published_by": published_by,
                    "review_status": (
                        source_spv.review_status if source_spv else fallback_review
                    ),
                },
            )

            update_fields = ["latest_version_seq", "updated_at"]
            skill.latest_version_seq = new_version_seq
            if sha and skill.install_content_hash != sha:
                skill.install_content_hash = sha
                update_fields.append("install_content_hash")
            skill.save(update_fields=update_fields)
            affected += 1

        if affected:
            logger.info(
                "[PackageRegistry] revert synced %d Skill(s) "
                "package_id=%s version=%s new_seq=%s source_seq=%s",
                affected, package_id, label or version_label, new_version_seq,
                source_version_seq,
            )
        return affected
    except Exception as exc:
        logger.error(
            "[PackageRegistry] revert Skill sync failed "
            "package_id=%s new_seq=%s: %s",
            package_id, new_version_seq, exc, exc_info=True,
        )
        try:
            emit_with_outbox_fallback(
                "pkg.package.reverted_sync_failed",
                "",
                {
                    "package_id": str(package_id),
                    "target_version_seq": new_version_seq,
                    "source_version_seq": source_version_seq,
                    "reason": str(exc),
                },
            )
        except Exception:
            logger.warning(
                "[PackageRegistry] outbox-fallback emit "
                "pkg.package.reverted_sync_failed 失败 package_id=%s",
                package_id, exc_info=True,
            )
        return 0


def fork_package(
    *,
    source_package: Package,
    target_namespace: str,
    target_name: str,
    target_organization_id: str,
    fork_at_version_seq: int | None = None,
    user_id: str,
) -> dict[str, Any]:
    validate_slug(target_namespace, "namespace")
    validate_slug(target_name, "name")
    check_package_write_access(user_id=user_id, organization_id=target_organization_id, min_role="editor")
    with transaction.atomic(using=_USING_DB):
        new_pkg = Package.objects.create(
            namespace=target_namespace,
            name=target_name,
            organization_id=target_organization_id,
            created_by=user_id,
            metadata=source_package.metadata,
            parent_package_id=source_package.id,
        )

        src_versions = PackageVersion.objects.filter(
            package=source_package,
            status=PackageVersion.Status.PUBLISHED,
            is_yanked=False,
        ).order_by("version_seq")

        if fork_at_version_seq is not None:
            src_versions = src_versions.filter(version_seq__lte=fork_at_version_seq)

        copied = 0
        for sv in src_versions:
            # A3: fork 时清洗 manifest._init_files,避免跨 namespace 传染 legacy 残留
            # (即使 source 因 0003 异常或部署窗口期产生了"manifest 含 _init_files"
            # 的脏行,fork 出的新版本必须是纯净的 published 状态)。
            clean_manifest = _strip_legacy_init_files(sv.manifest)
            nv = PackageVersion.objects.create(
                package=new_pkg,
                version_seq=sv.version_seq,
                version_label=sv.version_label,
                bundle_sha256=sv.bundle_sha256,
                file_count=sv.file_count,
                total_size=sv.total_size,
                manifest=clean_manifest,
                init_files=[],
                status=PackageVersion.Status.PUBLISHED,
                created_by=user_id,
            )
            src_files = PackageFile.objects.filter(version=sv)
            file_batch = [
                PackageFile(
                    version=nv,
                    path=sf.path,
                    file_record_id=sf.file_record_id,
                    oss_object_key=sf.oss_object_key,
                    content_type=sf.content_type,
                    file_size=sf.file_size,
                    sha256=sf.sha256,
                )
                for sf in src_files
            ]
            if file_batch:
                PackageFile.objects.bulk_create(file_batch)
            copied += 1

        if copied > 0:
            new_pkg.latest_version_seq = src_versions.last().version_seq
            new_pkg.save(update_fields=["latest_version_seq", "updated_at"])

        emit_on_commit("pkg.package.created", target_organization_id, {
            "package_id": str(new_pkg.id),
            "namespace": target_namespace,
            "name": target_name,
            "organization_id": target_organization_id,
            "created_by": user_id,
        })

        emit_on_commit("pkg.fork.created", target_organization_id, {
            "source_package_id": str(source_package.id),
            "new_package_id": str(new_pkg.id),
            "fork_at_version_seq": fork_at_version_seq,
        })

    return {
        "new_package_id": str(new_pkg.id),
        "copied_versions": copied,
    }


def lookup_package(*, namespace: str, name: str) -> Package:
    """按 namespace + name 查找 Package，找不到抛 LookupError。"""
    pkg = Package.objects.filter(namespace=namespace, name=name).first()
    if not pkg:
        raise LookupError(f"PACKAGE_NOT_FOUND: {namespace}/{name}")
    return pkg


# ---------------------------------------------------------------------------
# Wave 1（PRD V3.3 §11.1，2026-05-02）：Skill 表归 PG，跨库 ref 已删除。
# 旧 _record_managed_skill_ref / _delete_managed_skill_ref 不再需要——GC 任务
# 直接 Skill.objects.filter(package_id=...).exists() 在 PG 同库内查（race-free）。
# 保留两个空 helper 占位以兼容外部 import（如 tests / outbox retry）。
# ---------------------------------------------------------------------------


def _record_managed_skill_ref(
    *,
    package_id: Any,
    skill_key: str,
    organization_id: str | None,
) -> bool:
    """已废弃（Wave 1 起）— Skill 表归 PG，无需跨库 ref；no-op。"""
    return True


def _delete_managed_skill_ref(
    *,
    package_id: Any,
    skill_key: str,
    organization_id: str | None = None,
) -> bool:
    """已废弃（Wave 1 起）— Skill 表归 PG，无需跨库 ref；no-op。"""
    return True


# Wave 1 完成：所有跨库 ref 历史实现已彻底删除。
