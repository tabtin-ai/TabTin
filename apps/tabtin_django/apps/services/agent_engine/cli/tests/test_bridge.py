"""``wrap_as_cli_invocation_spec`` schema 桥接 helper 单元测试。

PRD-v3 §5.1 第 2 项：把 Extension 的 ``CliCommandDescriptor`` 适配为 ``CliInvocationSpec``。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional

import pytest

from apps.extensions.base import CliCommandDescriptor, CliOptionDescriptor

from apps.services.agent_engine.cli.parser import wrap_as_cli_invocation_spec
from apps.services.agent_engine.cli.spec import (
    RISK_REVIEW,
    RISK_SAFE,
    RISK_STRICT,
    CliInvocationSpec,
)


# ── happy ────────────────────────────────────────────────────────


def test_happy_basic_descriptor_to_spec():
    """既有 ``CliCommandDescriptor``（无 risk_level）→ fallback 到 review。"""
    desc = CliCommandDescriptor(
        name="send",
        description="发送消息",
        api_endpoint="/api/extensions/linear/issues/send",
    )
    spec = wrap_as_cli_invocation_spec("linear", desc)
    assert isinstance(spec, CliInvocationSpec)
    assert spec.binary == "tabtin"
    assert spec.domain == "linear"
    assert spec.verb == "send"
    assert spec.risk_level == RISK_REVIEW  # 老 Extension 不填 risk_level → review fallback
    assert spec.raw_args == []
    assert spec.resource is None


def test_happy_with_options_and_runtime_data():
    desc = CliCommandDescriptor(
        name="list",
        description="列出记录",
        api_endpoint="/api/extensions/linear/issues/list",
        options=[CliOptionDescriptor(flag="--limit <n>", description="数量")],
    )
    spec = wrap_as_cli_invocation_spec(
        "linear",
        desc,
        raw_args=["--limit", "10"],
        parsed_resource="table:tbl_demo",
        resource_label="演示表",
    )
    assert spec.domain == "linear"
    assert spec.verb == "list"
    assert spec.raw_args == ["--limit", "10"]
    assert spec.resource == "table:tbl_demo"
    assert spec.resource_label == "演示表"


def test_happy_descriptor_with_explicit_risk_level_attr():
    """向后兼容：未来 ``CliCommandDescriptor`` 加上 ``risk_level`` 字段时（PRD §5.1 第 2 项），
    桥接 helper 必须使用其值，不再 fallback。"""

    @dataclass(frozen=True)
    class _FutureCliCommandDescriptor:
        name: str
        description: str = ""
        api_endpoint: str = ""
        method: str = "POST"
        options: List = field(default_factory=list)
        risk_level: Optional[str] = None  # PRD §5.1 第 2 项约定的新字段

    desc = _FutureCliCommandDescriptor(
        name="send",
        description="发送",
        risk_level=RISK_SAFE,
    )
    spec = wrap_as_cli_invocation_spec("linear", desc)
    assert spec.risk_level == RISK_SAFE


def test_happy_descriptor_strict_risk_level_preserved():
    @dataclass(frozen=True)
    class _StrictDescriptor:
        name: str
        risk_level: Optional[str] = RISK_STRICT

    desc = _StrictDescriptor(name="purge_all")
    spec = wrap_as_cli_invocation_spec("danger_app", desc)
    assert spec.risk_level == RISK_STRICT
    assert spec.domain == "danger_app"


# ── error ────────────────────────────────────────────────────────


def test_error_missing_extension_id_raises():
    desc = CliCommandDescriptor(
        name="send", description="x", api_endpoint="/x"
    )
    with pytest.raises(ValueError, match="extension_id"):
        wrap_as_cli_invocation_spec("", desc)


def test_error_none_descriptor_raises():
    with pytest.raises(ValueError, match="descriptor"):
        wrap_as_cli_invocation_spec("linear", None)  # type: ignore[arg-type]


def test_error_descriptor_with_empty_name_raises():
    desc = CliCommandDescriptor(
        name="", description="无名子命令", api_endpoint="/x"
    )
    with pytest.raises(ValueError, match="descriptor.name"):
        wrap_as_cli_invocation_spec("linear", desc)


def test_error_descriptor_with_invalid_risk_level_raises():
    """如果 descriptor 上有 risk_level 但不在词表内，spec ``__post_init__`` 必须拒绝。

    防御性：未来若 Extension 端 typo（如 ``"low"``），不能让坏数据穿过桥接到 PermissionRule。

    本测试形式上断言的是 ``CliInvocationSpec`` 的校验，但归类为 bridge 测试是因为 bridge
    helper 是 Extension descriptor 进入 spec 词表的**唯一入口**，一旦该入口失守
    所有审计/HITL 都会拿到 typo'd risk_level，所以由 bridge 一并守护。"""
    @dataclass(frozen=True)
    class _BadDescriptor:
        name: str
        risk_level: Optional[str] = "low"  # K8 已废弃

    with pytest.raises(ValueError, match="risk_level"):
        wrap_as_cli_invocation_spec("linear", _BadDescriptor(name="send"))


