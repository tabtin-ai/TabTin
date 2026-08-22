"""
EQ-015 & EQ-016 回归测试

EQ-015：get_all_local_agent_organization_ids 正确返回所有含 user 来源的 organization_id
EQ-016：_build_content_text 纳入 parameters 语义信息

#7118：租户键从 space_id 换到 organization_id；SkillEmbedding 的权威列改成 organization_id，
       metadata 与顶层字段同步。

运行：
    cd apps/tabtin_django
    python manage.py test apps.skills.tests.test_eq015_eq016_embedding --verbosity=1 --no-input
"""

from __future__ import annotations

import uuid
from unittest.mock import patch, MagicMock

from django.test import TestCase


FAKE_VECTOR = [0.0] * 1024  # W7: 对齐 RAG_EMBEDDING_DIMENSIONS=1024


def _create_skill_embedding(skill_key, source="system", organization_id=None):
    """#7118: SkillEmbedding.organization_id 是权威租户键（原生 UUIDField）。"""
    from apps.rag.models import SkillEmbedding

    metadata: dict = {"name": skill_key, "description": f"desc for {skill_key}"}
    if organization_id:
        metadata["organization_id"] = str(organization_id)

    org_uuid = None
    if organization_id:
        try:
            org_uuid = uuid.UUID(str(organization_id))
        except (ValueError, TypeError):
            org_uuid = None

    return SkillEmbedding.objects.create(
        skill_key=skill_key,
        source=source,
        content=f"content for {skill_key}",
        content_hash=uuid.uuid4().hex[:64],
        embedding=FAKE_VECTOR,
        metadata=metadata,
        organization_id=org_uuid,
    )


# ─────────────────────────────────────────────────────────────
# EQ-016：_build_content_text 参数语义信息
# ─────────────────────────────────────────────────────────────

class BuildContentTextParametersTest(TestCase):
    """EQ-016 回归：_build_content_text 正确追加参数信息。"""

    def _build(self, name, description, tags=None, parameters=None):
        from apps.skills.services.embedding_service import _build_content_text
        return _build_content_text(name, description, tags, parameters)

    def test_no_parameters_returns_baseline(self):
        text = self._build("MySkill", "Does stuff", tags=["a", "b"])
        self.assertIn("MySkill", text)
        self.assertIn("Does stuff", text)
        self.assertIn("tags: a, b", text)
        self.assertNotIn("参数:", text)

    def test_parameters_with_name_type_description(self):
        params = [
            {"name": "url", "type": "string", "description": "目标网址"},
            {"name": "depth", "type": "int", "description": "爬取深度"},
        ]
        text = self._build("Crawler", "网页抓取", parameters=params)
        self.assertIn("参数:", text)
        self.assertIn("url(string): 目标网址", text)
        self.assertIn("depth(int): 爬取深度", text)

    def test_parameters_with_name_only(self):
        params = [{"name": "query"}]
        text = self._build("Search", "搜索工具", parameters=params)
        self.assertIn("参数:", text)
        self.assertIn("query", text)

    def test_parameters_with_type_no_description(self):
        params = [{"name": "limit", "type": "int"}]
        text = self._build("Paginate", "分页", parameters=params)
        self.assertIn("limit(int)", text)

    def test_parameters_with_description_no_type(self):
        params = [{"name": "token", "description": "访问令牌"}]
        text = self._build("Auth", "认证", parameters=params)
        self.assertIn("token: 访问令牌", text)

    def test_empty_parameters_list(self):
        text = self._build("Empty", "空参数", parameters=[])
        self.assertNotIn("参数:", text)

    def test_parameters_with_none_name_skipped(self):
        params = [
            {"name": None, "type": "string"},
            {"name": "valid_param", "type": "bool"},
        ]
        text = self._build("Partial", "部分有效参数", parameters=params)
        self.assertIn("valid_param(bool)", text)
        self.assertNotIn("None", text)

    def test_non_dict_parameters_skipped(self):
        params = ["not_a_dict", None, {"name": "ok", "type": "string"}]
        text = self._build("Mixed", "混合参数", parameters=params)
        self.assertIn("ok(string)", text)

    def test_parameters_appended_after_tags(self):
        params = [{"name": "x", "type": "float"}]
        text = self._build("A", "B", tags=["t1"], parameters=params)
        tag_pos = text.index("tags:")
        param_pos = text.index("参数:")
        self.assertGreater(param_pos, tag_pos, "参数应追加在 tags 之后")

    def test_parameters_use_input_schema_alias(self):
        """input_schema 格式（name/type/description）可直接传给 _build_content_text。"""
        input_schema = [
            {"name": "file_path", "type": "string", "description": "文件路径"},
        ]
        text = self._build("FileReader", "读取文件", parameters=input_schema)
        self.assertIn("file_path(string): 文件路径", text)


