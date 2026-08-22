"""AgentMemory 统一检索层测试（ 根因修：自然语言改写不再必空）。

分两层：
  - ``TokenizeQueryTest``：纯函数分词单测（无 DB）。
  - ``KeywordSearchRecallTest``：真实 PostgreSQL 集成——覆盖  的
    验收场景（paraphrase 命中、短 query、空结果、隔离）。走
    ``AgentMemoryRepository.list_page``（HTTP `/agent-memory/memories/`，
    memory_search 工具与 memory-injector 召回共用的读侧）与
    ``AgentMemoryRecall.list_memories``（服务端内部多-agent 管道），两条
    读路径都经 ``apply_keyword_search`` 统一检索层收口。
"""
from __future__ import annotations

import unittest

import pytest
from django.db import connections
from django.test import TransactionTestCase

from apps.agent_memory.models import AgentMemory
from apps.agent_memory.recall import AgentMemoryRecall
from apps.agent_memory.repository import AgentMemoryRepository
from apps.agent_memory.search import (
    MAX_SEARCH_KEYWORDS,
    apply_keyword_search,
    tokenize_query,
)


class TokenizeQueryTest(unittest.TestCase):
    """纯函数分词——不触库，不需要 Django TestCase / PG。"""

    def test_empty_and_stopword_only_query_yields_no_keywords(self):
        self.assertEqual(tokenize_query(""), [])
        self.assertEqual(tokenize_query("   "), [])
        self.assertEqual(tokenize_query("的了吗"), [])
        self.assertEqual(tokenize_query("what is the"), [])

    def test_cjk_paraphrase_shares_bigram_with_source_sentence(self):
        """ 验收例子：记忆「用户每天早上 9 点开晨会」，
        改写问法「我每天有什么固定日程？」——两句分词结果必须有交集
        （"每天" bigram），这正是整句 icontains 修复前必空的根因。"""
        memory_tokens = set(tokenize_query("用户每天早上9点开晨会"))
        query_tokens = set(tokenize_query("我每天有什么固定日程？"))

        overlap = memory_tokens & query_tokens
        self.assertIn("每天", overlap)

    def test_short_cjk_query_kept_as_single_meaningful_token(self):
        # 2 字词本身就是一个 bigram，短查询不会被空过滤掉。
        self.assertEqual(tokenize_query("晨会"), ["晨会"])
        # 单字非停用词保留；停用词单字被过滤。
        self.assertIn("会", tokenize_query("会"))
        self.assertEqual(tokenize_query("吗"), [])

    def test_latin_token_filters_single_char_noise_but_keeps_digits(self):
        tokens = tokenize_query("a 9am standup")
        self.assertNotIn("a", tokens)
        self.assertIn("9am", tokens)
        self.assertIn("standup", tokens)

    def test_long_cjk_query_is_capped_below_orm_recursion_threshold(self):
        """#8912：500 字互异汉字会喷出近 499 个 bigram；必须截断，
        否则 CombinedExpression / WhereNode 递归哈希会 RecursionError。"""
        text = "".join(chr(0x4E00 + i) for i in range(500))
        tokens = tokenize_query(text)
        self.assertEqual(len(tokens), MAX_SEARCH_KEYWORDS)
        self.assertLess(MAX_SEARCH_KEYWORDS, 190)


