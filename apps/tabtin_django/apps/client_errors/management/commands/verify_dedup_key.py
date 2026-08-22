"""Wave 2 + Wave 6 端到端验证：dedup_key 去重 + trim 回填 + user_id 回填 +
并发 race + frontend_dedup_count 累加 + fingerprint_algo_version 写入 行为。

跑法：
    python manage.py verify_dedup_key

验证以下行为（生产环境运维 / CI 都可用）：

1. **同 dedup_key 两次上报 → 1 条 event** —— 双路径冗余的核心去重契约
2. **同 dedup_key 第二次上报推进 group last_seen** —— 但**不**增加 event_count
3. **不同 dedup_key 同 fingerprint → 2 条 event** —— 不同次错误正常累计
4. **dedup_key=None / 空 / 全空白 → 不参与去重** —— 老客户端 / 非 fatal 兼容
5. **sendBeacon trim 版本先入库 + flushErrors 完整版本后到 → upgrade existing**
   —— admindash 始终拿到现场最完整快照（breadcrumbs + extra + stack）
6. **sendBeacon anonymous 先到（user_id="") + flushErrors authed 后到（user_id=X）
   → 回填 user_id + group/release user_count 增量** —— admindash"按用户筛 fatal"
   不再永久显示匿名（Wave 2 Round 2 P1-A）
7. **2 个线程并发同 dedup_key 上报 → 仍然只产生 1 条 event** —— DB partial unique
   兜住竞态（任一 path=fast 或 path=race 命中即可）
8. **extra.frontend_dedup_count=N 时 group.event_count += (1 + N)**（Wave 6）——
   admindash 真实反映 burst 严重性，而不是被 isDuplicate 黑洞吃掉的"看起来 1 次"
9. **frontend_dedup_count 超过上限被 clamp**（Wave 6）—— 防止单事件灌爆 event_count
10. **新 ingest 的 event / group 必带 fingerprint_algo_version=FINGERPRINT_ALGO_VERSION**
    （Wave 6）—— migration 兜底外的 ingest 路径写入也对齐版本号
11. **backfill_fingerprint_algo_version 幂等性 + 不覆盖高版本**（Wave 6）——
    制造 dirty (algo_v=0)、higher (algo_v=2/3) 数据，跑 backfill 验证：
    dirty → 1，higher 保持不变；二次跑 updated=0
12. **DedupSummary 路由到原 group + 跳 webhook**（Wave 6 Round 2 P1-1）——
    构造 DedupSummary 事件验证：(a) 找到原 group 时累加 event_count + 不创建独立
    ClientErrorEvent；(b) 找不到原 group 时 fallback 创建独立 group；(c) 两条
    路径都不发 send_error_webhook
13. **真并发 user_count race**（Wave 6 Round 2 P1-4）——10 个线程并发以同一
    user_id 调 _ingest_event 同 fingerprint，user_count 必须严格 +1 不多 +1

测试数据全部使用 ``app_version=__verify_dedup_key__`` 隔离，跑完自动清理。
"""

from __future__ import annotations

import concurrent.futures
import io
import logging
import uuid

from django.core.management import call_command
from django.core.management.base import BaseCommand, CommandError
from django.db import connections, transaction
from django.utils import timezone

from apps.client_errors.api import (
    ErrorEventSchema,
    _FRONTEND_DEDUP_COUNT_MAX,
    _ingest_event,
)
from apps.client_errors.models import (
    FINGERPRINT_ALGO_VERSION,
    ClientErrorEvent,
    ClientErrorGroup,
    Release,
)
from apps.services.common.db_router import postgres_app_db_alias


_TEST_VERSION = "__verify_dedup_key__"


def _make(**overrides) -> ErrorEventSchema:
    base = dict(
        error_type="VerifyDedupError",
        message="Wave2 dedup verification",
        stack_trace="at verify (verify.js:1:1)",
        level="fatal",
        source="renderer",
        file="verify.js",
        line=1,
        column=1,
        breadcrumbs=[],
        app_version=_TEST_VERSION,
        electron_version="32.0.0",
        os_name="macOS",
        os_version="15.0",
        arch="arm64",
        locale="zh-CN",
        extra={"session_id": "verify-sess"},
        occurred_at=None,
    )
    base.update(overrides)
    return ErrorEventSchema(**base)


def _cleanup() -> None:
    """删除测试期生产的所有 fixtures（按 sentinel app_version 过滤）。"""
    db = postgres_app_db_alias()
    events = ClientErrorEvent.objects.using(db).filter(app_version=_TEST_VERSION)
    group_ids = list(events.values_list("group_id", flat=True).distinct())
    events.delete()
    ClientErrorGroup.objects.using(db).filter(pk__in=[gid for gid in group_ids if gid]).delete()
    Release.objects.using(db).filter(app_version=_TEST_VERSION).delete()


