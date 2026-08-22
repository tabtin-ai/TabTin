"""fts_reindex — 全量回填 ES 索引（PRD 4.3.E + 第 10 章 + Wave 5）。

用法：

    # 全量回填所有 6 索引（顺序：agents → spaces → resources → memos → im → messages，PRD 10.1）
    python manage.py fts_reindex --index=all --batch-size=1000

    # 单索引回填
    python manage.py fts_reindex --index=tabtin-messages --batch-size=2000

    # 断点续传（从 Redis 进度继续）
    python manage.py fts_reindex --index=tabtin-messages --resume

    # 删除重建（mapping 变更后必跑）
    python manage.py fts_reindex --index=tabtin-messages --recreate

    # dry-run（不写 ES，只统计）
    python manage.py fts_reindex --index=tabtin-spaces --dry-run

设计要点（PRD 10.2 性能优化）：
    1. 批量读取（游标分批，默认 1000）
    2. 临时 settings：`refresh_interval=-1` + `number_of_replicas=0` 提速
    3. 回填完成后 forcemerge + 恢复 refresh + replica
    4. 断点 / 进度存 Redis key `fts:reindex:progress:{base_name}`
    5. R1-21 警告：ES 8.x 禁通配符 delete，`--recreate` 必须先 `_cat/indices/{pattern}`
       列具体名再逐个 delete

D5 警告（总控）：
    50 万 outbox 回填规模下 PG 行为可能改变；本命令本身不写 outbox，但若与
    `flush_outbox_task` 同时跑会触发 partial index 验证场景。

R4-04 / Wave 5 监控：
    每批 ES bulk 后 record_reindex_progress(...)；失败计数 record_reindex_failures(...)
"""
from __future__ import annotations

import logging
import time
from datetime import datetime, timezone as _tz
from typing import Any, Iterable, Iterator, Optional

from django.core.management.base import BaseCommand, CommandError
from django.db import connections
from apps.services.common.db_router import postgres_app_db_alias

logger = logging.getLogger(__name__)

# 6 索引按 PRD 10.1 顺序：小到大（避免大表先跑挂掉前面没数据）
DEFAULT_REINDEX_ORDER = [
    "tabtin-agents",
    "tabtin-spaces",
    "tabtin-resources",
    "tabtin-memos",
    "tabtin-im",
    "tabtin-messages",
]


class Command(BaseCommand):
    help = "全量回填 ES 索引：6 索引或单索引；支持 --resume / --recreate / --dry-run"

    def add_arguments(self, parser):
        parser.add_argument(
            "--index", type=str, default="all",
            help="目标索引：'all' / 'tabtin-messages' / 'tabtin-spaces' 等",
        )
        parser.add_argument("--batch-size", type=int, default=1000, help="单批文档数")
        parser.add_argument(
            "--resume", action="store_true",
            help="从 Redis 进度续跑（仅当上次未完成）",
        )
        parser.add_argument(
            "--recreate", action="store_true",
            help="先 delete 索引再重建 mapping 再回填（mapping 变更场景）",
        )
        parser.add_argument(
            "--dry-run", action="store_true",
            help="不写 ES，只读 DB 统计需回填条数",
        )
        parser.add_argument(
            "--no-perf-tweak", action="store_true",
            help="不做 refresh_interval=-1 / replica=0 加速（保守模式）",
        )

    def handle(self, *args, **options):
        from apps.fts.client import get_client, is_engine_enabled

        if not is_engine_enabled():
            raise CommandError(
                "SEARCH_ENGINE_ENABLED=false。fts_reindex 需要先 export "
                "SEARCH_ENGINE_ENABLED=true 才能跑。",
            )

        target = options["index"]
        batch_size = options["batch_size"]
        resume = options["resume"]
        recreate = options["recreate"]
        dry_run = options["dry_run"]
        no_perf_tweak = options["no_perf_tweak"]

        if target == "all":
            indices = list(DEFAULT_REINDEX_ORDER)
        elif target in DEFAULT_REINDEX_ORDER:
            indices = [target]
        else:
            raise CommandError(
                f"未知索引: {target}。允许：'all' 或 {DEFAULT_REINDEX_ORDER}",
            )

        client = get_client()

        # PRD 6.4 集成：每个索引开 reindex span 便于排查跨日跑批
        for full_index_name in indices:
            base = _strip_prefix(full_index_name)  # 'messages' 'resources' ...
            self.stdout.write(self.style.MIGRATE_HEADING(
                f"\n=== 回填索引 {full_index_name}（base={base}）==="
            ))

            if recreate and not dry_run:
                _delete_indices_safely(self, client, full_index_name, base)

            # 重建 mapping（依赖 ensure_indices 幂等）
            if not dry_run:
                from apps.fts.index_definitions import ensure_indices
                ensure_indices(client)

            # 性能 tweak（PRD 10.2）
            if not dry_run and not no_perf_tweak:
                _enter_bulk_mode(self, client, base)

            try:
                stats = _reindex_one(
                    self, client, base,
                    batch_size=batch_size,
                    resume=resume,
                    dry_run=dry_run,
                )
                self.stdout.write(self.style.SUCCESS(
                    f"  ✓ {full_index_name} 完成: scanned={stats['scanned']} "
                    f"indexed={stats['indexed']} failed={stats['failed']} "
                    f"elapsed={stats['elapsed']:.1f}s"
                ))
            finally:
                if not dry_run and not no_perf_tweak:
                    _exit_bulk_mode(self, client, base)

        self.stdout.write(self.style.SUCCESS("\n=== 全部索引回填完成 ==="))