class IndexSkillParametersTest(TestCase):
    """EQ-016 回归：index_skill 接受并传递 parameters。

    ：source canonical → platform/app/device/user；``system`` 已废（fallback
    到 user 会强制要求 organization_id）。这里用 ``platform`` 表达无租户的系统级技能。
    """

    databases = "__all__"

    @patch("apps.services.llm.services.embedding.embed_text")
    def test_index_skill_with_parameters_updates_content(self, mock_embed):
        from apps.skills.services.embedding_service import SkillEmbeddingService
        from apps.rag.models import SkillEmbedding

        mock_embed.return_value = MagicMock(vectors=[FAKE_VECTOR])

        params = [{"name": "url", "type": "string", "description": "目标 URL"}]
        result = SkillEmbeddingService.index_skill(
            skill_key="test_skill_params",
            name="TestSkill",
            description="测试技能",
            source="platform",
            parameters=params,
        )

        self.assertTrue(result)
        record = SkillEmbedding.objects.get(skill_key="test_skill_params")
        self.assertIn("url(string): 目标 URL", record.content)
        self.assertIn("参数:", record.content)

    @patch("apps.services.llm.services.embedding.embed_text")
    def test_index_skill_without_parameters_no_params_in_content(self, mock_embed):
        from apps.skills.services.embedding_service import SkillEmbeddingService
        from apps.rag.models import SkillEmbedding

        mock_embed.return_value = MagicMock(vectors=[FAKE_VECTOR])

        SkillEmbeddingService.index_skill(
            skill_key="test_skill_no_params",
            name="NoParamSkill",
            description="无参数技能",
            source="platform",
        )

        record = SkillEmbedding.objects.get(skill_key="test_skill_no_params")
        self.assertNotIn("参数:", record.content)


class IndexEntriesInputSchemaTest(TestCase):
    """EQ-016 回归：_index_entries 从 input_schema 提取 parameters。"""

    databases = "__all__"

    @patch("apps.skills.services.embedding_service.SkillEmbeddingService.index_skill")
    def test_index_entries_passes_input_schema_as_parameters(self, mock_index):
        from apps.skills.services.embedding_service import SkillEmbeddingService

        mock_index.return_value = True

        input_schema = [{"name": "q", "type": "string", "description": "搜索词"}]
        entries = [
            {
                "skill_key": "skill_with_schema",
                "name": "HasSchema",
                "description": "有 input_schema",
                "source": "managed",
                "input_schema": input_schema,
            }
        ]
        SkillEmbeddingService._index_entries(entries)

        mock_index.assert_called_once()
        call_kwargs = mock_index.call_args[1]
        self.assertEqual(call_kwargs["parameters"], input_schema)

    @patch("apps.skills.services.embedding_service.SkillEmbeddingService.index_skill")
    def test_index_entries_prefers_parameters_over_input_schema(self, mock_index):
        from apps.skills.services.embedding_service import SkillEmbeddingService

        mock_index.return_value = True

        parameters = [{"name": "explicit", "type": "bool"}]
        input_schema = [{"name": "fallback", "type": "string"}]
        entries = [
            {
                "skill_key": "skill_prefer_params",
                "name": "PreferParams",
                "description": "优先 parameters",
                "source": "system",
                "parameters": parameters,
                "input_schema": input_schema,
            }
        ]
        SkillEmbeddingService._index_entries(entries)

        call_kwargs = mock_index.call_args[1]
        self.assertEqual(call_kwargs["parameters"], parameters)

    @patch("apps.skills.services.embedding_service.SkillEmbeddingService.index_skill")
    def test_index_entries_no_schema_passes_none(self, mock_index):
        from apps.skills.services.embedding_service import SkillEmbeddingService

        mock_index.return_value = True

        entries = [
            {
                "skill_key": "skill_no_schema",
                "name": "NoSchema",
                "description": "无 schema",
                "source": "app",
            }
        ]
        SkillEmbeddingService._index_entries(entries)

        call_kwargs = mock_index.call_args[1]
        self.assertIsNone(call_kwargs["parameters"])


