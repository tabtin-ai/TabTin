"""
AgentMode Contract — Python mirror of `packages/agent-runtime/agent-mode-contract.json`.

设计动机
---------
本地 Agent Runtime（TS）与 Django 后端（Python）需要对 AgentMode → 工具白名单
/ prompt 段保持完全一致的认知，否则同一份用户消息走不同链路会出现行为差异：

  - Renderer 选 Plan 模式 → 本地 Runtime 工具过滤遵循 contract A
  - Renderer 选 Plan 模式 → Django Tin Agent 工具过滤遵循 contract B
  - 当 A != B 时 → 同一个产品语义在不同入口表现不同

为避免上述漂移：

1. **TS 端**：`packages/agent-runtime/src/agent-modes/contract.ts` 是 SSoT。
2. **JSON 中间件**：`packages/agent-runtime/agent-mode-contract.json` 由
   TS SSoT 序列化得到（commit 进 git）。
3. **Python 端**：本文件加载该 JSON，提供 `AGENT_MODE_CONTRACT` 数据结构 + 一组
   工具函数。Django 内任何模式判断都应当走本文件的常量，而不是硬编码字符串。
4. **测试断言**：
   - TS 侧 `tests/agent-modes.test.ts` 断言 `serializeAgentModeContract()` 与
     JSON 文件 round-trip 等价。
   - Python 侧 `apps/services/agent_engine/tests/test_agent_mode_contract.py`
     断言 JSON 加载结果与 `agent_mode.py` 中的 5 个 mode name 完全一致。
   - 任一端修改 SSoT 而忘记更新 JSON 都会被 CI 拦截。

字段命名
---------
JSON 字段使用 snake_case（贴近 Python），TS 侧的 SerializedAgentMode* 类型也已经
按 snake_case 序列化。所有新增字段必须双端同步：

  TS shape (`SerializedAgentModeContract`) ↔ Python TypedDict (`SerializedAgentModeContract`)

不变量
-------
- contract.version 必须等于 `EXPECTED_CONTRACT_VERSION`。
- contract.modes 必须等于 `agent_mode.ALL_AGENT_MODES`（顺序也需一致）。
- 每个 mode 必须有完整的 metadata + tool_policy + has_prompt_section。
- **yolo 继承 agent 工具集**（PRD v3 §1.4 + DR-15 + reviewer-C MEDIUM-5）：
  `_decide("yolo", ...)` 内部直接调用 `_decide("agent", ...)`，保证两 mode 的工具
  裁定永远一致（即便 contract.json 中两 mode 的 tool_policy 字段不慎漂移）。

`BaseTool.available_modes` 状态
--------------------------------
W6（2026-05-04）下线 Python ToolHub 后，server-side 工具过滤的生产消费归零；本文件的
contract 是工具可见性的实质 SSoT。`BaseTool.available_modes` 字段保留但视为 deprecated
（留给后续 wave 统一清理）。任何新工具不应再依赖该字段做 mode 过滤。

TS 端工具过滤行为变更（ask/plan 软拒 Phase 1，2026-05-27）
-------------------------------------------------------
TS runtime 的 `filterToolsForMode` 已退化为 identity —— 所有 mode 都能看到完整工具
列表，调用时由 `judge.ts` step 0 + `evaluateAgentModeToolAccess` 软拒并返回带
`remediation` 的结构化错误（让模型从工具列表 + 工具 description + 错误返回三处拿到
完整能力边界）。

**本 contract 数据不变**：allow_tool_names / deny_tool_names 仍是 TS 端 guard
策略的 SSoT —— 它现在用于"调用时拦"而不是"展示前过滤"。Django 端 `is_tool_allowed_
for_mode` 行为保持原样，因为 D10 决策 lightweight 云端路径本期不引入完整
mode_restricted enforcement（仅保证不真写入）。

如果未来 Django 也实现 evaluate 路径，应当复用本文件 _decide() 的结果，并把"软拒"
错误格式对齐 `@tabtin/agent-modes::ModeRestrictedError`（带 deny_code / remediation）。
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List, Literal, TypedDict

from .agent_mode import ALL_AGENT_MODES, AgentModeName

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Contract schema (mirrors TS SerializedAgentMode* types)
# ---------------------------------------------------------------------------


class SerializedAgentModeMetadata(TypedDict):
    name: AgentModeName
    label: str
    description: str
    # PR1 (2026-05-18)：扩展为三档；`full_auto` 仅 yolo 档使用。
    authorization_preset: Literal["cautious", "collaborative", "full_auto"]
    skip_execution_section: bool


class SerializedAgentModeToolPolicy(TypedDict, total=False):
    kind: Literal["all", "restricted"]
    allow_tool_names: List[str]
    deny_tool_names: List[str]
    default_allow_read_only: bool
    mcp_read_only_only: bool
    # L16 W5.5：受限模式 input 级 shell 白名单。仅 plan/ask/study 在 contract 中显式
    # 设置为 'tabtin-readonly'；agent/group 不输出此字段。runtime 端
    # （packages/agent-runtime/src/capability/core/shell.ts）按此字段决定是否注入
    # RestrictedShellAllowlistChecker。Django 主流程目前不消费——保留 typed key 让
    # 后续工具审计 / telemetry 能直接读取。
    restricted_shell_allowlist: Literal["tabtin-readonly"]


class SerializedAgentModeConfig(TypedDict):
    metadata: SerializedAgentModeMetadata
    tool_policy: SerializedAgentModeToolPolicy
    has_prompt_section: bool


class SerializedAgentModeContract(TypedDict):
    version: int
    modes: List[AgentModeName]
    configs: dict[AgentModeName, SerializedAgentModeConfig]


# ---------------------------------------------------------------------------
# Loader
# ---------------------------------------------------------------------------

EXPECTED_CONTRACT_VERSION = 1

# 路径优先级：包内副本 → monorepo 路径（dev fallback）
_PACKAGE_DATA_DIR = Path(__file__).resolve().parent / "_data"
_PACKAGE_CONTRACT_PATH = _PACKAGE_DATA_DIR / "agent-mode-contract.json"
from apps.services.repo_root import get_repo_root

_REPO_ROOT = get_repo_root()
_REPO_CONTRACT_PATH = _REPO_ROOT / "packages" / "agent-runtime" / "agent-mode-contract.json"


class AgentModeContractError(RuntimeError):
    """Contract 加载 / 校验失败。任何使用方应当在启动期捕获并记录到 telemetry。"""


_DEGRADED_WRITE_DENY = [
    # L16 W5.5：`run_terminal_command` 不再整体 deny。受限模式通过
    # `restricted_shell_allowlist='tabtin-readonly'` 在工具入口做 input 级过滤——
    # tabtin 只读子命令放行，写命令拒绝。降级 contract 保持同步语义，避免 JSON
    # 加载失败时回退到旧 W3 行为。
    "mcp_call_tool",
    "agent",
    "write_file",
    "edit_file",
    "delete_file",
    "tabdoc_update_document",
    "skill_invoke",
]
# W4 R3（2026-05-11）：`ask_user` 替代旧 `ask_choice`（多选问答 HITL）；
# `ask_form` 是 TabTin HITL 扩展（多字段填表）。#3709（2026-07-08）下架
# `request_approval`——审批意图由 ask_user / 纯文本承接，高危动作安全兜底由系统
# 拦截（judge 管线）承担。degraded fallback 跟随 SSoT。
_DEGRADED_ASK_TOOLS = ["ask_user", "ask_form"]
# Wave 4.5（2026-05-10）：移除降级路径中的 `think` 引用——TS runtime 已下线 think
# 工具，degraded fallback 跟随 SSoT。
_DEGRADED_PLAN_ALLOW = [*_DEGRADED_ASK_TOOLS, "show_widget", "todo_write",
                        "plan_create", "plan_update_todos",
                        # L16 W5.5：放进 allow list 才能绕过 isReadOnly=False 默认排除
                        "run_terminal_command"]


def _build_degraded_contract() -> SerializedAgentModeContract:
    """
    两个路径都找不到 JSON 时使用的最小 contract（degraded mode）。

    agent/group 使用 kind='all'（全放行），但 plan/ask/study 保持 restricted
    策略并 deny 核心写工具，确保安全退化而非全量放行。
    生产环境出现此路径意味着部署流程有问题。
    """
    configs: dict = {}
    for mode in ALL_AGENT_MODES:
        if mode in ("agent", "group", "yolo"):
            policy = {
                "kind": "all",
                "allow_tool_names": [],
                "deny_tool_names": [],
                "default_allow_read_only": True,
                "mcp_read_only_only": False,
            }
            # PR1 (2026-05-18)：yolo 在 degraded contract 中保留 full_auto preset
            # （和正常 contract 对齐),agent/group 继续 collaborative。
            preset = "full_auto" if mode == "yolo" else "collaborative"
        elif mode == "ask":
            policy = {
                "kind": "restricted",
                "allow_tool_names": [*_DEGRADED_ASK_TOOLS, "show_widget",
                                     "run_terminal_command"],
                "deny_tool_names": _DEGRADED_WRITE_DENY + ["todo_write"],
                "default_allow_read_only": True,
                "mcp_read_only_only": True,
                "restricted_shell_allowlist": "tabtin-readonly",
            }
            preset = "cautious"
        elif mode == "plan":
            policy = {
                "kind": "restricted",
                "allow_tool_names": _DEGRADED_PLAN_ALLOW,
                "deny_tool_names": _DEGRADED_WRITE_DENY,
                "default_allow_read_only": True,
                "mcp_read_only_only": True,
                "restricted_shell_allowlist": "tabtin-readonly",
            }
            preset = "cautious"
        else:
            policy = {
                "kind": "restricted",
                "allow_tool_names": _DEGRADED_PLAN_ALLOW + ["present_to_user"],
                "deny_tool_names": _DEGRADED_WRITE_DENY,
                "default_allow_read_only": True,
                "mcp_read_only_only": True,
                "restricted_shell_allowlist": "tabtin-readonly",
            }
            preset = "collaborative"

        # PR1：yolo 与 agent 对齐 — 不跳 <execution> 段、不注入额外 prompt section。
        configs[mode] = {
            "metadata": {
                "name": mode,
                "label": mode,
                "description": f"degraded: {mode}",
                "authorization_preset": preset,
                "skip_execution_section": mode not in ("agent", "yolo"),
            },
            "tool_policy": policy,
            "has_prompt_section": mode not in ("agent", "yolo"),
        }
    return {
        "version": EXPECTED_CONTRACT_VERSION,
        "modes": list(ALL_AGENT_MODES),
        "configs": configs,
    }  # type: ignore[return-value]


def _validate_contract(raw: dict, source: str) -> SerializedAgentModeContract:
    """校验 JSON 内容与当前 Python 端 agent_mode 枚举一致。"""
    version = raw.get("version")
    if version != EXPECTED_CONTRACT_VERSION:
        raise AgentModeContractError(
            f"agent-mode-contract.json ({source}) version {version!r} does not match "
            f"expected {EXPECTED_CONTRACT_VERSION!r}. Bump EXPECTED_CONTRACT_VERSION "
            "in agent_mode_contract.py (and audit consumers) when intentionally "
            "breaking compat."
        )

    modes = raw.get("modes")
    if list(modes) != list(ALL_AGENT_MODES):
        raise AgentModeContractError(
            f"agent-mode-contract.json ({source}) modes {modes!r} do not match "
            f"agent_mode.ALL_AGENT_MODES {list(ALL_AGENT_MODES)!r}. "
            "Both sides must enumerate the same set in the same order."
        )

    configs = raw.get("configs")
    if not isinstance(configs, dict):
        raise AgentModeContractError(
            f"agent-mode-contract.json ({source}) missing required 'configs' object"
        )

    for mode in ALL_AGENT_MODES:
        if mode not in configs:
            raise AgentModeContractError(
                f"agent-mode-contract.json ({source}) missing config for mode {mode!r}"
            )

    return raw  # type: ignore[return-value]


def _try_load_from(path: Path, label: str) -> SerializedAgentModeContract | None:
    """尝试从指定路径加载并校验 contract，失败返回 None。"""
    if not path.exists():
        return None
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        logger.warning("agent-mode-contract.json at %s (%s) is not valid JSON: %s", path, label, exc)
        return None
    try:
        return _validate_contract(raw, label)
    except AgentModeContractError as exc:
        logger.warning("agent-mode-contract.json at %s (%s) validation failed: %s", path, label, exc)
        return None


def _load_contract() -> SerializedAgentModeContract:
    # 1. 包内副本（Docker / pip install 部署）
    result = _try_load_from(_PACKAGE_CONTRACT_PATH, "package _data")
    if result is not None:
        return result

    # 2. monorepo 路径（开发环境 fallback）
    result = _try_load_from(_REPO_CONTRACT_PATH, "monorepo")
    if result is not None:
        return result

    # 3. degraded mode — 不崩溃但 warning
    logger.warning(
        "agent-mode-contract.json not found at package _data (%s) nor monorepo (%s). "
        "Using degraded contract with restricted ask/plan/study tool policies. "
        "This likely indicates a broken deployment — run `pnpm build` and "
        "ensure the copy-contract step executed.",
        _PACKAGE_CONTRACT_PATH,
        _REPO_CONTRACT_PATH,
    )
    return _build_degraded_contract()


AGENT_MODE_CONTRACT: SerializedAgentModeContract = _load_contract()


# ---------------------------------------------------------------------------
# Lookup helpers
# ---------------------------------------------------------------------------


def get_mode_config(mode: AgentModeName | str) -> SerializedAgentModeConfig:
    """根据 mode 名取出配置；未知名抛 KeyError，而不是静默回退 — 让调用方显式处理。"""
    return AGENT_MODE_CONTRACT["configs"][mode]  # type: ignore[index]


def get_tool_policy(mode: AgentModeName | str) -> SerializedAgentModeToolPolicy:
    return get_mode_config(mode)["tool_policy"]


def get_metadata(mode: AgentModeName | str) -> SerializedAgentModeMetadata:
    return get_mode_config(mode)["metadata"]


def has_prompt_section(mode: AgentModeName | str) -> bool:
    return get_mode_config(mode)["has_prompt_section"]


@dataclass(frozen=True)
class ToolModeFilterDecision:
    """用于 telemetry / 调试的工具过滤决策快照。"""

    mode: AgentModeName
    tool_name: str
    is_read_only: bool
    allowed: bool
    reason: str


def is_tool_allowed_for_mode(
    mode: AgentModeName | str,
    tool_name: str,
    is_read_only: bool,
) -> bool:
    """
    Python 侧执行同样的 mode → 工具可见性裁定（与 TS 的 `isToolAllowedForMode` 等价）。

    # DEAD CODE — ask/plan 软拒方案 Phase 1 (2026-05-27) 后 TS 端切换为「软拒架构」
    # （filterToolsForMode → identity）后，本函数在 Django **生产路径** 0 调用方
    # （grep `is_tool_allowed_for_mode` in apps/services/ 非 test 文件 → 0 命中）。
    # 保留作 audit / 测试 / 未来 Django 重新引入 server-side enforcement 的预留入口。
    # 守门测试在 `tests/test_user_context_wrapper_contract.py` 防止有人误引用。
    # 详见内部计划文档（ask_plan soft-deny Phase 1）§7.6 TD-4。

    解析顺序与 TS 完全一致（见 packages/agent-runtime/src/agent-modes/tool-policy.ts）：
      0. mode == 'yolo' → 继承 agent 的决策（PRD v3 §1.4 "yolo 工具集=all"）
      1. policy.kind == 'all' → 允许
      2. tool_name 在 deny_tool_names → 拒绝
      3. tool_name 在 allow_tool_names → 允许（即便 isReadOnly=False）
      4. mcp_read_only_only && tool_name 以 'mcp_' 开头 → 仅放行 isReadOnly=True 的 MCP
      5. default_allow_read_only && is_read_only → 允许
      6. 否则 → 拒绝

    本函数给 Django 侧的 audit / telemetry / 工具自声明对齐测试使用。注意：
      - **历史包袱**：Django 主流程的工具过滤过去走 `BaseTool.available_modes`
        （工具自声明），但 W6（2026-05-04）下线 Python ToolHub 之后，server-side
        工具过滤的生产消费基本归零（grep 显示仅 audit + 测试用）。
      - **现状**：42 个工具中 0 个声明 `'yolo'`；如果未来 Django 重新引入 server-side
        tool filtering 路径，contract（本文件 + JSON）就是唯一裁定 SSoT。
        `BaseTool.available_modes` 字段视为 deprecated，留给后续 wave 清理。
      - **PRD v3 + DR-15 + reviewer-C MEDIUM-5 共识**：yolo 工具集 = agent 工具集。
        实现采用"yolo 决策直接转发给 agent"——即便未来 contract.json 不慎让两个
        mode 漂移，本函数层面也保证 yolo 不会比 agent 拿到更多/更少工具。
    """
    return _decide(mode, tool_name, is_read_only).allowed


def explain_tool_mode_decision(
    mode: AgentModeName | str,
    tool_name: str,
    is_read_only: bool,
) -> ToolModeFilterDecision:
    # DEAD CODE — 同 `is_tool_allowed_for_mode`，软拒架构后 Django 生产 0 调用。
    # 详见总控 §7.6 TD-4。
    return _decide(mode, tool_name, is_read_only)


def _decide(
    mode: AgentModeName | str,
    tool_name: str,
    is_read_only: bool,
) -> ToolModeFilterDecision:
    # PRD v3 §1.4 + DR-15 + reviewer-C MEDIUM-5：yolo 工具集 = agent 工具集。
    # 显式 forward 而不是依赖 contract.json 中两个 mode 各自声明 kind='all'——
    # 后者一旦未来人为漂移（比如有人误改 yolo policy），本函数仍保证两个 mode
    # 的工具裁定完全一致。返回的 decision 仍标记 mode='yolo' 以便 telemetry 可
    # 追溯调用方传入的真实 mode。
    if mode == "yolo":
        agent_decision = _decide("agent", tool_name, is_read_only)
        return ToolModeFilterDecision(
            mode="yolo",
            tool_name=tool_name,
            is_read_only=is_read_only,
            allowed=agent_decision.allowed,
            reason=agent_decision.reason,
        )

    policy = get_tool_policy(mode)

    if policy["kind"] == "all":
        return ToolModeFilterDecision(
            mode=mode,  # type: ignore[arg-type]
            tool_name=tool_name,
            is_read_only=is_read_only,
            allowed=True,
            reason="policy_all",
        )

    if tool_name in policy["deny_tool_names"]:
        return ToolModeFilterDecision(
            mode=mode,  # type: ignore[arg-type]
            tool_name=tool_name,
            is_read_only=is_read_only,
            allowed=False,
            reason="explicit_deny",
        )

    if tool_name in policy["allow_tool_names"]:
        return ToolModeFilterDecision(
            mode=mode,  # type: ignore[arg-type]
            tool_name=tool_name,
            is_read_only=is_read_only,
            allowed=True,
            reason="explicit_allow",
        )

    if policy["mcp_read_only_only"] and tool_name.startswith("mcp_"):
        return ToolModeFilterDecision(
            mode=mode,  # type: ignore[arg-type]
            tool_name=tool_name,
            is_read_only=is_read_only,
            allowed=is_read_only,
            reason="mcp_read_only_only",
        )

    if policy["default_allow_read_only"] and is_read_only:
        return ToolModeFilterDecision(
            mode=mode,  # type: ignore[arg-type]
            tool_name=tool_name,
            is_read_only=is_read_only,
            allowed=True,
            reason="default_read_only",
        )

    return ToolModeFilterDecision(
        mode=mode,  # type: ignore[arg-type]
        tool_name=tool_name,
        is_read_only=is_read_only,
        allowed=False,
        reason="default_deny",
    )


def filter_tool_names_for_mode(
    mode: AgentModeName | str,
    tools: Iterable[tuple[str, bool]],
) -> list[str]:
    """
    根据 contract 过滤工具列表，返回当前模式下允许的工具名（保持输入顺序）。

    # DEAD CODE — 同 `is_tool_allowed_for_mode`，软拒架构后 Django 生产 0 调用。
    # 保留作 audit / 测试 / 未来 server-side enforcement 预留。详见总控 §7.6 TD-4。

    输入是 `(tool_name, is_read_only)` 元组迭代器 — 这种"无副作用"接口让 Django
    侧无需引入 BaseTool 类，方便单测与 Lint 工具直接消费。
    """
    return [name for name, ro in tools if is_tool_allowed_for_mode(mode, name, ro)]


__all__ = [
    "AGENT_MODE_CONTRACT",
    "AgentModeContractError",
    "EXPECTED_CONTRACT_VERSION",
    "SerializedAgentModeContract",
    "SerializedAgentModeConfig",
    "SerializedAgentModeMetadata",
    "SerializedAgentModeToolPolicy",
    "ToolModeFilterDecision",
    "get_mode_config",
    "get_tool_policy",
    "get_metadata",
    "has_prompt_section",
    "is_tool_allowed_for_mode",
    "explain_tool_mode_decision",
    "filter_tool_names_for_mode",
]