class Command(BaseCommand):
    help = "Wave 2 端到端验证：dedup_key 去重 + trim 回填行为"

    def handle(self, *args, **options) -> None:
        # 测试开始前先清扫，防止前次跑残留干扰
        _cleanup()

        try:
            self._test_same_dedup_key_dedup()
            self._test_different_dedup_key_no_dedup()
            self._test_null_or_empty_dedup_key_no_dedup()
            self._test_trim_upgrade()
            self._test_user_id_backfill()
            self._test_concurrent_race()
            self._test_frontend_dedup_count_event_count_累加()
            self._test_frontend_dedup_count_clamp()
            self._test_fingerprint_algo_version_written()
            self._test_backfill_idempotent_and_no_overwrite()
            self._test_dedup_summary_routing()
            self._test_concurrent_user_count_race()
        finally:
            _cleanup()

        self.stdout.write(self.style.SUCCESS(
            "[verify_dedup_key] 全部 12 项端到端验证通过 ✓"
        ))

    # ── 1. 同 dedup_key 去重 ──
    def _test_same_dedup_key_dedup(self) -> None:
        dedup = str(uuid.uuid4())
        ev_a = _ingest_event(_make(dedup_key=dedup), user_id="")
        ev_b = _ingest_event(_make(dedup_key=dedup), user_id="42")

        if ev_a.id != ev_b.id:
            raise CommandError(
                f"[case 1] 同 dedup_key 两次上报应返回同一 event id，"
                f"实际 A={ev_a.id} B={ev_b.id}"
            )

        group = ClientErrorGroup.objects.using(postgres_app_db_alias()).get(pk=ev_a.group_id)
        if group.event_count != 1:
            raise CommandError(
                f"[case 1] 同 dedup_key 后 group.event_count 应为 1，实际 {group.event_count}"
            )

        rows = ClientErrorEvent.objects.using(postgres_app_db_alias()).filter(dedup_key=dedup).count()
        if rows != 1:
            raise CommandError(f"[case 1] DB 应只有 1 条 dedup_key={dedup}，实际 {rows}")

        self.stdout.write("  [case 1] 同 dedup_key 去重 ✓")

    # ── 2. 不同 dedup_key 不去重 ──
    def _test_different_dedup_key_no_dedup(self) -> None:
        ev_a = _ingest_event(_make(dedup_key=str(uuid.uuid4())), user_id="42")
        ev_b = _ingest_event(_make(dedup_key=str(uuid.uuid4())), user_id="42")

        if ev_a.id == ev_b.id:
            raise CommandError(
                "[case 2] 不同 dedup_key 应创建不同 event，但 id 相同"
            )

        # 因为 fingerprint 相同（base 数据一致），两次 event 应归同一 group
        if ev_a.group_id != ev_b.group_id:
            raise CommandError(
                f"[case 2] 同 fingerprint 应归同一 group，实际 {ev_a.group_id} vs {ev_b.group_id}"
            )

        self.stdout.write("  [case 2] 不同 dedup_key 各自入库 ✓")

    # ── 3. None / 空串 dedup_key 不参与 ──
    def _test_null_or_empty_dedup_key_no_dedup(self) -> None:
        # None
        ev_a = _ingest_event(_make(dedup_key=None), user_id="42")
        ev_b = _ingest_event(_make(dedup_key=None), user_id="42")
        if ev_a.id == ev_b.id:
            raise CommandError(
                "[case 3a] dedup_key=None 不应触发去重，但 event id 相同"
            )

        # 空串
        ev_c = _ingest_event(_make(dedup_key=""), user_id="42")
        ev_d = _ingest_event(_make(dedup_key="   "), user_id="42")
        if ev_c.id == ev_d.id:
            raise CommandError(
                "[case 3b] 空白 dedup_key 不应触发去重，但 event id 相同"
            )

        self.stdout.write("  [case 3] dedup_key=None/空白 不去重 ✓")

    # ── 4. Trim 回填 ──
    def _test_trim_upgrade(self) -> None:
        dedup = str(uuid.uuid4())

        # sendBeacon trimmed 版本先入库
        trimmed = _ingest_event(
            _make(
                dedup_key=dedup,
                breadcrumbs=[],
                extra={"session_id": "verify-sess", "_beacon_trim": "breadcrumb_data"},
                stack_trace="trimmed stack",
            ),
            user_id="",
        )

        before = ClientErrorEvent.objects.using(postgres_app_db_alias()).get(pk=trimmed.pk)
        if before.stack_trace != "trimmed stack":
            raise CommandError(
                f"[case 4] trimmed 版本入库 stack_trace 不对：{before.stack_trace!r}"
            )
        if before.breadcrumbs != []:
            raise CommandError(
                f"[case 4] trimmed 版本入库 breadcrumbs 应为空：{before.breadcrumbs!r}"
            )

        # flushErrors 完整版本后到 → 应回填
        full_extra = {
            "session_id": "verify-sess",
            "componentStack": "    at App (at app.tsx:1:1)",
            "user_action": "click_export",
        }
        full = _ingest_event(
            _make(
                dedup_key=dedup,
                breadcrumbs=[],  # ErrorEventSchema 接受 list[BreadcrumbSchema]
                extra=full_extra,
                stack_trace="full stack with frames\nat foo (app.js:1:1)",
            ),
            user_id="42",
        )

        if full.id != trimmed.id:
            raise CommandError(
                f"[case 4] dedup 应返回 existing event；实际 trimmed={trimmed.id} full={full.id}"
            )

        after = ClientErrorEvent.objects.using(postgres_app_db_alias()).get(pk=trimmed.pk)
        if after.stack_trace != "full stack with frames\nat foo (app.js:1:1)":
            raise CommandError(
                f"[case 4] upgrade 后 stack_trace 应被完整版替换，实际 {after.stack_trace!r}"
            )
        if not isinstance(after.extra, dict) or "user_action" not in after.extra:
            raise CommandError(
                f"[case 4] upgrade 后 extra 应保留完整版的 user_action，实际 {after.extra!r}"
            )
        if after.component_stack != "    at App (at app.tsx:1:1)":
            raise CommandError(
                f"[case 4] upgrade 后 component_stack 应从 extra.componentStack 提取，"
                f"实际 {after.component_stack!r}"
            )
        # P1-A: trim upgrade 路径同时也做了 user_id 回填——sendBeacon 用 user_id=""
        # 入库，flushErrors 用 user_id="42" 后到，应该把 user_id 一并回填
        if after.user_id != "42":
            raise CommandError(
                f"[case 4] upgrade 后 user_id 应被回填为 '42'，实际 {after.user_id!r}"
            )

        self.stdout.write("  [case 4] trim + user_id 回填 upgrade ✓")

    # ── 5. user_id 回填 + user_count 增量（P1-A，无 trim 场景） ──
    def _test_user_id_backfill(self) -> None:
        """sendBeacon anonymous 先到 → flushErrors authed 后到 → 回填 user_id +
        ClientErrorGroup.user_count / Release.user_count 增量。

        本 case 与 case 4 区别：case 4 是 trim+user 双路径上行，本 case 验证
        **纯 user_id 回填** 路径（不 trim），并且首次回填后再来一次同 user 不应
        重复 +1 user_count。
        """
        dedup = str(uuid.uuid4())

        # sendBeacon anonymous 先入库
        anon = _ingest_event(_make(dedup_key=dedup), user_id="")
        if anon.user_id != "":
            raise CommandError(
                f"[case 5] anonymous 上报 event.user_id 应为空，实际 {anon.user_id!r}"
            )

        group = ClientErrorGroup.objects.using(postgres_app_db_alias()).get(pk=anon.group_id)
        release = Release.objects.using(postgres_app_db_alias()).get(app_version=_TEST_VERSION)
        # group 和 release 的 user_count 在创建时被默认值初始化
        # （ClientErrorGroup.user_count 默认 1；Release 创建时无显式 user_count
        # 但 anonymous 不会让 release.user_count + 1 因为 user_id="" → 走默认 0）
        baseline_group_user_count = group.user_count
        baseline_release_user_count = release.user_count

        # flushErrors authed 后到（user_id="100"）
        ev = _ingest_event(_make(dedup_key=dedup), user_id="100")
        if ev.id != anon.id:
            raise CommandError(
                f"[case 5] dedup 应返回同一 event；anon={anon.id} authed={ev.id}"
            )

        after = ClientErrorEvent.objects.using(postgres_app_db_alias()).get(pk=anon.pk)
        if after.user_id != "100":
            raise CommandError(
                f"[case 5] 后到的 user_id='100' 应被回填，实际 {after.user_id!r}"
            )

        group.refresh_from_db(using=postgres_app_db_alias())
        release.refresh_from_db(using=postgres_app_db_alias())

        if group.user_count != baseline_group_user_count + 1:
            raise CommandError(
                f"[case 5] group.user_count 应 +1（{baseline_group_user_count}→"
                f"{baseline_group_user_count + 1}），实际 {group.user_count}"
            )
        if release.user_count != baseline_release_user_count + 1:
            raise CommandError(
                f"[case 5] release.user_count 应 +1（{baseline_release_user_count}→"
                f"{baseline_release_user_count + 1}），实际 {release.user_count}"
            )

        # 第二次 user_id="100" 同 dedup_key 上报——不应再触发回填（user_id 已非空），
        # 也不应重复 +1 user_count
        ev2 = _ingest_event(_make(dedup_key=dedup), user_id="100")
        group.refresh_from_db(using=postgres_app_db_alias())
        release.refresh_from_db(using=postgres_app_db_alias())
        if group.user_count != baseline_group_user_count + 1:
            raise CommandError(
                f"[case 5] 重复 user_id='100' 后 group.user_count 不应再 +1，"
                f"实际 {group.user_count}"
            )
        if release.user_count != baseline_release_user_count + 1:
            raise CommandError(
                f"[case 5] 重复 user_id='100' 后 release.user_count 不应再 +1，"
                f"实际 {release.user_count}"
            )

        self.stdout.write("  [case 5] user_id 回填 + user_count 增量幂等 ✓")

    # ── 6. 并发竞态：DB partial unique 兜底（P2-D） ──
    def _test_concurrent_race(self) -> None:
        """2 个线程并发同 dedup_key 上报 → 仍然只产生 1 条 event。

        合法路径：两个线程都看到 fast-path SELECT 不存在（race window）→ 都尝试
        create → 一方触发 ``IntegrityError`` 走 race-path 兜底。也可能其中一个线程
        的 SELECT 已经看到对方刚 commit 的 event → 走 fast-path。两种路径都满足
        "DB 最终只有 1 条 dedup_key=X 的 event"。

        本 case 用 ``logging`` 捕获 path=fast / path=race 命中日志，至少其中之一
        应当出现。
        """
        dedup = str(uuid.uuid4())

        log_buf = io.StringIO()
        handler = logging.StreamHandler(log_buf)
        handler.setLevel(logging.INFO)
        handler.setFormatter(logging.Formatter("%(message)s"))
        target_logger = logging.getLogger("apps.client_errors.api")
        target_logger.addHandler(handler)
        prev_level = target_logger.level
        target_logger.setLevel(logging.INFO)

        try:
            def submit(uid: str):
                # 关键：每个线程必须拿到独立的 DB connection——Django 默认
                # 线程级 connection（thread-local），ThreadPoolExecutor 直接调用
                # 是安全的；但 worker 退出时连接需关闭以归还连接池。
                try:
                    return _ingest_event(_make(dedup_key=dedup), user_id=uid)
                finally:
                    connections.close_all()

            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as ex:
                f1 = ex.submit(submit, "")
                f2 = ex.submit(submit, "200")
                ev1 = f1.result()
                ev2 = f2.result()
        finally:
            target_logger.removeHandler(handler)
            target_logger.setLevel(prev_level)

        if ev1.id != ev2.id:
            raise CommandError(
                f"[case 6] 并发上报应返回同一 event id；实际 {ev1.id} vs {ev2.id}"
            )

        rows = ClientErrorEvent.objects.using(postgres_app_db_alias()).filter(dedup_key=dedup).count()
        if rows != 1:
            raise CommandError(
                f"[case 6] DB 应只有 1 条 dedup_key={dedup}，实际 {rows}（并发未去重）"
            )

        log_text = log_buf.getvalue()
        seen_path = "path=fast" in log_text or "path=race" in log_text
        if not seen_path:
            raise CommandError(
                f"[case 6] 日志未见 path=fast 或 path=race 命中标记；实际日志:\n{log_text}"
            )

        self.stdout.write(
            f"  [case 6] 并发竞态去重 ✓ (path=race={'race' in log_text}, "
            f"path=fast={'fast' in log_text})"
        )

    # ── 7. Wave 6: frontend_dedup_count 累加 event_count ──
    def _test_frontend_dedup_count_event_count_累加(self) -> None:
        """前端 isDuplicate 累加 pendingDedupCount 后随事件上报：
        - 首事件 frontend_dedup_count=49 → 新 group 创建 event_count = 1 + 49 = 50
        - 第二事件 frontend_dedup_count=99 → existing group event_count += (1 + 99) = 100，
          总值 50 + 100 = 150
        - Release.event_count 同步累加
        """
        # 用一个跟其他 case 不同的 fingerprint，独立 group
        ev1 = _ingest_event(
            _make(
                error_type="WaveSixDedupAccumError",
                stack_trace="at burst (burst.js:1:1)",
                extra={"frontend_dedup_count": 49, "session_id": "verify-w6"},
            ),
            user_id="42",
        )
        group = ClientErrorGroup.objects.using(postgres_app_db_alias()).get(pk=ev1.group_id)
        if group.event_count != 50:
            raise CommandError(
                f"[case 7a] 新 group 首事件 frontend_dedup_count=49 → "
                f"event_count 应为 50（1+49），实际 {group.event_count}"
            )

        # 第二条同 fingerprint 事件
        ev2 = _ingest_event(
            _make(
                error_type="WaveSixDedupAccumError",
                stack_trace="at burst (burst.js:1:1)",
                extra={"frontend_dedup_count": 99, "session_id": "verify-w6"},
            ),
            user_id="42",
        )
        if ev2.id == ev1.id:
            raise CommandError(
                "[case 7b] 不同 dedup_key（默认 random UUID）应创建新 event"
            )
        group.refresh_from_db(using=postgres_app_db_alias())
        if group.event_count != 150:
            raise CommandError(
                f"[case 7b] 第二事件 frontend_dedup_count=99 → group.event_count "
                f"应累加到 150（50 + 100），实际 {group.event_count}"
            )

        # Release.event_count 同步累加
        release = Release.objects.using(postgres_app_db_alias()).get(app_version=_TEST_VERSION)
        if release.event_count < 150:
            raise CommandError(
                f"[case 7c] Release.event_count 应 >= 150（含本 case 累加），"
                f"实际 {release.event_count}"
            )

        # 第三条 frontend_dedup_count=0 应当退化为普通 +1
        baseline = group.event_count
        _ingest_event(
            _make(
                error_type="WaveSixDedupAccumError",
                stack_trace="at burst (burst.js:1:1)",
                extra={"session_id": "verify-w6"},  # 无 frontend_dedup_count
            ),
            user_id="42",
        )
        group.refresh_from_db(using=postgres_app_db_alias())
        if group.event_count != baseline + 1:
            raise CommandError(
                f"[case 7d] 无 frontend_dedup_count 应退化为 +1，实际 "
                f"{group.event_count - baseline}"
            )

        self.stdout.write("  [case 7] frontend_dedup_count event_count 累加 ✓")

    # ── 8. Wave 6: frontend_dedup_count clamp 防灌爆 ──
    def _test_frontend_dedup_count_clamp(self) -> None:
        """超过 _FRONTEND_DEDUP_COUNT_MAX 时被 clamp，不会让单事件灌爆 event_count。

        非 int / 负数 / bool 时静默忽略（视作未携带）。
        """
        # 100 万次 → 应 clamp 到 _FRONTEND_DEDUP_COUNT_MAX
        ev = _ingest_event(
            _make(
                error_type="WaveSixDedupClampError",
                stack_trace="at runaway (runaway.js:1:1)",
                extra={"frontend_dedup_count": 1_000_000},
            ),
            user_id="42",
        )
        group = ClientErrorGroup.objects.using(postgres_app_db_alias()).get(pk=ev.group_id)
        expected = 1 + _FRONTEND_DEDUP_COUNT_MAX
        if group.event_count != expected:
            raise CommandError(
                f"[case 8a] frontend_dedup_count=1_000_000 应 clamp 到 "
                f"{_FRONTEND_DEDUP_COUNT_MAX}，event_count 应为 {expected}，"
                f"实际 {group.event_count}"
            )

        # 负数 / 字符串 / bool 应静默 0（普通 +1）
        baseline = group.event_count
        for invalid in (-5, "haha", True, False, 0, None):
            _ingest_event(
                _make(
                    error_type="WaveSixDedupClampError",
                    stack_trace="at runaway (runaway.js:1:1)",
                    extra={"frontend_dedup_count": invalid} if invalid is not None else {},
                ),
                user_id="42",
            )
        group.refresh_from_db(using=postgres_app_db_alias())
        # 6 次普通 +1（包括 None case）→ baseline + 6
        if group.event_count != baseline + 6:
            raise CommandError(
                f"[case 8b] 非法 frontend_dedup_count 应退化为 +1，6 次后应 "
                f"+6，实际 +{group.event_count - baseline}"
            )

        self.stdout.write("  [case 8] frontend_dedup_count clamp / 非法忽略 ✓")

    # ── 9. Wave 6: fingerprint_algo_version 写入 ──
    def _test_fingerprint_algo_version_written(self) -> None:
        """ingest 路径 / get_or_create 路径都要写当前 FINGERPRINT_ALGO_VERSION。

        覆盖：
        - 新 ClientErrorEvent.fingerprint_algo_version = FINGERPRINT_ALGO_VERSION
        - 新 ClientErrorGroup.fingerprint_algo_version = FINGERPRINT_ALGO_VERSION
        - 同 fingerprint 二次事件入库时 algo_version 仍然写入（不依赖默认值）
        """
        ev1 = _ingest_event(
            _make(
                error_type="WaveSixAlgoVerError",
                stack_trace="at algo (algo.js:1:1)",
            ),
            user_id="42",
        )
        if ev1.fingerprint_algo_version != FINGERPRINT_ALGO_VERSION:
            raise CommandError(
                f"[case 9a] 新 event.fingerprint_algo_version 应为 "
                f"{FINGERPRINT_ALGO_VERSION}，实际 {ev1.fingerprint_algo_version}"
            )

        group = ClientErrorGroup.objects.using(postgres_app_db_alias()).get(pk=ev1.group_id)
        if group.fingerprint_algo_version != FINGERPRINT_ALGO_VERSION:
            raise CommandError(
                f"[case 9b] 新 group.fingerprint_algo_version 应为 "
                f"{FINGERPRINT_ALGO_VERSION}，实际 {group.fingerprint_algo_version}"
            )

        # 同 fingerprint 二次事件
        ev2 = _ingest_event(
            _make(
                error_type="WaveSixAlgoVerError",
                stack_trace="at algo (algo.js:1:1)",
            ),
            user_id="42",
        )
        if ev2.id == ev1.id:
            raise CommandError("[case 9c] 不同 dedup_key 应创建新 event")
        if ev2.fingerprint_algo_version != FINGERPRINT_ALGO_VERSION:
            raise CommandError(
                f"[case 9c] 二次事件 algo_version 应为 {FINGERPRINT_ALGO_VERSION}，"
                f"实际 {ev2.fingerprint_algo_version}"
            )

        self.stdout.write(
            f"  [case 9] fingerprint_algo_version=v{FINGERPRINT_ALGO_VERSION} 写入 ✓"
        )

    # ── 10. Wave 6: backfill 命令幂等性 + 不覆盖高版本 ──
    def _test_backfill_idempotent_and_no_overwrite(self) -> None:
        """``backfill_fingerprint_algo_version`` management command 的端到端契约。

        覆盖：
        - 制造 dirty (algo_v=0) 数据 → 跑 backfill → events/groups updated >= 1
        - 制造 higher (algo_v=2/3) 数据 → 跑 backfill → 不应被改回 v1
        - 第二次跑 backfill → updated 0（幂等）
        """
        # 准备 1 个 group + 2 events 标 algo_v=0（脏），2 events 标 algo_v=2（高版本不应被覆盖）
        dirty_group = ClientErrorGroup.objects.using(postgres_app_db_alias()).create(
            fingerprint=f"verify_backfill_dirty_{uuid.uuid4().hex[:16]}",
            title="verify_backfill dirty",
            level="error",
            status="open",
            first_seen=timezone.now(),
            last_seen=timezone.now(),
            event_count=0,
            user_count=0,
            sample_stack_trace="",
            sample_app_version=_TEST_VERSION,
            fingerprint_algo_version=0,  # dirty
        )
        v2_group = ClientErrorGroup.objects.using(postgres_app_db_alias()).create(
            fingerprint=f"verify_backfill_v2_{uuid.uuid4().hex[:16]}",
            title="verify_backfill v2",
            level="error",
            status="open",
            first_seen=timezone.now(),
            last_seen=timezone.now(),
            event_count=0,
            user_count=0,
            sample_stack_trace="",
            sample_app_version=_TEST_VERSION,
            fingerprint_algo_version=2,
        )

        def _make_ev(group, algo_v):
            return ClientErrorEvent.objects.using(postgres_app_db_alias()).create(
                group=group,
                error_type="VerifyBackfillEv",
                message="backfill case",
                stack_trace="",
                component_stack="",
                level="error",
                source="renderer",
                user_id="42",
                app_version=_TEST_VERSION,
                fingerprint=group.fingerprint,
                fingerprint_algo_version=algo_v,
                occurred_at=timezone.now(),
            )

        dirty_e1 = _make_ev(dirty_group, 0)
        dirty_e2 = _make_ev(dirty_group, 0)
        v2_e1 = _make_ev(v2_group, 2)
        v2_e2 = _make_ev(v2_group, 2)

        # 跑 backfill（第一次）
        out = io.StringIO()
        call_command("backfill_fingerprint_algo_version", stdout=out)
        text1 = out.getvalue()
        # dirty 应被修：events updated >= 2 & groups updated >= 1
        # （注意：可能有其他 fixture 残留也被一起标，所以用 >= 而不是 ==）
        if "events updated=0" in text1:
            raise CommandError(
                f"[case 10a] 脏数据存在时第一次 backfill 应 events updated > 0，"
                f"实际:\n{text1}"
            )
        if "groups updated=0" in text1:
            raise CommandError(
                f"[case 10a] 脏数据存在时第一次 backfill 应 groups updated > 0，"
                f"实际:\n{text1}"
            )

        # 验证 dirty 真的被修成 1
        dirty_group.refresh_from_db(using=postgres_app_db_alias())
        dirty_e1.refresh_from_db(using=postgres_app_db_alias())
        dirty_e2.refresh_from_db(using=postgres_app_db_alias())
        if dirty_group.fingerprint_algo_version != 1:
            raise CommandError(
                f"[case 10b] backfill 后 dirty group.algo_version 应为 1，"
                f"实际 {dirty_group.fingerprint_algo_version}"
            )
        if dirty_e1.fingerprint_algo_version != 1 or dirty_e2.fingerprint_algo_version != 1:
            raise CommandError(
                f"[case 10b] backfill 后 dirty events 应都是 1，"
                f"实际 e1={dirty_e1.fingerprint_algo_version}, "
                f"e2={dirty_e2.fingerprint_algo_version}"
            )

        # v2 不应被覆盖
        v2_group.refresh_from_db(using=postgres_app_db_alias())
        v2_e1.refresh_from_db(using=postgres_app_db_alias())
        v2_e2.refresh_from_db(using=postgres_app_db_alias())
        if v2_group.fingerprint_algo_version != 2:
            raise CommandError(
                f"[case 10c] backfill 不应覆盖 v2 group，"
                f"实际 {v2_group.fingerprint_algo_version}"
            )
        if v2_e1.fingerprint_algo_version != 2 or v2_e2.fingerprint_algo_version != 2:
            raise CommandError(
                f"[case 10c] backfill 不应覆盖 v2 events，实际 "
                f"e1={v2_e1.fingerprint_algo_version}, e2={v2_e2.fingerprint_algo_version}"
            )

        # 第二次跑：updated=0 幂等
        out2 = io.StringIO()
        call_command("backfill_fingerprint_algo_version", stdout=out2)
        text2 = out2.getvalue()
        if "events updated=0" not in text2 or "groups updated=0" not in text2:
            raise CommandError(
                f"[case 10d] 第二次 backfill 应幂等 updated=0，实际:\n{text2}"
            )

        self.stdout.write("  [case 10] backfill 幂等 + 不覆盖高版本 ✓")

    # ── 11. Wave 6 Round 2 P1-1: DedupSummary 路由到原 group + 跳 webhook ──
    def _test_dedup_summary_routing(self) -> None:
        """DedupSummary 路径覆盖：
        - 11a: 原 group 存在 → 路由到原 group + event_count 累加 + 不创建独立 ClientErrorEvent
        - 11b: 原 group 不存在 → fallback 创建独立 group
        - 11c: 两条路径都不发 send_error_webhook（patch send_error_webhook.delay 验证）
        """
        from unittest.mock import patch

        # 11a: 创建原 group 并入库一个普通事件
        original_event = _ingest_event(
            _make(
                error_type="WaveSixDedupSummaryRoutingError",
                stack_trace="at original (orig.js:1:1)",
            ),
            user_id="42",
        )
        original_group = ClientErrorGroup.objects.using(postgres_app_db_alias()).get(pk=original_event.group_id)
        original_fp = original_group.fingerprint
        baseline_event_count = original_group.event_count
        baseline_event_rows = ClientErrorEvent.objects.using(postgres_app_db_alias()).filter(
            group=original_group,
        ).count()

        # 构造 DedupSummary 事件 — 后端按 extra.original_fingerprint 反查到原 group
        summary_data = _make(
            error_type="DedupSummary",
            message=f"pending fatal burst summary fp={original_fp}",
            stack_trace="",
            extra={
                "session_id": "verify-w6r2",
                "frontend_dedup_count": 47,
                "original_fingerprint": original_fp,
                "summary": "flushed_pending_dedup_burst",
            },
        )

        with patch(
            "apps.client_errors.api.send_error_webhook.delay",
        ) as mock_webhook:
            routed = _ingest_event(summary_data, user_id="42")
            if mock_webhook.called:
                raise CommandError(
                    f"[case 11a] DedupSummary routed-to-original 路径不应触发 send_error_webhook，"
                    f"实际调用了 {mock_webhook.call_count} 次"
                )

        # routed 是 placeholder（不是真正入库的 event）
        if routed.pk is not None:
            # placeholder 应没有 pk（未入库）
            raise CommandError(
                f"[case 11a] DedupSummary routed-to-original 应返回未入库 placeholder，"
                f"实际 pk={routed.pk}"
            )

        # 验证原 group event_count 累加 47 + 不创建独立 ClientErrorEvent
        original_group.refresh_from_db(using=postgres_app_db_alias())
        if original_group.event_count != baseline_event_count + 47:
            raise CommandError(
                f"[case 11a] 原 group event_count 应累加 47（{baseline_event_count}→"
                f"{baseline_event_count + 47}），实际 {original_group.event_count}"
            )
        new_event_rows = ClientErrorEvent.objects.using(postgres_app_db_alias()).filter(
            group=original_group,
        ).count()
        if new_event_rows != baseline_event_rows:
            raise CommandError(
                f"[case 11a] DedupSummary routed-to-original 不应创建独立 ClientErrorEvent，"
                f"实际新增 {new_event_rows - baseline_event_rows} 条"
            )

        # 11b: 原 group 不存在 → fallback 创建独立 group
        ghost_fp = f"ghost-fp-{uuid.uuid4().hex[:16]}"
        with patch(
            "apps.client_errors.api.send_error_webhook.delay",
        ) as mock_webhook:
            fallback = _ingest_event(
                _make(
                    error_type="DedupSummary",
                    message=f"pending fatal burst summary fp={ghost_fp}",
                    stack_trace="",
                    extra={
                        "session_id": "verify-w6r2",
                        "frontend_dedup_count": 23,
                        "original_fingerprint": ghost_fp,
                        "summary": "flushed_pending_dedup_burst",
                    },
                ),
                user_id="42",
            )
            # P1-1：fallback 路径同样不发 webhook（is_dedup_summary 标志贯穿到末尾）
            if mock_webhook.called:
                raise CommandError(
                    f"[case 11b] DedupSummary fallback 路径不应触发 send_error_webhook，"
                    f"实际调用了 {mock_webhook.call_count} 次"
                )

        # fallback 创建了独立 group，event_count = 1 + 23 = 24
        if fallback.pk is None or fallback.group_id is None:
            raise CommandError(
                f"[case 11b] DedupSummary fallback 应入库真实 event，"
                f"实际 pk={fallback.pk} group_id={fallback.group_id}"
            )
        fallback_group = ClientErrorGroup.objects.using(postgres_app_db_alias()).get(pk=fallback.group_id)
        if fallback_group.event_count != 24:
            raise CommandError(
                f"[case 11b] fallback group event_count 应为 24（1+23），"
                f"实际 {fallback_group.event_count}"
            )

        self.stdout.write("  [case 11] DedupSummary 路由 + 跳 webhook ✓")

    # ── 12. Wave 6 Round 2 P1-4: user_count 真并发 race ──
    def _test_concurrent_user_count_race(self) -> None:
        """10 个线程并发以同一 user_id 上报同 fingerprint → user_count 严格 +1
        （之前 exists() → +1 模式可能多 +1，partial unique INSERT ON CONFLICT
        DO NOTHING 兜底后必须严格只 +1 一次）。
        """
        # 先创建一个 group 让 baseline 已有 user_count=1（创建路径已 claim 首位用户）
        seed_event = _ingest_event(
            _make(
                error_type="WaveSixUserRaceError",
                stack_trace="at user_race (race.js:1:1)",
            ),
            user_id="seed_user",
        )
        seed_group = ClientErrorGroup.objects.using(postgres_app_db_alias()).get(pk=seed_event.group_id)
        if seed_group.user_count != 1:
            raise CommandError(
                f"[case 12 setup] 首次创建 group user_count 应为 1，实际 {seed_group.user_count}"
            )

        baseline = seed_group.user_count

        # 10 个线程并发上报"同一新用户" race_user → 期望最终 user_count = baseline + 1
        # （而不是 + N）
        race_user = "race_user_X"

        def submit():
            try:
                return _ingest_event(
                    _make(
                        error_type="WaveSixUserRaceError",
                        stack_trace="at user_race (race.js:1:1)",
                    ),
                    user_id=race_user,
                )
            finally:
                connections.close_all()

        with concurrent.futures.ThreadPoolExecutor(max_workers=10) as ex:
            futs = [ex.submit(submit) for _ in range(10)]
            for f in futs:
                f.result()

        seed_group.refresh_from_db(using=postgres_app_db_alias())
        if seed_group.user_count != baseline + 1:
            raise CommandError(
                f"[case 12] 10 个线程并发同 user_id 应只让 user_count +1（"
                f"{baseline}→{baseline + 1}），实际 {seed_group.user_count} "
                f"（差 +{seed_group.user_count - baseline - 1}，TOCTOU race 兜底失效）"
            )

        # Release.user_count 也必须严格 +1
        release = Release.objects.using(postgres_app_db_alias()).get(app_version=_TEST_VERSION)
        if release.user_count == 0:
            raise CommandError(
                "[case 12] Release.user_count 至少 +1，实际 0（兜底未生效）"
            )

        # 第二次同 race_user 不应再 +1（幂等）
        before = seed_group.user_count
        _ingest_event(
            _make(
                error_type="WaveSixUserRaceError",
                stack_trace="at user_race (race.js:1:1)",
            ),
            user_id=race_user,
        )
        seed_group.refresh_from_db(using=postgres_app_db_alias())
        if seed_group.user_count != before:
            raise CommandError(
                f"[case 12] 已知 user_id 再次上报 user_count 不应再 +1，"
                f"实际 {seed_group.user_count}"
            )

        self.stdout.write("  [case 12] 真并发 user_count race 兜底 ✓")
