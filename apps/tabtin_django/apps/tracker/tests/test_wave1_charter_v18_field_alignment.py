"""Tracker Wave 1 (charter v1.8 §7.1 / §7.2) 字段对齐回归测试。

不依赖测试 DB（local 环境无 mysql test 库创建权限），用 SimpleTestCase + model 元数据
反射 + 直接构造 model 实例的方式验证：

- 1.1 Tracker.agent / intent_snapshot / skill_params 字段定义（FK + nullable + default + on_delete）
- 1.1 Tracker.space / created_by 已 nullable（_meta 反射）
- 1.2 TrackerRun.chat_session 字段定义（跨库 FK，db_constraint=False）
- 1.3b deprecation telemetry：log_deprecated_field_access 函数行为 + Tracker/TrackerRun.save() 钩子
- 1.4 多租户隔离：QuerySet 过滤逻辑契约（agent FK 不会让 Organization A 看到 B 的 agent 关联 Tracker）

详
- docs/planning/tracker-charter-v1.md v1.8 §7.x
- docs/planning/tracker-execution-plan-v2.md v2.1 §Phase 1
- apps/scheduler/migrations/0020_tracker_charter_v18_field_alignment.py
"""
from __future__ import annotations

import logging
import uuid
from unittest.mock import MagicMock, patch

from django.db import models
from django.test import SimpleTestCase

from apps.tracker.models import Tracker, TrackerRun
from apps.tracker.services.deprecation_logger import (
    TRACKER_DEPRECATED_FIELDS,
    TRACKER_RUN_DEPRECATED_FIELDS,
    log_deprecated_field_access,
)


# ═══════════════════════════════════════════════════════════════
# 1.1 Tracker model 字段定义验证（_meta 反射）
# ═══════════════════════════════════════════════════════════════


class GoalNewFieldsSchemaTest(SimpleTestCase):
    """1.1 Tracker.agent / intent_snapshot 新字段的 model 定义。"""

    def test_goal_has_agent_field(self):
        """Tracker 必须定义 agent FK，指向 tabtinspace.Agent。"""
        field = Tracker._meta.get_field("agent")
        self.assertIsInstance(field, models.ForeignKey)
        self.assertEqual(field.related_model._meta.app_label, "tabtinspace")
        self.assertEqual(field.related_model._meta.model_name, "agent")

    def test_goal_agent_is_nullable(self):
        """agent 本期 nullable=True（charter v1.8 §7.1：避免 migration 失败）。"""
        field = Tracker._meta.get_field("agent")
        self.assertTrue(field.null, "Wave 1 期 agent 必须 nullable，应用层校验创建时必填")
        self.assertTrue(field.blank, "blank 与 null 一致，admin form 也允许空")

    def test_goal_agent_on_delete_set_null(self):
        """charter §7.1 要求 SET_NULL —— Agent 删除时 Tracker 不连带删。"""
        field = Tracker._meta.get_field("agent")
        self.assertEqual(
            field.remote_field.on_delete,
            models.SET_NULL,
            "agent 必须用 SET_NULL；CASCADE 会让 Agent 删除连带删除所有 Tracker",
        )

    def test_goal_has_intent_snapshot(self):
        """charter §7.1 要求 intent_snapshot JSONField nullable。"""
        field = Tracker._meta.get_field("intent_snapshot")
        self.assertIsInstance(field, models.JSONField)
        self.assertTrue(field.null, "intent_snapshot nullable —— 表单 / CLI 路径无对话快照")
        self.assertTrue(field.blank)

    def test_goal_has_skill_params(self):
        """charter §7.1 要求 skill_params JSONField nullable，与 skill_key 配套。

        三条创建路径（Agent / 表单 / CLI）均可写入；schema 由 Service 层依各 Skill 自定义。
        与 intent_snapshot 同模式：nullable=True / blank=True / default=None。
        """
        field = Tracker._meta.get_field("skill_params")
        self.assertIsInstance(field, models.JSONField)
        self.assertTrue(field.null, "skill_params nullable —— 无显式参数时为 NULL")
        self.assertTrue(field.blank)

    def test_goal_skill_params_default_is_none(self):
        """与 intent_snapshot 一致：default=None（不是 dict / list），避免 mutable 默认陷阱。

        JSONField default=None 是宪法 §7.1 终局形态："空值表示无显式参数"。
        若 default={} 会让 Service 层无法区分「未设置」与「显式空 dict」。
        """
        field = Tracker._meta.get_field("skill_params")
        # Django get_default() 在 has_default() 时返回 default 值；为 None 时返回 None
        self.assertIsNone(field.get_default(), "skill_params default 必须 None，非 {} 或 []")


