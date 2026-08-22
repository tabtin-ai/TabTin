"""CLI 审计事件写入与 HITL 回填 helper（PRD-v3 §5.1 第 5 项 + A1-L2 升级）。

入口：

- ``emit_cli_audit_event(spec, *, thread_id, agent_id, user_id,
  rule_decision, hitl_required, **optional)`` — 通过 / 拒绝 / 执行结束后落库
- ``update_hitl_decision(audit_event_id, *, user_decision, decided_by, decided_at)``
  — review 路径下用户做出决策后回填（A4 启动包接入 UI）

设计纪律：

1. **fail-close**（PRD §5.1 第 5 项核心承诺）：PG 不可达 / DB 异常时 **不静默吞掉**，
   而是抛 ``CliAuditWriteError`` 让上层 wrapper 拒绝执行。
   "审计断链 = 高风险操作不留痕，比延迟更危险"。

2. **PII 脱敏三档分级**（A1-L2 升级，落地总控笔记 § 七遗留项）：
   - ``safe`` 级 — 不增加额外脱敏（A1 parser 已经做过 hash+长度脱敏）
   - ``review`` 级 — 维持 A1 的脱敏（hash 前 8 位 + 长度，便于审计反查）
   - ``strict`` 级 — 完全隐藏长度（仅保留字段名 + ``<redacted>``，不保留 hash 不保留长度）
     原因：strict 级别对应"绝对禁止透露任何线索"的合规高压场景（生产环境写动作 / 不可逆操作）；
     即便是 8 位 hash 与长度，也可能给攻击者后验证密码的余地。

3. **spec.to_dict 字段缺失** → 抛 ``CliAuditWriteError``。
   原因：spec_json 是审计反查的根证据，缺字段就等于审计失效，必须 fail-close
   ——而非默默写一条不完整记录。

4. **跨库引用**：thread_id / agent_id / user_id / hitl_decided_by 全部 UUIDField + db_constraint=False，
   接收时容忍 ``str`` / ``UUID`` 两种类型，落库前统一 ``uuid.UUID(...)`` 规范化。
   ``None`` 直接落 NULL（因为 model 字段 ``null=True``）。

5. 不在本启动包做：
   - HITL UI 接入（A4）
   - CLI fork 完成 hook（A5）
   - AdminDash 审计页前端（E3）
"""

from __future__ import annotations

import logging
import re
import uuid
from datetime import datetime
from typing import TYPE_CHECKING, Any, Optional, Sequence, Union

from django.db import DatabaseError, OperationalError, transaction

from apps.services.agent_engine.cli.spec import (
    RISK_LEVELS,
    RISK_REVIEW,
    RISK_SAFE,
    RISK_STRICT,
    CliInvocationSpec,
)

if TYPE_CHECKING:
    # 仅类型检查；运行时通过 lazy import 避免 cli/__init__.py 顶层即触发 Django app load
    from apps.services.agent_engine.cli.models import CliAuditEvent  # noqa: F401

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────
# 异常类
# ─────────────────────────────────────────────────────────────────────


class CliAuditWriteError(Exception):
    """CLI 审计写入失败 — fail-close 信号。

    上层 ``tabtin install <app>`` 等命令收到本异常时
    **必须拒绝执行**并 stderr 上报，而不是静默继续（PRD §5.1 第 5 项 fail-close）。

    触发条件：
    - PG 不可达 / DB 连接超时 / 写事务被中止（``OperationalError`` / ``DatabaseError``）
    - ``spec.to_dict()`` 缺少必备字段（spec_json 不完整 = 审计失效）
    - ``rule_decision`` / ``hitl_user_decision`` 等枚举字段值非法
    - ``update_hitl_decision`` 业务态校验失败（重复回填 / 非 review 路径）

    属性：
    - ``cause`` — 底层异常（如有），便于上层日志追溯
    - ``retryable`` — 是否可重试（PRD §5.1 第 6 项 tool result 协议）：
      ``True``  → 短时 PG 故障 / 网络抖动等，上层可在退避后重试
      ``False`` → 业务态错误（缺字段 / 重复回填），重试不会成功
      默认值取决于触发场景（DB 异常 → True；业务校验 → False）
    """

    def __init__(
        self,
        message: str,
        *,
        cause: Optional[BaseException] = None,
        retryable: bool = False,
    ) -> None:
        super().__init__(message)
        self.cause = cause
        self.retryable = retryable


