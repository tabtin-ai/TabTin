from unittest import TestCase
from uuid import uuid4

from apps.tabtinspace.services.share_scope import parse_scope_ids, validate_object_scope


class ShareScopeHelpersTests(TestCase):
    def test_validate_object_scope_allows_docs_only_selective_scope(self):
        doc_id = str(uuid4())

        errors = validate_object_scope(
            {
                "scope_type": "selective",
                "docs": [doc_id],
            }
        )

        self.assertEqual(errors, [])

    def test_validate_object_scope_allows_folder_only_selective_scope(self):
        errors = validate_object_scope(
            {
                "scope_type": "selective",
                "folders": ["/tmp/tabtin"],
            }
        )

        self.assertEqual(errors, [])

    def test_parse_scope_ids_denies_missing_type_in_selective_scope(self):
        doc_uuid = uuid4()
        scope = {
            "scope_type": "selective",
            "docs": [str(doc_uuid)],
        }

        self.assertEqual(parse_scope_ids(scope, "tables"), [])
        self.assertEqual(parse_scope_ids(scope, "docs"), [doc_uuid])

    def test_parse_scope_ids_fails_closed_for_invalid_scope_type(self):
        table_uuid = uuid4()
        scope = {
            "scope_type": "legacy",
            "tables": [str(table_uuid)],
        }

        self.assertEqual(parse_scope_ids(scope, "tables"), [])

    def test_parse_scope_ids_returns_none_for_unrestricted_scope(self):
        table_uuid = uuid4()

        self.assertIsNone(parse_scope_ids({}, "tables"))
        self.assertIsNone(parse_scope_ids({"scope_type": "all"}, "tables"))
        self.assertEqual(
            parse_scope_ids(
                {
                    "scope_type": "selective",
                    "tables": [str(table_uuid)],
                },
                "tables",
            ),
            [table_uuid],
        )

    def test_validate_object_scope_rejects_selective_without_authorized_lists(self):
        errors = validate_object_scope(
            {
                "scope_type": "selective",
                "tables": [],
                "docs": [],
                "folders": [],
            }
        )

        self.assertEqual(
            errors,
            ["selective 模式下 tables/docs/folders 至少需要一个非空列表"],
        )
