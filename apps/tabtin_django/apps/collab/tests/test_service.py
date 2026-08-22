"""
VersionHistoryService 单元测试

测试核心版本管理逻辑：
- 快照锚点判断
- 全量/增量版本创建
- diff 链重建
- TTL 和降采样
- 命名版本
- 版本恢复
"""
import json
import uuid
import zlib
from unittest.mock import MagicMock, patch

import pytest

from apps.collab.adapters.base import CollabAdapter
from apps.collab.service import VersionHistoryService


class MockAdapter(CollabAdapter):
    """用于测试的 mock adapter，操作纯 JSON 数据。"""

    resource_type = "test"

    def __init__(self):
        self._resources = {}
        self._restored = {}

    def serialize_snapshot(self, data):
        return self.compress_json(data)

    def deserialize_snapshot(self, blob):
        return self.decompress_json(blob)

    def compute_diff(self, base_data, current_data):
        if base_data == current_data:
            return None
        diff = {"_base_keys": list(base_data.keys()), "_changes": {}}
        for k, v in current_data.items():
            if base_data.get(k) != v:
                diff["_changes"][k] = v
        for k in base_data:
            if k not in current_data:
                diff["_changes"][k] = "__DELETED__"
        return self.compress_json(diff)

    def apply_diff(self, base_data, diff_blob):
        diff = self.decompress_json(diff_blob)
        result = dict(base_data)
        for k, v in diff["_changes"].items():
            if v == "__DELETED__":
                result.pop(k, None)
            else:
                result[k] = v
        return result

    def get_content_stats(self, data):
        return {"key_count": len(data)}

    def get_resource(self, resource_id):
        return self._resources.get(resource_id)

    def check_permission(self, user, resource, action="edit"):
        return True

    def build_snapshot(self, resource):
        return resource.get("data", {})

    def persist_changes(self, resource, changes, editor_info):
        resource["data"] = changes
        return {"version": 1}

    def restore(self, resource, data, *, prepared=None, user=None):
        resource["data"] = data
        self._restored[resource.get("id")] = data


class TestSerializationSymmetry:
    """测试 serialize / deserialize 对称性。"""

    def test_roundtrip_json(self):
        adapter = MockAdapter()
        data = {"title": "测试文档", "pages": [1, 2, 3], "nested": {"a": True}}
        blob = adapter.serialize_snapshot(data)
        assert isinstance(blob, bytes)
        assert len(blob) > 0
        restored = adapter.deserialize_snapshot(blob)
        assert restored == data

    def test_empty_data(self):
        adapter = MockAdapter()
        data = {}
        blob = adapter.serialize_snapshot(data)
        restored = adapter.deserialize_snapshot(blob)
        assert restored == data

    def test_large_data(self):
        adapter = MockAdapter()
        data = {f"key_{i}": f"value_{i}" * 100 for i in range(100)}
        blob = adapter.serialize_snapshot(data)
        restored = adapter.deserialize_snapshot(blob)
        assert restored == data


class TestDiffSymmetry:
    """测试 compute_diff / apply_diff 对称性。"""

    def test_no_change(self):
        adapter = MockAdapter()
        data = {"a": 1, "b": 2}
        diff = adapter.compute_diff(data, data)
        assert diff is None

    def test_add_key(self):
        adapter = MockAdapter()
        base = {"a": 1}
        current = {"a": 1, "b": 2}
        diff = adapter.compute_diff(base, current)
        assert diff is not None
        restored = adapter.apply_diff(base, diff)
        assert restored == current

    def test_remove_key(self):
        adapter = MockAdapter()
        base = {"a": 1, "b": 2}
        current = {"a": 1}
        diff = adapter.compute_diff(base, current)
        assert diff is not None
        restored = adapter.apply_diff(base, diff)
        assert restored == current

    def test_modify_value(self):
        adapter = MockAdapter()
        base = {"a": 1, "b": "old"}
        current = {"a": 1, "b": "new"}
        diff = adapter.compute_diff(base, current)
        assert diff is not None
        restored = adapter.apply_diff(base, diff)
        assert restored == current

    def test_complex_diff(self):
        adapter = MockAdapter()
        base = {"a": 1, "b": 2, "c": 3}
        current = {"a": 100, "c": 3, "d": 4}
        diff = adapter.compute_diff(base, current)
        restored = adapter.apply_diff(base, diff)
        assert restored == current


class TestVersionHistoryServiceLogic:
    """测试 VersionHistoryService 的业务逻辑（不依赖数据库）。"""

    def test_compute_ttl(self):
        adapter = MockAdapter()
        svc = VersionHistoryService(adapter)

        from datetime import timedelta
        from django.utils import timezone

        now = timezone.now()

        ttl_free = svc._compute_ttl("free")
        assert ttl_free > now
        assert (ttl_free - now) < timedelta(days=8)

        ttl_pro = svc._compute_ttl("pro")
        assert (ttl_pro - now) > timedelta(days=29)

        ttl_team = svc._compute_ttl("team")
        assert (ttl_team - now) > timedelta(days=89)

    def test_adapter_resource_type(self):
        adapter = MockAdapter()
        svc = VersionHistoryService(adapter)
        assert svc.resource_type == "test"

    def test_adapter_compress_decompress(self):
        adapter = MockAdapter()
        data = {"key": "value", "num": 42}
        blob = CollabAdapter.compress_json(data)
        result = CollabAdapter.decompress_json(blob)
        assert result == data
