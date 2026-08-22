from __future__ import annotations

import pytest
from django.db import connections
from django.test import RequestFactory, TransactionTestCase

from apps.agent_memory.error_codes import ErrorCode, ServiceError
from apps.agent_memory.models import AgentMemory
from apps.agent_memory.repository import AgentMemoryRepository
from apps.agent_memory.services import AgentMemoryService


pytestmark = pytest.mark.requires_pg_native


class AgentMemoryDomainTest(TransactionTestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        from apps.tabtinspace.models import OrganizationMember
        from apps.tabtinspace.tests.fixtures import (
            create_test_agent,
            create_test_organization_with_agent,
            create_test_user,
        )

        connections["postgresql"].close()
        context = create_test_organization_with_agent(prefix="amdomain")
        self.user_a = context["user"]
        self.organization = context["organization"]
        self.agent_a = context["agent"]
        self.space = context["space"]
        # user_b 是同组织的另一名成员（viewer）。用来验「同 Agent 下他人
        # subject 的记忆对 user_a 不可见」以及「直挂访问需 Agent 归属」。
        # 注意：本波后端只支持「Agent owner / 个人 workspace owner」解析记忆
        # scope；团队 Space 多用户读路径尚未接线（见汇报的接口约定），故
        # 不给 user_b 造私有 workspace 的 SpaceMembership（那是不支持的场景）。
        self.user_b = create_test_user(prefix="amdomain-b")
        OrganizationMember.objects.create(
            organization=self.organization,
            user_id=self.user_b.id,
            role="viewer",
        )
        self.agent_b = create_test_agent(
            organization=self.organization,
            owner_user=self.user_a,
            prefix="amdomain-agent-b",
        )
        self.service_a = AgentMemoryService(self.user_a)
        self.scope_a = self.service_a.resolve_scope(
            organization_id=str(self.organization.id),
            agent_id=str(self.agent_a.id),
        )

    def tearDown(self):
        from apps.tabtinspace.models import Organization
        from apps.tabtinspace.tests.fixtures import cleanup_test_organization

        AgentMemory.objects.filter(organization_id=self.organization.id).delete()
        # create_test_user 触发 create_default_organization 信号，为 user_a /
        # user_b 各自建了个人组织（Organization.owner 是 PROTECT FK）。逐个
        # 级联清理其名下所有组织（含主组织与自动建的个人组织），delete_user
        # 只在该 user 已无组织残留时才真正删，避免 ProtectedError。
        owner_ids = [self.user_a.id, self.user_b.id]
        for org in list(
            Organization.objects.filter(owner_id__in=owner_ids)
        ):
            cleanup_test_organization(org, delete_user=True)

    def _memory(self, *, agent=None, owner=None, content="memory"):
        return AgentMemory.objects.create(
            organization_id=self.organization.id,
            agent=agent or self.agent_a,
            owner_id=(owner or self.user_a).id,
            memo_type=AgentMemory.MemoType.ABOUT_YOU,
            content_plaintext=content,
            content_markdown=content,
        )

    def test_same_agent_two_subjects_are_isolated(self):
        """同一 Agent 下不同 subject（owner）互不可见——归属键含 owner_id。

        团队 Space 里多个用户与同一执行分身交互会在同一 agent 下产生不同
        owner 的行；隔离由仓储层 ``(org, agent, subject_user)`` 强制过滤兜底，
        而 ``resolve_scope`` 永远把 subject 钉成当前登录用户。
        """
        memory_a = self._memory(owner=self.user_a, content="subject-a")
        memory_b = self._memory(owner=self.user_b, content="subject-b")

        # 服务层：user_a 的 scope 只召回自己的 subject 行，不见 user_b 的行。
        result_a = self.service_a.list_memories(scope=self.scope_a)
        self.assertEqual(
            {item["id"] for item in result_a["items"]},
            {str(memory_a.id)},
        )

        # 仓储层不变量：owner 维度双向隔离（团队多 subject 落同一 agent 时
        # 的读隔离基准）。
        rows_b = AgentMemoryRepository.scoped(
            organization_id=str(self.organization.id),
            agent_id=str(self.agent_a.id),
            subject_user_id=str(self.user_b.id),
        )
        self.assertEqual({str(row.id) for row in rows_b}, {str(memory_b.id)})
        rows_a = AgentMemoryRepository.scoped(
            organization_id=str(self.organization.id),
            agent_id=str(self.agent_a.id),
            subject_user_id=str(self.user_a.id),
        )
        self.assertEqual({str(row.id) for row in rows_a}, {str(memory_a.id)})

    def test_same_subject_two_agents_are_isolated(self):
        memory_a = self._memory(agent=self.agent_a, content="agent-a")
        self._memory(agent=self.agent_b, content="agent-b")

        result = self.service_a.list_memories(scope=self.scope_a)

        self.assertEqual(
            {item["id"] for item in result["items"]},
            {str(memory_a.id)},
        )

    def test_direct_agent_access_requires_agent_owner(self):
        service_b = AgentMemoryService(self.user_b)

        with self.assertRaises(ServiceError) as captured:
            service_b.resolve_scope(
                organization_id=str(self.organization.id),
                agent_id=str(self.agent_a.id),
            )

        self.assertEqual(captured.exception.code, ErrorCode.AGENT_ACCESS_DENIED)
        self.assertEqual(captured.exception.status, 403)

    def test_service_rejects_forged_subject_scope(self):
        forged_scope = type(self.scope_a)(
            organization_id=self.scope_a.organization_id,
            agent_id=self.scope_a.agent_id,
            subject_user_id=str(self.user_b.id),
        )

        with self.assertRaises(ServiceError) as captured:
            self.service_a.list_memories(scope=forged_scope)

        self.assertEqual(captured.exception.code, ErrorCode.PERMISSION_DENIED)

    def test_correct_preserves_provenance_and_forget_hides_content(self):
        original = self._memory(content="old fact")

        replacement = self.service_a.correct(
            scope=self.scope_a,
            memory_id=str(original.id),
            content="correct fact",
        )
        original.refresh_from_db()
        self.assertEqual(original.status, AgentMemory.Status.ARCHIVED)
        self.assertEqual(replacement.supersedes_id, original.id)
        self.assertEqual(replacement.status, AgentMemory.Status.ACTIVE)

        # 纠正后：默认（active）召回只见替代事实，旧事实不再召回。
        recalled = self.service_a.list_memories(scope=self.scope_a)
        recalled_ids = {item["id"] for item in recalled["items"]}
        self.assertIn(str(replacement.id), recalled_ids)
        self.assertNotIn(str(original.id), recalled_ids)

        changed = self.service_a.forget(
            scope=self.scope_a,
            memory_id=str(replacement.id),
        )
        self.assertTrue(changed)
        replacement.refresh_from_db()
        self.assertIsNotNone(replacement.forgotten_at)
        self.assertEqual(replacement.status, AgentMemory.Status.ARCHIVED)
        self.assertFalse(
            AgentMemoryRepository.scoped(
                organization_id=str(self.organization.id),
                agent_id=str(self.agent_a.id),
                subject_user_id=str(self.user_a.id),
            ).filter(id=replacement.id).exists()
        )
        with self.assertRaises(ServiceError) as captured:
            self.service_a.get_memory(
                scope=self.scope_a,
                memory_id=str(replacement.id),
            )
        self.assertEqual(captured.exception.code, ErrorCode.MEMORY_NOT_FOUND)

    def test_record_respects_privacy_master_switch(self):
        """record 与自动蒸馏同口径过隐私总闸——「全部关闭」后显式写入也拒绝。"""
        from unittest.mock import patch

        # 默认开（查无 record_style 配置 → enabled=True）：record 成功。
        memory = self.service_a.record(
            scope=self.scope_a,
            memory_type=AgentMemory.MemoType.ABOUT_YOU,
            content="用户偏好深色主题",
        )
        self.assertEqual(str(memory.owner_id), str(self.user_a.id))

        before = AgentMemory.objects.filter(
            organization_id=self.organization.id
        ).count()
        with patch(
            "apps.tabmemo.services.record_style_service.resolve_record_preference",
            return_value=(False, ""),
        ):
            with self.assertRaises(ServiceError) as captured:
                self.service_a.record(
                    scope=self.scope_a,
                    memory_type=AgentMemory.MemoType.ABOUT_YOU,
                    content="总闸关闭时不应写入",
                )
        self.assertEqual(captured.exception.code, ErrorCode.RECORD_DISABLED)
        self.assertEqual(
            AgentMemory.objects.filter(organization_id=self.organization.id).count(),
            before,
        )

    def test_adjust_importance_absolute_and_useful_feedback(self):
        """importance 端点：绝对设定 + 「有用/不有用」增减一档（1-5 夹取）。"""
        memory = self._memory(content="importance-target")
        self.assertIsNone(memory.importance)

        # 绝对设定
        updated = self.service_a.adjust_importance(
            scope=self.scope_a, memory_id=str(memory.id), importance=4,
        )
        self.assertEqual(updated.importance, 4)

        # useful=True 上调一档 + 累计 access_count
        bumped = self.service_a.adjust_importance(
            scope=self.scope_a, memory_id=str(memory.id), useful=True,
        )
        self.assertEqual(bumped.importance, 5)
        self.assertEqual(bumped.access_count, 1)

        # 已封顶后再 useful=True 保持 5（夹取）
        capped = self.service_a.adjust_importance(
            scope=self.scope_a, memory_id=str(memory.id), useful=True,
        )
        self.assertEqual(capped.importance, 5)

        # useful=False 下调一档
        lowered = self.service_a.adjust_importance(
            scope=self.scope_a, memory_id=str(memory.id), useful=False,
        )
        self.assertEqual(lowered.importance, 4)

    def test_adjust_importance_rejects_out_of_range(self):
        memory = self._memory(content="range-check")
        with self.assertRaises(ServiceError) as captured:
            self.service_a.adjust_importance(
                scope=self.scope_a, memory_id=str(memory.id), importance=9,
            )
        self.assertEqual(captured.exception.code, ErrorCode.INVALID_CONTENT)

    def test_adjust_importance_rejects_forgotten_and_cross_agent(self):
        """importance 反馈拒绝：已忘记行 / 他人 Agent 的行都当作不可访问（404）。"""
        forgotten = self._memory(content="forgotten-target")
        self.service_a.forget(scope=self.scope_a, memory_id=str(forgotten.id))
        with self.assertRaises(ServiceError) as captured:
            self.service_a.adjust_importance(
                scope=self.scope_a, memory_id=str(forgotten.id), useful=True,
            )
        self.assertEqual(captured.exception.code, ErrorCode.MEMORY_NOT_FOUND)

        # 其它 Agent 的记忆：当前 scope（agent_a）看不到，视为不存在。
        other_agent_memory = self._memory(agent=self.agent_b, content="agent-b-mem")
        with self.assertRaises(ServiceError) as captured2:
            self.service_a.adjust_importance(
                scope=self.scope_a, memory_id=str(other_agent_memory.id), importance=3,
            )
        self.assertEqual(captured2.exception.code, ErrorCode.MEMORY_NOT_FOUND)

    def test_read_side_respects_privacy_master_switch(self):
        """#4094 读侧总闸：关闭后 list/stats/get 一律 fail-closed（空 / 404），
        不泄漏任何既有记忆内容——与画像 GET 门控对称。"""
        from unittest.mock import patch

        self._memory(owner=self.user_a, content="secret-1")
        self._memory(owner=self.user_a, content="secret-2")

        # 开启态（默认）：能读到 2 条。
        open_result = self.service_a.list_memories(scope=self.scope_a)
        self.assertEqual(len(open_result["items"]), 2)
        one_id = open_result["items"][0]["id"]

        with patch(
            "apps.tabmemo.services.record_style_service.resolve_record_preference",
            return_value=(False, ""),
        ):
            gated_list = self.service_a.list_memories(scope=self.scope_a)
            self.assertEqual(gated_list["items"], [])
            self.assertFalse(gated_list["has_more"])

            gated_stats = self.service_a.stats(scope=self.scope_a)
            self.assertEqual(gated_stats["total"], 0)
            for memo_type in AgentMemory.MemoType.values:
                self.assertEqual(gated_stats[memo_type], 0)

            with self.assertRaises(ServiceError) as captured:
                self.service_a.get_memory(scope=self.scope_a, memory_id=one_id)
            self.assertEqual(captured.exception.code, ErrorCode.MEMORY_NOT_FOUND)

    def test_correct_respects_privacy_master_switch(self):
        """correct 归档原行 + 新建替代行（写入新内容 = 记）→ 与 record 同口径过总闸；
        关闭时拒绝，且原行保持不变（不误归档）。forget 仍放行（删除类）。"""
        from unittest.mock import patch

        original = self._memory(content="待更正的事实")
        before = AgentMemory.objects.filter(
            organization_id=self.organization.id
        ).count()

        with patch(
            "apps.tabmemo.services.record_style_service.resolve_record_preference",
            return_value=(False, ""),
        ):
            with self.assertRaises(ServiceError) as captured:
                self.service_a.correct(
                    scope=self.scope_a,
                    memory_id=str(original.id),
                    content="总闸关闭时不应新建替代行",
                )
        self.assertEqual(captured.exception.code, ErrorCode.RECORD_DISABLED)
        original.refresh_from_db()
        # 原行未被归档、未新增替代行（correct 原子性 + gate 在写入前拦截）。
        self.assertEqual(original.status, AgentMemory.Status.ACTIVE)
        self.assertEqual(
            AgentMemory.objects.filter(organization_id=self.organization.id).count(),
            before,
        )

    def test_stats_by_type_is_subject_and_agent_scoped(self):
        self._memory(owner=self.user_a, content="a1")
        self._memory(owner=self.user_a, content="a2")
        AgentMemory.objects.create(
            organization_id=self.organization.id,
            agent=self.agent_a,
            owner_id=self.user_a.id,
            memo_type=AgentMemory.MemoType.INSIGHT,
            content_plaintext="i1",
            content_markdown="i1",
        )
        # 他人 subject / 其它 agent 的行绝不计入本 scope 统计
        self._memory(owner=self.user_b, content="other-subject")
        self._memory(agent=self.agent_b, owner=self.user_a, content="other-agent")

        stats = self.service_a.stats(scope=self.scope_a)

        self.assertEqual(stats["about_you"], 2)
        self.assertEqual(stats["insight"], 1)
        self.assertEqual(stats["task_summary"], 0)
        self.assertEqual(stats["total"], 3)

    def test_list_limit_is_capped_and_dto_has_no_memo_asset_fields(self):
        AgentMemory.objects.bulk_create(
            [
                AgentMemory(
                    organization_id=self.organization.id,
                    agent=self.agent_a,
                    owner_id=self.user_a.id,
                    memo_type=AgentMemory.MemoType.INSIGHT,
                    content_plaintext=f"bounded-{index}",
                    content_markdown=f"bounded-{index}",
                )
                for index in range(101)
            ]
        )

        result = self.service_a.list_memories(scope=self.scope_a, limit=1000)

        self.assertEqual(result["limit"], 100)
        self.assertEqual(len(result["items"]), 100)
        self.assertTrue(result["has_more"])
        self.assertNotEqual(result["next_cursor"], "")
        forbidden_fields = {"color", "collection_id", "is_trashed", "source"}
        self.assertTrue(forbidden_fields.isdisjoint(result["items"][0]))

    def test_serialize_dto_matches_memory_out_schema(self):
        """W2b 契约守卫：``serialize()`` 输出的键集必须与 ``MemoryOut`` schema 字段一致。

        /agent-memory 端点 response 声明为 catch-all dict（Ninja 不强校验），Runtime
        直连的是 ``serialize()`` 的手写 dict——这里断言两者字段严格对齐，任一漂移即红，
        避免 W2b 对着过时契约对接。
        """
        from apps.agent_memory.schemas import MemoryOut

        memory = self._memory(owner=self.user_a, content="dto-contract")
        dto = self.service_a.serialize(memory)
        self.assertEqual(set(dto.keys()), set(MemoryOut.model_fields.keys()))
        # 且不含 Memo 用户笔记资产字段（伪字段防回归）
        forbidden = {"color", "collection_id", "is_trashed", "source", "access_count"}
        self.assertTrue(forbidden.isdisjoint(dto.keys()))

    def test_legacy_agent_route_no_longer_returns_agent_memory(self):
        """#4118 W5 终态：旧 ``/tabmemo/memos?source=agent`` 已与 Agent 记忆彻底
        解耦——即便同 agent 下存在本人 / 他人 subject 的记忆行，TabMemo 列表也
        一律返回空。Agent 记忆读取统一走 /agent-memory 领域端点，subject 隔离由
        ``resolve_scope`` 在那里强制（见本类的 scope / subject 隔离用例），从而
        彻底杜绝任何经旧路径的泄漏（ 的更强终态）。
        """
        self._memory(owner=self.user_a, content="legacy-a")
        self._memory(owner=self.user_b, content="legacy-b")
        request = RequestFactory().get("/api/tabmemo/memos/")
        request.auth = self.user_a

        from apps.tabmemo.api import list_memos

        response = list_memos(
            request,
            organization_id=str(self.organization.id),
            space_id=str(self.space.id),
            source="agent",
        )

        self.assertTrue(response["success"])
        self.assertEqual(response["data"]["items"], [])

    # ── feedback 端点 HTTP 层集成（ W5：W3 只覆盖 service 级） ──

    def _feedback_endpoint(self, memory_id, **payload_kwargs):
        """直调 ``POST /agent-memory/memories/{id}/feedback/`` 端点函数。

        走真实 schema 校验 + 端点鉴权 + ServiceError→HTTP 映射，补齐
        W3 只测 ``service.adjust_importance`` 的 HTTP 层缺口。
        """
        from apps.agent_memory.api import feedback_memory
        from apps.agent_memory.schemas import MemoryFeedbackRequest

        request = RequestFactory().post(
            f"/api/agent-memory/memories/{memory_id}/feedback/"
        )
        request.auth = self.user_a
        payload = MemoryFeedbackRequest(
            organization_id=str(self.organization.id),
            agent_id=str(self.agent_a.id),
            **payload_kwargs,
        )
        return feedback_memory(request, str(memory_id), payload)

    def test_feedback_endpoint_sets_absolute_importance(self):
        memory = self._memory(content="feedback-abs")
        memory.importance = 2
        memory.save(update_fields=["importance"])

        response = self._feedback_endpoint(memory.id, importance=5)

        self.assertTrue(response["success"])
        self.assertEqual(response["data"]["importance"], 5)
        self.assertEqual(response["data"]["id"], str(memory.id))
        memory.refresh_from_db()
        self.assertEqual(memory.importance, 5)

    def test_feedback_endpoint_useful_bumps_importance_and_access(self):
        memory = self._memory(content="feedback-useful")
        memory.importance = 3
        memory.access_count = 0
        memory.save(update_fields=["importance", "access_count"])

        response = self._feedback_endpoint(memory.id, useful=True)

        self.assertTrue(response["success"])
        self.assertEqual(response["data"]["importance"], 4)
        memory.refresh_from_db()
        self.assertEqual(memory.importance, 4)
        self.assertEqual(memory.access_count, 1)

    def test_feedback_endpoint_forgotten_returns_404(self):
        """forgotten 行经端点反馈映射为 404（读侧不可达行不可反馈）。"""
        memory = self._memory(content="feedback-forgotten")
        self.service_a.forget(scope=self.scope_a, memory_id=str(memory.id))

        response = self._feedback_endpoint(memory.id, useful=True)

        # ServiceError → error_response_with_status；非 success envelope
        self.assertEqual(getattr(response, "status_code", None), 404)

    def test_feedback_endpoint_cross_subject_denied(self):
        """他人 subject 的记忆经端点反馈映射为 404（归属三键强隔离）。"""
        others = self._memory(owner=self.user_b, content="feedback-other-subject")

        response = self._feedback_endpoint(others.id, importance=4)

        self.assertEqual(getattr(response, "status_code", None), 404)
        others.refresh_from_db()
        self.assertIsNone(others.importance)

    def test_portrait_collects_agent_memory_without_old_memo_enum(self):
        included = self._memory(owner=self.user_a, content="portrait-memory")
        self._memory(agent=self.agent_b, owner=self.user_a, content="other-agent")
        self._memory(owner=self.user_b, content="other-subject")

        from apps.user_portrait.services.distill_service import PortraitDistillService

        service = PortraitDistillService(
            user=self.user_a,
            organization_id=str(self.organization.id),
            agent_id=str(self.agent_a.id),
        )
        rows, total, truncated = service._collect_new_memos(since=None)

        self.assertEqual(total, 1)
        self.assertEqual(truncated, 0)
        # _collect_new_memos 把类型前缀进 content（"(about_you) ..."）；
        # 关键断言是「只取到本 (agent, owner, org) 的那条画像原料」。
        self.assertEqual(len(rows), 1)
        self.assertIn(included.content_markdown, rows[0]["content"])

    def test_portrait_without_agent_fails_closed(self):
        self._memory(owner=self.user_a, content="must-not-cross-agent")

        from apps.user_portrait.services.distill_service import PortraitDistillService

        service = PortraitDistillService(
            user=self.user_a,
            organization_id=str(self.organization.id),
        )
        rows, total, truncated = service._collect_new_memos(since=None)

        self.assertEqual((rows, total, truncated), ([], 0, 0))
