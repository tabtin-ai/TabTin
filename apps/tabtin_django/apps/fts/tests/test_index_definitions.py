"""`apps.fts.index_definitions` 单元测试。

验证：
    - 6 个索引 mapping 字段结构满足 PRD 3.8/4.4/4.5 契约
    - 所有 text 字段正确分离 index/query 分析器（ADR-06）
    - `get_monthly_index_name` 按月正确派生
    - `ensure_indices(client)` 对 mock client 幂等（存在则跳过 create）
    - `ensure_monthly_index` 正确处理 `resource_already_exists_exception`

ES 8.x 禁止 mapping-level `boost`，专项用例做前向保障，
防止误引入导致 create 时 ES 拒绝（阿里云 ES 托管同样拒绝）。
"""

from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import MagicMock

from django.test import SimpleTestCase, override_settings

from apps.fts.index_definitions import (
    ANALYZER_INDEX,
    ANALYZER_QUERY,
    INDEX_DEFINITIONS,
    INDEX_SETTINGS,
    MESSAGES_TEMPLATE_NAME,
    ensure_indices,
    ensure_monthly_index,
    get_index_name,
    get_messages_alias,
    get_messages_template_name,
    get_monthly_index_name,
    iter_index_names,
)


class MappingShapeTests(SimpleTestCase):
    """mapping 的必需字段 + 类型合规。"""

    REQUIRED_FIELDS = {
        "messages": {
            "message_id", "session_id", "organization_id", "space_id", "user_id",
            "creator_type", "agent_id", "role", "content", "session_title",
            "session_status", "session_revert_state_index",
            # ADR-16（2026-04-17 QC 后修正）：移除 message_index_in_session 死字段，
            # 新增 checkpoint_state_index 作为 Wave 2 回滚过滤主键
            "checkpoint_state_index",
            "tool_call_summary", "tool_names", "created_at",
        },
        "resources": {
            "item_id", "item_type", "title", "preview", "resource_id",
            "space_id", "organization_id", "creator_type", "creator_id",
            "is_archived", "trashed_at", "visibility", "object_scope_id",
            "created_at", "updated_at",
        },
        "agents": {
            "agent_id", "name", "description", "type",
            "organization_id", "user_id", "space_ids", "created_at",
        },
        "spaces": {
            "space_id", "name", "description", "type", "is_archived",
            "organization_id", "created_at",
        },
        "memos": {
            "memo_id", "content", "tags", "ai_tags", "status", "memo_type",
            "source", "is_pinned", "trashed_at",
            "space_id", "organization_id", "user_id", "creator_type",
            "created_at", "updated_at",
        },
        "im": {
            "message_id", "conversation_id", "conversation_name", "sender_id",
            "creator_type", "space_id", "content", "is_deleted", "organization_id",
            "created_at",
        },
    }

    def test_all_six_indices_present(self) -> None:
        self.assertEqual(
            set(INDEX_DEFINITIONS.keys()),
            {"messages", "resources", "agents", "spaces", "memos", "im"},
        )

    def test_each_mapping_has_required_fields(self) -> None:
        for logical, expected in self.REQUIRED_FIELDS.items():
            with self.subTest(index=logical):
                props = INDEX_DEFINITIONS[logical]["mapping"]["properties"]
                missing = expected - set(props.keys())
                self.assertFalse(
                    missing,
                    msg=f"{logical} mapping 缺失字段: {missing}",
                )

    def test_text_fields_use_separate_analyzers(self) -> None:
        """所有 text 字段均须声明 `analyzer` 与 `search_analyzer` 分离（ADR-06）。"""
        for logical, definition in INDEX_DEFINITIONS.items():
            for field_name, spec in definition["mapping"]["properties"].items():
                if spec.get("type") != "text":
                    continue
                with self.subTest(index=logical, field=field_name):
                    self.assertEqual(spec.get("analyzer"), ANALYZER_INDEX)
                    self.assertEqual(spec.get("search_analyzer"), ANALYZER_QUERY)

    def test_no_mapping_level_boost(self) -> None:
        """ES 8.x 已移除 mapping-level boost（启用会 create 失败）。"""
        for logical, definition in INDEX_DEFINITIONS.items():
            for field_name, spec in definition["mapping"]["properties"].items():
                with self.subTest(index=logical, field=field_name):
                    self.assertNotIn(
                        "boost", spec,
                        msg=f"{logical}.{field_name} 不应携带 mapping-level boost",
                    )

    def test_resources_preview_has_keyword_multi_field(self) -> None:
        """PRD 4.5 代码标识符精确匹配：tabtin-resources.preview.keyword 必备。

        Wave 1 同步 ContextItem.preview 写入；Wave 2 搜索层对
        `item_type='tabcode'` 的资源用 `preview.keyword` 做驼峰标识符
        精确匹配。
        """
        preview = INDEX_DEFINITIONS["resources"]["mapping"]["properties"]["preview"]
        self.assertEqual(preview.get("type"), "text")
        fields = preview.get("fields") or {}
        self.assertIn("keyword", fields)
        keyword_spec = fields["keyword"]
        self.assertEqual(keyword_spec.get("type"), "keyword")
        self.assertEqual(keyword_spec.get("ignore_above"), 256)

    def test_messages_mapping_does_not_have_dead_field(self) -> None:
        """ADR-16：message_index_in_session 是死字段，必须从 mapping 移除。

        防止有人误加回（每条消息 2 次 COUNT 查询的 MySQL 杀手）。
        """
        props = INDEX_DEFINITIONS["messages"]["mapping"]["properties"]
        self.assertNotIn(
            "message_index_in_session", props,
            msg="message_index_in_session 是死字段（ADR-16），不应在 mapping 中。"
                "Wave 2 回滚过滤改用 checkpoint_state_index。",
        )
        self.assertIn(
            "checkpoint_state_index", props,
            msg="ADR-16：必须包含 checkpoint_state_index 字段供 Wave 2 回滚过滤",
        )
        self.assertEqual(
            props["checkpoint_state_index"].get("type"), "integer",
            msg="checkpoint_state_index 必须是 integer 类型（与 ChatMessage 模型字段一致）",
        )

    def test_strict_dynamic_on_all_mappings(self) -> None:
        """6 个 mapping 必须 dynamic=strict（PRD 4.4）。

        Wave 1 的 _bulk 失败隔离强依赖此声明；退化为 dynamic=true 会导致
        索引 schema 爆炸，违反 PRD 4.4 搜索质量承诺。
        """
        for logical, definition in INDEX_DEFINITIONS.items():
            with self.subTest(index=logical):
                self.assertEqual(definition["mapping"].get("dynamic"), "strict")

    def test_index_settings_define_both_analyzers(self) -> None:
        analyzers = INDEX_SETTINGS["analysis"]["analyzer"]
        self.assertIn(ANALYZER_INDEX, analyzers)
        self.assertIn(ANALYZER_QUERY, analyzers)
        self.assertEqual(
            analyzers[ANALYZER_INDEX]["filter"][-1], "cjk_bigram_with_unigrams",
        )
        self.assertEqual(
            analyzers[ANALYZER_QUERY]["filter"][-1], "cjk_bigram_only",
        )
        filters = INDEX_SETTINGS["analysis"]["filter"]
        self.assertTrue(filters["cjk_bigram_with_unigrams"]["output_unigrams"])
        self.assertFalse(filters["cjk_bigram_only"]["output_unigrams"])


