"""R1-10：ContextItem.creator_type 推断规则单测。"""

from __future__ import annotations

import unittest
from types import SimpleNamespace
import apps.fts.tests.conftest  # noqa: F401


def _ctx_item(**kwargs):
    return SimpleNamespace(**{**dict(
        id="ci-1", space_id="sp-1", created_by_id="u-9",
        metadata={}, item_type="tabdoc", title="T", preview="P",
        resource_id="r-1", trashed_at=None, is_archived=False,
        created_at=None, updated_at=None,
    ), **kwargs})


class ResourceCreatorTypeTests(unittest.TestCase):
    def test_metadata_creator_type_agent_wins(self):
        from apps.fts.services.sync_service import _resource_creator_type
        item = _ctx_item(metadata={"creator_type": "agent"}, created_by_id="any")
        self.assertEqual(_resource_creator_type(item), "agent")

    def test_metadata_creator_type_user_treated_as_user(self):
        from apps.fts.services.sync_service import _resource_creator_type
        item = _ctx_item(metadata={"creator_type": "user"})
        self.assertEqual(_resource_creator_type(item), "user")

    def test_creator_identity_is_not_inferred_from_user_or_space(self):
        from apps.fts.services.sync_service import _resource_creator_type
        item = _ctx_item(metadata={}, created_by_id="agent-system-user-id")
        self.assertEqual(_resource_creator_type(item), "user")


if __name__ == "__main__":
    unittest.main()
