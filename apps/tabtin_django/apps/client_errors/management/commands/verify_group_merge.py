"""Wave 2 Round 2 P1-C + Wave 6 端到端验证：``POST /client-errors/groups/merge`` 接口。

跑法：
    python manage.py verify_group_merge

验证 fingerprint 算法升级后归并 group 的运维场景：

1. **基础合并**：2 个 source group + N events → merge → 1 个 target，event 全部
   迁移、event_count 累加、first_seen=min、last_seen=max
2. **跨 group user_count 去重**：3 个 group 的 user 集合有重叠时 user_count 必须
   按 set diff 计算，不能简单累加
3. **rejection 校验**：target_group_id 不存在 / source 含 target / source 全部
   缺失 / 超过 50 个时拒绝
4. **DB 一致性**：merge 后 source group 物理删除，events 全部指向 target
5. **Wave 6 跨 algo_version 合并 warning**：source / target fingerprint_algo_version
   不一致时响应里有 ``algo_version_warning`` 信号，但**不**阻塞合并；同 algo_version
   合并时**没有** warning（避免噪声）

测试数据用 ``app_version=__verify_group_merge__`` 隔离，跑完自动清理。
"""

from __future__ import annotations

import uuid
from datetime import timedelta

from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone

from apps.client_errors.admin_api import GroupMergeSchema, merge_error_groups
from apps.client_errors.models import ClientErrorEvent, ClientErrorGroup, Release
from apps.services.common.db_router import postgres_app_db_alias


_TEST_VERSION = "__verify_group_merge__"


def _cleanup() -> None:
    db = postgres_app_db_alias()
    events = ClientErrorEvent.objects.using(db).filter(app_version=_TEST_VERSION)
    group_ids = list(events.values_list("group_id", flat=True).distinct())
    events.delete()
    ClientErrorGroup.objects.using(db).filter(
        pk__in=[gid for gid in group_ids if gid]
    ).delete()
    # 兜底删测试 group（如果 events 已被清空但 group 还在）
    ClientErrorGroup.objects.using(db).filter(
        sample_app_version=_TEST_VERSION
    ).delete()
    Release.objects.using(db).filter(app_version=_TEST_VERSION).delete()


def _make_group(*, fingerprint: str, title: str, first_seen, last_seen,
                event_count: int = 0, user_count: int = 0,
                fingerprint_algo_version: int = 1) -> ClientErrorGroup:
    return ClientErrorGroup.objects.using(postgres_app_db_alias()).create(
        fingerprint=fingerprint,
        title=title,
        level="error",
        status="open",
        first_seen=first_seen,
        last_seen=last_seen,
        event_count=event_count,
        user_count=user_count,
        sample_stack_trace="",
        sample_app_version=_TEST_VERSION,
        fingerprint_algo_version=fingerprint_algo_version,
    )


def _make_event(group: ClientErrorGroup, *, user_id: str, message: str = "merge test") -> ClientErrorEvent:
    return ClientErrorEvent.objects.using(postgres_app_db_alias()).create(
        group=group,
        error_type="MergeTestError",
        message=message,
        stack_trace="",
        component_stack="",
        level="error",
        source="renderer",
        user_id=user_id,
        app_version=_TEST_VERSION,
        fingerprint=group.fingerprint,
        occurred_at=timezone.now(),
    )


def _fake_request():
    """merge_error_groups 是 ninja view，签名 ``(request, payload)``——本测试直接
    调函数不走 HTTP，request 不影响 StaffAuth 鉴权（ninja 装饰器在路由层校验，
    本函数体内不读 request）。传一个 None 也可以，但保留 dict 让未来如果加了
    request 引用也容易调试。"""
    return None


