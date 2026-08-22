"""``cli/audit.py`` 单元测试（A2 启动包，PRD-v3 §5.1 第 5 项 + 三视角 Review 修复）。

覆盖：

- **happy**
  - safe / review / strict 三档 PII 脱敏正确（A1-L2 升级验收）
  - HITL 回填 helper 时间戳与字段写入正确（含 timeout 词表）
  - bypass=True 写入正常（N18 / H2-9 预留字段）
  - 复合 index 真实存在（``binary,risk_level`` / ``user_id,created_at`` /
    ``thread_id,created_at`` / ``organization_id,created_at`` / ``organization_id,risk_level``）
  - inner_binary 写入与回读
  - **K7：entry_binary='tabtin' + inner_binary='<some-app-cli>' 顶层与 fork 子进程分别记录**
  - **organization_id / domain / verb 顶层提级写入**
  - 重复回填同一事件（默认拒绝，allow_override=True 才允许覆盖）

- **error / fail-close**
  - PG 不可达（mock ``Manager.create`` 抛 ``OperationalError``）→ 抛 ``CliAuditWriteError``
    （retryable=True）
  - ``spec.to_dict`` 字段缺失 → 拒绝写入（retryable=False）
  - 非法 ``rule_decision`` / ``hitl_user_decision`` → 拒绝
  - 非法 UUID 字符串 → 拒绝
  - HITL 回填不存在的事件 ID → 抛 ``CliAuditWriteError``
  - HITL 回填非 review 路径事件 → 拒绝（业务态校验）
  - HITL 重复回填（无 allow_override）→ 拒绝（幂等约束）

- **edge**
  - thread_id / agent_id / user_id / organization_id 全部为 None 也能写入
  - resource / resource_label 为 None 时 spec_json 仍正确序列化
  - strict 级把 ``<unparsed: ...>`` 与 ``<redacted len=N hash=XXXXXXXX>`` 都压成 ``<redacted>``
  - CliAuditWriteError.retryable 属性正确
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from unittest.mock import patch

from django.db import DatabaseError, OperationalError, connections
from django.test import TransactionTestCase

from apps.services.agent_engine.cli.audit import (
    CliAuditWriteError,
    emit_cli_audit_event,
    update_hitl_decision,
)
from apps.services.agent_engine.cli.models import CliAuditEvent
from apps.services.agent_engine.cli.parser import CliInvocationParser
from apps.services.agent_engine.cli.spec import (
    RISK_REVIEW,
    RISK_SAFE,
    RISK_STRICT,
    CliInvocationSpec,
)


def _spec_review_delete() -> CliInvocationSpec:
    """模拟 A1 parser 输出的 spec：``records delete`` 命中 ``*.delete`` review 规则。

    含 ``--text=...`` 让 A1 parser 已对 PII 做脱敏，方便后续 strict/review 比较。
    """
    return CliInvocationParser().parse(
        'tabtin records delete --table=tbl_demo --text="重要消息内容"'
    )


def _spec_safe(verb: str = "list") -> CliInvocationSpec:
    return CliInvocationParser().parse(f"tabtin records {verb}")


def _spec_strict_unknown_binary() -> CliInvocationSpec:
    """未知 binary → strict（A1 _build_unknown_binary_spec）。"""
    return CliInvocationParser().parse("foo bar baz --secret=hello")


def _spec_strict_create_in_prod() -> CliInvocationSpec:
    """``*.create_in_prod`` 命中 strict 规则。"""
    return CliInvocationParser().parse(
        "tabtin table create_in_prod --name=订单 --password=topsecret"
    )


# =====================================================================
# Happy / 三档 PII 脱敏
# =====================================================================


class HappyPathPiiPolicyTests(TransactionTestCase):
    """三档 PII 脱敏（A1-L2 升级）+ 基础写入回读。"""

    # CliAuditEvent 落 PG，本测试套件不依赖 default(MySQL)。
    # 显式仅声明 postgresql 让 pytest-django / Django test runner 跳过 MySQL 测试库创建。
    databases = {"postgresql"}

    def test_safe_keeps_a1_redaction_unchanged(self):
        """safe 级：A1 已脱敏，audit 不再二次处理。"""
        spec = _spec_safe()  # raw_args 通常无 PII（list 命令），但用 spec dict 验证 raw_args 原样回写
        event = emit_cli_audit_event(
            spec,
            thread_id=uuid.uuid4(),
            agent_id=uuid.uuid4(),
            user_id=uuid.uuid4(),
            rule_decision="allow",
            hitl_required=False,
        )
        self.assertEqual(event.risk_level, RISK_SAFE)
        # raw_args 原样回写（A1 没脱敏，audit 也没二次处理）
        self.assertEqual(event.spec_json["raw_args"], spec.to_dict()["raw_args"])

    def test_review_preserves_hash_and_length(self):
        """review 级：保留 hash 前 8 位 + 长度，便于审计反查。"""
        spec = _spec_review_delete()
        # 前置断言：A1 parser 已经把 --text 脱敏成 hash+length
        text_arg = next(a for a in spec.raw_args if a.startswith("--text="))
        self.assertIn("<redacted len=", text_arg)
        self.assertIn("hash=", text_arg)
        # ── audit 写入 ──
        event = emit_cli_audit_event(
            spec,
            thread_id=uuid.uuid4(),
            agent_id=uuid.uuid4(),
            user_id=uuid.uuid4(),
            rule_decision="review",
            hitl_required=True,
        )
        self.assertEqual(event.risk_level, RISK_REVIEW)
        # spec_json.raw_args 中 --text 仍保留 hash + length（review 不二次处理）
        stored_text = next(
            a for a in event.spec_json["raw_args"] if a.startswith("--text=")
        )
        self.assertIn("<redacted len=", stored_text)
        self.assertIn("hash=", stored_text)

    def test_strict_strips_length_and_hash(self):
        """strict 级：完全隐藏长度，仅保留字段名 + ``<redacted>``。"""
        spec = _spec_strict_create_in_prod()
        # 前置：A1 已对 --password 做 hash+length 脱敏
        pwd_arg = next(a for a in spec.raw_args if a.startswith("--password="))
        self.assertIn("<redacted len=", pwd_arg)

        event = emit_cli_audit_event(
            spec,
            thread_id=uuid.uuid4(),
            agent_id=uuid.uuid4(),
            user_id=uuid.uuid4(),
            rule_decision="deny",
            hitl_required=False,
        )
        self.assertEqual(event.risk_level, RISK_STRICT)
        stored_pwd = next(
            a for a in event.spec_json["raw_args"] if a.startswith("--password=")
        )
        # strict 级抹掉 len 与 hash，只剩 <redacted>
        self.assertEqual(stored_pwd, "--password=<redacted>")
        # 命令骨架（--name / 业务参数）保留 — strict 不丢命令结构，只丢 PII value
        joined = " ".join(event.spec_json["raw_args"])
        self.assertIn("--name", joined)

    def test_strict_strips_unparsed_placeholder(self):
        """strict 级：A1 ``<unparsed: reason=... length=N>`` 也压成 ``<redacted>``。"""
        # 通过 emit_cli_audit_event 不太好造 unparsed spec（需要构造特殊 spec），
        # 这里直接构造一个 strict spec 含 unparsed placeholder
        spec = CliInvocationSpec(
            binary="<unparsed>",
            domain="<unparsed>",
            verb="shlex_error:ValueError",
            risk_level=RISK_STRICT,
            raw_args=["<unparsed: reason=shlex_error length=42>"],
            matched_rule_pattern="",
            matched_rule_reason="parse failed",
        )
        event = emit_cli_audit_event(
            spec,
            thread_id=uuid.uuid4(),
            agent_id=None,
            user_id=None,
            rule_decision="deny",
            hitl_required=False,
        )
        self.assertEqual(event.spec_json["raw_args"], ["<redacted>"])


# =====================================================================
# Happy / 字段完整性 + inner_binary + bypass
# =====================================================================


class HappyPathFieldWritingTests(TransactionTestCase):
    """字段写入与回读（K7 顶层 binary + inner_binary + organization_id + domain/verb）。"""

    databases = {"postgresql"}

    def test_k7_entry_binary_separates_user_entry_from_fork_subprocess(self):
        """**K7 核心场景**：``tabtin <wrapper> records delete`` → 用户入口 binary='tabtin'，
        fork 子进程 inner_binary='<某 marketplace app cli>'。

        这是 PRD §5.1 第 5 项 + §7.1 验收 SQL ``WHERE binary='tabtin' AND
        inner_binary='<some-app-cli>'`` 的关键路径。三视角 Review P0-2 修复。
        """
        spec = CliInvocationParser().parse(
            "tabtin records delete --table=tbl_demo --text=hi"
        )
        # 前置：parser 解析后 spec.binary='tabtin'
        self.assertEqual(spec.binary, "tabtin")

        event = emit_cli_audit_event(
            spec,
            thread_id=uuid.uuid4(),
            agent_id=uuid.uuid4(),
            user_id=uuid.uuid4(),
            rule_decision="review",
            hitl_required=True,
            entry_binary="tabtin",  # K7：用户最外层入口
            inner_binary="some-app-cli",  # K7：fork 子进程
        )
        # 顶层 binary 字段 = 用户入口（满足 PRD §7.1 验收 SQL）
        self.assertEqual(event.binary, "tabtin")
        self.assertEqual(event.inner_binary, "some-app-cli")
        # spec_json 仍保留 spec.binary 完整记录便于审计反查
        self.assertEqual(event.spec_json["binary"], "tabtin")
        # 重读校验
        refreshed = CliAuditEvent.objects.get(id=event.id)
        self.assertEqual(refreshed.binary, "tabtin")
        self.assertEqual(refreshed.inner_binary, "some-app-cli")

    def test_entry_binary_fallback_to_spec_binary_when_omitted(self):
        """未传 entry_binary 时 fallback 到 spec.binary（向后兼容简单场景）。"""
        spec = CliInvocationParser().parse("tabtin records list")
        event = emit_cli_audit_event(
            spec,
            thread_id=uuid.uuid4(),
            agent_id=uuid.uuid4(),
            user_id=uuid.uuid4(),
            rule_decision="allow",
            hitl_required=False,
        )
        self.assertEqual(event.binary, "tabtin")
        self.assertIsNone(event.inner_binary)

    def test_organization_id_persisted_for_pii_isolation(self):
        """**P0-1 修复**：organization_id 顶层字段写入，满足 PRD §5.5 PII 隔离要求。"""
        spec = CliInvocationParser().parse("tabtin records list")
        wt_id = uuid.uuid4()
        event = emit_cli_audit_event(
            spec,
            thread_id=uuid.uuid4(),
            agent_id=uuid.uuid4(),
            user_id=uuid.uuid4(),
            organization_id=wt_id,
            rule_decision="allow",
            hitl_required=False,
        )
        self.assertEqual(event.organization_id, wt_id)
        # AdminDash 主查询路径：按 organization_id 过滤
        self.assertTrue(
            CliAuditEvent.objects.filter(organization_id=wt_id).exists()
        )

    def test_domain_and_verb_persisted_at_top_level(self):
        """**P1-2 修复**：domain / verb 顶层提级，AdminDash 统计无需 JSONB 解析。"""
        spec = CliInvocationParser().parse(
            "tabtin records delete --table=tbl_x --text=hi"
        )
        event = emit_cli_audit_event(
            spec,
            thread_id=uuid.uuid4(),
            agent_id=uuid.uuid4(),
            user_id=uuid.uuid4(),
            rule_decision="review",
            hitl_required=True,
        )
        self.assertEqual(event.domain, "records")
        self.assertEqual(event.verb, "delete")
        # AdminDash 按 domain/verb 统计直接走顶层 + index
        self.assertEqual(
            CliAuditEvent.objects.filter(domain="records", verb="delete").count(),
            1,
        )

    def test_bypass_true_writes_normally(self):
        """N18：bypass=True（直跑被 shim 接管的场景）正常写入。"""
        spec = _spec_safe()
        event = emit_cli_audit_event(
            spec,
            thread_id=uuid.uuid4(),
            agent_id=uuid.uuid4(),
            user_id=uuid.uuid4(),
            rule_decision="allow",
            hitl_required=False,
            bypass=True,
        )
        self.assertTrue(event.bypass)
        refreshed = CliAuditEvent.objects.get(id=event.id)
        self.assertTrue(refreshed.bypass)

    def test_spec_json_contains_matched_rule_metadata(self):
        """``matched_rule_pattern`` / ``matched_rule_reason`` 进 spec_json，
        便于审计页"为什么是这个 risk"反查。"""
        spec = _spec_review_delete()
        event = emit_cli_audit_event(
            spec,
            thread_id=uuid.uuid4(),
            agent_id=uuid.uuid4(),
            user_id=uuid.uuid4(),
            rule_decision="review",
            hitl_required=True,
        )
        self.assertEqual(event.spec_json["matched_rule_pattern"], "*.delete")
        self.assertTrue(event.spec_json["matched_rule_reason"])

    def test_resource_and_label_serialized_when_none(self):
        """resource / resource_label 为 None 时也能正确写入 spec_json。"""
        spec = _spec_safe()  # 不带 resource flag
        self.assertIsNone(spec.resource)
        event = emit_cli_audit_event(
            spec,
            thread_id=uuid.uuid4(),
            agent_id=uuid.uuid4(),
            user_id=uuid.uuid4(),
            rule_decision="allow",
            hitl_required=False,
        )
        self.assertIsNone(event.spec_json["resource"])
        self.assertIsNone(event.spec_json["resource_label"])


# =====================================================================
# Happy / HITL 回填
# =====================================================================


class HitlDecisionUpdateTests(TransactionTestCase):
    databases = {"postgresql"}

    def test_update_hitl_decision_writes_three_fields(self):
        spec = _spec_review_delete()
        event = emit_cli_audit_event(
            spec,
            thread_id=uuid.uuid4(),
            agent_id=uuid.uuid4(),
            user_id=uuid.uuid4(),
            rule_decision="review",
            hitl_required=True,
        )
        self.assertIsNone(event.hitl_user_decision)

        decided_by = uuid.uuid4()
        decided_at = datetime(2026, 4, 17, 12, 30, 0, tzinfo=timezone.utc)
        refreshed = update_hitl_decision(
            event.id,
            user_decision="allow",
            decided_by=decided_by,
            decided_at=decided_at,
        )
        self.assertEqual(refreshed.hitl_user_decision, "allow")
        self.assertEqual(refreshed.hitl_decided_by, decided_by)
        self.assertEqual(refreshed.hitl_decided_at, decided_at)
        # rule_decision 不被改写
        self.assertEqual(refreshed.rule_decision, "review")

    def test_update_hitl_decision_accepts_str_uuid(self):
        spec = _spec_review_delete()
        event = emit_cli_audit_event(
            spec,
            thread_id=uuid.uuid4(),
            agent_id=uuid.uuid4(),
            user_id=uuid.uuid4(),
            rule_decision="review",
            hitl_required=True,
        )
        decided_by_str = str(uuid.uuid4())
        decided_at = datetime.now(timezone.utc)
        refreshed = update_hitl_decision(
            str(event.id),
            user_decision="deny",
            decided_by=decided_by_str,
            decided_at=decided_at,
        )
        self.assertEqual(refreshed.hitl_user_decision, "deny")
        self.assertEqual(str(refreshed.hitl_decided_by), decided_by_str)

    def test_update_hitl_decision_accepts_timeout_value(self):
        """**P1-7 修复**：HITL 词表扩展支持 timeout（PRD §5.1 第 6 项三种 tool result 路径）。"""
        spec = _spec_review_delete()
        event = emit_cli_audit_event(
            spec,
            thread_id=uuid.uuid4(),
            agent_id=uuid.uuid4(),
            user_id=uuid.uuid4(),
            rule_decision="review",
            hitl_required=True,
        )
        refreshed = update_hitl_decision(
            event.id,
            user_decision="timeout",
            decided_by=uuid.uuid4(),
            decided_at=datetime.now(timezone.utc),
        )
        self.assertEqual(refreshed.hitl_user_decision, "timeout")

    def test_update_hitl_rejects_duplicate_without_override(self):
        """**P1-4 修复**：重复回填默认拒绝（防止两个 admin 并发覆盖）。"""
        spec = _spec_review_delete()
        event = emit_cli_audit_event(
            spec,
            thread_id=uuid.uuid4(),
            agent_id=uuid.uuid4(),
            user_id=uuid.uuid4(),
            rule_decision="review",
            hitl_required=True,
        )
        # 第一次回填 OK
        update_hitl_decision(
            event.id,
            user_decision="allow",
            decided_by=uuid.uuid4(),
            decided_at=datetime.now(timezone.utc),
        )
        # 第二次（不同 admin）默认拒绝
        with self.assertRaises(CliAuditWriteError) as ctx:
            update_hitl_decision(
                event.id,
                user_decision="deny",
                decided_by=uuid.uuid4(),
                decided_at=datetime.now(timezone.utc),
            )
        self.assertIn("已有 HITL 决策", str(ctx.exception))
        self.assertFalse(ctx.exception.retryable)
        # DB 未被覆盖
        self.assertEqual(
            CliAuditEvent.objects.get(id=event.id).hitl_user_decision, "allow"
        )

    def test_update_hitl_allows_override_when_explicit(self):
        """allow_override=True 时允许覆盖（如 timeout 自动转 deny / admin 显式重判）。"""
        spec = _spec_review_delete()
        event = emit_cli_audit_event(
            spec,
            thread_id=uuid.uuid4(),
            agent_id=uuid.uuid4(),
            user_id=uuid.uuid4(),
            rule_decision="review",
            hitl_required=True,
        )
        update_hitl_decision(
            event.id,
            user_decision="allow",
            decided_by=uuid.uuid4(),
            decided_at=datetime.now(timezone.utc),
        )
        new_decided_by = uuid.uuid4()
        refreshed = update_hitl_decision(
            event.id,
            user_decision="deny",
            decided_by=new_decided_by,
            decided_at=datetime.now(timezone.utc),
            allow_override=True,
        )
        self.assertEqual(refreshed.hitl_user_decision, "deny")
        self.assertEqual(refreshed.hitl_decided_by, new_decided_by)

    def test_update_hitl_rejects_non_review_path_event(self):
        """**P1-9 业务态校验**：rule_decision != 'review' 的事件不能走 HITL 回填。"""
        spec = _spec_safe()  # safe 路径，自动 allow，不走 HITL
        event = emit_cli_audit_event(
            spec,
            thread_id=uuid.uuid4(),
            agent_id=uuid.uuid4(),
            user_id=uuid.uuid4(),
            rule_decision="allow",
            hitl_required=False,
        )
        with self.assertRaises(CliAuditWriteError) as ctx:
            update_hitl_decision(
                event.id,
                user_decision="allow",
                decided_by=uuid.uuid4(),
                decided_at=datetime.now(timezone.utc),
            )
        self.assertIn("非 review 路径事件", str(ctx.exception))
        self.assertFalse(ctx.exception.retryable)


# =====================================================================
# Error / fail-close
# =====================================================================


class FailCloseOnDbErrorTests(TransactionTestCase):
    databases = {"postgresql"}

    def test_emit_raises_on_operational_error(self):
        """PG 不可达：必须抛 ``CliAuditWriteError`` 而不是静默吞异常。
        **P1-5 修复**：retryable=True（DB 短时故障可重试）。"""
        spec = _spec_review_delete()
        with patch.object(
            CliAuditEvent.objects,
            "create",
            side_effect=OperationalError("connection refused"),
        ):
            with self.assertRaises(CliAuditWriteError) as ctx:
                emit_cli_audit_event(
                    spec,
                    thread_id=uuid.uuid4(),
                    agent_id=uuid.uuid4(),
                    user_id=uuid.uuid4(),
                    rule_decision="review",
                    hitl_required=True,
                )
        # 异常 cause 必须指向 OperationalError，便于上层日志追溯
        self.assertIsInstance(ctx.exception.__cause__, OperationalError)
        self.assertIn("PG 写入 cli_audit_event 失败", str(ctx.exception))
        # retryable=True 表示 DB 短时故障可重试
        self.assertTrue(ctx.exception.retryable)

    def test_emit_raises_on_database_error(self):
        spec = _spec_review_delete()
        with patch.object(
            CliAuditEvent.objects,
            "create",
            side_effect=DatabaseError("transaction aborted"),
        ):
            with self.assertRaises(CliAuditWriteError) as ctx:
                emit_cli_audit_event(
                    spec,
                    thread_id=uuid.uuid4(),
                    agent_id=uuid.uuid4(),
                    user_id=uuid.uuid4(),
                    rule_decision="review",
                    hitl_required=True,
                )
        self.assertTrue(ctx.exception.retryable)  # DB 异常可重试

    def test_emit_raises_on_unexpected_exception(self):
        """未预期异常（如 router 配置错）也必须 fail-close。
        retryable=False（结构性问题重试无意义）。"""
        spec = _spec_review_delete()
        with patch.object(
            CliAuditEvent.objects,
            "create",
            side_effect=RuntimeError("router misconfigured"),
        ):
            with self.assertRaises(CliAuditWriteError) as ctx:
                emit_cli_audit_event(
                    spec,
                    thread_id=uuid.uuid4(),
                    agent_id=uuid.uuid4(),
                    user_id=uuid.uuid4(),
                    rule_decision="review",
                    hitl_required=True,
                )
        self.assertFalse(ctx.exception.retryable)

    def test_update_hitl_raises_on_missing_event(self):
        nonexistent_id = uuid.uuid4()
        with self.assertRaises(CliAuditWriteError) as ctx:
            update_hitl_decision(
                nonexistent_id,
                user_decision="allow",
                decided_by=uuid.uuid4(),
                decided_at=datetime.now(timezone.utc),
            )
        self.assertIn("不存在", str(ctx.exception))
        self.assertFalse(ctx.exception.retryable)  # 业务态错误，不可重试


# =====================================================================
# Error / spec / 枚举校验
# =====================================================================


class SpecValidationTests(TransactionTestCase):
    databases = {"postgresql"}

    def test_emit_raises_on_spec_none(self):
        with self.assertRaises(CliAuditWriteError):
            emit_cli_audit_event(
                None,  # type: ignore[arg-type]
                thread_id=uuid.uuid4(),
                agent_id=uuid.uuid4(),
                user_id=uuid.uuid4(),
                rule_decision="allow",
                hitl_required=False,
            )

    def test_emit_raises_when_to_dict_missing_required_field(self):
        """spec.to_dict 必须含 binary/domain/verb/risk_level/raw_args；缺一拒绝写入。"""
        # 注入一个返回不完整 dict 的假 to_dict（patch 实例方法）
        class _FakeSpec:
            binary = "tabtin"
            domain = "records"
            verb = "list"

            def to_dict(self):
                return {"binary": "tabtin"}  # 缺 domain / verb / risk_level / raw_args

        with self.assertRaises(CliAuditWriteError) as ctx:
            emit_cli_audit_event(
                _FakeSpec(),  # type: ignore[arg-type]
                thread_id=uuid.uuid4(),
                agent_id=uuid.uuid4(),
                user_id=uuid.uuid4(),
                rule_decision="allow",
                hitl_required=False,
            )
        self.assertIn("缺少必备字段", str(ctx.exception))

    def test_emit_raises_when_to_dict_returns_non_dict(self):
        class _BadSpec:
            binary = "x"
            domain = "y"
            verb = "z"

            def to_dict(self):
                return "not-a-dict"

        with self.assertRaises(CliAuditWriteError):
            emit_cli_audit_event(
                _BadSpec(),  # type: ignore[arg-type]
                thread_id=uuid.uuid4(),
                agent_id=uuid.uuid4(),
                user_id=uuid.uuid4(),
                rule_decision="allow",
                hitl_required=False,
            )

    def test_emit_raises_on_invalid_rule_decision(self):
        spec = _spec_safe()
        with self.assertRaises(CliAuditWriteError) as ctx:
            emit_cli_audit_event(
                spec,
                thread_id=uuid.uuid4(),
                agent_id=uuid.uuid4(),
                user_id=uuid.uuid4(),
                rule_decision="approve",  # 非法
                hitl_required=False,
            )
        self.assertIn("rule_decision", str(ctx.exception))

    def test_emit_raises_on_invalid_hitl_user_decision(self):
        spec = _spec_review_delete()
        with self.assertRaises(CliAuditWriteError):
            emit_cli_audit_event(
                spec,
                thread_id=uuid.uuid4(),
                agent_id=uuid.uuid4(),
                user_id=uuid.uuid4(),
                rule_decision="review",
                hitl_required=True,
                hitl_user_decision="maybe",  # 非法
            )

    def test_emit_raises_on_invalid_uuid_str(self):
        spec = _spec_safe()
        with self.assertRaises(CliAuditWriteError) as ctx:
            emit_cli_audit_event(
                spec,
                thread_id="not-a-uuid",  # type: ignore[arg-type]
                agent_id=uuid.uuid4(),
                user_id=uuid.uuid4(),
                rule_decision="allow",
                hitl_required=False,
            )
        self.assertIn("thread_id", str(ctx.exception))

    def test_update_hitl_raises_on_invalid_decision(self):
        spec = _spec_review_delete()
        event = emit_cli_audit_event(
            spec,
            thread_id=uuid.uuid4(),
            agent_id=uuid.uuid4(),
            user_id=uuid.uuid4(),
            rule_decision="review",
            hitl_required=True,
        )
        with self.assertRaises(CliAuditWriteError):
            update_hitl_decision(
                event.id,
                user_decision="approve",  # 非法
                decided_by=uuid.uuid4(),
                decided_at=datetime.now(timezone.utc),
            )

    def test_update_hitl_raises_when_decided_by_none(self):
        spec = _spec_review_delete()
        event = emit_cli_audit_event(
            spec,
            thread_id=uuid.uuid4(),
            agent_id=uuid.uuid4(),
            user_id=uuid.uuid4(),
            rule_decision="review",
            hitl_required=True,
        )
        with self.assertRaises(CliAuditWriteError):
            update_hitl_decision(
                event.id,
                user_decision="allow",
                decided_by=None,  # 必填
                decided_at=datetime.now(timezone.utc),
            )


# =====================================================================
# Edge / 上下文 ID 全为 None / 索引验证
# =====================================================================


class EdgeCaseTests(TransactionTestCase):
    databases = {"postgresql"}

    def test_all_context_ids_can_be_none(self):
        """A5 之前若 fork 上下文未拿到 thread/agent/user/organization，仍允许写审计
        （有总比无好；缺失追溯能力降级，但 fail-close 主路径不变）。"""
        spec = _spec_safe()
        event = emit_cli_audit_event(
            spec,
            thread_id=None,
            agent_id=None,
            user_id=None,
            organization_id=None,
            rule_decision="allow",
            hitl_required=False,
        )
        self.assertIsNone(event.thread_id)
        self.assertIsNone(event.agent_id)
        self.assertIsNone(event.user_id)
        self.assertIsNone(event.organization_id)
        # 重读校验：序列化进 PG 后回读仍是 None
        refreshed = CliAuditEvent.objects.get(id=event.id)
        self.assertIsNone(refreshed.thread_id)
        self.assertIsNone(refreshed.organization_id)

    def test_cli_audit_write_error_default_retryable(self):
        """**P1-5**：CliAuditWriteError 默认 retryable=False（业务态保守）；
        DB fail-close 路径需要显式 retryable=True。"""
        from apps.services.agent_engine.cli.audit import CliAuditWriteError as Err

        e1 = Err("default")
        self.assertFalse(e1.retryable)
        e2 = Err("dbfail", retryable=True)
        self.assertTrue(e2.retryable)
        # cause 与 __cause__ 都能用
        try:
            raise ValueError("inner")
        except ValueError as inner:
            e3 = Err("wrap", cause=inner)
            self.assertIs(e3.cause, inner)

    def test_unknown_risk_level_in_spec_json_falls_close_to_strict_redaction(self):
        """spec_json 含未知 risk_level（防御性）：fail-close 按 strict 处理。
        正常情况下 spec.__post_init__ 已拦截非法 risk_level，本测试覆盖
        "spec 被绕过 / 篡改" 的极端路径，确保 emit_cli_audit_event 不会把
        非法 risk_level 写库。"""
        spec = _spec_safe()
        with self.assertRaises(CliAuditWriteError) as ctx:
            # 直接 mock to_dict 返回非法 risk_level
            with patch.object(
                spec.__class__,
                "to_dict",
                return_value={
                    "binary": "tabtin",
                    "domain": "records",
                    "verb": "list",
                    "risk_level": "danger",  # 非法
                    "raw_args": [],
                    "resource": None,
                    "resource_label": None,
                    "matched_rule_pattern": "",
                    "matched_rule_reason": "",
                },
            ):
                emit_cli_audit_event(
                    spec,
                    thread_id=uuid.uuid4(),
                    agent_id=uuid.uuid4(),
                    user_id=uuid.uuid4(),
                    rule_decision="allow",
                    hitl_required=False,
                )
        self.assertIn("risk_level", str(ctx.exception))


class IndexExistenceTests(TransactionTestCase):
    """复合 index 真实存在于 ``cli_audit_event`` 表（PRD §5.1 第 5 项验收必查）。

    使用 Django 的 ``connection.introspection.get_constraints`` 抽象
    （sqlite / PG / MySQL 均支持），既能在 USE_SQLITE_FOR_TESTS=1 的本地测试
    中跑通，也能在真实 PG（USE_SQLITE_FOR_TESTS=0 + manage.py migrate
    --database=postgresql）的 staging / CI 环境验证。

    PG-specific 的 ``pg_indexes`` 验证由 prompt §2 验收脚本（``python -c ...``）
    在 staging 环境单独触达，不在 pytest 内重复。
    """

    databases = {"postgresql"}

    def test_compound_indexes_exist_via_introspection(self):
        """复合 index 必须真实落到 DB（防止 Meta.indexes 写了但 migration 未跑）。
        **P0-1 修复后**：5 个复合 index（增加 (organization_id, created_at) +
        (organization_id, risk_level)）。"""
        conn = connections["postgresql"]
        with conn.cursor() as cur:
            constraints = conn.introspection.get_constraints(cur, "cli_audit_event")

        # 提取所有"非主键 + 非 unique"的 index（复合 index）
        index_columns = {
            name: tuple(meta["columns"])
            for name, meta in constraints.items()
            if meta.get("index") and not meta.get("primary_key") and not meta.get("unique")
        }

        # 五个复合 index 必须真实存在 + 列序正确
        self.assertEqual(
            index_columns.get("idx_cliaudit_bin_risk"),
            ("binary", "risk_level"),
            f"idx_cliaudit_bin_risk 列序不匹配，实际 indexes: "
            f"{sorted(index_columns.items())}",
        )
        self.assertEqual(
            index_columns.get("idx_cliaudit_user_created"),
            ("user_id", "created_at"),
        )
        self.assertEqual(
            index_columns.get("idx_cliaudit_thread_created"),
            ("thread_id", "created_at"),
        )
        # P0-1：organization 维度复合 index（PRD §5.5 PII 隔离主路径）
        self.assertEqual(
            index_columns.get("idx_cliaudit_wt_created"),
            ("organization_id", "created_at"),
        )
        self.assertEqual(
            index_columns.get("idx_cliaudit_wt_risk"),
            ("organization_id", "risk_level"),
        )

    def test_top_level_indexes_present(self):
        """N10 决策：``binary`` / ``risk_level`` / ``created_at`` 单列 index 也必须存在
        （让 AdminDash "按 binary 排序"、"按 risk_level 分桶"、"按时间窗" 三种独立查询走 index）。
        **P1-1 / P1-2 修复后**：``inner_binary`` / ``domain`` / ``verb`` 也加 index。"""
        conn = connections["postgresql"]
        with conn.cursor() as cur:
            constraints = conn.introspection.get_constraints(cur, "cli_audit_event")

        # 所有"index 覆盖单列"的集合（含 db_index=True 自动生成的）
        single_col_indexed = {
            tuple(meta["columns"])[0]
            for meta in constraints.values()
            if meta.get("index")
            and not meta.get("primary_key")
            and not meta.get("unique")
            and len(meta.get("columns", [])) == 1
        }
        for col in (
            "binary",
            "risk_level",
            "created_at",
            "inner_binary",  # P1-1
            "domain",  # P1-2
            "verb",  # P1-2
        ):
            self.assertIn(
                col,
                single_col_indexed,
                f"{col} 必须有单列 index（N10/P1 决策），实际单列 index: "
                f"{sorted(single_col_indexed)}",
            )