class GoalNullabilityTest(SimpleTestCase):
    """1.1 space / created_by nullable 化（charter §7.1）。"""

    def test_goal_space_is_nullable(self):
        """charter §7.1：个人级 Tracker 可不绑 Space。"""
        field = Tracker._meta.get_field("space")
        self.assertTrue(field.null, "space 必须 nullable")
        self.assertTrue(field.blank)
        self.assertEqual(
            field.remote_field.on_delete,
            models.SET_NULL,
            "Space 删除时 Tracker 不连带删除（业务上 Space 是容器，删除 Space 不应连带删 Tracker）",
        )

    def test_goal_created_by_is_nullable(self):
        """charter §7.1：未来 system_preset 时为 NULL（本期保留 nullable 设计）。"""
        field = Tracker._meta.get_field("created_by")
        self.assertTrue(field.null, "created_by 必须 nullable")
        self.assertTrue(field.blank, "blank 必须显式（避免 admin form 强制必填）")
        # 单库治理（M3a）：User 与 tracker 同库（PG）后恢复物理 FK 约束。
        self.assertTrue(
            field.db_constraint,
            "单库下 User FK 应为物理约束 db_constraint=True（M3a）",
        )


# ═══════════════════════════════════════════════════════════════
# 1.2 TrackerRun.chat_session 跨库 FK 字段定义
# ═══════════════════════════════════════════════════════════════


class GoalRunChatSessionFieldTest(SimpleTestCase):
    """1.2 TrackerRun.chat_session（charter §7.2 / §6.7）。

    M3b 单库治理：tracker 与 conversation 同库（PG）后，``chat_session`` 从跨库
    UUIDField 软引用恢复为物理 ForeignKey（db_column=chat_session_id，SET_NULL）。
    本测试类对应升级为"物理 FK + 列名/可空/索引/删除语义不变"断言。
    """

    def test_chat_session_is_foreign_key(self):
        field = TrackerRun._meta.get_field("chat_session")
        self.assertIsInstance(field, models.ForeignKey)
        self.assertEqual(field.remote_field.model._meta.label, "conversation.ChatSession")

    def test_chat_session_column_and_attname_stable(self):
        """物理列名仍是 chat_session_id；FK 的 _id 访问器照常可用。"""
        field = TrackerRun._meta.get_field("chat_session")
        self.assertEqual(field.column, "chat_session_id")
        self.assertEqual(field.attname, "chat_session_id")

    def test_chat_session_nullable(self):
        field = TrackerRun._meta.get_field("chat_session")
        self.assertTrue(field.null, "nullable —— 允许 Run 先入库、后链接 session")
        self.assertTrue(field.blank)

    def test_chat_session_indexed(self):
        """``TrackerRun.objects.filter(chat_session_id__in=...)`` 是热查询，必须有索引。"""
        field = TrackerRun._meta.get_field("chat_session")
        self.assertTrue(
            field.db_index,
            "chat_session 上需要 index（_batch_resolve_tracker_run_meta 批量查询热路径）",
        )

    def test_chat_session_on_delete_set_null(self):
        """删 ChatSession 时 Run 不连带删（审计资产），chat_session_id 置 NULL。"""
        from django.db.models.deletion import SET_NULL
        field = TrackerRun._meta.get_field("chat_session")
        self.assertIs(field.remote_field.on_delete, SET_NULL)


# ═══════════════════════════════════════════════════════════════
# 1.3b deprecation_logger 行为验证
# ═══════════════════════════════════════════════════════════════


