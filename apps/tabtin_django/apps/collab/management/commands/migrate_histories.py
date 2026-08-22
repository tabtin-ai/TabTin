from django.conf import settings
"""
迁移各模块的 History 表到统一 VersionHistory 表。

用法:
    python manage.py migrate_histories --module=slide
    python manage.py migrate_histories --module=docs
    python manage.py migrate_histories --module=video
    python manage.py migrate_histories --all
    python manage.py migrate_histories --module=slide --dry-run

幂等设计：重复运行不创建重复记录（通过 metadata.legacy_id 去重）。
"""
import base64
import logging
import zlib

from django.core.cache import cache
from django.core.management.base import BaseCommand
from django.utils import timezone

from apps.collab.models import VersionHistory

logger = logging.getLogger("collab.migrate_histories")

DB = ('default' if getattr(settings, 'TABTIN_SINGLE_DATABASE_MODE', False) else 'postgresql')
# CSC-036: 迁移时对已过期记录赋予的最小 TTL（秒），避免迁移后立即被 cleanup 删除。
_MIGRATE_MIN_TTL_SECONDS = 86400 * 7  # 7 天

# CSC-038: 迁移任务的 Redis 锁 key，防止与 cleanup_slide_history 并发。
_MIGRATE_SLIDE_LOCK_KEY = "lock:migrate_slide_histories"
_MIGRATE_SLIDE_LOCK_TIMEOUT = 3600  # 最长持锁 1 小时

# MC-01: DocHistory 迁移任务的 Redis 锁 key，防止与手动迁移/cleanup 并发。
_MIGRATE_DOC_LOCK_KEY = "lock:migrate_doc_histories"
_MIGRATE_DOC_LOCK_TIMEOUT = 3600

MODULE_HANDLERS = {}


def register_handler(module_name):
    def decorator(func):
        MODULE_HANDLERS[module_name] = func
        return func
    return decorator


def _backfill_base_history(resource_type: str, old_histories, legacy_to_new: dict):
    """第二遍：回填 base_history 指针关系。"""
    updated = 0
    for h in old_histories:
        if h.base_history_id is None:
            continue
        legacy_base_id = str(h.base_history_id)
        new_base_id = legacy_to_new.get(legacy_base_id)
        if not new_base_id:
            continue
        legacy_id = str(h.id)
        new_id = legacy_to_new.get(legacy_id)
        if not new_id:
            continue
        VersionHistory.objects.using(DB).filter(id=new_id).update(
            base_history_id=new_base_id
        )
        updated += 1
    if updated:
        logger.info("Backfilled %d base_history links for %s", updated, resource_type)


def _safe_expired_at(expired_at):
    """CSC-036: 确保迁移后的 expired_at 不早于当前时间 + 最小 TTL。

    若原始 expired_at 已过期或即将过期（< 最小 TTL），则延长到 now + 最小 TTL。
    命名版本（expired_at=None）保持 None 不变。
    """
    if expired_at is None:
        return None
    min_expiry = timezone.now() + timezone.timedelta(seconds=_MIGRATE_MIN_TTL_SECONDS)
    if expired_at < min_expiry:
        return min_expiry
    return expired_at


