"""
agent_config v2 形状 + migration 解析测试（Hilt W4 cost-only 重写后对齐）。

Hilt W4 背景：活跃 capability 收敛到只剩 ``cost``。原来的 7 分组
（shell / filesystem / network / sql / device / audit + cost）、顶层
``authorization_preset`` / ``capabilities.preset``、以及 v1→v2 把 terminal_mode /
operation_switches / sandbox / sql_mode / device_permissions / authorization_rules
promote 进 ``overrides`` 的行为均已移除——schema 仍容忍 bleed-back（老 DB 行 /
旧客户端 respread），但 ``build_default`` 不产出、``migrate_v1_to_v2`` 不再 promote。
本文件原断言「W4 之前形状」的用例已随之更新或退役（见各用例 ``Hilt W4`` 注释）。

测试范围：
- ``apps/tabtinspace/agent_config_v2.py`` 纯函数 v1→v2 转换（cost-only）
- ``AgentService._validate_and_merge_config``：接受 v2 形状 / 静默丢弃 v1 残留
  顶层字段 / 对 incoming 显式带的退役分组「容忍并逐字段 sanitize」（但默认
  target 不再为退役分组兜底默认值）

不依赖外部 DB；纯函数测试用 ``unittest.TestCase``。
"""
from __future__ import annotations

import unittest
from copy import deepcopy

from apps.tabtinspace.agent_config_v2 import (
    RETIRED_CAPABILITY_GROUPS,
    V2_SCHEMA_VERSION,
    build_default_agent_config_v2,
    get_capability_override,
    set_capability_override,
    migrate_v1_to_v2,
    strip_retired_agent_config_fields,
)


class AgentConfigV2BuildDefaultTests(unittest.TestCase):
    """v2 default 形状 + 关键字段位置（W2.1.0 §2 严格对齐）。"""

    def setUp(self):
        self.cfg = build_default_agent_config_v2()

    def test_schema_version_is_2(self):
        self.assertEqual(self.cfg["schema_version"], 2)

    def test_runtime_plane_is_local(self):
        # D2.1 命名修订
        self.assertEqual(self.cfg["runtime_plane"], "local")
        self.assertNotIn("runtime", self.cfg)  # 不能用 'runtime'（与 Agent.runtime_type 冲突）

    def test_no_authorization_preset_top_level(self):
        # Hilt W4：顶层 authorization_preset 已删除。旧 preset 仅在 migration 时
        # 用于推断 security.allow_yolo_mode，不再作为独立字段产出。
        # （原 test_authorization_preset_top_level 断言 =="collaborative" 已退役。）
        self.assertNotIn("authorization_preset", self.cfg)

    def test_capabilities_only_cost(self):
        # Hilt W4：活跃 capability 收敛到只剩 cost。原 7 分组里的 shell /
        # filesystem / network / sql / device / audit 在 W4 重写时移除——
        # build_default 不再产出（schema 仍容忍 bleed-back，但默认形状不带）。
        # （原 test_capabilities_7_groups 断言 7 分组齐全已退役。）
        overrides = self.cfg["capabilities"]["overrides"]
        self.assertEqual(set(overrides.keys()), {"cost"})
        for retired in ["shell", "filesystem", "network", "sql", "device", "audit"]:
            self.assertNotIn(
                retired, overrides, f"retired capability group leaked: {retired}"
            )

    # 注：原 test_shell_overrides_fields / test_filesystem_deny_paths /
    # test_audit_authorization_rules_position 三个用例随 shell / filesystem /
    # audit 分组在 Hilt W4 退役而删除——它们断言的字段默认形状里已不存在。

    def test_cost_execution_limits_position(self):
        cost = self.cfg["capabilities"]["overrides"]["cost"]
        self.assertIn("execution_limits", cost)
        self.assertIsNone(cost["execution_limits"]["max_iterations_per_run"])

    def test_conversation_top_level(self):
        self.assertTrue(self.cfg["conversation"]["cross_turn_memory"])
        self.assertEqual(self.cfg["conversation"]["max_history_messages"], 10)

    def test_no_v1_deprecated_fields(self):
        # v2 删除字段
        self.assertNotIn("execution_env", self.cfg)
        self.assertNotIn("permission_mode", self.cfg)
        # v2 default 不带 memory（D2 / TabMemo 后续专题）
        self.assertNotIn("memory", self.cfg)
        # 顶层不再有 sandbox（已展开到 capabilities.overrides）
        self.assertNotIn("sandbox", self.cfg)
        # 顶层不再有这些（已下沉到 capabilities.overrides.shell）
        self.assertNotIn("terminal_mode", self.cfg)
        self.assertNotIn("operation_switches", self.cfg)
        self.assertNotIn("sql_mode", self.cfg)

    def test_agent_backend_builtin(self):
        self.assertEqual(self.cfg["agent_backend"]["type"], "builtin")
        self.assertEqual(self.cfg["agent_backend"]["config_version"], 2)


