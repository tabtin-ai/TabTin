"""#3836 验收：Agent 级 allow_yolo_mode 已废弃。

- API schema 拒绝 ``agent_config.security`` 写入（422）
- ``strip_retired_agent_config_fields`` 清掉存量死字段
- ``build_default_agent_config_v2`` 不再产出 security 子树
"""
from __future__ import annotations

import unittest

from pydantic import ValidationError

from apps.tabtinspace.agent_config_v2 import (
    build_default_agent_config_v2,
    strip_retired_agent_config_fields,
)
from apps.tabtinspace.schemas.agent import AgentUpdate


class AgentConfigSchemaRejectsSecurityTests(unittest.TestCase):
    def test_agent_update_rejects_security_subtree(self) -> None:
        with self.assertRaises(ValidationError):
            AgentUpdate(agent_config={"security": {"allow_yolo_mode": True}})

    def test_agent_update_rejects_legacy_yolo_mode_in_security(self) -> None:
        with self.assertRaises(ValidationError):
            AgentUpdate(agent_config={"security": {"yolo_mode": True}})

    def test_capabilities_update_still_allowed(self) -> None:
        model = AgentUpdate(
            agent_config={
                "capabilities": {
                    "overrides": {
                        "cost": {
                            "execution_limits": {"max_iterations_per_run": 50},
                        },
                    },
                },
            },
        )
        self.assertIsNotNone(model.agent_config)


class StripAgentYoloGateTests(unittest.TestCase):
    def test_strips_allow_yolo_mode_and_empty_security(self) -> None:
        cfg = {
            "schema_version": 2,
            "security": {"allow_yolo_mode": True},
            "capabilities": {"overrides": {"cost": {}}},
        }
        out, changed = strip_retired_agent_config_fields(cfg)
        self.assertTrue(changed)
        self.assertNotIn("security", out)

    def test_strips_legacy_yolo_mode_field(self) -> None:
        cfg = {"security": {"yolo_mode": True}}
        out, changed = strip_retired_agent_config_fields(cfg)
        self.assertTrue(changed)
        self.assertNotIn("security", out)

    def test_authorization_preset_no_longer_infers_yolo(self) -> None:
        out, changed = strip_retired_agent_config_fields(
            {"authorization_preset": "full_auto"},
        )
        self.assertTrue(changed)
        self.assertNotIn("authorization_preset", out)
        self.assertNotIn("security", out)


class BuildDefaultNoSecurityTests(unittest.TestCase):
    def test_default_has_no_security(self) -> None:
        cfg = build_default_agent_config_v2()
        self.assertNotIn("security", cfg)


if __name__ == "__main__":
    unittest.main()