@override_settings(SEARCH_INDEX_PREFIX="tabtin")
class NamingTests(SimpleTestCase):

    def test_prefix_applied(self) -> None:
        self.assertEqual(get_index_name("resources"), "tabtin-resources")
        self.assertEqual(get_messages_alias(), "tabtin-messages")

    def test_monthly_index_format(self) -> None:
        dt = datetime(2026, 4, 16, tzinfo=timezone.utc)
        self.assertEqual(
            get_monthly_index_name("messages", dt), "tabtin-messages-2026-04",
        )

    def test_iter_index_names_covers_six(self) -> None:
        names = iter_index_names()
        self.assertEqual(len(names), 6)
        self.assertIn("tabtin-messages", names)  # alias 名
        self.assertIn("tabtin-resources", names)

    @override_settings(SEARCH_INDEX_PREFIX="tabtin-ci")
    def test_prefix_override_for_ci_environment(self) -> None:
        self.assertEqual(get_index_name("agents"), "tabtin-ci-agents")
        dt = datetime(2026, 4, 16, tzinfo=timezone.utc)
        self.assertEqual(
            get_monthly_index_name("messages", dt), "tabtin-ci-messages-2026-04",
        )
        self.assertEqual(get_messages_template_name(), "tabtin-ci-messages-template")

    def test_messages_template_name_default_prefix(self) -> None:
        self.assertEqual(get_messages_template_name(), "tabtin-messages-template")