# ─────────────────────────────────────────────────────────────────────
# 常量与允许值
# ─────────────────────────────────────────────────────────────────────


_ALLOWED_RULE_DECISIONS = frozenset({"allow", "review", "deny"})
# P1-7：HITL 词表扩展支持 timeout（PRD §5.1 第 6 项的三种 tool result 路径）。
# allow / deny 是用户主动选择，timeout 是 A4 检测到用户超时未响应注入的最终态。
_ALLOWED_HITL_DECISIONS = frozenset({"allow", "deny", "timeout"})

_REQUIRED_SPEC_FIELDS = frozenset(
    {
        "binary",
        "domain",
        "verb",
        "risk_level",
        "raw_args",
    }
)
"""``spec.to_dict()`` 写库前必须包含的字段集（缺一即拒绝写入）。

不强求 ``resource`` / ``resource_label`` / ``matched_rule_pattern`` 等可空字段，
但要求至少有 binary/domain/verb/risk_level/raw_args 五项构成审计追溯的最小集。
"""

# strict 级 PII 脱敏：识别 A1 parser 写入的 hash 占位符
# 例：``--text=<redacted len=11 hash=2e7d2c03>`` → ``--text=<redacted>``
# 也命中无前缀的 ``<redacted len=N hash=XXXXXXXX>``（A1 parser._build_unparsed_spec 的 placeholder）
_REDACTED_PLACEHOLDER_RE = re.compile(
    r"<redacted\s+len=\d+\s+hash=[0-9a-f]+>"
)
# A1 parser._build_unparsed_spec 还会写出 `<unparsed: reason=... length=N>`，
# strict 级别也要把这段字符压成 `<redacted>`（不留 length）
_UNPARSED_PLACEHOLDER_RE = re.compile(r"<unparsed:[^>]*>")


# ─────────────────────────────────────────────────────────────────────
# strict 级 PII 二次脱敏
# ─────────────────────────────────────────────────────────────────────


def _strict_redact_arg(token: str) -> str:
    """strict 级别二次脱敏：彻底剥离长度与 hash 信息。

    输入示例（A1 parser 已做 review 级脱敏）：
    - ``--text=<redacted len=11 hash=2e7d2c03>`` → ``--text=<redacted>``
    - ``<redacted len=5 hash=a1b2c3d4>`` → ``<redacted>``  （space-value 形式 A1 写到独立 token）
    - ``<unparsed: reason=shlex_error length=42>`` → ``<redacted>``
    - ``--table-id=tbl_xxx`` → 保持原样（resource id 不属于 PII，且 strict 仍需可观测）
    - 其他正常 token → 保持原样

    设计要点：
    - **不**对全部 token 做 ``<redacted>`` 化——会把 ``--table-id`` / ``--verb`` 等结构信息丢光，
      让审计反查"是谁调用了什么命令"完全不可能；strict 的核心是隐藏 *value*（PII），不是隐藏命令结构。
    - 仅识别 A1 parser 已经标记为脱敏的占位符（含 hash 与长度），把 ``len=`` / ``hash=``
      段直接抹掉，剩下的命令骨架照旧。
    """
    # 命中 review 级 hash 占位符 → 替换为纯 <redacted>
    out = _REDACTED_PLACEHOLDER_RE.sub("<redacted>", token)
    # 命中 unparsed 占位符 → 同样压成 <redacted>
    out = _UNPARSED_PLACEHOLDER_RE.sub("<redacted>", out)
    return out