# ─────────────────────────────────────────────────────────────
# EQ-015：get_all_local_agent_organization_ids
# ─────────────────────────────────────────────────────────────

class GetAllLocalAgentWorkspaceIdsTest(TestCase):
    """EQ-015 回归：get_all_local_agent_organization_ids 正确返回所有 organization_id。"""

    databases = "__all__"

    def test_returns_all_distinct_organization_ids(self):
        """#7118: get_all_local_agent_organization_ids 按 source='user' +
        organization_id 是 UUID 过滤（租户键从 space_id 换到 organization_id）。
        """
        from apps.skills.services.embedding_service import SkillEmbeddingService

        org_a = str(uuid.uuid4())
        org_b = str(uuid.uuid4())
        _create_skill_embedding("la-ws1-a", source="user", organization_id=org_a)
        _create_skill_embedding("la-ws1-b", source="user", organization_id=org_a)
        _create_skill_embedding("la-ws2-a", source="user", organization_id=org_b)
        _create_skill_embedding("sys-global", source="system")

        organization_ids = SkillEmbeddingService.get_all_local_agent_organization_ids()

        self.assertIn(org_a, organization_ids)
        self.assertIn(org_b, organization_ids)
        self.assertNotIn(None, organization_ids)
        self.assertNotIn("", organization_ids)
        # 去重:同 organization 只对应一项。
        self.assertEqual(len(set(organization_ids)), len({org_a, org_b}))

    def test_excludes_non_local_agent_sources(self):
        """#7118: source canonical → platform/app/user；platform/system 类不返回。"""
        from apps.skills.services.embedding_service import SkillEmbeddingService

        _create_skill_embedding("sys-a", source="system")
        _create_skill_embedding("market-a", source="market")
        _create_skill_embedding("managed-a", source="managed")

        organization_ids = SkillEmbeddingService.get_all_local_agent_organization_ids()
        self.assertEqual(organization_ids, [])

    def test_returns_empty_when_no_local_agent_skills(self):
        from apps.skills.services.embedding_service import SkillEmbeddingService

        organization_ids = SkillEmbeddingService.get_all_local_agent_organization_ids()
        self.assertIsInstance(organization_ids, list)
        self.assertEqual(organization_ids, [])

    def test_filters_out_none_organization_id(self):
        """#7118: organization_id 为 None 的 user 记录不应出现在结果中。"""
        from apps.skills.services.embedding_service import SkillEmbeddingService
        from apps.rag.models import SkillEmbedding

        SkillEmbedding.objects.create(
            skill_key="la-no-org",
            source="user",
            content="test",
            content_hash=uuid.uuid4().hex[:64],
            embedding=FAKE_VECTOR,
            metadata={},  # 无 organization_id
        )
        org_ok = str(uuid.uuid4())
        _create_skill_embedding("la-ws-ok", source="user", organization_id=org_ok)

        organization_ids = SkillEmbeddingService.get_all_local_agent_organization_ids()
        self.assertIn(org_ok, organization_ids)
        self.assertNotIn(None, organization_ids)
        self.assertNotIn("", organization_ids)
