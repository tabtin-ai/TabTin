"""ACL service 单测。

不依赖真 PG：mock `Space*` 模型。覆盖：
    - 缓存命中 / 缓存未命中走 PG
    - Membership 权限场景
    - build_es_filter 结构（membership full access / 无 access）
"""

from __future__ import annotations

import unittest
from unittest.mock import MagicMock, patch

import apps.fts.tests.conftest  # noqa: F401


class AccessibleSpacesDtoTests(unittest.TestCase):
    def test_has_any_access(self):
        from apps.fts.services.acl_service import AccessibleSpaces
        a = AccessibleSpaces()
        self.assertFalse(a.has_any_access())
        a.full_access_space_ids = ["s1"]
        self.assertTrue(a.has_any_access())

    def test_all_space_ids_dedupe(self):
        from apps.fts.services.acl_service import AccessibleSpaces
        a = AccessibleSpaces(full_access_space_ids=["s1", "s2", "s1"])
        self.assertEqual(a.all_space_ids(), ["s1", "s2"])

    def test_serialization_roundtrip(self):
        from apps.fts.services.acl_service import AccessibleSpaces, _serialize, _deserialize
        a = AccessibleSpaces(
            full_access_space_ids=["s1"],
            organization_id="wt-1", cached_at=123.4,
        )
        data = _serialize(a)
        b = _deserialize(data)
        self.assertEqual(b.full_access_space_ids, ["s1"])
        self.assertEqual(b.organization_id, "wt-1")
        self.assertEqual(b.cached_at, 123.4)

    def test_deserialization_ignores_retired_object_scoped_payload(self):
        from apps.fts.services.acl_service import _deserialize

        b = _deserialize(
            '{"full_access_space_ids":["s1"],"object_scoped":{"s2":["i1"]},'
            '"organization_id":"wt-1","cached_at":123.4}'
        )

        self.assertEqual(b.all_space_ids(), ["s1"])


class GetUserAccessibleSpacesTests(unittest.TestCase):
    """覆盖 membership 权限场景 + 缓存路径。"""

    def setUp(self):
        # 清掉 redis fake
        self._patches = []

    def tearDown(self):
        for p in self._patches:
            p.stop()

    def _patch(self, target, **kwargs):
        p = patch(target, **kwargs)
        self._patches.append(p)
        return p.start()

    def test_membership_only(self):
        # mock _resolve_from_pg 返回纯 membership
        from apps.fts.services.acl_service import (
            AccessibleSpaces, get_user_accessible_spaces,
        )
        # 打开缓存绕过 redis：直接 mock _get_redis 返回 None
        self._patch("apps.fts.services.acl_service._get_redis", return_value=None)
        self._patch(
            "apps.fts.services.acl_service._resolve_from_pg",
            return_value=AccessibleSpaces(
                full_access_space_ids=["s1", "s2"],
                organization_id="wt-1",
            ),
        )
        acc = get_user_accessible_spaces("u1", "wt-1")
        self.assertEqual(acc.full_access_space_ids, ["s1", "s2"])

    def test_cache_hit_short_circuits_pg(self):
        from apps.fts.services.acl_service import (
            AccessibleSpaces, _serialize, get_user_accessible_spaces,
        )
        cached = AccessibleSpaces(
            full_access_space_ids=["s99"], organization_id="wt-1", cached_at=999.0,
        )

        fake_redis = MagicMock()
        fake_redis.get.return_value = _serialize(cached)
        self._patch("apps.fts.services.acl_service._get_redis", return_value=fake_redis)
        pg_mock = self._patch(
            "apps.fts.services.acl_service._resolve_from_pg",
            return_value=AccessibleSpaces(),
        )

        acc = get_user_accessible_spaces("u1", "wt-1")
        self.assertEqual(acc.full_access_space_ids, ["s99"])
        pg_mock.assert_not_called()

    def test_cache_miss_writes_then_returns(self):
        from apps.fts.services.acl_service import (
            AccessibleSpaces, get_user_accessible_spaces,
        )
        fake_redis = MagicMock()
        fake_redis.get.return_value = None
        self._patch("apps.fts.services.acl_service._get_redis", return_value=fake_redis)
        self._patch(
            "apps.fts.services.acl_service._resolve_from_pg",
            return_value=AccessibleSpaces(full_access_space_ids=["s1"], organization_id="wt-1"),
        )
        acc = get_user_accessible_spaces("u1", "wt-1")
        self.assertEqual(acc.full_access_space_ids, ["s1"])
        # 写入 setex 调用一次
        fake_redis.setex.assert_called_once()