class GetCapabilityOverrideTests(unittest.TestCase):
    """工具函数 get/set_capability_override 行为（DX 关键）。"""

    def test_read_existing_field(self):
        # Hilt W4：cost 是唯一活跃分组。原断言读 shell.terminal_mode 随 shell
        # 分组退役，改读 cost.execution_limits 验证「读取存在字段」语义。
        cfg = build_default_agent_config_v2()
        v = get_capability_override(cfg, "cost", "execution_limits", default="X")
        self.assertEqual(
            v, {"max_iterations_per_run": None, "max_credits_per_run": None}
        )

    def test_read_missing_field_returns_default(self):
        cfg = build_default_agent_config_v2()
        v = get_capability_override(cfg, "shell", "nonexistent", default="DEFAULT")
        self.assertEqual(v, "DEFAULT")

    def test_read_missing_capability_returns_default(self):
        cfg = {"capabilities": {"overrides": {}}}
        v = get_capability_override(cfg, "shell", "terminal_mode", default="X")
        self.assertEqual(v, "X")

    def test_read_none_config(self):
        v = get_capability_override(None, "shell", "terminal_mode", default="X")
        self.assertEqual(v, "X")

    def test_set_creates_intermediate(self):
        cfg = {}
        set_capability_override(cfg, "shell", "terminal_mode", "regular")
        self.assertEqual(
            cfg["capabilities"]["overrides"]["shell"]["terminal_mode"], "regular"
        )

    def test_set_preserves_existing_keys(self):
        cfg = {"capabilities": {"overrides": {"shell": {"existing": "value"}}}}
        set_capability_override(cfg, "shell", "terminal_mode", "regular")
        self.assertEqual(cfg["capabilities"]["overrides"]["shell"]["existing"], "value")
        self.assertEqual(
            cfg["capabilities"]["overrides"]["shell"]["terminal_mode"], "regular"
        )


