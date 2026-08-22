from __future__ import annotations

from unittest.mock import MagicMock

from django.test import SimpleTestCase

from apps.integrations_feishu.client import FeishuClient
from apps.integrations_feishu.constants import OAUTH_SCOPES
from apps.integrations_feishu.flow_view import (
    build_flow_view_from_whiteboard_nodes,
    extract_whiteboard_tokens,
    parse_feishu_flow,
    render_flow_view_markdown,
)


def _shape(node_id: str, label: str, x: float, y: float) -> dict:
    return {
        "id": node_id,
        "type": "composite_shape",
        "x": x,
        "y": y,
        "z_index": 0,
        "text": {"text": label},
        "composite_shape": {"type": "round_rect"},
    }


def _connector(edge_id: str, start_id: str, end_id: str) -> dict:
    return {
        "id": edge_id,
        "type": "connector",
        "connector": {
            "start": {
                "arrow_style": "none",
                "attached_object": {"id": start_id},
            },
            "end": {
                "arrow_style": "line_arrow",
                "attached_object": {"id": end_id},
            },
        },
    }


class FeishuFlowViewTests(SimpleTestCase):
    def test_oauth_requests_whiteboard_node_read_scope(self):
        self.assertIn("board:whiteboard:node:read", OAUTH_SCOPES)

    def test_client_reads_whiteboard_nodes_from_official_endpoint(self):
        client = FeishuClient(api_base="https://open.feishu.test")
        client._get_json = MagicMock(  # type: ignore[method-assign]
            return_value={"data": {"nodes": [{"id": "root"}, "invalid"]}}
        )

        result = client.list_whiteboard_nodes("access_token", "board/id")

        self.assertEqual(result, [{"id": "root"}])
        client._get_json.assert_called_once_with(
            "https://open.feishu.test/open-apis/board/v1/whiteboards/board%2Fid/nodes",
            access_token="access_token",
        )

    def test_extract_whiteboard_tokens_from_docx_blocks(self):
        blocks = [
            {"block_type": 1, "page": {}},
            {"block_type": 43, "board": {"token": "wb_one"}},
            {"block_type": 43, "whiteboard": {"whiteboard_id": "wb_two"}},
        ]

        self.assertEqual(extract_whiteboard_tokens(blocks), ["wb_one", "wb_two"])

    def test_sample_board_becomes_the_approved_parent_child_flow(self):
        raw_nodes = [
            _connector("c45", "o1:4", "o1:5"),
            _connector("c89", "o1:8", "o1:9"),
            _shape("o1:1", "流程1", 1086, 597),
            _shape("o1:5", "24", 1709, 870),
            _shape("o1:9", "5", 1086, 1510),
            _connector("c56", "o1:5", "o1:6"),
            _shape("o1:6", "25", 2026, 870),
            _shape("o1:7", "31", 1443, 1083),
            _shape("o1:3", "3", 1086, 1083),
            _connector("c24", "o1:2", "o1:4"),
            _shape("o1:4", "23", 1369, 870),
            _connector("c37", "o1:3", "o1:7"),
            _connector("c38", "o1:3", "o1:8"),
            _connector("c12", "o1:1", "o1:2"),
            _shape("o1:2", "2", 1086, 870),
            _connector("c23", "o1:2", "o1:3"),
            _shape("o1:8", "4", 1086, 1331),
        ]

        result = build_flow_view_from_whiteboard_nodes(raw_nodes, source_title="测试文档")

        self.assertEqual(result["title"], "流程1")
        self.assertEqual(result["warnings"], [])
        self.assertEqual(
            result["nodes"],
            [
                {"id": "o1:1", "label": "流程1", "status": "pending"},
                {"id": "o1:2", "parent_id": "o1:1", "label": "2", "status": "pending"},
                {"id": "o1:4", "parent_id": "o1:2", "label": "23", "status": "pending"},
                {"id": "o1:5", "parent_id": "o1:4", "label": "24", "status": "pending"},
                {"id": "o1:6", "parent_id": "o1:5", "label": "25", "status": "pending"},
                {"id": "o1:3", "parent_id": "o1:2", "label": "3", "status": "pending"},
                {"id": "o1:7", "parent_id": "o1:3", "label": "31", "status": "pending"},
                {"id": "o1:8", "parent_id": "o1:3", "label": "4", "status": "pending"},
                {"id": "o1:9", "parent_id": "o1:8", "label": "5", "status": "pending"},
            ],
        )

        self.assertEqual(
            render_flow_view_markdown(result),
            "## 流程图：流程1\n\n"
            "```text\n"
            "流程1\n"
            "└─ 2\n"
            "   ├─ 23\n"
            "   │  └─ 24\n"
            "   │     └─ 25\n"
            "   └─ 3\n"
            "      ├─ 31\n"
            "      └─ 4\n"
            "         └─ 5\n"
            "```",
        )

    def test_multiple_parents_and_cycles_are_reduced_to_a_safe_tree(self):
        raw_nodes = [
            _shape("a", "A", 0, 0),
            _shape("b", "B", 0, 100),
            _shape("c", "C", 100, 0),
            _connector("ab", "a", "b"),
            _connector("cb", "c", "b"),
            _connector("ba", "b", "a"),
        ]

        result = build_flow_view_from_whiteboard_nodes(raw_nodes, source_title="复杂流程")

        ids = [node["id"] for node in result["nodes"]]
        self.assertEqual(set(ids), {"a", "b", "c"})
        self.assertEqual(len(ids), len(set(ids)))
        positions = {node_id: index for index, node_id in enumerate(ids)}
        for node in result["nodes"]:
            if node.get("parent_id"):
                self.assertLess(positions[node["parent_id"]], positions[node["id"]])
        self.assertTrue(result["warnings"])

    def test_mind_map_parent_ids_form_hierarchy_without_connectors(self):
        root = _shape("root", "根节点", 0, 0)
        root["mind_map_root"] = {"layout": "tree_right"}
        child = _shape("child", "子节点", 0, 100)
        child["mind_map_node"] = {"parent_id": "root", "children": ["leaf"]}
        leaf = _shape("leaf", "叶子节点", 0, 200)
        leaf["mind_map_node"] = {"parent_id": "child"}

        result = build_flow_view_from_whiteboard_nodes([leaf, root, child])

        self.assertEqual(
            result["nodes"],
            [
                {"id": "root", "label": "根节点", "status": "pending"},
                {
                    "id": "child",
                    "parent_id": "root",
                    "label": "子节点",
                    "status": "pending",
                },
                {
                    "id": "leaf",
                    "parent_id": "child",
                    "label": "叶子节点",
                    "status": "pending",
                },
            ],
        )

    def test_top_level_parent_id_is_supported(self):
        root = _shape("root", "根节点", 0, 0)
        child = _shape("child", "子节点", 0, 100)
        child["parent_id"] = "root"

        result = build_flow_view_from_whiteboard_nodes([child, root])

        self.assertEqual(result["nodes"][1]["parent_id"], "root")

    def test_connector_parent_wins_over_native_parent(self):
        native_parent = _shape("native", "原生父节点", 0, 0)
        connector_parent = _shape("connector", "连线父节点", 100, 0)
        child = _shape("child", "子节点", 0, 100)
        child["mind_map_node"] = {"parent_id": "native"}

        result = build_flow_view_from_whiteboard_nodes(
            [
                native_parent,
                connector_parent,
                child,
                _connector("edge", "connector", "child"),
            ]
        )

        child_result = next(node for node in result["nodes"] if node["id"] == "child")
        self.assertEqual(child_result["parent_id"], "connector")

    def test_wiki_docx_board_is_resolved_and_parsed(self):
        client = MagicMock()
        client.get_wiki_node.return_value = {
            "selectable": True,
            "import_kind": "docx",
            "token": "docx_token",
            "name": "测试文档",
        }
        client.list_docx_blocks.return_value = [
            {"block_type": 43, "board": {"token": "whiteboard_token"}},
        ]
        client.list_whiteboard_nodes.return_value = [
            _shape("root", "流程1", 0, 0),
            _shape("child", "步骤2", 0, 100),
            _connector("edge", "root", "child"),
        ]

        result = parse_feishu_flow(
            client,
            "access_token",
            "https://example.feishu.cn/wiki/wiki_token",
        )

        self.assertEqual(result["title"], "流程1")
        self.assertEqual(result["nodes"][1]["parent_id"], "root")
        self.assertEqual(result["source"]["document_token"], "docx_token")
        self.assertEqual(result["source"]["whiteboard_tokens"], ["whiteboard_token"])
        client.list_whiteboard_nodes.assert_called_once_with(
            "access_token",
            "whiteboard_token",
        )