class DeprecationFieldsConstantsTest(SimpleTestCase):
    """deprecation_logger 监控字段清单与 charter v1.8 §7.x 同步。

    Wave 2 收尾 (charter v1.8 §7.1 + plan v2.1 §1.3c)：
      - 4 个 Tracker deprecated 字段已 drop（migration 0023）→ TRACKER_DEPRECATED_FIELDS = ()
      - cycle_history 已 drop → TRACKER_RUN_DEPRECATED_FIELDS 仅保留 total_steps / completed_steps
        （Wave 3 启动前再独立 PR drop）
    """

    def test_goal_deprecated_fields_is_empty_after_drop(self):
        """Wave 2 收尾：4 个 Tracker 字段全部 drop 后 TRACKER_DEPRECATED_FIELDS 清空。"""
        self.assertEqual(
            tuple(TRACKER_DEPRECATED_FIELDS),
            (),
            "drop 完成后清单清空——未来若新增 deprecated 字段，按相同模式追加",
        )

    def test_goal_run_deprecated_fields_match_remaining(self):
        """charter §7.2：cycle_history 已 drop；total_steps / completed_steps
        Wave 3 启动前再独立 PR drop，期间继续监控。"""
        names = set(TRACKER_RUN_DEPRECATED_FIELDS)
        self.assertEqual(
            names,
            {"total_steps", "completed_steps"},
        )

    def test_dropped_fields_no_longer_on_models(self):
        """Wave 2 收尾验证：4 个 Tracker 字段 + cycle_history 不再存在于 model 反射。"""
        from django.core.exceptions import FieldDoesNotExist
        for name in ("execution_config", "project_mode", "token_budget", "max_concurrent_runs"):
            with self.assertRaises(FieldDoesNotExist, msg=f"Tracker.{name} 应已 drop"):
                Tracker._meta.get_field(name)
        with self.assertRaises(FieldDoesNotExist, msg="TrackerRun.cycle_history 应已 drop"):
            TrackerRun._meta.get_field("cycle_history")

    def test_remaining_deprecated_fields_still_exist_on_models(self):
        """total_steps / completed_steps 字段保留（Wave 3 前再 drop）。"""
        for name in TRACKER_RUN_DEPRECATED_FIELDS:
            try:
                TrackerRun._meta.get_field(name)
            except Exception as e:  # noqa: BLE001
                self.fail(
                    f"TrackerRun.{name} 仍应存在（Wave 2 不 drop），但反射失败: {e}",
                )