class MigrateV1ToV2Tests(unittest.TestCase):
    """v1 → v2 转换的纯函数测试（migration / service 共用同一套逻辑）。"""

    def test_empty_input_returns_v2_default(self):
        result = migrate_v1_to_v2({})
        self.assertEqual(result["schema_version"], V2_SCHEMA_VERSION)

    def test_none_input_returns_v2_default(self):
        result = migrate_v1_to_v2(None)
        self.assertEqual(result["schema_version"], V2_SCHEMA_VERSION)

    def test_idempotent_v2_input(self):
        v2 = build_default_agent_config_v2()
        result = migrate_v1_to_v2(v2)
        self.assertEqual(result, v2)
        # 不 mutate 入参
        self.assertIsNot(result, v2)

    def test_v1_terminal_mode_dropped(self):
        # Hilt W4：shell 分组退役。v1 顶层 terminal_mode 不再 promote 到
        # capabilities.overrides.shell，归一时静默丢弃（_SKIP_KEYS）。
        # （原 test_v1_terminal_mode_promoted 断言 promote 到 shell 已退役。）
        v1 = {"terminal_mode": "regular"}
        result = migrate_v1_to_v2(v1)
        self.assertNotIn("terminal_mode", result)
        self.assertNotIn("shell", result["capabilities"]["overrides"])

    def test_v1_operation_switches_dropped(self):
        # Hilt W4：shell 分组退役，operation_switches 不再 promote，静默丢弃。
        v1 = {"operation_switches": {"git_push": "block", "ssh": "allow"}}
        result = migrate_v1_to_v2(v1)
        self.assertNotIn("operation_switches", result)
        self.assertNotIn("shell", result["capabilities"]["overrides"])

    def test_v1_sandbox_subdict_dropped(self):
        # Hilt W4：shell / filesystem / network 分组退役。v1 sandbox 子树不再
        # 展开到这些分组，整体在归一时静默丢弃，overrides 只剩 cost。
        # （原 test_v1_sandbox_subdict_expanded 断言展开到三分组已退役。）
        v1 = {
            "sandbox": {
                "command_execution": "regular",
                "sandbox_level": "complete",
                "network_mode": "blocked",
                "deny_read_paths": ["/etc/secret"],
                "high_risk_requires_approval": False,
            }
        }
        result = migrate_v1_to_v2(v1)
        self.assertNotIn("sandbox", result)
        self.assertEqual(set(result["capabilities"]["overrides"].keys()), {"cost"})

    def test_v1_execution_limits_promoted_to_cost(self):
        v1 = {"execution_limits": {"max_iterations_per_run": 50}}
        result = migrate_v1_to_v2(v1)
        self.assertEqual(
            result["capabilities"]["overrides"]["cost"]["execution_limits"][
                "max_iterations_per_run"
            ],
            50,
        )

    def test_v1_authorization_rules_dropped(self):
        # Hilt W4：audit 分组退役，authorization_rules 不再 promote，静默丢弃。
        v1 = {"authorization_rules": {"write": "confirm", "delete_system": "auto"}}
        result = migrate_v1_to_v2(v1)
        self.assertNotIn("authorization_rules", result)
        self.assertNotIn("audit", result["capabilities"]["overrides"])

    def test_v1_device_permissions_dropped(self):
        # Hilt W4：device 分组退役，device_permissions 不再 promote，静默丢弃。
        v1 = {"device_permissions": {"screen_capture": "allow"}}
        result = migrate_v1_to_v2(v1)
        self.assertNotIn("device_permissions", result)
        self.assertNotIn("device", result["capabilities"]["overrides"])

    def test_v1_sql_mode_dropped(self):
        # Hilt W4：sql 分组退役，sql_mode 不再 promote，静默丢弃。
        v1 = {"sql_mode": "read_only"}
        result = migrate_v1_to_v2(v1)
        self.assertNotIn("sql_mode", result)
        self.assertNotIn("sql", result["capabilities"]["overrides"])

    def test_v1_cross_turn_memory_promoted_to_conversation(self):
        v1 = {"cross_turn_memory": False, "max_history_messages": 5}
        result = migrate_v1_to_v2(v1)
        self.assertFalse(result["conversation"]["cross_turn_memory"])
        self.assertEqual(result["conversation"]["max_history_messages"], 5)

    def test_v1_execution_env_dropped(self):
        v1 = {"execution_env": "remote"}
        result = migrate_v1_to_v2(v1)
        self.assertNotIn("execution_env", result)

    def test_v1_permission_mode_dropped(self):
        v1 = {"permission_mode": "auto-approve-edits"}
        result = migrate_v1_to_v2(v1)
        self.assertNotIn("permission_mode", result)

    def test_v1_memory_subtree_preserved(self):
        # v2 default 不带 memory，但 migration 不强删现有数据
        v1 = {"memory": {"enabled": True, "version": "v2.0"}}
        result = migrate_v1_to_v2(v1)
        self.assertEqual(result["memory"], {"enabled": True, "version": "v2.0"})

    def test_v1_agent_backend_type_normalized(self):
        v1 = {"agent_backend": {"type": "claude_code", "execution_mode": "stub"}}
        result = migrate_v1_to_v2(v1)
        self.assertEqual(result["agent_backend"]["type"], "builtin")
        self.assertNotIn("execution_mode", result["agent_backend"])

    def test_v1_authorization_preset_dropped_no_yolo_inference(self):
        # Hilt W4：authorization_preset 已删除。#3836：不再推断 security.allow_yolo_mode。
        result = migrate_v1_to_v2({"authorization_preset": "cautious"})
        self.assertNotIn("authorization_preset", result)
        self.assertNotIn("preset", result["capabilities"])
        self.assertNotIn("security", result)

        result_auto = migrate_v1_to_v2({"authorization_preset": "full_auto"})
        self.assertNotIn("authorization_preset", result_auto)
        self.assertNotIn("security", result_auto)

    def test_v1_workspace_root_top_level_preserved(self):
        v1 = {"workspace_root": "/Users/test/proj"}
        result = migrate_v1_to_v2(v1)
        self.assertEqual(result["workspace_root"], "/Users/test/proj")

    def test_v1_soul_dropped(self):
        # Soul 概念已整体移除（总控计划 D4）：旧数据里的 soul 子树在 v1→v2
        # 归一时被静默丢弃，不再 preserve。
        v1 = {"soul": {"preset_id": "executor", "preset_version": "1.0"}}
        result = migrate_v1_to_v2(v1)
        self.assertNotIn("soul", result)

    def test_pseudo_v2_capabilities_block_cost_preserved(self):
        """「假 v2」形态——cfg 缺 schema_version 但带 capabilities 嵌套。

        Hilt W4：migrate 仅保留 cost 分组；用户显式的 cost override 不被 default
        覆盖（deep merge）。shell / filesystem 等退役分组在归一时一并丢弃。
        （原 test_pseudo_v2_capabilities_block_preserved 断言 shell/filesystem
        被保留已退役——纯函数 migrate 不再保留退役分组。）
        """
        pseudo = {
            "authorization_preset": "collaborative",
            "capabilities": {
                "preset": "collaborative",
                "overrides": {
                    "cost": {"execution_limits": {"max_iterations_per_run": 42}},
                    # 退役分组：migrate 后应被丢弃
                    "shell": {
                        "terminal_mode": "regular",
                        "operation_switches": {"git_push": "allow", "ssh": "allow"},
                    },
                    "filesystem": {"deny_read_paths": ["/etc/secret"]},
                },
            },
        }
        result = migrate_v1_to_v2(pseudo)
        ov = result["capabilities"]["overrides"]
        # cost 显式 override 保留（deep merge，不被 default 覆盖）
        self.assertEqual(ov["cost"]["execution_limits"]["max_iterations_per_run"], 42)
        # 退役分组不保留，overrides 只剩 cost
        self.assertEqual(set(ov.keys()), {"cost"})

    def test_pseudo_v2_conversation_block_preserved(self):
        """同上，conversation 嵌套块在「假 v2」形态下也要保留。"""
        pseudo = {
            "conversation": {"cross_turn_memory": False, "max_history_messages": 25},
        }
        result = migrate_v1_to_v2(pseudo)
        self.assertFalse(result["conversation"]["cross_turn_memory"])
        self.assertEqual(result["conversation"]["max_history_messages"], 25)

    def test_v1_top_field_cost_overridden_by_capabilities_block(self):
        """混合包：v1 顶层 + capabilities 嵌套块同时存在时，capabilities 嵌套块
        最后合并、优先于 v1 顶层（migrate 先 set v1 顶层、再 deep_merge 嵌套块）。

        Hilt W4：此优先级语义现仅对唯一存活的 cost 分组成立——原以 shell.
        terminal_mode 演示的用例已随 shell 退役改用 cost.execution_limits。
        """
        mixed = {
            "execution_limits": {"max_iterations_per_run": 10},  # v1 顶层
            "capabilities": {
                "overrides": {
                    "cost": {"execution_limits": {"max_iterations_per_run": 99}},
                },
            },
        }
        result = migrate_v1_to_v2(mixed)
        # capabilities 嵌套块作为最后一步合并，应优先于 v1 顶层
        self.assertEqual(
            result["capabilities"]["overrides"]["cost"]["execution_limits"][
                "max_iterations_per_run"
            ],
            99,
        )

    def test_unknown_top_level_fields_preserved(self):
        """W2.1 Review 1 P1：未知顶层字段（dogfood / 集成测试 / 未来扩展）必须保留。"""
        v1 = {
            "authorization_preset": "collaborative",
            "custom_dogfood_field": "experimental",
            "_internal_marker": {"trace": "abc"},
            "enabled_tools": ["foo", "bar"],
        }
        result = migrate_v1_to_v2(v1)
        self.assertEqual(result["custom_dogfood_field"], "experimental")
        self.assertEqual(result["_internal_marker"], {"trace": "abc"})
        self.assertEqual(result["enabled_tools"], ["foo", "bar"])

    def test_full_v1_realistic_round_trip(self):
        """模拟真实 v1 形状归一到 Hilt W4 新形状。

        W4 后只有 cost.execution_limits 与 memory 子树存活；shell / filesystem /
        sql / authorization_preset 等旧授权字段全部丢弃。
        """
        v1 = {
            "execution_env": "local",
            "authorization_preset": "collaborative",
            "terminal_mode": "sandboxed",
            "operation_switches": {
                "git_read": "allow",
                "git_push": "confirm",
                "ssh": "block",
            },
            "sql_mode": "read_write",
            "agent_backend": {"type": "builtin"},
            "sandbox": {
                "command_execution": "sandboxed",
                "sandbox_level": "filesystem",
                "deny_read_paths": ["~/.ssh"],
                "high_risk_requires_approval": True,
            },
            "execution_limits": {"max_iterations_per_run": 100},
            "memory": {"enabled": False},
            "permission_mode": "default",  # 应该被丢弃
        }
        result = migrate_v1_to_v2(v1)

        # v2 顶层：schema_version / runtime_plane 固定；旧授权字段全部丢弃
        self.assertEqual(result["schema_version"], 2)
        self.assertEqual(result["runtime_plane"], "local")
        self.assertNotIn("authorization_preset", result)
        self.assertNotIn("execution_env", result)
        self.assertNotIn("permission_mode", result)
        self.assertNotIn("security", result)

        # capabilities.overrides：唯一存活的 cost；退役分组不产出
        ov = result["capabilities"]["overrides"]
        self.assertEqual(set(ov.keys()), {"cost"})
        self.assertEqual(ov["cost"]["execution_limits"]["max_iterations_per_run"], 100)

        # memory 保留（migration 不强删现有数据）
        self.assertEqual(result["memory"], {"enabled": False})


