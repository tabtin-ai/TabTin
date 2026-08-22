"""分家前后召回等价对照测试（ M4.5/C5 整改项 3；#4118 W5 迁入领域）。

分家前召回语义：``GET /tabmemo/memos/?source=agent&space_id=X`` 按 space
维度过滤——该 space 里**任何** agent 蒸馏的记忆都可见（含团队协作会话
直挂的非 1:1 执行分身写入的行，因为旧行带 space_id）。

分家后行只挂 agent_id。等价覆盖 = ``AgentMemoryRecall.resolve_recall_agent_ids``：
space 1:1 agent ∪ 该 space 历史会话直挂过的 agent（distinct）。

#4118 W5：召回逻辑随 TabMemo 彻底解耦迁入 ``apps.agent_memory.recall``，
本测试同步迁入领域测试目录。谓词一致性（``source=='agent'`` 唯一，手写行
留 Memo 表按笔记读回）见 ``apps/tabmemo/tests/test_memo_agent_id_write_path.py``。
"""
import pytest
from django.db import connections
from django.test import TransactionTestCase

from apps.agent_memory.models import AgentMemory
from apps.agent_memory.recall import AgentMemoryRecall
from apps.agent_memory.repository import AgentMemoryRepository
from apps.tabmemo.models import Memo


pytestmark = pytest.mark.requires_pg_native


class RecallEquivalenceTest(TransactionTestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        from apps.tabtinspace.tests.fixtures import (
            create_test_agent,
            create_test_organization_with_agent,
        )

        connections["postgresql"].close()
        ctx = create_test_organization_with_agent(prefix="recalleq")
        self.user = ctx["user"]
        self.organization = ctx["organization"]
        self.agent_a = ctx["agent"]          # space 1:1 执行分身
        self.space = ctx["space"]
        # 同 org 的另外两个 agent：B 曾在本 space 会话直挂，C 无关
        self.agent_b = create_test_agent(
            organization=self.organization, prefix="recalleqB", owner_user=self.user,
        )
        self.agent_c = create_test_agent(
            organization=self.organization, prefix="recalleqC", owner_user=self.user,
        )

        from apps.chat.conversation.models import ChatSession
        self.session_b = ChatSession.objects.create(
            user=self.user,
            organization_id=str(self.organization.id),
            space=self.space,
            agent=self.agent_b,
            title="direct-agent session",
        )

        def _mem(agent, text):
            return AgentMemoryRepository.create(
                agent_id=str(agent.id),
                organization_id=str(self.organization.id),
                owner_id=str(self.user.id),
                memo_type="about_you",
                content_markdown=text,
            )

        self.mem_a = _mem(self.agent_a, "memory from 1:1 agent")
        self.mem_b = _mem(self.agent_b, "memory from session-bound agent")
        self.mem_c = _mem(self.agent_c, "memory from unrelated agent")

    def tearDown(self):
        from apps.tabtinspace.tests.fixtures import cleanup_test_organization

        AgentMemory.objects.all().delete()
        Memo.objects.all().delete()
        self.session_b.delete()
        cleanup_test_organization(self.organization, delete_user=True)

    # ── 等价覆盖：分家前 space 维度可见集 == 分家后 agent 并集可见集 ──

    def test_resolve_recall_agent_ids_covers_session_bound_agents(self):
        agent_ids = AgentMemoryRecall.resolve_recall_agent_ids(self.space.id)
        self.assertEqual(
            set(agent_ids),
            {str(self.agent_a.id), str(self.agent_b.id)},
            "召回 agent 集应含 space 1:1 分身与会话直挂分身，不含无关 agent",
        )

    def test_list_memories_matches_pre_split_space_scope(self):
        """分家前按 space 过滤 source=agent 应召回 {A行, B行}；分家后等价。"""
        result = AgentMemoryRecall.list_memories(
            agent_ids=AgentMemoryRecall.resolve_recall_agent_ids(self.space.id),
            organization_id=str(self.organization.id),
            owner_id=str(self.user.id),
        )
        recalled_ids = {entry["id"] for entry in result["items"]}
        self.assertEqual(
            recalled_ids,
            {str(self.mem_a.id), str(self.mem_b.id)},
            "会话直挂分身的记忆必须可召回（分家前语义）；无关 agent 的不可见",
        )