def _strip_prefix(full_name: str) -> str:
    """`tabtin-messages` → `messages`"""
    return full_name.split("-", 1)[1] if "-" in full_name else full_name


def _delete_indices_safely(cmd: Command, client: Any, full_index_name: str, base: str) -> None:
    """ES 8.x 默认禁通配符 delete（R1-21）。先 `_cat/indices/{pattern}` 列具体名再逐个 delete。"""
    try:
        # rollover 索引（messages-*）需要列 month 索引
        from apps.fts.index_definitions import INDEX_DEFINITIONS
        is_rollover = INDEX_DEFINITIONS.get(base, {}).get("rollover", False)
        if is_rollover:
            pattern = f"{full_index_name}-*"
            cat = client.cat.indices(index=pattern, format="json")
            names = [r.get("index") for r in cat if r.get("index")]
        else:
            names = [full_index_name]
        for name in names:
            try:
                if client.indices.exists(index=name):
                    client.indices.delete(index=name)
                    cmd.stdout.write(f"    ✗ deleted {name}")
            except Exception as exc:
                cmd.stdout.write(cmd.style.WARNING(f"    ! delete {name} failed: {exc}"))
    except Exception as exc:
        cmd.stdout.write(cmd.style.WARNING(f"    ! recreate enumeration failed: {exc}"))


def _enter_bulk_mode(cmd: Command, client: Any, base: str) -> None:
    """临时关闭 refresh + replica 提速（PRD 10.2）。"""
    try:
        from apps.fts.index_definitions import INDEX_DEFINITIONS, get_index_name
        is_rollover = INDEX_DEFINITIONS.get(base, {}).get("rollover", False)
        # rollover 索引：当月物理索引名；其他：alias 名
        target = (
            f"{get_index_name(base)}-*" if is_rollover else get_index_name(base)
        )
        client.indices.put_settings(
            index=target,
            settings={"index": {"refresh_interval": "-1", "number_of_replicas": 0}},
        )
        cmd.stdout.write(f"    ⚙ {target}: refresh=-1 replicas=0")
    except Exception as exc:
        cmd.stdout.write(cmd.style.WARNING(f"    ! enter bulk mode failed: {exc}"))


def _exit_bulk_mode(cmd: Command, client: Any, base: str) -> None:
    """恢复 refresh + replica，触发 forcemerge。"""
    try:
        from apps.fts.index_definitions import INDEX_DEFINITIONS, get_index_name
        is_rollover = INDEX_DEFINITIONS.get(base, {}).get("rollover", False)
        target = (
            f"{get_index_name(base)}-*" if is_rollover else get_index_name(base)
        )
        client.indices.put_settings(
            index=target,
            settings={"index": {"refresh_interval": "1s", "number_of_replicas": 1}},
        )
        cmd.stdout.write(f"    ⚙ {target}: refresh=1s replicas=1")
        try:
            client.indices.forcemerge(index=target, max_num_segments=1)
            cmd.stdout.write(f"    ⚙ {target}: forcemerge done")
        except Exception as exc:  # pragma: no cover
            cmd.stdout.write(cmd.style.WARNING(f"    ! forcemerge failed: {exc}"))
    except Exception as exc:
        cmd.stdout.write(cmd.style.WARNING(f"    ! exit bulk mode failed: {exc}"))