class EnsureIndicesIdempotencyTests(SimpleTestCase):
    """mock client 验证 `ensure_indices` 幂等性。"""

    def _make_client(self, existing: set[str] | None = None) -> MagicMock:
        existing = set(existing or ())
        client = MagicMock(name="es-client")
        client.indices = MagicMock()
        client.indices.exists = MagicMock(
            side_effect=lambda index: index in existing,
        )
        client.indices.create = MagicMock()
        client.indices.put_index_template = MagicMock()
        return client

    def test_creates_all_indices_when_empty(self) -> None:
        client = self._make_client(existing=set())
        result = ensure_indices(client)

        # 单索引（5 个非 rollover）+ 1 个月度索引 = 6 create
        self.assertEqual(client.indices.create.call_count, 6)

        # 消息 template 被写一次，name 派生自 SEARCH_INDEX_PREFIX（默认 tabtin-）
        client.indices.put_index_template.assert_called_once()
        args, kwargs = client.indices.put_index_template.call_args
        self.assertEqual(kwargs.get("name"), get_messages_template_name())
        self.assertEqual(kwargs.get("name"), MESSAGES_TEMPLATE_NAME)  # 默认前缀下兼容
        self.assertIn("template", kwargs)

        # 返回所有逻辑名
        self.assertEqual(set(result.keys()), set(INDEX_DEFINITIONS.keys()))

    @override_settings(SEARCH_INDEX_PREFIX="tabtin-ci")
    def test_creates_all_indices_with_ci_prefix(self) -> None:
        """多环境共享 ES 时 template + 索引名必须全部走派生，不能硬编码"""
        client = self._make_client(existing=set())
        result = ensure_indices(client)

        # template 名带 CI 前缀
        kwargs = client.indices.put_index_template.call_args.kwargs
        self.assertEqual(kwargs.get("name"), "tabtin-ci-messages-template")
        # template body 的 pattern / alias 也带 CI 前缀
        tpl_body = kwargs["template"]
        self.assertEqual(list(tpl_body["aliases"].keys()), ["tabtin-ci-messages"])

        # 每个实际 create 的索引名都带 CI 前缀
        for call in client.indices.create.call_args_list:
            idx = call.kwargs.get("index") or (call.args[0] if call.args else "")
            self.assertTrue(
                idx.startswith("tabtin-ci-"),
                msg=f"索引 {idx} 未带 CI 前缀，可能硬编码 tabtin-",
            )
        # 返回值里的索引名也要带前缀
        for logical, name in result.items():
            self.assertTrue(
                name.startswith("tabtin-ci-"),
                msg=f"逻辑名 {logical} 返回的实际名 {name} 未带 CI 前缀",
            )

    def test_skips_existing_indices(self) -> None:
        # 假装所有索引都已存在
        all_names = {get_index_name(d["base_name"]) for d in INDEX_DEFINITIONS.values()}
        monthly = get_monthly_index_name("messages")
        client = self._make_client(existing=all_names | {monthly})
        ensure_indices(client)
        # 仍然写 template（保证 mapping 更新）
        client.indices.put_index_template.assert_called_once()
        # create 从未调用
        client.indices.create.assert_not_called()

    def test_monthly_index_handles_race(self) -> None:
        """并发启动时 create 抛 resource_already_exists_exception 不应再升级。"""
        client = MagicMock(name="es-client")
        client.indices = MagicMock()
        client.indices.exists = MagicMock(return_value=False)
        client.indices.create = MagicMock(
            side_effect=Exception("resource_already_exists_exception: foo"),
        )
        out = ensure_monthly_index(client, base="messages")
        self.assertIn("messages-", out)

    def test_monthly_index_raises_on_other_errors(self) -> None:
        client = MagicMock(name="es-client")
        client.indices = MagicMock()
        client.indices.exists = MagicMock(return_value=False)
        client.indices.create = MagicMock(side_effect=RuntimeError("wtf"))
        with self.assertRaises(RuntimeError):
            ensure_monthly_index(client, base="messages")

    def test_ensure_plain_index_does_not_swallow_non_already_exists_errors(self) -> None:
        """磁盘满 / 鉴权失败等非 already_exists 错误必须上抛（Review C1）。"""
        from apps.fts.index_definitions import _ensure_plain_index

        client = MagicMock(name="es-client")
        client.indices = MagicMock()
        client.indices.exists = MagicMock(return_value=False)
        client.indices.create = MagicMock(
            side_effect=Exception("authentication_exception: bad credentials"),
        )
        with self.assertRaises(Exception) as cm:
            _ensure_plain_index(client, base="resources", mapping={})
        self.assertIn("authentication", str(cm.exception))


