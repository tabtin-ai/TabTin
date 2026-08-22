"""Unit tests for preserve_stable_html_block_ids (no DB)."""

from __future__ import annotations

import unittest
from uuid import uuid4

from apps.tabdoc.services.markdown_exchange import preserve_stable_html_block_ids


class PreserveStableHtmlBlockIdsTests(unittest.TestCase):
    def test_restores_missing_id_for_unique_file(self):
        file_id = str(uuid4())
        block_id = str(uuid4())
        existing = {
            "type": "doc",
            "content": [
                {
                    "type": "htmlBlock",
                    "attrs": {"blockId": block_id, "fileId": file_id},
                }
            ],
        }
        incoming = {
            "type": "doc",
            "content": [
                {
                    "type": "htmlBlock",
                    "attrs": {"fileId": file_id, "title": "stale"},
                }
            ],
        }
        out = preserve_stable_html_block_ids(incoming, existing)
        self.assertEqual(out["content"][0]["attrs"]["blockId"], block_id)

    def test_does_not_overwrite_explicit_incoming_id(self):
        file_id = str(uuid4())
        existing_id = str(uuid4())
        incoming_id = str(uuid4())
        existing = {
            "type": "doc",
            "content": [
                {"type": "htmlBlock", "attrs": {"blockId": existing_id, "fileId": file_id}}
            ],
        }
        incoming = {
            "type": "doc",
            "content": [
                {"type": "htmlBlock", "attrs": {"blockId": incoming_id, "fileId": file_id}}
            ],
        }
        out = preserve_stable_html_block_ids(incoming, existing)
        self.assertEqual(out["content"][0]["attrs"]["blockId"], incoming_id)

    def test_skips_ambiguous_duplicate_file_ids(self):
        file_id = str(uuid4())
        existing = {
            "type": "doc",
            "content": [
                {"type": "htmlBlock", "attrs": {"blockId": "a", "fileId": file_id}},
                {"type": "htmlBlock", "attrs": {"blockId": "b", "fileId": file_id}},
            ],
        }
        incoming = {
            "type": "doc",
            "content": [
                {"type": "htmlBlock", "attrs": {"fileId": file_id}},
                {"type": "htmlBlock", "attrs": {"fileId": file_id}},
            ],
        }
        out = preserve_stable_html_block_ids(incoming, existing)
        self.assertIs(out, incoming)
        self.assertNotIn("blockId", out["content"][0]["attrs"])

    def test_replaces_auto_alias_when_unique(self):
        file_id = str(uuid4())
        block_id = str(uuid4())
        existing = {
            "type": "doc",
            "content": [
                {"type": "htmlBlock", "attrs": {"blockId": block_id, "fileId": file_id}}
            ],
        }
        incoming = {
            "type": "doc",
            "content": [
                {
                    "type": "htmlBlock",
                    "attrs": {"blockId": "auto_0", "fileId": file_id},
                }
            ],
        }
        out = preserve_stable_html_block_ids(incoming, existing)
        self.assertEqual(out["content"][0]["attrs"]["blockId"], block_id)

    def test_does_not_restore_block_id_already_occupied_in_incoming(self):
        shared_id = str(uuid4())
        file_a = str(uuid4())
        file_b = str(uuid4())
        existing = {
            "type": "doc",
            "content": [
                {"type": "htmlBlock", "attrs": {"blockId": shared_id, "fileId": file_a}},
            ],
        }
        incoming = {
            "type": "doc",
            "content": [
                # Another block already holds the candidate stable id.
                {"type": "htmlBlock", "attrs": {"blockId": shared_id, "fileId": file_b}},
                {"type": "htmlBlock", "attrs": {"fileId": file_a}},
            ],
        }
        out = preserve_stable_html_block_ids(incoming, existing)
        self.assertIs(out, incoming)
        self.assertNotIn("blockId", out["content"][1]["attrs"])
