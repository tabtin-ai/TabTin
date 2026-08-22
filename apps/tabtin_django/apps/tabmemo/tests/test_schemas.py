"""
TabMemo Schema 校验测试

验证 Pydantic Schema 的输入校验逻辑（SimpleTestCase，不依赖数据库）。
"""

from uuid import uuid4

from django.test import SimpleTestCase
from pydantic import ValidationError

from apps.tabmemo.schemas import (
    CollectionCreateRequest,
    CollectionUpdateRequest,
    MemoBatchRequest,
    MemoCreateRequest,
)


class MemoBatchRequestTests(SimpleTestCase):

    def test_valid_action_archive(self):
        req = MemoBatchRequest(
            organization_id=str(uuid4()),
            space_id=str(uuid4()),
            memo_ids=[str(uuid4())],
            action="archive",
        )
        self.assertEqual(req.action, "archive")

    def test_valid_action_tag(self):
        req = MemoBatchRequest(
            organization_id=str(uuid4()),
            space_id=str(uuid4()),
            memo_ids=[str(uuid4())],
            action="tag",
            tags=["test"],
        )
        self.assertEqual(req.action, "tag")

    def test_valid_action_move_to_collection(self):
        req = MemoBatchRequest(
            organization_id=str(uuid4()),
            space_id=str(uuid4()),
            memo_ids=[str(uuid4())],
            action="move_to_collection",
            collection_id=str(uuid4()),
        )
        self.assertEqual(req.action, "move_to_collection")

    def test_invalid_action_rejected(self):
        with self.assertRaises(ValidationError):
            MemoBatchRequest(
                organization_id=str(uuid4()),
                space_id=str(uuid4()),
                memo_ids=[str(uuid4())],
                action="destroy_all",
            )


class MemoCreateRequestTests(SimpleTestCase):

    def test_diary_accepts_agent_id(self):
        agent_id = str(uuid4())
        req = MemoCreateRequest(
            organization_id=str(uuid4()),
            agent_id=agent_id,
            memo_type="diary",
            content_markdown="今天完成了记忆链路整理。",
        )
        self.assertEqual(req.memo_type, "diary")
        self.assertEqual(req.agent_id, agent_id)

    def test_invalid_agent_id_rejected(self):
        with self.assertRaises(ValidationError):
            MemoCreateRequest(
                organization_id=str(uuid4()),
                agent_id="not-a-uuid",
                memo_type="diary",
            )

    def test_invalid_memo_id_rejected(self):
        with self.assertRaises(ValidationError):
            MemoBatchRequest(
                organization_id=str(uuid4()),
                space_id=str(uuid4()),
                memo_ids=["not-a-uuid"],
                action="archive",
            )


class SmartFilterValidationTests(SimpleTestCase):

    def test_create_collection_valid_smart_filter(self):
        req = CollectionCreateRequest(
            organization_id=str(uuid4()),
            space_id=str(uuid4()),
            title="My Smart",
            is_smart=True,
            smart_filter={
                "match_mode": "any",
                "tags": ["python"],
                "keywords": ["hello"],
                "color": "blue",
                "source": ["manual"],
            },
        )
        self.assertEqual(req.smart_filter["match_mode"], "any")

    def test_create_collection_empty_smart_filter_ok(self):
        req = CollectionCreateRequest(
            organization_id=str(uuid4()),
            space_id=str(uuid4()),
            title="Normal",
        )
        self.assertEqual(req.smart_filter, {})

    def test_create_collection_rejects_invalid_key(self):
        with self.assertRaises(ValidationError):
            CollectionCreateRequest(
                organization_id=str(uuid4()),
                space_id=str(uuid4()),
                title="Bad",
                smart_filter={"unknown_field": "value"},
            )

    def test_create_collection_rejects_invalid_match_mode(self):
        with self.assertRaises(ValidationError):
            CollectionCreateRequest(
                organization_id=str(uuid4()),
                space_id=str(uuid4()),
                title="Bad",
                smart_filter={"match_mode": "invalid"},
            )

    def test_create_collection_rejects_tags_as_string(self):
        with self.assertRaises(ValidationError):
            CollectionCreateRequest(
                organization_id=str(uuid4()),
                space_id=str(uuid4()),
                title="Bad",
                smart_filter={"tags": "not-a-list"},
            )

    def test_create_collection_rejects_color_as_list(self):
        with self.assertRaises(ValidationError):
            CollectionCreateRequest(
                organization_id=str(uuid4()),
                space_id=str(uuid4()),
                title="Bad",
                smart_filter={"color": ["blue"]},
            )

    def test_update_collection_validates_smart_filter(self):
        with self.assertRaises(ValidationError):
            CollectionUpdateRequest(
                smart_filter={"bad_key": True},
            )

    def test_update_collection_allows_none_smart_filter(self):
        req = CollectionUpdateRequest(title="Updated")
        self.assertIsNone(req.smart_filter)

    def test_update_collection_valid_smart_filter(self):
        req = CollectionUpdateRequest(
            smart_filter={"tags": ["ai"], "match_mode": "all"},
        )
        self.assertEqual(req.smart_filter["tags"], ["ai"])

    def test_create_collection_rejects_non_string_tags(self):
        with self.assertRaises(ValidationError):
            CollectionCreateRequest(
                organization_id=str(uuid4()),
                space_id=str(uuid4()),
                title="Bad",
                smart_filter={"tags": [123, True]},
            )

    def test_create_collection_rejects_non_string_source(self):
        with self.assertRaises(ValidationError):
            CollectionCreateRequest(
                organization_id=str(uuid4()),
                space_id=str(uuid4()),
                title="Bad",
                smart_filter={"source": [None, 42]},
            )