def _apply_pii_policy(
    risk_level: str, raw_args: Sequence[str]
) -> list[str]:
    """按 risk_level 三档对 raw_args 做二次 PII 处理。

    - safe   → 原样返回（A1 已脱敏，不再加码）
    - review → 原样返回（保留 hash+length 便于审计反查）
    - strict → 调用 ``_strict_redact_arg`` 抹掉 length 与 hash

    其他 risk_level 值（理论上不应出现，spec __post_init__ 已校验）→
    保守按 strict 处理（fail-close 倾向，宁可信息少泄露不要多泄露）。
    """
    if risk_level == RISK_STRICT:
        return [_strict_redact_arg(t) for t in raw_args]
    if risk_level in (RISK_SAFE, RISK_REVIEW):
        return list(raw_args)
    # 未知 risk_level（防御性）：按最严走
    logger.warning(
        "[cli.audit] unknown risk_level %r when applying PII policy, "
        "fail-close to strict",
        risk_level,
    )
    return [_strict_redact_arg(t) for t in raw_args]


# ─────────────────────────────────────────────────────────────────────
# 工具函数：UUID 规范化
# ─────────────────────────────────────────────────────────────────────


_UuidLike = Union[str, uuid.UUID, None]


def _coerce_uuid(value: _UuidLike, *, field_name: str) -> Optional[uuid.UUID]:
    """把 ``str`` / ``UUID`` / ``None`` 统一为 ``UUID`` 或 ``None``。

    无法解析时抛 ``CliAuditWriteError``（fail-close）——审计上下文 ID 错乱比写不进去更危险。
    业务态错误，``retryable=False``。
    """
    if value is None:
        return None
    if isinstance(value, uuid.UUID):
        return value
    if isinstance(value, str):
        try:
            return uuid.UUID(value)
        except (ValueError, TypeError) as exc:
            raise CliAuditWriteError(
                f"{field_name}={value!r} 不是合法 UUID 字符串",
                retryable=False,
            ) from exc
    raise CliAuditWriteError(
        f"{field_name} 必须是 str / UUID / None，got {type(value).__name__}",
        retryable=False,
    )


# ─────────────────────────────────────────────────────────────────────
# Sentry 上报（PRD §5.1 第 5 项 "stderr + Sentry" 承诺）
# ─────────────────────────────────────────────────────────────────────


def _capture_sentry(exc: BaseException, extra: dict) -> None:
    """fail-close 路径上报 Sentry，不可用时静默（不影响主流程）。

    PRD §5.1 第 5 项："PG 不可达时 audit 写入降级到 stderr + Sentry 报警"。
    Sentry 客户端不可用（dev 环境无 SENTRY_DSN）时本函数不报错，
    保证 audit.py 在任何环境都能 fail-close 拒绝执行（拒绝是主功能，
    上报是辅助可观测性）。
    """
    try:
        import sentry_sdk  # type: ignore[import-not-found]

        sentry_sdk.capture_exception(exc, extras=extra)  # type: ignore[arg-type]
    except Exception:  # noqa: BLE001 — Sentry 不可用绝不能影响主路径
        pass


# ─────────────────────────────────────────────────────────────────────
# 写入 helper
# ─────────────────────────────────────────────────────────────────────


