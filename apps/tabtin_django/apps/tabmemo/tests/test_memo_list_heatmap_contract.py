"""
Memo list / heatmap / tag-stats 契约：ownership 对齐 + 半开日期边界。

用真实 PG 行钉住：
- owner_id | created_by_id 与 list 同口径（历史只落 created_by 的行仍计入 heatmap/tag-stats）
- [created_after, created_before) —— 边界时刻本身被排除 / 包含
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone as dt_timezone

from django.db import connections
from django.test import RequestFactory, TransactionTestCase

from apps.tabmemo.constants import TABMEMO_DB
from apps.tabmemo.models import Memo
from apps.tabmemo.services.memo_service import MemoService


class MemoListHeatmapContractTests(TransactionTestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        from apps.tabtinspace.models import OrganizationMember
        from apps.tabtinspace.tests.fixtures import (
            create_test_organization,
            create_test_user,
            cleanup_test_organization,
        )

        connections["postgresql"].close()
        self.user = create_test_user(prefix="memo-own")
        self.other = create_test_user(prefix="memo-own-other")
        self.organization = create_test_organization(owner=self.user, prefix="memo-own")
        OrganizationMember.objects.create(
            organization=self.organization,
            user_id=self.other.id,
            role="editor",
        )
        self.svc = MemoService(user=self.user)
        self._cleanup = cleanup_test_organization
        self.factory = RequestFactory()

    def tearDown(self):
        from apps.tabtinspace.models import Organization

        Memo.objects.using(TABMEMO_DB).filter(
            organization_id=self.organization.id
        ).delete()
        # create_test_user 会顺带建默认组织；按 owner 一并清掉
        owner_ids = [self.user.id, self.other.id]
        for org in list(Organization.objects.filter(owner_id__in=owner_ids)):
            self._cleanup(org, delete_user=True)

    def _create_memo(
        self,
        *,
        user=None,
        owner_id=None,
        created_by=None,
        tags=None,
        content="memo",
        created_at=None,
    ) -> Memo:
        user = user or self.user
        memo = Memo.objects.using(TABMEMO_DB).create(
            organization_id=self.organization.id,
            space_id=None,
            owner_id=owner_id if owner_id is not None else user.id,
            content_json={},
            content_plaintext=content,
            content_markdown=content,
            tags=tags or [],
            status=Memo.Status.ACTIVE,
            memo_type=Memo.MemoType.NOTE,
            source=Memo.Source.MANUAL,
            created_by=created_by if created_by is not None else user,
            updated_by=user,
        )
        if created_at is not None:
            Memo.objects.using(TABMEMO_DB).filter(id=memo.id).update(created_at=created_at)
            memo.refresh_from_db()
        return memo

    def test_historic_created_by_only_counted_in_list_heatmap_and_tag_stats(self):
        """列表可见的历史行（仅 created_by，owner_id 为空）必须进 heatmap / tag-stats。"""
        historic = self._create_memo(
            user=self.user,
            owner_id=None,
            created_by=self.user,
            tags=["契约标签"],
            content="historic created_by only",
        )
        # 显式清空 owner_id（create 可能被默认填）
        Memo.objects.using(TABMEMO_DB).filter(id=historic.id).update(owner_id=None)
        historic.refresh_from_db()
        self.assertIsNone(historic.owner_id)
        self.assertEqual(str(historic.created_by_id), str(self.user.id))

        # 另一用户的 memo：list/heatmap/tag-stats 都不应计入当前用户
        self._create_memo(
            user=self.other,
            tags=["契约标签"],
            content="other user memo",
        )

        listed = self.svc.list_memos(organization_id=str(self.organization.id))
        listed_ids = {str(m.id) for m in listed["items"]}
        self.assertIn(str(historic.id), listed_ids)

        from apps.tabmemo.api import memo_heatmap_stats, tag_stats

        req = self.factory.get("/tabmemo/stats/heatmap/")
        req.auth = self.user
        heat = memo_heatmap_stats(req, organization_id=str(self.organization.id), days=84)
        self.assertTrue(heat["success"])
        self.assertGreaterEqual(heat["data"]["total"], 1)
        heat_total = heat["data"]["total"]

        # 同 org / 同用户：historic 计入；other 的不算进当前用户 total
        other_heat_req = self.factory.get("/tabmemo/stats/heatmap/")
        other_heat_req.auth = self.other
        other_heat = memo_heatmap_stats(
            other_heat_req, organization_id=str(self.organization.id), days=84
        )
        self.assertEqual(other_heat["data"]["total"], 1)

        # 当前用户至少有 historic 这一条
        self.assertEqual(heat_total, 1)

        tag_req = self.factory.get("/tabmemo/tags/stats/")
        tag_req.auth = self.user
        tags = tag_stats(tag_req, organization_id=str(self.organization.id))
        self.assertTrue(tags["success"])
        by_name = {t["name"]: t["count"] for t in tags["data"]["tags"]}
        self.assertEqual(by_name.get("契约标签"), 1)

    def test_list_memos_half_open_date_boundaries_with_real_datetimes(self):
        """半开 [after, before)：恰好 before 排除，恰好 after 纳入。"""
        tz = dt_timezone.utc
        day_start = datetime(2026, 7, 31, 0, 0, 0, tzinfo=tz)
        day_end = datetime(2026, 8, 1, 0, 0, 0, tzinfo=tz)

        at_after = self._create_memo(
            content="at created_after",
            created_at=day_start,
        )
        just_before_end = self._create_memo(
            content="just before created_before",
            created_at=day_end - timedelta(microseconds=1),
        )
        at_before = self._create_memo(
            content="at created_before exclusive",
            created_at=day_end,
        )
        after_window = self._create_memo(
            content="after window",
            created_at=day_end + timedelta(hours=1),
        )

        result = self.svc.list_memos(
            organization_id=str(self.organization.id),
            created_after=day_start.isoformat(),
            created_before=day_end.isoformat(),
        )
        ids = {str(m.id) for m in result["items"]}
        self.assertIn(str(at_after.id), ids)
        self.assertIn(str(just_before_end.id), ids)
        self.assertNotIn(str(at_before.id), ids)
        self.assertNotIn(str(after_window.id), ids)

        # API 层同样半开
        from apps.tabmemo.api import list_memos

        req = self.factory.get(
            "/tabmemo/memos/",
            {
                "organization_id": str(self.organization.id),
                "created_after": day_start.isoformat(),
                "created_before": day_end.isoformat(),
            },
        )
        req.auth = self.user
        response = list_memos(
            req,
            organization_id=str(self.organization.id),
            created_after=day_start.isoformat(),
            created_before=day_end.isoformat(),
        )
        self.assertTrue(response["success"])
        api_ids = {item["id"] for item in response["data"]["items"]}
        self.assertIn(str(at_after.id), api_ids)
        self.assertNotIn(str(at_before.id), api_ids)