# ── edge ────────────────────────────────────────────────────────


def test_edge_raw_args_copied_not_shared():
    """``raw_args`` 必须 copy in，避免外部 mutate 影响 spec 内部状态。"""
    desc = CliCommandDescriptor(
        name="send", description="x", api_endpoint="/x"
    )
    args = ["--table=tbl_x", "--text=hi"]
    spec = wrap_as_cli_invocation_spec("linear", desc, raw_args=args)
    args.append("--evil=injected")
    assert "--evil=injected" not in spec.raw_args


def test_edge_extension_id_used_as_domain():
    """``extension_id → domain`` 隐式映射（PRD §5.1 第 2 项第 1 条）。"""
    desc = CliCommandDescriptor(
        name="send", description="x", api_endpoint="/x"
    )
    for ext_id in ("github", "github_actions", "linear", "demo_app"):
        spec = wrap_as_cli_invocation_spec(ext_id, desc)
        assert spec.domain == ext_id


def test_edge_bridge_grammar_key_two_segments():
    """桥接产出的 spec 是 ``binary='tabtin'``（Extension proxy 模式 = ``tabtin {ext} {verb}``），
    所以 grammar_key 统一走二段公式 ``<extension_id>.<verb>`` = ``"linear.send"``。

    与 parser 直接解析 ``"tabtin records send"`` 产生的二段 grammar_key
    （``"records.send"``）保持一致语义：grammar_key 永远是 ``<domain>.<verb>``，
    domain 由 extension_id 或 parser 解析的 domain 字段提供。
    """
    desc = CliCommandDescriptor(
        name="send", description="x", api_endpoint="/x"
    )
    spec_via_bridge = wrap_as_cli_invocation_spec("linear", desc)
    assert spec_via_bridge.grammar_key == "linear.send"
    assert spec_via_bridge.binary == "tabtin"


def test_edge_bridge_redacts_raw_args_by_default():
    """P1-5 修复：默认 ``redact=True``，避免调用方传入未脱敏 argv 直接进入审计。"""
    desc = CliCommandDescriptor(
        name="send", description="x", api_endpoint="/x"
    )
    spec = wrap_as_cli_invocation_spec(
        "linear",
        desc,
        raw_args=["--text=mysecret", "--user-id=usr_x"],
    )
    text_arg = next(arg for arg in spec.raw_args if arg.startswith("--text="))
    assert "mysecret" not in text_arg
    assert "<redacted len=8 hash=" in text_arg
    # 非敏感 flag 保持原样
    assert "--user-id=usr_x" in spec.raw_args


def test_edge_bridge_redact_opt_out():
    """显式 ``redact=False`` 时 helper 不再处理（用于已脱敏链路二次包装）。"""
    desc = CliCommandDescriptor(
        name="send", description="x", api_endpoint="/x"
    )
    spec = wrap_as_cli_invocation_spec(
        "linear",
        desc,
        raw_args=["--text=already-sanitized-by-caller"],
        redact=False,
    )
    assert spec.raw_args == ["--text=already-sanitized-by-caller"]