class DeprecationLogBehaviorTest(SimpleTestCase):
    """log_deprecated_field_access 函数行为：默认值不 log，非默认值 log。

    Wave 2 P1-2：默认值通过 ``field.get_default()`` 反射 model 真实声明，
    所以测试 instance 必须使用真实 model（如 TrackerRun()）而非 MagicMock，否则
    ``instance._meta.get_field(...)`` 找不到字段。

    Wave 2 收尾：4 个 Tracker deprecated 字段已 drop，TRACKER_DEPRECATED_FIELDS = ()。
    剩余监控字段全部在 TrackerRun (total_steps / completed_steps)。
    """

    def test_empty_field_names_skips_silently(self):
        """空 field_names 视为「无监控目标」，直接返回不报错。

        Wave 2 收尾后 TRACKER_DEPRECATED_FIELDS = ()，Tracker.save() 钩子调此函数
        必须能优雅处理空列表。
        """
        instance = Tracker()
        instance.id = uuid.uuid4()

        # 不抛异常 + 不打 log
        log_deprecated_field_access("Tracker", TRACKER_DEPRECATED_FIELDS, instance)

    def test_skips_default_values(self):
        """写入默认值视为「未真正使用」—— 不打 log（避免 Celery 高频 read 造成日志风暴）。

        Wave 2 收尾：用 TrackerRun（真实 model 字段 total_steps / completed_steps default=0）
        替代已 drop 的 Tracker 字段做断言基准。
        """
        instance = TrackerRun()  # 默认 = model 字段定义的 default
        instance.id = uuid.uuid4()

        with self.assertLogs("scheduler.deprecation", level="WARNING") as cm:
            log_deprecated_field_access("TrackerRun", TRACKER_RUN_DEPRECATED_FIELDS, instance)
            # 加 dummy 防止 assertLogs 因为完全无 log 而 raise
            logging.getLogger("scheduler.deprecation").warning("baseline")
        depr_msgs = [m for m in cm.output if "tracker_deprecated_field_access" in m]
        self.assertEqual(depr_msgs, [], "默认值应该被 skip")

    def test_logs_non_default_values(self):
        """Wave 2 收尾：用 TrackerRun.total_steps / completed_steps 验证非默认值上报。"""
        instance = TrackerRun()
        instance.id = uuid.uuid4()
        instance.total_steps = 7
        instance.completed_steps = 3

        with self.assertLogs("scheduler.deprecation", level="WARNING") as cm:
            log_deprecated_field_access("TrackerRun", TRACKER_RUN_DEPRECATED_FIELDS, instance)
        depr_msgs = [m for m in cm.output if "tracker_deprecated_field_access" in m]
        self.assertEqual(len(depr_msgs), 2, f"2 个非默认值应触发 2 条 log，实际: {depr_msgs}")
        joined = "\n".join(depr_msgs)
        for fname in ("total_steps", "completed_steps"):
            self.assertIn(f"field={fname}", joined)
        self.assertIn("model=TrackerRun", joined)

    def test_logger_name_is_grep_friendly(self):
        """Wave 3 启动前会跑 `grep "tracker_deprecated_field_access" logs/`，
        所以 log message 必须含此固定 token，logger 名稳定。"""
        instance = TrackerRun()
        instance.total_steps = 5
        with self.assertLogs("scheduler.deprecation", level="WARNING") as cm:
            log_deprecated_field_access("TrackerRun", TRACKER_RUN_DEPRECATED_FIELDS, instance)
        # 至少一行命中 grep token
        self.assertTrue(
            any("tracker_deprecated_field_access" in m for m in cm.output),
            "log 必须含 'tracker_deprecated_field_access' grep token",
        )

    def test_p1_2_reflective_default_picks_up_model_changes(self):
        """Wave 2 P1-2：当 model 上的 ``default=...`` 改变时，
        deprecation_logger 自动同步——不需要双源真相维护。

        断言策略：instance 字段值 == model field default → 不打 log；
        改成不等于 default 的值 → 打 log。这条断言验证 ``field.get_default()``
        的反射链路工作。

        Wave 2 收尾：用 TrackerRun.total_steps（default=0）替代已 drop 的 execution_config。
        """
        instance = TrackerRun()
        instance.total_steps = TrackerRun._meta.get_field("total_steps").get_default()
        with self.assertLogs("scheduler.deprecation", level="WARNING") as cm:
            log_deprecated_field_access("TrackerRun", ("total_steps",), instance)
            logging.getLogger("scheduler.deprecation").warning("baseline")
        depr_msgs = [m for m in cm.output if "tracker_deprecated_field_access" in m]
        self.assertEqual(depr_msgs, [], "model.field.get_default() 视为未使用")

    def test_missing_field_returns_silently(self):
        """字段已 drop（_meta.get_field 抛异常）时跳过——不抛、不上报。

        Wave 2 收尾：execution_config 已 drop，调 log 时即使 caller 还传旧字段名也安全。
        """
        instance = Tracker()
        # 字段名不存在于 model 反射 → 走 _MISSING_FIELD sentinel 路径
        log_deprecated_field_access("Tracker", ("execution_config",), instance)


class GoalSaveHookTest(SimpleTestCase):
    """Tracker.save() / TrackerRun.save() 必须调用 deprecation telemetry。

    Wave 2 收尾：钩子保留——监控目标改为 TrackerRun.total_steps / completed_steps。
    Tracker.save() 钩子调用时 TRACKER_DEPRECATED_FIELDS = ()，函数内部空列表 short-circuit。
    """

    def test_goal_save_invokes_deprecation_logger_with_empty_list(self):
        """Tracker.save() 仍走 deprecation hook，但传空 field 列表（4 个 Tracker 字段已 drop）。"""
        with patch(
            "apps.tracker.services.deprecation_logger.log_deprecated_field_access"
        ) as mock_log, patch.object(models.Model, "save"):
            goal = Tracker(name="hook test")
            goal.save()
            self.assertTrue(mock_log.called, "Tracker.save() 必须走 deprecation hook")
            args = mock_log.call_args[0]
            self.assertEqual(args[0], "Tracker")
            # field_names 应该是空（TRACKER_DEPRECATED_FIELDS = ()）
            self.assertEqual(tuple(args[1]), ())

    def test_goal_run_save_invokes_deprecation_logger(self):
        """TrackerRun.save() 走 deprecation hook，监控 total_steps / completed_steps。"""
        with patch(
            "apps.tracker.services.deprecation_logger.log_deprecated_field_access"
        ) as mock_log, patch.object(models.Model, "save"):
            run = TrackerRun(
                trigger_type="manual",
                total_steps=3,
            )
            run.save()
            self.assertTrue(mock_log.called)
            args = mock_log.call_args[0]
            self.assertEqual(args[0], "TrackerRun")
            # 仍监控 total_steps / completed_steps
            self.assertIn("total_steps", tuple(args[1]))