@pytest.mark.requires_pg_native
class KeywordSearchRecallTest(TransactionTestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        from apps.tabtinspace.tests.fixtures import (
            create_test_agent,
            create_test_organization_with_agent,
            create_test_user,
        )

        connections["postgresql"].close()
        context = create_test_organization_with_agent(prefix="amsearch")
        self.user_a = context["user"]
        self.organization = context["organization"]
        self.agent_a = context["agent"]
        self.service_a = self._service(self.user_a)
        self.scope_a = self.service_a.resolve_scope(
            organization_id=str(self.organization.id),
            agent_id=str(self.agent_a.id),
        )

        self.user_b = create_test_user(prefix="amsearch-b")
        self.agent_b = create_test_agent(
            organization=self.organization,
            owner_user=self.user_a,
            prefix="amsearch-agent-b",
        )

    @staticmethod
    def _service(user):
        from apps.agent_memory.services import AgentMemoryService

        return AgentMemoryService(user)

    def tearDown(self):
        from apps.tabtinspace.models import Organization
        from apps.tabtinspace.tests.fixtures import cleanup_test_organization

        AgentMemory.objects.filter(organization_id=self.organization.id).delete()
        owner_ids = [self.user_a.id, self.user_b.id]
        for org in list(Organization.objects.filter(owner_id__in=owner_ids)):
            cleanup_test_organization(org, delete_user=True)

    def _memory(self, *, agent=None, owner=None, content, title=""):
        return AgentMemory.objects.create(
            organization_id=self.organization.id,
            agent=agent or self.agent_a,
            owner_id=(owner or self.user_a).id,
            memo_type=AgentMemory.MemoType.ABOUT_YOU,
            content_plaintext=content,
            content_markdown=content,
            title=title,
        )

    # ──  验收：改写问法命中（repository.list_page 读侧） ──

    def test_paraphrase_query_hits_via_service_list_memories(self):
        """晨会例子：记忆原句与问法完全不同的改写句子，整句 icontains 必空，
        统一检索层（分词 + bigram 候选 + 打分）必须命中。"""
        memory = self._memory(content="用户每天早上9点开晨会")

        # 回归防线：改写问法在旧行为下确实不是原句子串。
        self.assertNotIn("我每天有什么固定日程", memory.content_plaintext)

        result = self.service_a.list_memories(
            scope=self.scope_a, search="我每天有什么固定日程？",
        )

        self.assertEqual(
            {item["id"] for item in result["items"]}, {str(memory.id)},
        )

    def test_paraphrase_query_hits_via_recall_list_memories(self):
        """同一 paraphrase 场景，走服务端内部多-agent 召回入口
        （AgentMemoryRecall，供 tabmemo_search_memos 等服务端管道复用）。"""
        memory = self._memory(content="用户每天早上9点开晨会")

        result = AgentMemoryRecall.list_memories(
            agent_ids=[str(self.agent_a.id)],
            organization_id=str(self.organization.id),
            owner_id=str(self.user_a.id),
            search="我每天有什么固定日程？",
        )

        ids = {item["id"] for item in result["items"]}
        self.assertEqual(ids, {str(memory.id)})
        #  要求 2：返回可观测分数——命中至少 1 个关键词（"每天"）。
        hit = result["items"][0]
        self.assertIsNotNone(hit["score"])
        self.assertGreaterEqual(hit["score"], 1)

    def test_multi_keyword_hit_scores_higher_than_single_keyword_hit(self):
        """打分策略：命中更多不同关键词的行排在前面（"多关键词命中优先"）。"""
        strong = self._memory(content="用户每天早上9点开晨会，晨会讨论每天的固定日程")
        weak = self._memory(content="用户喜欢喝咖啡")

        result = self.service_a.list_memories(
            scope=self.scope_a, search="我每天有什么固定日程？",
        )

        ids = [item["id"] for item in result["items"]]
        self.assertIn(str(strong.id), ids)
        self.assertNotIn(str(weak.id), ids)

    # ── 短 query ──

    def test_short_meaningful_query_still_matches(self):
        memory = self._memory(content="今天的晨会讨论了发布计划")
        self._memory(content="用户喜欢喝咖啡")

        result = self.service_a.list_memories(scope=self.scope_a, search="晨会")

        self.assertEqual(
            {item["id"] for item in result["items"]}, {str(memory.id)},
        )

    def test_stopword_only_query_falls_back_to_unfiltered_browse(self):
        """search 分词后为空（如纯疑问词）——退化为不过滤，不是"查无结果"。"""
        memory = self._memory(content="用户喜欢喝咖啡")

        result = self.service_a.list_memories(scope=self.scope_a, search="吗")

        self.assertEqual(
            {item["id"] for item in result["items"]}, {str(memory.id)},
        )

    # ── 空结果 ──

    def test_unrelated_query_yields_empty_result(self):
        self._memory(content="用户每天早上9点开晨会")

        result = self.service_a.list_memories(
            scope=self.scope_a, search="太平洋深海鱼类迁徙路线",
        )

        self.assertEqual(result["items"], [])
        self.assertFalse(result["has_more"])

    # ── 隔离：跨 agent / owner 不命中 ──

    def test_search_does_not_cross_agent_boundary(self):
        """同样的关键词命中，但记忆属于另一个 agent——隔离键必须挡住。"""
        self._memory(agent=self.agent_b, content="用户每天早上9点开晨会")

        result = self.service_a.list_memories(
            scope=self.scope_a, search="我每天有什么固定日程？",
        )

        self.assertEqual(result["items"], [])

    def test_search_does_not_cross_owner_boundary_in_recall(self):
        """AgentMemoryRecall 入口：同 agent 下另一 owner 的记忆即便关键词命中也
        不可召回——(agent_id, owner_id, organization) 隔离键必须保留。"""
        self._memory(owner=self.user_b, content="用户每天早上9点开晨会")

        result = AgentMemoryRecall.list_memories(
            agent_ids=[str(self.agent_a.id)],
            organization_id=str(self.organization.id),
            owner_id=str(self.user_a.id),
            search="我每天有什么固定日程？",
        )

        self.assertEqual(result["items"], [])

    def test_repository_list_page_rows_carry_observable_score_attribute(self):
        """repository.list_page 打分路径直接注解在返回行上（不经 services 序列化
        也能观测）——供未来更严格的注入阈值判断复用。"""
        memory = self._memory(content="用户每天早上9点开晨会")

        rows, has_more = AgentMemoryRepository.list_page(
            organization_id=str(self.organization.id),
            agent_id=str(self.agent_a.id),
            subject_user_id=str(self.user_a.id),
            state=AgentMemory.Status.ACTIVE,
            search="我每天有什么固定日程？",
            memory_type="",
            offset=0,
            limit=30,
        )

        self.assertFalse(has_more)
        self.assertEqual([str(r.id) for r in rows], [str(memory.id)])
        self.assertGreaterEqual(getattr(rows[0], "search_score"), 1)

    def test_long_pptx_style_search_does_not_recursion_error(self):
        """Sentry  形态：整段任务原文当 search，合法长度内不得 500。"""
        self._memory(content="公司 AI 分身试点需要管理层汇报材料")
        search = (
            "请制作一份面向公司管理层的《公司 AI 分身试点》PPTX。"
            "必须严格为 6 页：封面、背景、试点目标、三个默认分身、"
            "试点计划、风险与待决策事项。" * 4
        )
        self.assertLessEqual(len(search), 500)

        result = self.service_a.list_memories(scope=self.scope_a, search=search)
        self.assertGreaterEqual(len(result["items"]), 1)
        self.assertIsNotNone(result["items"][0]["score"])

    def test_capped_keyword_queryset_compiles_without_recursion(self):
        """#8615：64 个 CJK token 的 OR 树必须能真正 list()，不能只靠截断推断。"""
        self._memory(content="公司")
        text = "".join(chr(0x4E00 + i) for i in range(500))
        queryset = apply_keyword_search(
            AgentMemory.objects.filter(organization_id=self.organization.id),
            text,
        )
        list(queryset[:5])