class AgentServiceValidateV2Tests(unittest.TestCase):
    """AgentService._validate_and_merge_config 的 v2 形状校验。

    用 mock user 直接 instantiate AgentService 调 _validate_and_merge_config（纯函数）。
    """

    def setUp(self):
        from apps.tabtinspace.services.agent_service import AgentService
        # 用 None user 调 _validate_and_merge_config（不需要 user 上下文）
        self.svc = AgentService(user=None)

    def test_v2_incoming_kept_as_is(self):
        # 注意：shell 在 Hilt W4 已退役，但这里它以 *v2 嵌套* 形态（无 v1 顶层键）
        # 出现——service 层走「bleed-back 容忍」路径（has_v1_top=False，不过 migrate，
        # sanitize 后 deep_merge 保留）。这与 migrate 丢弃 *v1 顶层* 退役字段是两条
        # 不同路径，不矛盾。
        target = build_default_agent_config_v2()
        incoming = {
            "schema_version": V2_SCHEMA_VERSION,
            "capabilities": {
                "overrides": {
                    "shell": {"terminal_mode": "regular"},
                },
            },
        }
        self.svc._validate_and_merge_config(target, incoming)
        self.assertEqual(
            target["capabilities"]["overrides"]["shell"]["terminal_mode"], "regular"
        )

    def test_v1_incoming_promoted_to_v2(self):
        # Hilt W4：v1 顶层只有 execution_limits 仍 promote（→ cost）；
        # terminal_mode / operation_switches 等 shell 字段已退役，归一时丢弃。
        # （原断言 promote 到 shell.terminal_mode / operation_switches 已退役。）
        target = build_default_agent_config_v2()
        incoming = {
            "execution_limits": {"max_iterations_per_run": 50},
            "terminal_mode": "regular",                    # 退役字段
            "operation_switches": {"git_push": "allow"},   # 退役字段
        }
        self.svc._validate_and_merge_config(target, incoming)
        self.assertEqual(
            target["capabilities"]["overrides"]["cost"]["execution_limits"][
                "max_iterations_per_run"
            ],
            50,
        )
        self.assertNotIn("shell", target["capabilities"]["overrides"])
        self.assertNotIn("terminal_mode", target)
        self.assertNotIn("operation_switches", target)

    def test_invalid_terminal_mode_normalized(self):
        target = build_default_agent_config_v2()
        incoming = {
            "schema_version": V2_SCHEMA_VERSION,
            "capabilities": {"overrides": {"shell": {"terminal_mode": "invalid"}}},
        }
        self.svc._validate_and_merge_config(target, incoming)
        self.assertEqual(
            target["capabilities"]["overrides"]["shell"]["terminal_mode"], "sandboxed"
        )

    def test_execution_env_silently_dropped(self):
        target = build_default_agent_config_v2()
        incoming = {"schema_version": V2_SCHEMA_VERSION, "execution_env": "remote"}
        self.svc._validate_and_merge_config(target, incoming)
        self.assertNotIn("execution_env", target)

    def test_permission_mode_silently_dropped(self):
        target = build_default_agent_config_v2()
        incoming = {"schema_version": V2_SCHEMA_VERSION, "permission_mode": "default"}
        self.svc._validate_and_merge_config(target, incoming)
        self.assertNotIn("permission_mode", target)

    def test_incoming_soul_tolerated_and_dropped_not_422(self):
        """Soul 已整体移除，但作为 bleed-back 容忍（对齐 authorization_preset 模式）：
        旧客户端 / 老 DB 行整包 respread 带 soul 子树时——
          ① schema 层 ``AgentConfigUpdateSchema`` 接受（不 422，避免 extra='forbid'
             先于 service 拒绝）；
          ② service ``_validate_and_merge_config`` 静默 pop 丢弃，不写库。
        覆盖总控验收 #4「旧客户端 echo agent_config.soul 不再 422」。"""
        from apps.tabtinspace.schemas.agent_config_v3 import AgentConfigUpdateSchema

        # ① schema 层容忍：构造不应抛 ValidationError
        AgentConfigUpdateSchema(soul={"preset_id": "executor", "preset_version": "1.0"})

        # ② service 层静默丢弃
        target = build_default_agent_config_v2()
        incoming = {
            "schema_version": V2_SCHEMA_VERSION,
            "soul": {"preset_id": "executor", "preset_version": "1.0"},
        }
        self.svc._validate_and_merge_config(target, incoming)
        self.assertNotIn("soul", target)

    def test_invalid_authorization_preset_silently_dropped(self):
        # Hilt W4：authorization_preset 已删除，service 层无条件 pop——不再做
        # 「非法值 fallback collaborative」的校验（schema 层接受 bleed-back，
        # service 层静默丢弃，不写库）。
        # （原 test_invalid_authorization_preset_falls_back_to_collaborative
        # 断言 fallback 到 collaborative 已退役。）
        target = build_default_agent_config_v2()
        incoming = {
            "schema_version": V2_SCHEMA_VERSION,
            "authorization_preset": "INVALID",
        }
        self.svc._validate_and_merge_config(target, incoming)
        self.assertNotIn("authorization_preset", target)

    def test_invalid_operation_switch_value_dropped(self):
        # service 层容忍 incoming 显式带 shell（bleed-back / 旧客户端 v2 嵌套），
        # 并逐字段 sanitize：非法 key / 非法 value 被剔除后才 deep_merge 进 target。
        # Hilt W4：default target 不再带 shell.operation_switches，所以被 sanitize
        # 掉的 ssh 不会从 default 兜底回来——直接缺席。
        # （原断言 ssh=='block'（依赖 default 7 分组兜底）已退役。）
        target = build_default_agent_config_v2()
        incoming = {
            "schema_version": V2_SCHEMA_VERSION,
            "capabilities": {
                "overrides": {
                    "shell": {
                        "operation_switches": {
                            "git_push": "allow",
                            "git_invalid_key": "allow",  # 非法 key
                            "ssh": "INVALID_VAL",        # 非法 value
                        },
                    },
                },
            },
        }
        self.svc._validate_and_merge_config(target, incoming)
        ops = target["capabilities"]["overrides"]["shell"]["operation_switches"]
        self.assertEqual(ops["git_push"], "allow")
        self.assertNotIn("git_invalid_key", ops)
        # ssh 非法值被 sanitize 剔除，且 default 不再为退役分组兜底 → 缺席
        self.assertNotIn("ssh", ops)

    def test_bleed_back_filesystem_group_tolerated_and_sanitized(self):
        # 退役分组不止 shell：filesystem 等以 v2 嵌套形态 bleed-back（老 DB 行 /
        # 旧客户端 respread，无 v1 顶层键）时，service 层同样「容忍 + 逐字段
        # sanitize」后 deep_merge——锁住 _validate_capability_overrides 对退役
        # 分组的 defense-in-depth 分支（非法值规整为合法默认），防未来重构静默删。
        target = build_default_agent_config_v2()
        incoming = {
            "schema_version": V2_SCHEMA_VERSION,
            "capabilities": {
                "overrides": {
                    "filesystem": {
                        "sandbox_level": "INVALID",       # 非法值 → 规整为 filesystem
                        "deny_read_paths": "not_a_list",  # 非法类型 → 规整为 []
                    },
                },
            },
        }
        self.svc._validate_and_merge_config(target, incoming)
        fs = target["capabilities"]["overrides"]["filesystem"]
        self.assertEqual(fs["sandbox_level"], "filesystem")
        self.assertEqual(fs["deny_read_paths"], [])

    def test_conversation_max_history_clamp(self):
        target = build_default_agent_config_v2()
        incoming = {
            "schema_version": V2_SCHEMA_VERSION,
            "conversation": {"max_history_messages": 999},  # 超限
        }
        self.svc._validate_and_merge_config(target, incoming)
        self.assertEqual(target["conversation"]["max_history_messages"], 500)

    def test_mixed_v2_with_v1_conversation_top_keys_promoted(self):
        """「假 v2」混合包：capabilities 已存在但 cross_turn_memory /
        max_history_messages 仍在顶层（review #1 P1 修复点）。
        promote 后顶层不应残留 v1 字段，conversation 块应正确填充。"""
        target = build_default_agent_config_v2()
        incoming = {
            "capabilities": {
                "overrides": {"shell": {"terminal_mode": "regular"}},
            },
            # v1 顶层 conversation 字段（review 漏点）
            "cross_turn_memory": False,
            "max_history_messages": 50,
        }
        self.svc._validate_and_merge_config(target, incoming)
        self.assertFalse(target["conversation"]["cross_turn_memory"])
        self.assertEqual(target["conversation"]["max_history_messages"], 50)
        # capabilities 嵌套合并正确
        self.assertEqual(
            target["capabilities"]["overrides"]["shell"]["terminal_mode"], "regular"
        )

    def test_mixed_v2_with_v1_top_keys_dropped_from_target(self):
        """promote 后 incoming 顶层 v1 字段（terminal_mode / cross_turn_memory）
        不应残留在 target（review #1 P1 修复）。

        Hilt W4：terminal_mode 已退役——不再 promote 到 shell，归一时直接丢弃，
        不产生 shell 分组；cross_turn_memory 仍正常 promote 到 conversation。
        （原断言 shell.terminal_mode=='regular' 已退役。）
        """
        target = build_default_agent_config_v2()
        incoming = {
            "schema_version": V2_SCHEMA_VERSION,  # 已声明 v2
            "terminal_mode": "regular",            # 但仍混 v1 顶层（退役字段）
            "cross_turn_memory": False,
        }
        self.svc._validate_and_merge_config(target, incoming)
        self.assertNotIn("terminal_mode", target)
        self.assertNotIn("cross_turn_memory", target)
        self.assertNotIn("shell", target["capabilities"]["overrides"])
        self.assertFalse(target["conversation"]["cross_turn_memory"])