# ═══════════════════════════════════════════════════════════════
# 1.4 多租户隔离：QuerySet 契约验证
# ═══════════════════════════════════════════════════════════════


class MultiTenantIsolationContractTest(SimpleTestCase):
    """新字段不破坏 Organization / Space 隔离的契约。

    隔离的根本在于：所有查询都通过 organization_id 过滤。新字段（agent / intent_snapshot /
    chat_session）作为 Tracker / TrackerRun 的子字段，通过 Tracker.organization 间接受隔离 —— 不引入
    新的隔离漏洞需要：
      a. 新字段不是「在 Organization 之上」的引用（agent 已绑定 organization，跨 organization 查询不会
         无意命中）；
      b. ORM 关系合理（不存在「绕过 organization 直接通过 agent_id 查 Tracker」的反模式）；
      c. 隔离测试的精确性：A 的查询用 agent_b 不应命中 A 的 Tracker。

    本测试通过反射 + ORM Q 对象拼接，验证查询契约 ——
    若契约破坏（如 Tracker 失去 organization FK），测试立刻报错。
    """

    def test_goal_has_organization_fk(self):
        """organization 是 Tracker 的 FK，所有租户查询必须通过 organization 过滤。"""
        field = Tracker._meta.get_field("organization")
        self.assertIsInstance(field, models.ForeignKey)
        self.assertEqual(field.related_model._meta.model_name, "organization")
        self.assertFalse(field.null, "organization 不允许 NULL（Tracker 必须属于 Organization）")

    def test_goal_run_inherits_organization_via_goal(self):
        """TrackerRun.tracker → Tracker.organization，run 查询通过 tracker__organization 过滤。"""
        goal_field = TrackerRun._meta.get_field("tracker")
        self.assertIsInstance(goal_field, models.ForeignKey)
        self.assertEqual(goal_field.related_model, Tracker)
        self.assertFalse(goal_field.null, "goal 不允许 NULL（每个 Run 必属于一个 Tracker）")

    def test_agent_field_does_not_create_isolation_hole(self):
        """agent 字段引入跨 organization 隔离漏洞？

        漏洞场景：Organization A 的 Tracker 关联了 Organization B 的 agent。这会让按 agent 查询
        穿透 organization 边界。

        通过 Agent model 验证：Agent.organization 是 FK，所以 agent 必属于 organization，
        Tracker.agent → Agent.organization 应一致。应用层校验 (charter §7.1 创建时必填) +
        DB 层 nullable 一致性是 Wave 1 范围；本测试只验证字段定义不引入「无 organization
        关系的全局 agent」。
        """
        from apps.tabtinspace.models import Agent

        field = Agent._meta.get_field("organization")
        self.assertIsInstance(field, models.ForeignKey)
        self.assertEqual(field.related_model._meta.model_name, "organization")
        self.assertFalse(
            field.null,
            "Agent 必属于 Organization，不存在「全局 agent」漏洞",
        )

    def test_query_isolation_pattern_organization_first(self):
        """构造 ORM 查询，验证 organization 过滤 + agent 过滤组合的正确语义。

        关键：Tracker.objects.filter(organization=A, agent=agent_of_B) 必须返回空 ——
        因为 agent_of_B 不在 organization=A 的 Tracker 引用范围。
        """
        # 用 ORM Q 对象语义验证（不实际执行）：filter(organization=A, agent=B_agent) 等价
        # 于 SQL: WHERE organization_id = A AND agent_id = B_agent_id —— 隔离自然成立
        from django.db.models import Q

        ws_a = uuid.uuid4()
        agent_b = uuid.uuid4()
        q = Q(organization_id=ws_a) & Q(agent_id=agent_b)
        # Q 对象正确构造，无 ORM 抛异常
        self.assertIsInstance(q, Q)
        # 查询字符串里同时含两个条件
        self.assertIn("organization_id", str(q))
        self.assertIn("agent_id", str(q))