def _summarize_spec_for_log(spec_dict: dict, *, max_len: int = 2000) -> str:
    """把 spec_json 序列化截断到 ``max_len`` 字符，避免日志单条爆掉。

    spec_json 已经做过 PII 脱敏，但 ``raw_args`` 可能很长（脚本类参数 / 长 URL）。
    日志收集系统通常对单条 message 有上限（如 Sentry 默认 4KB / Loki 默认 8KB）。
    截断时保留前后各一半，给排障留尽量多上下文。
    """
    import json

    try:
        payload = json.dumps(spec_dict, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        payload = repr(spec_dict)
    if len(payload) <= max_len:
        return payload
    half = max_len // 2 - 20
    return f"{payload[:half]}…<truncated total={len(payload)}>…{payload[-half:]}"


def emit_cli_audit_event(
    spec: CliInvocationSpec,
    *,
    thread_id: _UuidLike,
    agent_id: _UuidLike,
    user_id: _UuidLike,
    rule_decision: str,
    hitl_required: bool,
    organization_id: _UuidLike = None,
    entry_binary: Optional[str] = None,
    inner_binary: Optional[str] = None,
    hitl_user_decision: Optional[str] = None,
    hitl_decided_by: _UuidLike = None,
    hitl_decided_at: Optional[datetime] = None,
    executed_at: Optional[datetime] = None,
    finished_at: Optional[datetime] = None,
    exit_code: Optional[int] = None,
    bypass: bool = False,
) -> "CliAuditEvent":
    """落库一条 CLI 审计事件（PRD §5.1 第 5 项）。

    参数：

    - ``spec`` — 解析得到的 ``CliInvocationSpec``（必须，不为 None）
    - ``thread_id`` / ``agent_id`` / ``user_id`` / ``organization_id`` —
      上下文 ID（``str`` / ``UUID`` / ``None``）
    - ``rule_decision`` — PermissionRuleEngine 输出 ``allow`` / ``review`` / ``deny``
    - ``hitl_required`` — 是否触发 HITL（review 时通常 True）
    - ``entry_binary`` — **K7 关键参数**：用户最外层敲的 binary（如 ``"tabtin"``）。
      PRD §7.1 验收 SQL ``WHERE binary IN (...)`` 直接走顶层 ``binary`` index。
      fork wrapper 场景应传 ``entry_binary='tabtin'`` + ``inner_binary=<third-party-cli>``；
      第三方 CLI 直跑（bypass）场景应传 ``entry_binary=<third-party-cli>`` + ``inner_binary=None``。
      未传时 fallback 到 ``spec.binary``（向后兼容简单场景，但应**显式传入**以保证 K7 语义）。
    - ``inner_binary`` — fork 子进程 binary（如第三方 CLI 名，wrapper 场景填）
    - 其余 HITL / 执行字段为可选，对应 review 路径完成后或 fork 完成后回填

    返回：``CliAuditEvent`` 实例（已写入 PG，``id`` 已生成）。

    异常：
    - ``CliAuditWriteError`` — fail-close 信号（PG 不可达 / spec 字段缺失 / 枚举非法）。
      上层接收到本异常 **必须拒绝执行原 CLI 命令**。
      ``retryable`` 属性指示是否可重试：DB 异常 → True，业务态错误 → False。
    """
    # ── 1. spec 完整性校验（fail-close，业务态 = retryable=False）─────
    if spec is None:
        raise CliAuditWriteError("spec 不能为 None", retryable=False)

    try:
        spec_dict = spec.to_dict()
    except Exception as exc:
        raise CliAuditWriteError(
            f"spec.to_dict() 失败: {type(exc).__name__}: {exc}",
            retryable=False,
        ) from exc

    if not isinstance(spec_dict, dict):
        raise CliAuditWriteError(
            f"spec.to_dict() 必须返回 dict，got {type(spec_dict).__name__}",
            retryable=False,
        )

    missing = _REQUIRED_SPEC_FIELDS - set(spec_dict.keys())
    if missing:
        raise CliAuditWriteError(
            f"spec.to_dict() 缺少必备字段: {sorted(missing)}",
            retryable=False,
        )

    # ── 2. 枚举字段校验（fail-close）────────────────────────────────
    if rule_decision not in _ALLOWED_RULE_DECISIONS:
        raise CliAuditWriteError(
            f"rule_decision={rule_decision!r} 非法，"
            f"必须是 {sorted(_ALLOWED_RULE_DECISIONS)} 之一",
            retryable=False,
        )

    risk_level = spec_dict.get("risk_level")
    if risk_level not in RISK_LEVELS:
        raise CliAuditWriteError(
            f"spec.risk_level={risk_level!r} 非法（spec __post_init__ 应已拦截，"
            f"出现说明 spec 被篡改）",
            retryable=False,
        )

    if hitl_user_decision is not None and hitl_user_decision not in _ALLOWED_HITL_DECISIONS:
        raise CliAuditWriteError(
            f"hitl_user_decision={hitl_user_decision!r} 非法，"
            f"必须是 {sorted(_ALLOWED_HITL_DECISIONS)} 之一或 None",
            retryable=False,
        )

    # ── 3. PII 三档脱敏（A1-L2 升级）─────────────────────────────────
    raw_args = spec_dict.get("raw_args") or []
    if not isinstance(raw_args, list):
        raise CliAuditWriteError(
            f"spec.raw_args 必须是 list，got {type(raw_args).__name__}",
            retryable=False,
        )
    spec_dict["raw_args"] = _apply_pii_policy(risk_level, raw_args)

    # ── 4. UUID 规范化 ───────────────────────────────────────────────
    organization_uuid = _coerce_uuid(organization_id, field_name="organization_id")
    thread_uuid = _coerce_uuid(thread_id, field_name="thread_id")
    agent_uuid = _coerce_uuid(agent_id, field_name="agent_id")
    user_uuid = _coerce_uuid(user_id, field_name="user_id")
    hitl_decided_by_uuid = _coerce_uuid(
        hitl_decided_by, field_name="hitl_decided_by"
    )

    # ── 5. K7 binary 顶层化 + domain/verb 顶层化 ────────────────────
    # entry_binary 未传 → fallback 到 spec.binary（向后兼容简单场景）；
    # 传入则覆盖（A5 wrapper 场景下 entry_binary='tabtin'，inner_binary 为 fork 的第三方 CLI）。
    final_binary = entry_binary or spec.binary
    final_domain = spec.domain
    final_verb = spec.verb

    # ── 6. 写入（fail-close on DB 异常，retryable=True）─────────────
    # lazy import：本模块顶层不应触发 cli/models.py 的 Django app load
    # （兼顾 audit.py 在 non-Django 上下文的纯函数测试可能性）
    from apps.services.agent_engine.cli.models import CliAuditEvent

    try:
        # 包一层 atomic 仅覆盖本次写入，避免外层 transaction 被本次失败连带回滚
        # （审计写失败不应该让外层业务事务回滚，但要能告知上层"我没写进去"）
        with transaction.atomic(using="postgresql"):
            event = CliAuditEvent.objects.create(
                organization_id=organization_uuid,
                thread_id=thread_uuid,
                agent_id=agent_uuid,
                user_id=user_uuid,
                binary=final_binary,
                inner_binary=inner_binary,
                domain=final_domain,
                verb=final_verb,
                risk_level=risk_level,
                spec_json=spec_dict,
                rule_decision=rule_decision,
                hitl_required=hitl_required,
                hitl_user_decision=hitl_user_decision,
                hitl_decided_by=hitl_decided_by_uuid,
                hitl_decided_at=hitl_decided_at,
                executed_at=executed_at,
                finished_at=finished_at,
                exit_code=exit_code,
                bypass=bypass,
            )
    except (OperationalError, DatabaseError) as exc:
        # PG 不可达 / 写事务异常 → fail-close + Sentry 上报
        # spec_json 截断避免单条日志爆掉（已脱敏，安全侧 OK）
        spec_summary = _summarize_spec_for_log(spec_dict)
        logger.error(
            "[cli.audit] PG 写入失败，fail-close 拒绝执行原 CLI 命令: "
            "binary=%s inner_binary=%s domain=%s verb=%s risk=%s "
            "rule_decision=%s hitl_required=%s bypass=%s exc=%s spec_json=%s",
            final_binary,
            inner_binary,
            final_domain,
            final_verb,
            risk_level,
            rule_decision,
            hitl_required,
            bypass,
            f"{type(exc).__name__}: {exc}",
            spec_summary,
        )
        _capture_sentry(
            exc,
            extra={
                "binary": final_binary,
                "inner_binary": inner_binary,
                "domain": final_domain,
                "verb": final_verb,
                "risk_level": risk_level,
                "rule_decision": rule_decision,
                "fail_close_phase": "emit",
            },
        )
        raise CliAuditWriteError(
            f"PG 写入 cli_audit_event 失败 ({type(exc).__name__}: {exc})；"
            f"上层必须拒绝执行原 CLI 命令",
            retryable=True,  # PG 短时故障 / 网络抖动可重试
        ) from exc
    except Exception as exc:
        # 兜底：未预期的异常一并 fail-close（如 router 配置错把记录路由到错库）
        spec_summary = _summarize_spec_for_log(spec_dict)
        logger.error(
            "[cli.audit] 未预期异常，fail-close: exc=%s spec_json=%s",
            f"{type(exc).__name__}: {exc}",
            spec_summary,
        )
        _capture_sentry(
            exc,
            extra={
                "binary": final_binary,
                "fail_close_phase": "emit_unexpected",
            },
        )
        raise CliAuditWriteError(
            f"写入 cli_audit_event 时发生未预期异常 "
            f"({type(exc).__name__}: {exc})；上层必须拒绝执行原 CLI 命令",
            retryable=False,  # 未预期异常重试不会成功（router 错配等结构性问题）
        ) from exc

    return event


# ─────────────────────────────────────────────────────────────────────
# HITL 决策回填 helper
# ─────────────────────────────────────────────────────────────────────


def update_hitl_decision(
    audit_event_id: _UuidLike,
    *,
    user_decision: str,
    decided_by: _UuidLike,
    decided_at: datetime,
    allow_override: bool = False,
) -> "CliAuditEvent":
    """用户在 HITL UI 完成 review 决策后回填（PRD §5.1 第 5/6 项）。

    参数：
    - ``audit_event_id`` — 之前 ``emit_cli_audit_event`` 返回的事件 ID
    - ``user_decision`` — ``"allow"`` / ``"deny"`` / ``"timeout"``（PRD §5.1 第 6 项三种 tool result 路径）
    - ``decided_by`` — 决策用户的 UUID（HITL 决策必须能追溯到具体用户）
    - ``decided_at`` — 决策时间戳（A4 由 HITL UI 注入；建议 ``timezone.now()`` 而非 naive）
    - ``allow_override`` — 默认 ``False``：拒绝覆盖已有决策（防止两个 admin 并发回填同一事件，
      后点的静默覆盖前点的，导致审计举证链断裂）。
      仅当上层（如系统 timeout 自动转 deny / admin 显式撤销重判）确实需要覆盖时设 True。

    业务态校验（fail-close, retryable=False）：
    - 事件必须存在
    - 事件必须是 review 路径（``rule_decision == "review"`` 且 ``hitl_required == True``），
      否则 allow / deny 路径不该走 HITL 回填
    - ``hitl_user_decision`` 已有值且 ``allow_override=False`` → 拒绝（幂等防护）
    - 词表 / 类型 / decided_by 非空校验

    返回：刷新后的 ``CliAuditEvent`` 实例。

    异常：
    - ``CliAuditWriteError`` — 业务态校验失败 / DB 写失败 等 fail-close 场景。
      ``retryable=False`` 表示业务态错误（覆盖判定 / 词表非法），重试无意义；
      ``retryable=True`` 表示 DB 短时异常，可重试。
    """
    from apps.services.agent_engine.cli.models import CliAuditEvent

    # ── 1. 词表与类型校验 ───────────────────────────────────────────
    if user_decision not in _ALLOWED_HITL_DECISIONS:
        raise CliAuditWriteError(
            f"user_decision={user_decision!r} 非法，"
            f"必须是 {sorted(_ALLOWED_HITL_DECISIONS)} 之一",
            retryable=False,
        )

    if decided_at is None:
        raise CliAuditWriteError("decided_at 不能为 None", retryable=False)
    if not isinstance(decided_at, datetime):
        raise CliAuditWriteError(
            f"decided_at 必须是 datetime，got {type(decided_at).__name__}",
            retryable=False,
        )

    event_uuid = _coerce_uuid(audit_event_id, field_name="audit_event_id")
    if event_uuid is None:
        raise CliAuditWriteError("audit_event_id 不能为 None", retryable=False)

    decided_by_uuid = _coerce_uuid(decided_by, field_name="decided_by")
    if decided_by_uuid is None:
        # decided_by 在 HITL 决策上下文必填（"谁拍的板"是审计核心证据）
        raise CliAuditWriteError(
            "decided_by 不能为 None（HITL 决策必须能追溯到具体用户）",
            retryable=False,
        )

    try:
        with transaction.atomic(using="postgresql"):
            try:
                event = CliAuditEvent.objects.select_for_update().get(id=event_uuid)
            except CliAuditEvent.DoesNotExist as exc:
                raise CliAuditWriteError(
                    f"audit_event_id={event_uuid} 对应的记录不存在",
                    retryable=False,
                ) from exc

            # ── 2. 业务态校验：必须是 review 路径才允许 HITL 回填 ────
            if event.rule_decision != "review" or not event.hitl_required:
                raise CliAuditWriteError(
                    f"audit_event_id={event_uuid} 非 review 路径事件 "
                    f"(rule_decision={event.rule_decision!r} "
                    f"hitl_required={event.hitl_required})，禁止回填 HITL",
                    retryable=False,
                )

            # ── 3. 幂等约束：已有决策不允许覆盖（除非显式 allow_override）─
            if event.hitl_user_decision is not None and not allow_override:
                raise CliAuditWriteError(
                    f"audit_event_id={event_uuid} 已有 HITL 决策 "
                    f"({event.hitl_user_decision!r}@{event.hitl_decided_at})，"
                    f"拒绝覆盖；如需覆盖请显式 allow_override=True",
                    retryable=False,
                )

            event.hitl_user_decision = user_decision
            event.hitl_decided_by = decided_by_uuid
            event.hitl_decided_at = decided_at
            # rule_decision 不在 HITL 决策中改变（rule_decision 记录的是 PermissionRule
            # 静态判定，HITL 是动态二次确认；两者并存便于反查"为什么 rule 是 review
            # 但用户最终 allow / deny / timeout"）
            event.save(
                update_fields=[
                    "hitl_user_decision",
                    "hitl_decided_by",
                    "hitl_decided_at",
                ]
            )
    except CliAuditWriteError:
        raise
    except (OperationalError, DatabaseError) as exc:
        logger.error(
            "[cli.audit] HITL 回填失败 (PG 异常) audit_event_id=%s "
            "user_decision=%s exc=%s",
            event_uuid,
            user_decision,
            f"{type(exc).__name__}: {exc}",
        )
        _capture_sentry(
            exc,
            extra={
                "audit_event_id": str(event_uuid),
                "user_decision": user_decision,
                "fail_close_phase": "update_hitl",
            },
        )
        raise CliAuditWriteError(
            f"HITL 回填失败 ({type(exc).__name__}: {exc})；"
            f"上层必须把这条 review 标记为 unresolved",
            retryable=True,
        ) from exc
    except Exception as exc:
        logger.error(
            "[cli.audit] HITL 回填未预期异常 audit_event_id=%s exc=%s",
            event_uuid,
            f"{type(exc).__name__}: {exc}",
        )
        _capture_sentry(
            exc,
            extra={
                "audit_event_id": str(event_uuid),
                "user_decision": user_decision,
                "fail_close_phase": "update_hitl_unexpected",
            },
        )
        raise CliAuditWriteError(
            f"HITL 回填发生未预期异常 ({type(exc).__name__}: {exc})",
            retryable=False,
        ) from exc

    return event


__all__ = [
    "CliAuditWriteError",
    "emit_cli_audit_event",
    "update_hitl_decision",
]