class Command(BaseCommand):
    help = "Wave 2 Round 2 P1-C 端到端验证：merge_error_groups 接口"

    def handle(self, *args, **options) -> None:
        _cleanup()

        try:
            self._test_basic_merge()
            self._test_user_count_dedup_across_groups()
            self._test_rejections()
            self._test_db_consistency()
            self._test_cross_algo_version_warning()
        finally:
            _cleanup()

        self.stdout.write(self.style.SUCCESS(
            "[verify_group_merge] 全部 5 项端到端验证通过 ✓"
        ))

    # ── 1. 基础合并 ──
    def _test_basic_merge(self) -> None:
        now = timezone.now()
        target = _make_group(
            fingerprint=f"target-{uuid.uuid4().hex[:16]}",
            title="Target group",
            first_seen=now - timedelta(days=2),
            last_seen=now - timedelta(hours=1),
        )
        source_a = _make_group(
            fingerprint=f"sourceA-{uuid.uuid4().hex[:16]}",
            title="Source A",
            first_seen=now - timedelta(days=10),  # 比 target 早 → first_seen 应取此
            last_seen=now - timedelta(hours=5),
        )
        source_b = _make_group(
            fingerprint=f"sourceB-{uuid.uuid4().hex[:16]}",
            title="Source B",
            first_seen=now - timedelta(days=1),
            last_seen=now,  # 比 target 晚 → last_seen 应取此
        )

        # target 已有 2 events / 2 users
        _make_event(target, user_id="alice")
        _make_event(target, user_id="bob")
        # source_a 3 events，user 都跟 target 重叠
        _make_event(source_a, user_id="alice")
        _make_event(source_a, user_id="bob")
        _make_event(source_a, user_id="alice")
        # source_b 2 events，1 个新用户
        _make_event(source_b, user_id="charlie")
        _make_event(source_b, user_id="alice")

        # 先把 target 的 event_count / user_count 设到正确状态（创建时是 0/0）
        ClientErrorGroup.objects.using(postgres_app_db_alias()).filter(pk=target.pk).update(
            event_count=2, user_count=2,
        )

        result = merge_error_groups(
            _fake_request(),
            GroupMergeSchema(target_group_id=target.pk,
                             source_group_ids=[source_a.pk, source_b.pk]),
        )

        if not result.get("success"):
            raise CommandError(f"[case 1] 期望 success=True，实际 {result}")
        if result["moved_event_count"] != 5:
            raise CommandError(
                f"[case 1] moved_event_count 应为 5（A:3 + B:2），实际 {result['moved_event_count']}"
            )
        if result["new_users_added"] != 1:
            raise CommandError(
                f"[case 1] new_users_added 应为 1（charlie；alice/bob 已在 target），"
                f"实际 {result['new_users_added']}"
            )

        target.refresh_from_db(using=postgres_app_db_alias())
        if target.event_count != 7:  # 2 + 5
            raise CommandError(
                f"[case 1] target.event_count 应为 7，实际 {target.event_count}"
            )
        if target.user_count != 3:  # alice/bob/charlie
            raise CommandError(
                f"[case 1] target.user_count 应为 3（alice/bob/charlie），"
                f"实际 {target.user_count}"
            )
        if target.first_seen != source_a.first_seen:
            raise CommandError(
                f"[case 1] first_seen 应取最早的 source_a；实际 {target.first_seen}"
            )
        if target.last_seen != source_b.last_seen:
            raise CommandError(
                f"[case 1] last_seen 应取最晚的 source_b；实际 {target.last_seen}"
            )

        # source 已硬删
        remaining = ClientErrorGroup.objects.using(postgres_app_db_alias()).filter(
            pk__in=[source_a.pk, source_b.pk]
        ).count()
        if remaining != 0:
            raise CommandError(
                f"[case 1] source group 应被硬删，DB 仍剩 {remaining} 条"
            )

        # source 的 events 已迁移到 target 且 fingerprint 已对齐
        moved_events = ClientErrorEvent.objects.using(postgres_app_db_alias()).filter(group=target).count()
        if moved_events != 7:
            raise CommandError(
                f"[case 1] target 关联 events 数应为 7，实际 {moved_events}"
            )
        wrong_fp = ClientErrorEvent.objects.using(postgres_app_db_alias()).filter(
            group=target,
        ).exclude(fingerprint=target.fingerprint).count()
        if wrong_fp != 0:
            raise CommandError(
                f"[case 1] 迁移后所有 events.fingerprint 应等于 target.fingerprint，"
                f"实际 {wrong_fp} 条不匹配"
            )

        self.stdout.write("  [case 1] 基础合并 ✓")

    # ── 2. 跨 group user_count 去重 ──
    def _test_user_count_dedup_across_groups(self) -> None:
        """3 个 source group 的用户全部跟 target 重叠 → user_count 应保持不变。"""
        now = timezone.now()
        target = _make_group(
            fingerprint=f"target-dedup-{uuid.uuid4().hex[:16]}",
            title="Target dedup",
            first_seen=now,
            last_seen=now,
        )
        s1 = _make_group(
            fingerprint=f"s1-dedup-{uuid.uuid4().hex[:16]}",
            title="S1",
            first_seen=now,
            last_seen=now,
        )
        s2 = _make_group(
            fingerprint=f"s2-dedup-{uuid.uuid4().hex[:16]}",
            title="S2",
            first_seen=now,
            last_seen=now,
        )
        _make_event(target, user_id="x")
        _make_event(target, user_id="y")
        _make_event(s1, user_id="x")  # 跟 target 重叠
        _make_event(s2, user_id="y")  # 跟 target 重叠

        ClientErrorGroup.objects.using(postgres_app_db_alias()).filter(pk=target.pk).update(
            event_count=2, user_count=2,
        )

        result = merge_error_groups(
            _fake_request(),
            GroupMergeSchema(target_group_id=target.pk, source_group_ids=[s1.pk, s2.pk]),
        )
        if result["new_users_added"] != 0:
            raise CommandError(
                f"[case 2] new_users_added 应为 0（全部重叠），实际 {result['new_users_added']}"
            )

        target.refresh_from_db(using=postgres_app_db_alias())
        if target.user_count != 2:
            raise CommandError(
                f"[case 2] 重叠 user merge 后 user_count 应保持 2，实际 {target.user_count}"
            )

        self.stdout.write("  [case 2] user_count 跨 group 去重 ✓")

    # ── 3. 输入校验 ──
    def _test_rejections(self) -> None:
        from ninja.errors import HttpError

        now = timezone.now()
        target = _make_group(
            fingerprint=f"target-rej-{uuid.uuid4().hex[:16]}",
            title="Target reject",
            first_seen=now,
            last_seen=now,
        )

        # 3a. target 不存在
        try:
            merge_error_groups(
                _fake_request(),
                GroupMergeSchema(target_group_id=999_999_999, source_group_ids=[target.pk]),
            )
        except HttpError as e:
            if e.status_code != 404:
                raise CommandError(f"[case 3a] target 不存在应 404，实际 {e.status_code}")
        else:
            raise CommandError("[case 3a] target 不存在应抛 HttpError(404)")

        # 3b. source 全部 == target → 过滤后空 → 400
        try:
            merge_error_groups(
                _fake_request(),
                GroupMergeSchema(target_group_id=target.pk, source_group_ids=[target.pk]),
            )
        except HttpError as e:
            if e.status_code != 400:
                raise CommandError(f"[case 3b] source==target 应 400，实际 {e.status_code}")
        else:
            raise CommandError("[case 3b] source==target 应抛 HttpError(400)")

        # 3c. source 不存在
        try:
            merge_error_groups(
                _fake_request(),
                GroupMergeSchema(target_group_id=target.pk, source_group_ids=[888_888_888]),
            )
        except HttpError as e:
            if e.status_code != 404:
                raise CommandError(f"[case 3c] source 不存在应 404，实际 {e.status_code}")
        else:
            raise CommandError("[case 3c] source 不存在应抛 HttpError(404)")

        # 3d. source 数量超过 50 → 400
        try:
            merge_error_groups(
                _fake_request(),
                GroupMergeSchema(
                    target_group_id=target.pk,
                    source_group_ids=list(range(1, 52)),  # 51 个
                ),
            )
        except HttpError as e:
            if e.status_code != 400:
                raise CommandError(f"[case 3d] source > 50 应 400，实际 {e.status_code}")
        else:
            raise CommandError("[case 3d] source > 50 应抛 HttpError(400)")

        self.stdout.write("  [case 3] 输入校验 ✓")

    # ── 4. DB 一致性 ──
    def _test_db_consistency(self) -> None:
        """merge 失败时事务整体回滚——伪造一个不存在的 source 让函数抛 404，
        target 的状态应当未被改动。"""
        now = timezone.now()
        target = _make_group(
            fingerprint=f"target-tx-{uuid.uuid4().hex[:16]}",
            title="Target tx",
            first_seen=now,
            last_seen=now,
            event_count=10,
            user_count=5,
        )

        from ninja.errors import HttpError
        try:
            merge_error_groups(
                _fake_request(),
                GroupMergeSchema(target_group_id=target.pk, source_group_ids=[777_777_777]),
            )
        except HttpError:
            pass

        target.refresh_from_db(using=postgres_app_db_alias())
        if target.event_count != 10 or target.user_count != 5:
            raise CommandError(
                f"[case 4] failed merge 后 target 状态不应被改动，"
                f"实际 event_count={target.event_count}, user_count={target.user_count}"
            )

        self.stdout.write("  [case 4] failed merge DB 一致性 ✓")

    # ── 5. Wave 6: 跨 algo_version 合并 warning ──
    def _test_cross_algo_version_warning(self) -> None:
        """algo_version 不一致时响应里有 warning，但合并仍然成功。

        覆盖 3 个分支：
        - target=v1 + source 全 v1 → 无 warning（同版本，常态）
        - target=v1 + source=v2 → 有 warning，合并成功
        - target=v1 + source 混 [v1, v2, v2] → warning.source_algo_versions=[2]，
          仅 v2 source 列入 cross_version_source_ids
        """
        now = timezone.now()

        # 5a. 同版本 → 无 warning
        target_a = _make_group(
            fingerprint=f"target-av1-{uuid.uuid4().hex[:16]}",
            title="Target v1", first_seen=now, last_seen=now,
            fingerprint_algo_version=1,
        )
        source_a = _make_group(
            fingerprint=f"source-av1-{uuid.uuid4().hex[:16]}",
            title="Source v1", first_seen=now, last_seen=now,
            fingerprint_algo_version=1,
        )
        result_a = merge_error_groups(
            _fake_request(),
            GroupMergeSchema(target_group_id=target_a.pk, source_group_ids=[source_a.pk]),
        )
        if "algo_version_warning" in result_a:
            raise CommandError(
                f"[case 5a] 同 algo_version 合并不应返回 algo_version_warning，"
                f"实际 {result_a.get('algo_version_warning')}"
            )

        # 5b. 跨版本 → 有 warning，合并仍成功
        target_b = _make_group(
            fingerprint=f"target-bv1-{uuid.uuid4().hex[:16]}",
            title="Target v1", first_seen=now, last_seen=now,
            fingerprint_algo_version=1,
        )
        source_b = _make_group(
            fingerprint=f"source-bv2-{uuid.uuid4().hex[:16]}",
            title="Source v2", first_seen=now, last_seen=now,
            fingerprint_algo_version=2,
        )
        result_b = merge_error_groups(
            _fake_request(),
            GroupMergeSchema(target_group_id=target_b.pk, source_group_ids=[source_b.pk]),
        )
        if not result_b.get("success"):
            raise CommandError(f"[case 5b] 跨版本合并应仍成功，实际 {result_b}")
        warning = result_b.get("algo_version_warning")
        if not warning:
            raise CommandError(
                "[case 5b] 跨版本合并应返回 algo_version_warning"
            )
        if warning.get("target_algo_version") != 1:
            raise CommandError(
                f"[case 5b] warning.target_algo_version 应为 1，"
                f"实际 {warning.get('target_algo_version')}"
            )
        if warning.get("source_algo_versions") != [2]:
            raise CommandError(
                f"[case 5b] warning.source_algo_versions 应为 [2]，"
                f"实际 {warning.get('source_algo_versions')}"
            )
        if warning.get("cross_version_source_ids") != [source_b.pk]:
            raise CommandError(
                f"[case 5b] warning.cross_version_source_ids 应为 [{source_b.pk}]，"
                f"实际 {warning.get('cross_version_source_ids')}"
            )

        # 5c. 混合 source [v1, v2, v2] → 仅 v2 source 列入
        target_c = _make_group(
            fingerprint=f"target-cv1-{uuid.uuid4().hex[:16]}",
            title="Target v1 mixed", first_seen=now, last_seen=now,
            fingerprint_algo_version=1,
        )
        s_c_v1 = _make_group(
            fingerprint=f"source-cv1-{uuid.uuid4().hex[:16]}",
            title="Source v1", first_seen=now, last_seen=now,
            fingerprint_algo_version=1,
        )
        s_c_v2_a = _make_group(
            fingerprint=f"source-cv2a-{uuid.uuid4().hex[:16]}",
            title="Source v2 A", first_seen=now, last_seen=now,
            fingerprint_algo_version=2,
        )
        s_c_v2_b = _make_group(
            fingerprint=f"source-cv2b-{uuid.uuid4().hex[:16]}",
            title="Source v2 B", first_seen=now, last_seen=now,
            fingerprint_algo_version=2,
        )
        result_c = merge_error_groups(
            _fake_request(),
            GroupMergeSchema(
                target_group_id=target_c.pk,
                source_group_ids=[s_c_v1.pk, s_c_v2_a.pk, s_c_v2_b.pk],
            ),
        )
        warning_c = result_c.get("algo_version_warning")
        if not warning_c:
            raise CommandError("[case 5c] 混合 source 含 v2 应返回 warning")
        if warning_c.get("source_algo_versions") != [2]:
            raise CommandError(
                f"[case 5c] mixed warning.source_algo_versions 应去重为 [2]，"
                f"实际 {warning_c.get('source_algo_versions')}"
            )
        if sorted(warning_c.get("cross_version_source_ids") or []) != sorted([s_c_v2_a.pk, s_c_v2_b.pk]):
            raise CommandError(
                f"[case 5c] mixed warning.cross_version_source_ids 应仅含 v2 source，"
                f"实际 {warning_c.get('cross_version_source_ids')}"
            )

        self.stdout.write("  [case 5] cross-algo-version warning ✓")