def _reindex_one(
    cmd: Command,
    client: Any,
    base: str,
    *,
    batch_size: int,
    resume: bool,
    dry_run: bool,
) -> dict:
    """单个索引回填核心循环。

    数据源：
        - messages → MySQL ChatMessage
        - resources → PG ContextItem
        - agents → PG Agent
        - spaces → PG Space
        - memos → PG Memo
        - im → PG tabchat.Message
    """
    from apps.fts.metrics import record_reindex_failures, record_reindex_progress
    from apps.fts.services import sync_service
    from elasticsearch import helpers

    progress_key = f"fts:reindex:progress:{base}"
    progress = _load_progress(progress_key) if resume else {}
    last_pk = progress.get("last_pk") or progress.get("last_id")  # 兼容旧 progress 格式
    last_created_at = progress.get("last_created_at")
    scanned_already = int(progress.get("scanned") or 0)

    after_cursor = None
    if resume and last_pk:
        # tuple (iso_created_at, last_pk)
        after_cursor = (last_created_at, last_pk)

    cmd.stdout.write(
        f"  · resume={resume} last_created_at={last_created_at} "
        f"last_pk={last_pk} scanned_already={scanned_already}"
    )

    started = time.monotonic()
    scanned = scanned_already
    indexed = 0
    failed = 0

    iterator = _model_iterator(base, batch_size=batch_size, after_cursor=after_cursor)

    for batch in iterator:
        if not batch:
            continue
        # 转换为 ES bulk action
        actions = []
        for instance in batch:
            doc = _to_doc(base, instance, sync_service=sync_service)
            if doc is None:
                continue
            actions.append({
                "_op_type": "index",
                "_index": _resolve_index_name(base, instance),
                "_id": str(instance.pk),
                "_source": doc,
            })
        scanned += len(batch)

        if dry_run:
            cmd.stdout.write(f"    [dry-run] batch scanned={len(batch)} actions={len(actions)}")
            continue

        last_obj = batch[-1]
        if not actions:
            _save_progress(
                progress_key,
                last_pk=last_obj.pk,
                last_created_at=getattr(last_obj, "created_at", None),
                scanned=scanned,
            )
            continue

        try:
            success_count, errors = helpers.bulk(
                client, actions, raise_on_error=False, raise_on_exception=False, stats_only=False,
            )
            indexed += int(success_count)
            failed_now = (
                len(errors) if isinstance(errors, list)
                else 0
            )
            if failed_now:
                failed += failed_now
                # 取头一条错误打 stderr 便于排查
                first_err = errors[0] if errors else None
                cmd.stdout.write(cmd.style.WARNING(
                    f"    ⚠ batch failed_count={failed_now} first_err={first_err}"
                ))
                record_reindex_failures(index=base, count=failed_now)
        except Exception as exc:
            cmd.stdout.write(cmd.style.ERROR(
                f"    ✗ bulk raise (treating as batch failure): {exc}"
            ))
            failed += len(actions)
            record_reindex_failures(index=base, count=len(actions))

        # 进度持久化（B3 修复：用 created_at + pk 复合游标）
        _save_progress(
            progress_key,
            last_pk=last_obj.pk,
            last_created_at=getattr(last_obj, "created_at", None),
            scanned=scanned,
        )
        record_reindex_progress(index=base, count=indexed)

        if scanned % (batch_size * 10) == 0:
            cmd.stdout.write(
                f"    progress scanned={scanned} indexed={indexed} failed={failed}"
            )

    # 完成清进度
    if not dry_run:
        _clear_progress(progress_key)

    return {
        "scanned": scanned,
        "indexed": indexed,
        "failed": failed,
        "elapsed": time.monotonic() - started,
    }