class BuildEsFilterTests(unittest.TestCase):
    def test_no_access_returns_match_none(self):
        from apps.fts.services.acl_service import AccessibleSpaces, build_es_filter
        node = build_es_filter(AccessibleSpaces(), "wt-1")
        self.assertIn("must_not", node["bool"])

    def test_full_only(self):
        from apps.fts.services.acl_service import AccessibleSpaces, build_es_filter
        node = build_es_filter(
            AccessibleSpaces(full_access_space_ids=["s1", "s2"], organization_id="wt-1"),
            "wt-1",
        )
        # 顶层 bool.filter 含 [organization term, bool.should]
        filters = node["bool"]["filter"]
        self.assertEqual(filters[0], {"term": {"organization_id": "wt-1"}})
        should = filters[1]["bool"]["should"]
        self.assertEqual(len(should), 1)
        self.assertEqual(should[0], {"terms": {"space_id": ["s1", "s2"]}})

    def test_logical_index_does_not_create_object_scoped_filter(self):
        from apps.fts.services.acl_service import AccessibleSpaces, build_es_filter
        node = build_es_filter(
            AccessibleSpaces(full_access_space_ids=["s1"], organization_id="wt-1"),
            "wt-1",
            logical_index="resources",
        )
        should = node["bool"]["filter"][1]["bool"]["should"]
        self.assertEqual(should, [{"terms": {"space_id": ["s1"]}}])

    def test_resources_org_only_branch_with_user_id(self):
        """#7238：resources 在有 user_id 时增加 space_id missing + creator ACL。"""
        from apps.fts.services.acl_service import AccessibleSpaces, build_es_filter
        node = build_es_filter(
            AccessibleSpaces(
                full_access_space_ids=["s1"],
                organization_id="wt-1",
                user_id="u-1",
                cloud_resource_ids=["res-shared"],
            ),
            "wt-1",
            logical_index="resources",
        )
        should = node["bool"]["filter"][1]["bool"]["should"]
        self.assertEqual(should[0], {"terms": {"space_id": ["s1"]}})
        org_only = should[1]["bool"]["filter"]
        self.assertEqual(
            org_only[0],
            {"bool": {"must_not": {"exists": {"field": "space_id"}}}},
        )
        owner_or_shared = org_only[1]["bool"]["should"]
        self.assertIn(
            {
                "bool": {
                    "filter": [
                        {"term": {"item_type": "tabfiles"}},
                        {"term": {"creator_id": "u-1"}},
                    ]
                }
            },
            owner_or_shared,
        )
        self.assertIn({"terms": {"resource_id": ["res-shared"]}}, owner_or_shared)

    def test_agents_acl_uses_space_ids_field(self):
        from apps.fts.services.acl_service import AccessibleSpaces, build_es_filter
        node = build_es_filter(
            AccessibleSpaces(full_access_space_ids=["s1"], organization_id="wt-1"),
            "wt-1",
            logical_index="agents",
        )
        should = node["bool"]["filter"][1]["bool"]["should"]
        self.assertEqual(should, [{"terms": {"space_ids": ["s1"]}}])


class InvalidationTests(unittest.TestCase):
    def setUp(self):
        self._p = patch("apps.fts.services.acl_service._get_redis")
        self.mock_get = self._p.start()

    def tearDown(self):
        self._p.stop()

    def test_invalidate_user_with_redis(self):
        from apps.fts.services.acl_service import invalidate_user_acl
        fake = MagicMock()
        fake.delete.return_value = 1
        self.mock_get.return_value = fake
        n = invalidate_user_acl("u1", "wt-1")
        self.assertEqual(n, 1)
        fake.delete.assert_called_once()

    def test_invalidate_no_redis_returns_zero(self):
        from apps.fts.services.acl_service import invalidate_user_acl
        self.mock_get.return_value = None
        self.assertEqual(invalidate_user_acl("u1", "wt-1"), 0)

    def test_invalidate_empty_args_zero(self):
        from apps.fts.services.acl_service import (
            invalidate_user_acl, invalidate_organization_users_acl,
        )
        self.assertEqual(invalidate_user_acl(None, "wt-1"), 0)
        self.assertEqual(invalidate_user_acl("u", None), 0)
        self.assertEqual(invalidate_organization_users_acl("wt", []), 0)
        self.assertEqual(invalidate_organization_users_acl(None, ["u"]), 0)

    def test_invalidate_batch(self):
        from apps.fts.services.acl_service import invalidate_organization_users_acl
        fake = MagicMock()
        fake.delete.return_value = 3
        self.mock_get.return_value = fake
        n = invalidate_organization_users_acl("wt-1", ["u1", "u2", "u3"])
        self.assertEqual(n, 3)
        # 一次 delete 多个 key
        args = fake.delete.call_args[0]
        self.assertEqual(len(args), 3)


if __name__ == "__main__":
    unittest.main()