def _upgrade_slide_blob_format(blob: bytes) -> bytes:
    """CSC-032: 将旧格式（纯 list）的 blob 升级为新格式（dict with pages/theme/font_meta）。

    旧格式 blob 反序列化后是 list（纯 pages 列表），不含 theme 和 font_meta。
    迁移时将其包装为 {"pages": [...], "theme": None, "font_meta": None}，
    确保 restore 时 isinstance(data, dict) 为 True，extra_fields 能正确提取。
    """
    import json
    import zlib

    if not blob:
        return blob
    try:
        raw = blob if isinstance(blob, bytes) else bytes(blob)
        data = json.loads(zlib.decompress(raw).decode("utf-8"))
        if isinstance(data, list):
            upgraded = {"pages": data, "theme": None, "font_meta": None}
            return zlib.compress(
                json.dumps(upgraded, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
                level=6,
            )
    except Exception as e:
        logger.warning("Failed to upgrade slide blob format: %s", e)
    return blob


@register_handler("slide")
def migrate_slide_histories(dry_run=False):
    """CSC-030/031/032/036/038: 修复后的 slide 历史迁移函数。

    - CSC-030: 改用 iterator() 流式读取，避免全量加载 OOM
    - CSC-031: 每条记录独立 try/except，失败跳过不中断整体迁移
    - CSC-032: 迁移时升级旧格式 blob（list → dict）
    - CSC-036: expired_at 已过期时延长 TTL，避免迁移后立即被 cleanup 删除
    - CSC-038: 持有 Redis 锁防止与 cleanup_slide_history 并发
    """
    from apps.tabslide.models import SlideHistory

    # CSC-038: 尝试获取迁移锁，防止与 cleanup 并发导致 base_history 链断裂。
    if not dry_run:
        acquired = cache.add(_MIGRATE_SLIDE_LOCK_KEY, "1", timeout=_MIGRATE_SLIDE_LOCK_TIMEOUT)
        if not acquired:
            logger.warning(
                "migrate_slide_histories: another migration is running (lock held), skipping"
            )
            return 0, 0, 0

    try:
        # CSC-030: 使用 iterator() 流式读取，避免 list() 全量加载 OOM。
        qs = SlideHistory.objects.using(DB).order_by("created_at")
        total = qs.count()
        migrated = 0
        skipped = 0
        failed = 0
        legacy_to_new: dict[str, str] = {}

        # 第一遍：迁移记录，收集 legacy_to_new 映射（用于第二遍回填 base_history）。
        # 注意：iterator() 不支持在遍历过程中再次查询同一 queryset，
        # 但 legacy_to_new 回填需要完整映射，故先完成第一遍再做第二遍。
        # 为支持第二遍回填，需要保留有 base_history_id 的记录 ID 列表（内存占用小）。
        histories_with_base: list[tuple[str, str]] = []  # (legacy_id, legacy_base_id)

        for h in qs.iterator():
            legacy_id = str(h.id)
            try:
                existing = VersionHistory.objects.using(DB).filter(
                    resource_type="slide",
                    metadata__legacy_id=legacy_id,
                ).first()
                if existing:
                    legacy_to_new[legacy_id] = str(existing.id)
                    skipped += 1
                    if h.base_history_id:
                        histories_with_base.append((legacy_id, str(h.base_history_id)))
                    continue

                if dry_run:
                    migrated += 1
                    continue

                # CSC-032: 升级旧格式 blob（list → dict with theme/font_meta）。
                blob = bytes(h.blob) if h.blob else b""
                blob = _upgrade_slide_blob_format(blob)

                # CSC-036: 确保 expired_at 不早于 now + 最小 TTL。
                safe_expired_at = _safe_expired_at(h.expired_at)

                vh = VersionHistory.objects.using(DB).create(
                    resource_type="slide",
                    resource_id=h.project_id,
                    organization_id=h.organization_id,
                    blob=blob,
                    blob_size=len(blob),
                    is_snapshot=h.is_snapshot,
                    base_history=None,
                    editor_type=h.editor_type or "user",
                    editor_id=h.editor_id or "",
                    expired_at=safe_expired_at,
                    is_named=h.is_named,
                    name=h.name or "",
                    pinned=h.pinned,
                    metadata={
                        "legacy_id": legacy_id,
                        "legacy_model": "SlideHistory",
                        "version": h.version,
                        "page_count": h.page_count,
                    },
                    created_at=h.created_at,
                )
                legacy_to_new[legacy_id] = str(vh.id)
                migrated += 1

                if h.base_history_id:
                    histories_with_base.append((legacy_id, str(h.base_history_id)))

            except Exception:
                # CSC-031: 单条失败不中断整体迁移，记录日志后继续。
                logger.exception(
                    "migrate_slide_histories: failed to migrate SlideHistory %s, skipping",
                    legacy_id,
                )
                failed += 1

        if not dry_run:
            # 第二遍：回填 base_history 指针关系（使用内存中的轻量映射）。
            _backfill_base_history_from_pairs("slide", histories_with_base, legacy_to_new)

        if failed:
            logger.warning(
                "migrate_slide_histories: %d records failed to migrate (see logs above)",
                failed,
            )

        return total, migrated, skipped

    finally:
        if not dry_run:
            cache.delete(_MIGRATE_SLIDE_LOCK_KEY)


def _backfill_base_history_from_pairs(
    resource_type: str,
    histories_with_base: list[tuple[str, str]],
    legacy_to_new: dict,
):
    """从 (legacy_id, legacy_base_id) 对列表回填 base_history 指针。

    替代原 _backfill_base_history，不需要重新遍历完整 ORM 对象列表，
    避免 iterator() 迁移后无法重新遍历的问题。
    """
    updated = 0
    for legacy_id, legacy_base_id in histories_with_base:
        new_id = legacy_to_new.get(legacy_id)
        new_base_id = legacy_to_new.get(legacy_base_id)
        if not new_id or not new_base_id:
            continue
        VersionHistory.objects.using(DB).filter(id=new_id).update(
            base_history_id=new_base_id
        )
        updated += 1
    if updated:
        logger.info("Backfilled %d base_history links for %s", updated, resource_type)


def migrate_slide_histories_batch(batch_size: int = 500) -> dict:
    """TSV-015/TSV-016/CSC-035: 增量分批迁移 SlideHistory → VersionHistory。

    供 Celery Beat 定时任务调用，每次迁移最多 batch_size 条未迁移记录。
    当所有记录均已迁移时返回 {"done": True}，任务可据此自动停止。

    与 migrate_slide_histories 的区别：
    - 不持有 Redis 锁（调用方 Celery 任务负责锁管理）
    - 只处理尚未迁移的记录（通过 metadata.legacy_id 去重）
    - 支持 batch_size 控制每次处理量，避免长时间占用 Worker
    - 返回结构化结果供调用方判断是否继续调度
    """
    from apps.tabslide.models import SlideHistory

    # 找出尚未迁移的 SlideHistory ID（通过 metadata.legacy_id 去重）
    # 先取一批候选记录，再过滤已迁移的
    candidate_qs = SlideHistory.objects.using(DB).order_by("created_at")
    total_remaining = candidate_qs.count()

    if total_remaining == 0:
        return {"done": True, "migrated": 0, "failed": 0, "remaining": 0}

    migrated = 0
    failed = 0
    processed = 0
    legacy_to_new: dict[str, str] = {}
    histories_with_base: list[tuple[str, str]] = []

    for h in candidate_qs.iterator():
        if processed >= batch_size:
            break

        legacy_id = str(h.id)
        try:
            existing = VersionHistory.objects.using(DB).filter(
                resource_type="slide",
                metadata__legacy_id=legacy_id,
            ).first()
            if existing:
                legacy_to_new[legacy_id] = str(existing.id)
                if h.base_history_id:
                    histories_with_base.append((legacy_id, str(h.base_history_id)))
                continue

            blob = bytes(h.blob) if h.blob else b""
            blob = _upgrade_slide_blob_format(blob)
            safe_expired_at = _safe_expired_at(h.expired_at)

            vh = VersionHistory.objects.using(DB).create(
                resource_type="slide",
                resource_id=h.project_id,
                organization_id=h.organization_id,
                blob=blob,
                blob_size=len(blob),
                is_snapshot=h.is_snapshot,
                base_history=None,
                editor_type=h.editor_type or "user",
                editor_id=h.editor_id or "",
                expired_at=safe_expired_at,
                is_named=h.is_named,
                name=h.name or "",
                pinned=h.pinned,
                metadata={
                    "legacy_id": legacy_id,
                    "legacy_model": "SlideHistory",
                    "version": h.version,
                    "page_count": h.page_count,
                },
                created_at=h.created_at,
            )
            legacy_to_new[legacy_id] = str(vh.id)
            migrated += 1
            processed += 1

            if h.base_history_id:
                histories_with_base.append((legacy_id, str(h.base_history_id)))

        except Exception:
            logger.exception(
                "migrate_slide_histories_batch: failed to migrate SlideHistory %s, skipping",
                legacy_id,
            )
            failed += 1
            processed += 1

    # 回填 base_history 指针（仅针对本批次处理的记录）
    if histories_with_base:
        _backfill_base_history_from_pairs("slide", histories_with_base, legacy_to_new)

    # 重新检查是否还有未迁移的记录
    remaining_count = SlideHistory.objects.using(DB).exclude(
        id__in=VersionHistory.objects.using(DB).filter(
            resource_type="slide",
        ).values_list("metadata__legacy_id", flat=True)
    ).count()

    # 注意：remaining_count 查询可能较慢（跨表 NOT IN），
    # 简化判断：若本批次迁移数 < batch_size 且 failed == 0，认为已完成
    done = migrated < batch_size and failed == 0

    return {
        "done": done,
        "migrated": migrated,
        "failed": failed,
        "remaining": remaining_count if not done else 0,
    }


def _decompress_doc_blob(blob: bytes) -> bytes:
    """解压 DocHistory blob，兼容旧的未压缩数据。"""
    if not blob:
        return b""
    try:
        return zlib.decompress(blob)
    except zlib.error:
        return blob


def _try_resolve_doc_diff(diff_history, all_histories_by_id: dict) -> tuple[bytes, bool]:
    """MC-01: 尝试将 DocHistory 增量 diff 解析为完整 Y.js binary。

    对于增量 diff，需要找到 base_history（全量快照），然后通过 collab-live
    apply-diff 合并得到完整 binary。

    Returns:
        (blob, resolved): blob 为最终存储的数据，resolved=True 表示已解析为全量快照。
        如果解析失败，返回原始 blob 并 resolved=False，保留 diff 链由 backfill 处理。
    """
    raw_blob = bytes(diff_history.blob) if diff_history.blob else b""
    if not raw_blob:
        return b"", False

    if not diff_history.base_history_id:
        return raw_blob, False

    try:
        base_hist = all_histories_by_id.get(str(diff_history.base_history_id))
        if not base_hist or not base_hist.blob:
            return raw_blob, False

        base_decompressed = _decompress_doc_blob(bytes(base_hist.blob))
        diff_decompressed = _decompress_doc_blob(raw_blob)

        # JSON snapshot 基线不支持 binary diff 合并
        try:
            import json
            parsed = json.loads(base_decompressed.decode("utf-8"))
            if isinstance(parsed, dict) and parsed.get("format") == "json_snapshot":
                return raw_blob, False
        except (UnicodeDecodeError, json.JSONDecodeError):
            pass

        from apps.services.common.live_api import call_live_api

        base_b64 = base64.b64encode(base_decompressed).decode()
        diff_b64 = base64.b64encode(diff_decompressed).decode()

        result = call_live_api("/yjs/apply-diff", {
            "base_binary_b64": base_b64,
            "diffs_b64": [diff_b64],
        }, max_retries=0, timeout=5)

        merged_b64 = result.get("merged_b64", "")
        if merged_b64:
            resolved_binary = base64.b64decode(merged_b64)
            return zlib.compress(resolved_binary, level=6), True
    except Exception as e:
        logger.debug(
            "migrate_doc: failed to resolve diff %s, keeping as diff: %s",
            diff_history.id, e,
        )

    return raw_blob, False


def _migrate_single_doc_history(h, legacy_to_new, histories_with_base,
                                all_histories_by_id: dict | None = None):
    """MC-01: 迁移单条 DocHistory → VersionHistory。

    Returns: "migrated" | "skipped" | "failed"
    """
    legacy_id = str(h.id)
    try:
        existing = VersionHistory.objects.using(DB).filter(
            resource_type="docs",
            metadata__legacy_id=legacy_id,
        ).first()
        if existing:
            legacy_to_new[legacy_id] = str(existing.id)
            if h.base_history_id:
                histories_with_base.append((legacy_id, str(h.base_history_id)))
            return "skipped"

        blob = bytes(h.blob) if h.blob else b""
        blob_size = len(blob)
        is_snapshot = h.is_snapshot
        resolved = False

        # 对增量 diff 尝试 resolve 为全量快照
        if not is_snapshot and all_histories_by_id:
            blob, resolved = _try_resolve_doc_diff(h, all_histories_by_id)
            blob_size = len(blob)
            if resolved:
                is_snapshot = True

        # CSC-036: 确保 expired_at 不早于 now + 最小 TTL
        safe_expired_at = _safe_expired_at(h.expired_at)

        # CSC-037: editor_type 空字符串规范化为 "user"
        editor_type = h.editor_type or "user"

        vh = VersionHistory.objects.using(DB).create(
            resource_type="docs",
            resource_id=h.document_id,
            organization_id=h.organization_id,
            blob=blob,
            blob_size=blob_size,
            is_snapshot=is_snapshot,
            base_history=None,
            editor_type=editor_type,
            editor_id=h.editor_id or "",
            editor_name="",
            expired_at=safe_expired_at,
            is_named=h.is_named,
            name=h.name or "",
            pinned=h.pinned,
            metadata={
                "legacy_id": legacy_id,
                "legacy_model": "DocHistory",
                "resolved_from_diff": resolved,
            },
            created_at=h.created_at,
        )
        legacy_to_new[legacy_id] = str(vh.id)

        # 未解析成功的 diff 记录，需要回填 base_history
        if not resolved and h.base_history_id:
            histories_with_base.append((legacy_id, str(h.base_history_id)))

        return "migrated"

    except Exception:
        logger.exception(
            "migrate_doc_histories: failed to migrate DocHistory %s, skipping",
            legacy_id,
        )
        return "failed"


@register_handler("docs")
def migrate_docs_histories(dry_run=False):
    """MC-01: DocHistory → VersionHistory 全量迁移（management command 入口）。

    - CSC-036: expired_at 已过期时延长 TTL
    - CSC-037: editor_type 空字符串规范化为 "user"
    - CSC-038: Redis 锁防止与 cleanup/incremental 任务并发
    - 增量 diff 尝试 resolve 为全量快照，失败则保留 diff 链
    """
    from apps.tabdoc.models import DocHistory

    if not dry_run:
        acquired = cache.add(_MIGRATE_DOC_LOCK_KEY, "1", timeout=_MIGRATE_DOC_LOCK_TIMEOUT)
        if not acquired:
            logger.warning(
                "migrate_docs_histories: another migration is running (lock held), skipping"
            )
            return 0, 0, 0

    try:
        qs = DocHistory.objects.using(DB).order_by("created_at")
        total = qs.count()
        migrated = 0
        skipped = 0
        failed = 0
        legacy_to_new: dict[str, str] = {}
        histories_with_base: list[tuple[str, str]] = []

        # 预加载有 base_history 的 snapshot 记录，用于 diff resolve
        snapshot_ids = set(
            qs.filter(is_snapshot=True).values_list("id", flat=True)
        )
        all_histories_by_id: dict = {}
        if snapshot_ids:
            for s in DocHistory.objects.using(DB).filter(id__in=snapshot_ids).iterator():
                all_histories_by_id[str(s.id)] = s

        for h in qs.iterator():
            if dry_run:
                legacy_id = str(h.id)
                exists = VersionHistory.objects.using(DB).filter(
                    resource_type="docs",
                    metadata__legacy_id=legacy_id,
                ).exists()
                if exists:
                    skipped += 1
                else:
                    migrated += 1
                continue

            result = _migrate_single_doc_history(
                h, legacy_to_new, histories_with_base, all_histories_by_id,
            )
            if result == "migrated":
                migrated += 1
            elif result == "skipped":
                skipped += 1
            else:
                failed += 1

        if not dry_run and histories_with_base:
            _backfill_base_history_from_pairs("docs", histories_with_base, legacy_to_new)

        if failed:
            logger.warning(
                "migrate_docs_histories: %d records failed to migrate", failed,
            )

        return total, migrated, skipped

    finally:
        if not dry_run:
            cache.delete(_MIGRATE_DOC_LOCK_KEY)


def migrate_doc_histories_batch(batch_size: int = 500) -> dict:
    """MC-01: 增量分批迁移 DocHistory → VersionHistory。

    供 Celery Beat 定时任务调用，每次迁移最多 batch_size 条未迁移记录。
    当所有记录均已迁移时返回 {"done": True}，任务可据此自动停止。

    与 migrate_docs_histories 的区别：
    - 不持有 Redis 锁（调用方 Celery 任务负责锁管理）
    - 只处理尚未迁移的记录（通过 metadata.legacy_id 去重）
    - 支持 batch_size 控制每次处理量
    - 对增量 diff 尝试 resolve 为全量快照，失败保留 diff 链
    """
    from apps.tabdoc.models import DocHistory

    candidate_qs = DocHistory.objects.using(DB).order_by("created_at")
    total_remaining = candidate_qs.count()

    if total_remaining == 0:
        return {"done": True, "migrated": 0, "failed": 0, "remaining": 0}

    migrated = 0
    failed = 0
    processed = 0
    legacy_to_new: dict[str, str] = {}
    histories_with_base: list[tuple[str, str]] = []

    # 预加载 snapshot 记录供 diff resolve 使用（仅加载必要的，上限 batch_size*2 防止 OOM）
    snapshot_ids = set(
        candidate_qs.filter(is_snapshot=True)
        .values_list("id", flat=True)[:batch_size * 2]
    )
    all_histories_by_id: dict = {}
    if snapshot_ids:
        for s in DocHistory.objects.using(DB).filter(id__in=snapshot_ids).iterator():
            all_histories_by_id[str(s.id)] = s

    for h in candidate_qs.iterator():
        if processed >= batch_size:
            break

        legacy_id = str(h.id)
        existing = VersionHistory.objects.using(DB).filter(
            resource_type="docs",
            metadata__legacy_id=legacy_id,
        ).first()
        if existing:
            legacy_to_new[legacy_id] = str(existing.id)
            if h.base_history_id:
                histories_with_base.append((legacy_id, str(h.base_history_id)))
            continue

        result = _migrate_single_doc_history(
            h, legacy_to_new, histories_with_base, all_histories_by_id,
        )
        if result == "migrated":
            migrated += 1
        elif result == "failed":
            failed += 1
        processed += 1

    if histories_with_base:
        _backfill_base_history_from_pairs("docs", histories_with_base, legacy_to_new)

    done = migrated < batch_size and failed == 0

    return {
        "done": done,
        "migrated": migrated,
        "failed": failed,
        "remaining": 0 if done else max(0, total_remaining - migrated),
    }


class Command(BaseCommand):
    help = "迁移各模块 History 表到统一 VersionHistory 表"

    def add_arguments(self, parser):
        parser.add_argument(
            "--module",
            type=str,
            choices=list(MODULE_HANDLERS.keys()),
            help="要迁移的模块",
        )
        parser.add_argument(
            "--all",
            action="store_true",
            help="迁移所有模块",
        )
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="只统计不写入",
        )

    def handle(self, *args, **options):
        modules = []
        if options.get("all"):
            modules = list(MODULE_HANDLERS.keys())
        elif options.get("module"):
            modules = [options["module"]]
        else:
            self.stderr.write("请指定 --module=<name> 或 --all")
            return

        dry_run = options.get("dry_run", False)
        if dry_run:
            self.stdout.write("[DRY RUN] 不会写入数据\n")

        for module in modules:
            handler = MODULE_HANDLERS[module]
            self.stdout.write(f"\n--- 迁移 {module} ---")
            try:
                total, migrated, skipped = handler(dry_run=dry_run)
                self.stdout.write(
                    f"  总计: {total}, 迁移: {migrated}, 跳过(已存在): {skipped}"
                )
            except Exception as e:
                self.stderr.write(f"  错误: {e}")
                logger.exception("Failed to migrate %s histories", module)

        self.stdout.write("\n完成。")
