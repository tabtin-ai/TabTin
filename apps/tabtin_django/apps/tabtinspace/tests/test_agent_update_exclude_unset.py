"""IA Phase 3 §8.5 P1 验收：Agent PUT 改 ``exclude_unset`` 修复"清回继承"。

修复改成 ``exclude_unset=True``：只剥客户端**未传**的字段、保留客户端**显式传
的 null**——正好对上 execution_limits 三态语义。

本测试模拟 router 的**完整转换链**（``AgentUpdate`` →
``model_dump(exclude_unset=True)`` → ``service.update_agent`` → DB → resolver），
覆盖 execution_limits 的 acceptance 与 partial update 防误清回归。

（：``security.allow_yolo_mode`` 已从 Agent schema 移除，相关用例删除。）
"""
from __future__ import annotations

import unittest

from django.test import TestCase

from apps.services.common.agent_governance_resolver import resolve_execution_limits
from apps.tabtinspace.agent_config_v2 import (
    build_default_agent_config_v2,
    get_capability_override,
)
from apps.tabtinspace.schemas.agent import AgentUpdate
from apps.tabtinspace.services.agent_service import AgentService
from apps.tabtinspace.tests.fixtures import (
    TABTINSPACE_DB_ALIAS,
    cleanup_test_organization,
    create_test_organization_with_agent,
)


class ExcludeUnsetDumpTests(unittest.TestCase):
    @staticmethod
    def _dump(raw: dict) -> dict:
        model = AgentUpdate(agent_config=raw)
        assert model.agent_config is not None
        return model.agent_config.model_dump(exclude_unset=True)

    def test_unset_fields_are_not_written(self) -> None:
        dumped = self._dump(
            {"capabilities": {"overrides": {"cost": {
                "execution_limits": {"max_iterations_per_run": 100},
            }}}},
        )
        self.assertIn("capabilities", dumped)
        self.assertNotIn("conversation", dumped)
        self.assertNotIn("schema_version", dumped)

    def test_partial_execution_limits_only_dumps_sent_dim(self) -> None:
        dumped = self._dump(
            {"capabilities": {"overrides": {"cost": {
                "execution_limits": {"max_iterations_per_run": None},
            }}}},
        )
        el = dumped["capabilities"]["overrides"]["cost"]["execution_limits"]
        self.assertEqual(el, {"max_iterations_per_run": None})
        self.assertNotIn("max_credits_per_run", el)


class AgentPutExcludeUnsetEndToEndTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self) -> None:
        self.ctx = create_test_organization_with_agent(prefix="exunset")
        self.user = self.ctx["user"]
        self.organization = self.ctx["organization"]
        self.agent = self.ctx["agent"]
        self.agent.agent_config = build_default_agent_config_v2()
        self.agent.save(using=TABTINSPACE_DB_ALIAS, update_fields=["agent_config"])

    def tearDown(self) -> None:
        cleanup_test_organization(self.organization, delete_user=True)

    def _service(self) -> AgentService:
        return AgentService(user=self.user)

    def _put(self, raw_agent_config: dict) -> None:
        data = AgentUpdate(agent_config=raw_agent_config)
        dumped = (
            data.agent_config.model_dump(exclude_unset=True)
            if data.agent_config is not None else None
        )
        self._service().update_agent(agent_id=self.agent.id, agent_config=dumped)

    def _cfg(self) -> dict:
        self.agent.refresh_from_db()
        return self.agent.agent_config

    def _exec_limits(self) -> dict:
        return get_capability_override(self._cfg(), "cost", "execution_limits") or {}

    def test_clear_both_execution_limits(self) -> None:
        self._put({"capabilities": {"overrides": {"cost": {
            "execution_limits": {
                "max_iterations_per_run": 100,
                "max_credits_per_run": "5.0",
            },
        }}}})
        el = self._exec_limits()
        self.assertEqual(el.get("max_iterations_per_run"), 100)
        self.assertEqual(el.get("max_credits_per_run"), "5.0")

        self._put({"capabilities": {"overrides": {"cost": {
            "execution_limits": {
                "max_iterations_per_run": None,
                "max_credits_per_run": None,
            },
        }}}})
        el = self._exec_limits()
        self.assertIsNone(el.get("max_iterations_per_run"))
        self.assertIsNone(el.get("max_credits_per_run"))

        resolved = resolve_execution_limits(self._cfg())
        self.assertIsNone(resolved["max_iterations_per_run"])
        self.assertIsNone(resolved["max_credits_per_run"])

    def test_clear_one_execution_dim_keeps_other(self) -> None:
        self._put({"capabilities": {"overrides": {"cost": {
            "execution_limits": {
                "max_iterations_per_run": 100,
                "max_credits_per_run": "5.0",
            },
        }}}})

        self._put({"capabilities": {"overrides": {"cost": {
            "execution_limits": {"max_iterations_per_run": None},
        }}}})
        el = self._exec_limits()
        self.assertIsNone(el.get("max_iterations_per_run"))
        self.assertEqual(el.get("max_credits_per_run"), "5.0")

    def test_unsent_subtree_not_cleared(self) -> None:
        self._put({"capabilities": {"overrides": {"cost": {
            "execution_limits": {"max_iterations_per_run": 100},
        }}}})
        self.assertEqual(self._exec_limits().get("max_iterations_per_run"), 100)

        self._put({"conversation": {"max_history_messages": 25}})
        self.assertEqual(self._exec_limits().get("max_iterations_per_run"), 100)
        self.assertEqual(self._cfg()["conversation"]["max_history_messages"], 25)