def _model_iterator(
    base: str,
    *,
    batch_size: int,
    after_cursor: Optional[tuple[str, Any]] = None,
) -> Iterator[list]:
    """从对应 model 流式迭代。

    Wave 5 三视角 Review BLOCKER B3 修复：
        业务模型主键全是 UUIDField；UUID 字符串排序 ≠ 时间顺序。
        改用 `(created_at, pk)` 游标 + tie-break，PRD 4.3.E 原始设计也是
        `last_processed_created_at`。
        游标 tuple `(iso_created_at, last_pk)`：
            - 主排序 created_at
            - tie-break pk（同时间戳的多条按 pk 字典序稳定）

    after_cursor: tuple[iso_created_at_str, last_pk_str] or None
    """
    from django.db.models import Q
    from django.utils.dateparse import parse_datetime

    def apply_cursor(qs):
        if after_cursor is None:
            return qs
        iso_dt, last_pk = after_cursor
        cursor_dt = parse_datetime(iso_dt) if isinstance(iso_dt, str) else iso_dt
        if cursor_dt is None:
            # 兼容老进度（如果只有 pk，无 created_at），退化为 pk__gt 但日志警告
            logger.warning(
                "[FTS] resume cursor missing created_at, fallback to pk__gt=%s "
                "(may skip/duplicate rows)",
                last_pk,
            )
            return qs.filter(pk__gt=last_pk)
        # `(created_at > cursor_dt) OR (created_at = cursor_dt AND pk > last_pk)`
        return qs.filter(
            Q(created_at__gt=cursor_dt)
            | Q(created_at=cursor_dt, pk__gt=last_pk)
        )

    if base == "messages":
        from apps.chat.conversation.models import ChatMessage
        qs = ChatMessage.objects.using("default").select_related("session")
        qs = apply_cursor(qs).order_by("created_at", "pk")
        yield from _chunk(qs, batch_size)
    elif base == "resources":
        from apps.tabtinspace.models import ContextItem
        qs = ContextItem.objects.using(postgres_app_db_alias()).select_related("workspace", "project")
        qs = apply_cursor(qs).order_by("created_at", "pk")
        yield from _chunk(qs, batch_size)
    elif base == "agents":
        from apps.tabtinspace.models import Agent
        qs = Agent.objects.using(postgres_app_db_alias()).all()
        qs = apply_cursor(qs).order_by("created_at", "pk")
        yield from _chunk(qs, batch_size)
    elif base == "spaces":
        from apps.tabtinspace.models import Project, Workspace
        qs = Workspace.objects.using(postgres_app_db_alias()).all()
        qs = apply_cursor(qs).order_by("created_at", "pk")
        yield from _chunk(qs, batch_size)
        qs = Project.objects.using(postgres_app_db_alias()).all()
        qs = apply_cursor(qs).order_by("created_at", "pk")
        yield from _chunk(qs, batch_size)
    elif base == "memos":
        from apps.tabmemo.models import Memo
        qs = Memo.objects.using(postgres_app_db_alias()).all()
        qs = apply_cursor(qs).order_by("created_at", "pk")
        yield from _chunk(qs, batch_size)
    elif base == "im":
        from apps.tabchat.models import Message as ImMessage
        qs = ImMessage.objects.using(postgres_app_db_alias()).select_related("conversation")
        qs = apply_cursor(qs).order_by("created_at", "pk")
        yield from _chunk(qs, batch_size)
    else:
        raise CommandError(f"未知 base 索引名: {base}")


def _chunk(qs, size: int) -> Iterator[list]:
    """简易 chunk 迭代（避免一次性载入全部）。"""
    buf = []
    for obj in qs.iterator(chunk_size=size):
        buf.append(obj)
        if len(buf) >= size:
            yield buf
            buf = []
    if buf:
        yield buf


def _to_doc(base: str, instance: Any, *, sync_service) -> Optional[dict]:
    """调对应 to_*_document 返回 None 表示该条不该索引。"""
    if base == "messages":
        return sync_service.to_message_document(instance)
    if base == "resources":
        return sync_service.to_resource_document(instance)
    if base == "agents":
        return sync_service.to_agent_document(instance)
    if base == "spaces":
        return sync_service.to_space_document(instance)
    if base == "memos":
        return sync_service.to_memo_document(instance)
    if base == "im":
        return sync_service.to_im_document(instance)
    return None


def _resolve_index_name(base: str, instance: Any) -> str:
    """messages 走月度 rollover，其他索引走 alias 名。"""
    from apps.fts.index_definitions import get_index_name, get_monthly_index_name
    if base == "messages":
        created_at = getattr(instance, "created_at", None) or datetime.now(_tz.utc)
        return get_monthly_index_name("messages", created_at)
    return get_index_name(base)


# ── Redis 进度 ─────────────────────────────────────────────────
def _redis():
    try:
        from django_redis import get_redis_connection
        return get_redis_connection("default")
    except Exception:  # pragma: no cover
        return None


def _load_progress(key: str) -> dict:
    redis = _redis()
    if redis is None:
        return {}
    try:
        import json
        raw = redis.get(key)
        if not raw:
            return {}
        if isinstance(raw, (bytes, bytearray)):
            raw = raw.decode()
        return json.loads(raw)
    except Exception:  # pragma: no cover
        return {}


def _save_progress(
    key: str,
    *,
    last_pk: Any,
    last_created_at: Any = None,
    scanned: int,
) -> None:
    """Wave 5 三视角 Review B3 修复：游标改 (created_at, pk) tuple。

    向后兼容：last_id 字段保留（旧 progress 还能读但应该重跑）。
    """
    redis = _redis()
    if redis is None:
        return
    try:
        import json
        iso_dt = (
            last_created_at.isoformat()
            if last_created_at and hasattr(last_created_at, "isoformat")
            else None
        )
        payload = {
            "last_pk": str(last_pk),
            "last_created_at": iso_dt,
            "last_id": str(last_pk),  # 旧字段兼容，后续可删
            "scanned": int(scanned),
            "ts": datetime.now(_tz.utc).isoformat(),
        }
        redis.setex(key, 7 * 24 * 3600, json.dumps(payload))
    except Exception:  # pragma: no cover
        pass


def _clear_progress(key: str) -> None:
    redis = _redis()
    if redis is None:
        return
    try:
        redis.delete(key)
    except Exception:  # pragma: no cover
        pass