class ResourceAlreadyExistsDetectionTests(SimpleTestCase):
    """验证 `_is_resource_already_exists` 结构化判断（Review C1）。"""

    def test_structured_bad_request_error(self) -> None:
        from apps.fts.index_definitions import _is_resource_already_exists
        from elasticsearch import BadRequestError

        exc = BadRequestError(
            message="already",
            meta=MagicMock(),
            body={"error": {"type": "resource_already_exists_exception"}},
        )
        self.assertTrue(_is_resource_already_exists(exc))

    def test_other_bad_request_error_is_not_match(self) -> None:
        from apps.fts.index_definitions import _is_resource_already_exists
        from elasticsearch import BadRequestError

        exc = BadRequestError(
            message="invalid",
            meta=MagicMock(),
            body={"error": {"type": "illegal_argument_exception"}},
        )
        self.assertFalse(_is_resource_already_exists(exc))

    def test_generic_exception_fallback_string_match(self) -> None:
        """兜底字符串匹配仅用于非 BadRequestError 场景。"""
        from apps.fts.index_definitions import _is_resource_already_exists

        self.assertTrue(_is_resource_already_exists(
            Exception("resource_already_exists_exception: foo"),
        ))
        self.assertFalse(_is_resource_already_exists(
            Exception("disk full"),
        ))


class FieldFactoryTests(SimpleTestCase):
    """字段工厂必须返回**独立字典实例**，不可共享状态（Review A5）。"""

    def test_keyword_factory_returns_fresh_dict(self) -> None:
        from apps.fts.index_definitions import _keyword

        a = _keyword()
        b = _keyword()
        self.assertIsNot(a, b)
        a["ignore_above"] = 256
        self.assertNotIn("ignore_above", b)

    def test_mapping_fields_do_not_share_instances(self) -> None:
        """同类字段在不同 mapping 里必须是不同对象。"""
        from apps.fts.index_definitions import INDEX_DEFINITIONS

        messages_ws = INDEX_DEFINITIONS["messages"]["mapping"]["properties"]["organization_id"]
        resources_ws = INDEX_DEFINITIONS["resources"]["mapping"]["properties"]["organization_id"]
        # 两者内容一致，但实例不同（防污染）
        self.assertEqual(messages_ws, resources_ws)
        self.assertIsNot(messages_ws, resources_ws)