class StripRetiredAgentConfigFieldsTests(unittest.TestCase):
    """strip_retired_agent_config_fields 纯函数（Hilt W4 收尾 · 阶段1 数据治理）。

    被数据迁移 0055 / 0091 与 migrate_auth_to_v3 command 共用：清退役字段、保留活跃字段。
    """

    def _full_retired_config(self):
        """构造一个塞满退役字段 + 活跃字段的 cfg（模拟老 DB 脏行）。"""
        return {
            "schema_version": 2,
            "runtime_plane": "local",
            "authorization_preset": "collaborative",
            "soul": {"preset_id": "executor", "preset_version": "1.0"},
            "security": {"allow_yolo_mode": False},
            "capabilities": {
                "preset": "collaborative",
                "overrides": {
                    "cost": {"execution_limits": {"max_iterations_per_run": 50}},
                    "shell": {"terminal_mode": "regular"},
                    "filesystem": {"deny_read_paths": ["/etc/secret"]},
                    "network": {"network_mode": "blocked"},
                    "sql": {"sql_mode": "read_only"},
                    "device": {"device_permissions": {"screen_capture": "allow"}},
                    "audit": {"authorization_rules": {"write": "confirm"}},
                },
            },
            "conversation": {"cross_turn_memory": True, "max_history_messages": 10},
            "agent_backend": {"type": "builtin", "config_version": 2},
            "memory": {"enabled": True},
            "workspace_root": "/Users/test/proj",
            "git_status": {"branch": "main"},
            "approval_memo": {"entries": {"git_push": {"decision": "allow"}}},
        }

    def test_strips_all_retired_capability_groups(self):
        cfg = self._full_retired_config()
        out, changed = strip_retired_agent_config_fields(cfg)
        self.assertTrue(changed)
        # 退役分组全清，cost 保留
        self.assertEqual(set(out["capabilities"]["overrides"].keys()), {"cost"})
        for grp in RETIRED_CAPABILITY_GROUPS:
            self.assertNotIn(grp, out["capabilities"]["overrides"])

    def test_strips_capabilities_preset(self):
        out, changed = strip_retired_agent_config_fields(self._full_retired_config())
        self.assertTrue(changed)
        self.assertNotIn("preset", out["capabilities"])

    def test_strips_top_level_authorization_preset_and_soul(self):
        out, _ = strip_retired_agent_config_fields(self._full_retired_config())
        self.assertNotIn("authorization_preset", out)
        self.assertNotIn("soul", out)

    def test_strips_agent_yolo_gate_fields(self):
        out, changed = strip_retired_agent_config_fields(
            {"security": {"allow_yolo_mode": True}},
        )
        self.assertTrue(changed)
        self.assertNotIn("security", out)

    def test_authorization_preset_does_not_infer_yolo(self):
        out, _ = strip_retired_agent_config_fields(
            {"authorization_preset": "full_auto"},
        )
        self.assertNotIn("authorization_preset", out)
        self.assertNotIn("security", out)

    def test_preserves_all_active_fields(self):
        out, _ = strip_retired_agent_config_fields(self._full_retired_config())
        # cost 活跃分组及其值保留
        self.assertEqual(
            out["capabilities"]["overrides"]["cost"]["execution_limits"][
                "max_iterations_per_run"
            ],
            50,
        )
        # 其余活跃字段一律保留
        self.assertEqual(out["schema_version"], 2)
        self.assertEqual(out["runtime_plane"], "local")
        self.assertEqual(out["conversation"]["max_history_messages"], 10)
        self.assertEqual(out["agent_backend"]["type"], "builtin")
        self.assertEqual(out["memory"], {"enabled": True})
        self.assertEqual(out["workspace_root"], "/Users/test/proj")
        self.assertEqual(out["git_status"], {"branch": "main"})

    def test_approval_memo_never_touched(self):
        # approval_memo 是 Hilt 保留的用户数据，strip 绝不能动它
        cfg = self._full_retired_config()
        out, _ = strip_retired_agent_config_fields(cfg)
        self.assertEqual(
            out["approval_memo"], {"entries": {"git_push": {"decision": "allow"}}}
        )

    def test_idempotent_on_clean_default(self):
        # 干净的 v2 default 无退役字段 → changed=False，且内容不变
        clean = build_default_agent_config_v2()
        out, changed = strip_retired_agent_config_fields(clean)
        self.assertFalse(changed)
        self.assertEqual(out, clean)

    def test_idempotent_second_pass(self):
        # 清一次后再清一次应稳定（changed=False）
        once, _ = strip_retired_agent_config_fields(self._full_retired_config())
        twice, changed = strip_retired_agent_config_fields(once)
        self.assertFalse(changed)
        self.assertEqual(twice, once)

    def test_does_not_mutate_input(self):
        cfg = self._full_retired_config()
        original = deepcopy(cfg)
        strip_retired_agent_config_fields(cfg)
        self.assertEqual(cfg, original)

    def test_non_dict_returns_unchanged(self):
        for bad in (None, "x", 42, ["a"]):
            out, changed = strip_retired_agent_config_fields(bad)
            self.assertIs(out, bad)
            self.assertFalse(changed)


if __name__ == "__main__":
    unittest.main()
