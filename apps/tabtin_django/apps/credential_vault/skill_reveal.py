"""Skill 运行时密钥注入 — 后端解析 + 授权 + env 派生（Wave 1.5）。

业务目标（credential-identity PRD Story 7）：
- 用户在"登录与密钥"里配好 API Key 凭据，并通过 ``SpaceAppSettings.skill_configs[skill_key].credential_id``
  绑定到某个 Skill
- Agent 执行 Skill 时，`run_terminal_command` 运行时通过本端点获取 **env 变量字典**，
  注入到子进程环境里
- 全程无需用户审批（PD-4：Agent 使用凭据自动允许）

模块划分：
- ``SKILL_CREDENTIAL_ENV_MAP``：``service_name`` → env 变量派生规则
  * 由 encrypted_data 的字段直接派生的映射在这里统一维护
  * 新增第三方服务时只改这张表
- ``derive_env_from_credential``：应用映射 + primary_env 兜底
- ``_check_skill_reveal_rate_limit``：独立于 autofill 限流（Skill 执行是 Agent
  主循环里高频行为——20/5min 不够用；60/5min 是经验值）
- ``skill_reveal_view``：Ninja endpoint 主体

**安全不变量**（违反即任务作废）：
1. 密钥绝不进入 LLM 上下文 —— endpoint 只返回 ``env``，前端 runtime 在命令工具
   中直接塞给子进程，不会作为 tool_result content 回到对话
2. 密钥绝不写日志 —— ``logger`` 调用里只出现 credential_id / service_name / env
   变量**名**，禁止打印 env 变量的值
3. 密钥绝不持久化 —— 返回后内存里只存在于 runtime 缓存（5min TTL）+ 子进程
   env，命令执行完 OS 释放子进程后全部回收
"""
from __future__ import annotations

import logging
import re
from typing import Any, Callable, Dict, List, Optional, Tuple
from uuid import UUID

from apps.i18n import _
from django.core.cache import cache
from django.http import JsonResponse
from django.utils import timezone

from apps.credential_vault.models import CredentialCategory, UserCredential
from apps.skills.services.space_context import SkillSpaceContextError

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# primary_env 合法性（产品 Review I）
# ---------------------------------------------------------------------------

# POSIX 允许的 env 变量名：字母或下划线起头，后续字母数字下划线。
# 不合法的 hint（如 "MY KEY" / "1ABC"）直接在后端拒绝，避免塞进
# `child_process.spawn({env})` 时 Node 默默丢弃或 shell 语法错误。
_VALID_ENV_VAR_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _is_valid_env_var_name(name: str) -> bool:
    return bool(name and _VALID_ENV_VAR_NAME_RE.match(name))


# ---------------------------------------------------------------------------
# 限流：Skill-reveal 专用 key（与 autofill 隔离）
# ---------------------------------------------------------------------------

SKILL_REVEAL_RATE_LIMIT_MAX = 60
"""per-user 每 5 分钟最多 60 次；Agent 在单次任务里高频运行命令很正常。"""

SKILL_REVEAL_RATE_LIMIT_WINDOW = 300


def _check_skill_reveal_rate_limit(user_id: str) -> tuple[bool, int]:
    """Per-user 原子递增限流（复用 credential_vault 既有 cache.add + incr 模式）。"""
    cache_key = f"credential_skill_reveal_rate:{user_id}"
    cache.add(cache_key, 0, SKILL_REVEAL_RATE_LIMIT_WINDOW)
    try:
        count = cache.incr(cache_key)
    except ValueError:
        cache.set(cache_key, 1, SKILL_REVEAL_RATE_LIMIT_WINDOW)
        count = 1
    if count > SKILL_REVEAL_RATE_LIMIT_MAX:
        ttl = cache.ttl(cache_key) if hasattr(cache, "ttl") else SKILL_REVEAL_RATE_LIMIT_WINDOW
        return False, max(ttl, 1)
    return True, 0


# ---------------------------------------------------------------------------
# service_name → env 变量派生规则
# ---------------------------------------------------------------------------


EnvDerivation = Callable[[Dict[str, Any], Optional[str]], Dict[str, str]]
"""(encrypted_data, primary_env_hint) → {ENV_VAR: value}

规则入参：
- ``encrypted_data``：UserCredential.encrypted_data（明文 dict，数据库层 Fernet 自动解密）
- ``primary_env_hint``：Skill frontmatter 里的 ``primary_env`` 字段，单密钥场景给映射兜底用

规则输出：env 变量字典，key 是目标环境变量名，value 是要注入的值。
"""


def _first_string_field(data: Dict[str, Any], *candidates: str) -> Optional[str]:
    """按顺序找第一个非空字符串字段；候选用尽还找不到就 None。"""
    for k in candidates:
        v = data.get(k)
        if isinstance(v, str) and v:
            return v
    return None


def _derive_openai(data: Dict[str, Any], primary_env: Optional[str]) -> Dict[str, str]:
    key = _first_string_field(data, "api_key", "key", "token")
    if not key:
        return {}
    return {"OPENAI_API_KEY": key}


def _derive_anthropic(data: Dict[str, Any], primary_env: Optional[str]) -> Dict[str, str]:
    key = _first_string_field(data, "api_key", "key", "token")
    if not key:
        return {}
    return {"ANTHROPIC_API_KEY": key}


def _derive_serper(data: Dict[str, Any], primary_env: Optional[str]) -> Dict[str, str]:
    key = _first_string_field(data, "api_key", "key")
    if not key:
        return {}
    return {"SERPER_API_KEY": key}


def _derive_generic(data: Dict[str, Any], primary_env: Optional[str]) -> Dict[str, str]:
    """兜底规则：encrypted_data 有 ``api_key`` 时，用 Skill frontmatter 的 primary_env
    作为变量名；若 primary_env 缺省则无法派生（返回空 dict，调用方自己决定 400 或降级）。"""
    key = _first_string_field(data, "api_key", "key", "token", "secret")
    if key and primary_env:
        return {primary_env: key}
    return {}


SKILL_CREDENTIAL_ENV_MAP: Dict[str, EnvDerivation] = {
    "openai": _derive_openai,
    "anthropic": _derive_anthropic,
    "serper": _derive_serper,
}
"""service_name → 派生函数。新增第三方服务时只改这张表，Wave 5 UI 层的
"服务选择器"也应读这张表提供合法 service_name 候选。"""


# ---------------------------------------------------------------------------
# P0-2 补丁：后端最小密钥长度守门
# ---------------------------------------------------------------------------

MIN_SECRET_VALUE_LENGTH = 8
"""Wave 1.5 P0-2（质疑 2 补丁）：后端派生的每条 env value 必须至少 8 字符。

**为什么必须在后端守门**：前端 `redactSecretsInOutput` 使用**字面子串替换**
对 stdout/stderr 做脱敏，阈值一刀切 `< 8 跳过`——短 key 天生在前端无法安
全脱敏（4 字符密钥 `test` 若参与替换会误伤大量业务文本中的 `test` 字样，
导致 Agent 读到满屏 `***REDACTED***` 无法调试；3 字符以下则直接泛滥）。

**后端补齐的承诺**：`derive_env_from_credential` 派生后的每个 env value
都 >= 8 字符，前端的"< 8 跳过"就从**安全漏洞**变成**数学上不会触发**的
保底分支（真实数据路径下永远不会有短 key 到达前端）。若凭据提供的字段
短于 8 字符，整条凭据视作"派生失败"返回空 dict → 端点回 422
`ENV_DERIVATION_FAILED` → 用户在设置里修正后重试。

**边界**：这个下限只针对 Skill 运行时注入路径（skill-reveal 端点）。
autofill-reveal（网站/App 密码）不受约束——那条路径走 `autofill-service`
的 DOM 直填，不经过子进程 env 注入，也不依赖字面脱敏。
"""


def _filter_too_short_values(
    env: Dict[str, str],
    *,
    service_name: str,
    credential_id_hint: Optional[str] = None,
) -> Dict[str, str]:
    """若 env dict 里存在任一 value 长度 < MIN_SECRET_VALUE_LENGTH，
    **整体返回空 dict**。

    为什么要 "all-or-nothing"（而不是只丢短的、保留长的）：

    1. 多值服务里只丢短的 → 用户拿到半套 env，命令运行时才报"某变量缺失"——
       这种半套凭据的反模式应在派生函数层面就禁止；
    2. 即便是单值服务（如 openai 只有 OPENAI_API_KEY），凭据里配了短
       key → 与其静默注入半套，不如整体失败让端点回 422，用户立刻知道
       "这条凭据不合格需要改"；
    3. 短 key 本身很可能是**配置错误**（粘贴截断 / 占位符没换），整体
       失败的 UX 比"部分成功"更容易诊断。

    过滤发生时写 warning 日志（只打变量名——值本身绝不打）。
    """
    violations: List[str] = []
    for k, v in env.items():
        if not isinstance(v, str) or len(v) < MIN_SECRET_VALUE_LENGTH:
            violations.append(k)
    if violations:
        logger.warning(
            "[CredentialVault] skill-reveal reject — short secret values: "
            "service=%s credential=%s env_vars=%s min=%d",
            service_name, credential_id_hint, sorted(violations),
            MIN_SECRET_VALUE_LENGTH,
        )
        return {}
    return dict(env)


def derive_env_from_credential(
    *,
    service_name: str,
    encrypted_data: Dict[str, Any],
    primary_env_hint: Optional[str],
    credential_id_hint: Optional[str] = None,
) -> Dict[str, str]:
    """把一条凭据的 ``encrypted_data`` 派生成子进程 env 变量字典。

    保留轻量包装函数：只返回 env dict（内部调用 ``derive_env_with_meta``
    后丢 meta）。新代码建议直接用 ``derive_env_with_meta`` 拿 ``reason`` +
    ``warnings`` 做更精细的降级。
    """
    env, _meta = derive_env_with_meta(
        service_name=service_name,
        encrypted_data=encrypted_data,
        primary_env_hint=primary_env_hint,
        credential_id_hint=credential_id_hint,
    )
    return env


def derive_env_with_meta(
    *,
    service_name: str,
    encrypted_data: Dict[str, Any],
    primary_env_hint: Optional[str],
    credential_id_hint: Optional[str] = None,
) -> Tuple[Dict[str, str], Dict[str, Any]]:
    """派生 env + 附带 meta（reason / warnings）——供 skill_reveal_view 细化 422。

    产品视角 Review F + G 的修复点：原实现在两种失败场景下都回 422
    ``ENV_DERIVATION_FAILED``，用户无从得知是 (a) 短 key (b) 非映射表服务
    且无 primary_env (c) primary_env 名字非法，无法自助修复。现在：

    - env 空 dict + reason ∈ {``SHORT_SECRET``, ``UNKNOWN_SERVICE``,
      ``INVALID_PRIMARY_ENV``, ``MISSING_PRIMARY_ENV``, ``EMPTY_CREDENTIAL``}
    - env 非空 + warnings 含 ``primary_env_ignored_for_mapped_service``：
      service_name 命中映射表但用户 primary_env 与派生结果 keys 不重合——
      用户写了期望变量但被映射表覆盖。让 resolver 把这个 warning 作为
      SYSTEM_NOTICE 的补充文案，用户得知 "你的 primary_env 没生效"。

    **规则优先级**：
      1. encrypted_data 空/无 `api_key` 类字段 → ``EMPTY_CREDENTIAL``（422）
      2. service 命中映射表 → 走映射派生 + 短 key 过滤
          - 若 primary_env_hint 合法但未在派生 keys 内：warnings 添加
            `primary_env_ignored_for_mapped_service`，200 正常返回
      3. service 不命中：
          - primary_env_hint 缺省 → ``MISSING_PRIMARY_ENV``
          - primary_env_hint 非法字符 → ``INVALID_PRIMARY_ENV``
          - 合法但 api_key 太短 → ``SHORT_SECRET``
    """
    svc = (service_name or "").strip().lower()
    is_mapped = svc in SKILL_CREDENTIAL_ENV_MAP
    deriver = SKILL_CREDENTIAL_ENV_MAP.get(svc, _derive_generic)

    warnings: List[str] = []
    meta: Dict[str, Any] = {"reason": None, "warnings": warnings}

    # 空凭据直接失败——不浪费下面派生的 CPU
    if not encrypted_data:
        meta["reason"] = "EMPTY_CREDENTIAL"
        return {}, meta

    # 非映射表 + primary_env_hint 合法性校验（比走完派生再发现短 key 更早失败）
    if not is_mapped:
        if not primary_env_hint:
            meta["reason"] = "MISSING_PRIMARY_ENV"
            return {}, meta
        if not _is_valid_env_var_name(primary_env_hint):
            meta["reason"] = "INVALID_PRIMARY_ENV"
            logger.warning(
                "[CredentialVault] skill-reveal reject — invalid primary_env: "
                "service=%s credential=%s primary_env=%r",
                svc or "unknown", credential_id_hint, primary_env_hint,
            )
            return {}, meta

    raw_env = deriver(encrypted_data, primary_env_hint)
    if not raw_env:
        # 派生函数自己返回空（如多字段服务缺某值）——不一定是短 key，归
        # ENV_DERIVATION_FAILED 大类
        meta["reason"] = "ENV_DERIVATION_FAILED"
        return {}, meta

    filtered = _filter_too_short_values(
        raw_env,
        service_name=svc or "unknown",
        credential_id_hint=credential_id_hint,
    )
    if not filtered:
        meta["reason"] = "SHORT_SECRET"
        return {}, meta

    # 映射表服务 + 用户传了 primary_env 但未在 keys 内 → warning
    if is_mapped and primary_env_hint:
        if primary_env_hint not in filtered:
            warnings.append("primary_env_ignored_for_mapped_service")
            logger.info(
                "[CredentialVault] skill-reveal primary_env ignored: "
                "service=%s credential=%s user_primary_env=%s derived_keys=%s",
                svc, credential_id_hint, primary_env_hint, sorted(filtered.keys()),
            )

    return filtered, meta


# ---------------------------------------------------------------------------
# Endpoint 主体
# ---------------------------------------------------------------------------


def _lookup_credential_id_from_space(
    *, user_id: str, space_id: str, agent_id: str, skill_key: str
) -> Optional[str]:
    """按 ``(agent_id, skill_key)`` 从 ``AgentSkillLink.config_json`` 取凭据 ID。

    ``space_id`` 作为可选 Workspace 锚点传入 ``resolve_skill_space_context``
    （：Skill 归属 Agent，不再从 Workspace 反推身份）。
    找不到 / 字段为空都返回 None；调用方按"无绑定"处理（404）。
    """
    from apps.skills.models import AgentSkillLink
    from apps.skills.services.space_context import resolve_skill_space_context

    context = resolve_skill_space_context(space_id, agent_id=agent_id)
    row = AgentSkillLink.objects.filter(
        agent_id=context.agent_id,
        skill_canonical_key=skill_key,
    ).first()
    if not row:
        return None
    cfg = row.config_json or {}
    if not isinstance(cfg, dict):
        return None
    cred_id = cfg.get("credential_id")
    if not isinstance(cred_id, str) or not cred_id:
        return None
    return cred_id


def skill_reveal_view(request, payload: "SkillRevealIn") -> JsonResponse:  # noqa: F821
    """``POST /api/credential-vault/skill-reveal`` — Wave 1.5 核心端点。

    入参：``{space_id, agent_id, skill_key, primary_env?}``（body）
    出参：``{success, credential_id, service_name, env: {ENV_VAR: value}}``

    不对称于 ``/app/.../autofill-reveal`` 的地方：
    - URL 里没有 ``credential_id``——由 ``(agent_id, skill_key)`` 从
      ``AgentSkillLink.config_json`` 反查得到。**一步到位**避免 Agent
      为每次调用多发一次 GET。
    - 返回 ``env`` 字典而非 ``encrypted_data``——env 变量名由后端统一决定，
      前端 runtime 拿到就能直接 ``spawn({env: {...process.env, ...resp.env}})``。
      这让"service → env name"映射表成为**唯一来源**（在 SKILL_CREDENTIAL_ENV_MAP），
      避免 Electron / Daemon 各自硬编码出现漂移。

    错误码：
    - 400 ``INVALID_SPACE_SKILL`` — 参数缺失
    - 404 ``SKILL_NOT_BOUND`` — skill_configs 里没这个 skill_key 或 credential_id 为空
    - 404 ``NOT_FOUND`` — credential_id 指向的凭据不存在 / 非当前用户 / 非 api_key 类别
    - 410 ``CREDENTIAL_EXPIRED`` / ``CREDENTIAL_INACTIVE`` — 失效（与 autofill 对齐）
    - 422 ``ENV_DERIVATION_FAILED`` / ``SHORT_SECRET`` / ``MISSING_PRIMARY_ENV`` /
      ``INVALID_PRIMARY_ENV`` / ``EMPTY_CREDENTIAL`` — 派生失败分子码（详见
      ``derive_env_with_meta``）
    - 429 ``RATE_LIMITED`` — per-user 60/5min 配额耗尽

    **PROD-5（2026-04-24 拍板）— 冲突响应：200 + warning，非 422**

    当 Skill 声明的 ``primary_env`` 与凭据 ``service_name`` 的默认映射不一致时：
    - 若 ``service_name`` 在 ``SKILL_CREDENTIAL_ENV_MAP`` 映射表内
      （openai / anthropic / serper）：**以映射表为准**
      派生 env，并返回 ``warnings: ["primary_env_ignored_for_mapped_service"]``。
      状态码 **200**（派生成功），**不走 422 拒绝**。
    - 若 ``service_name`` 不在映射表内：以 ``primary_env_hint`` 为准
      （``_derive_generic``），不产生 warning。

    **产品视角理由**：映射表是官方维护的权威映射——openai 凭据就是要
    派生成 ``OPENAI_API_KEY``，用户写的 ``primary_env: MY_CUSTOM_KEY``
    很可能是 Skill 作者笔误或版本不同步。硬拒绝（422）会让 Agent 执行
    完全失败，用户看到的错误远离根因；200 + warning 的策略则让 Agent
    能拿到密钥继续执行，命令若因变量名错配失败会产生**具体的命令级
    错误**（如 "OPENAI_API_KEY not set"），用户诊断路径更短。

    **前端消费契约**：共享 resolver
    （``packages/agent-host/src/credentials/skill-credential-resolver.ts``）
    把 ``warnings`` 透传到 ``SkillCredentialInjection.warnings``；
    `run_terminal_command` 运行时在注入 env 的同时发 ``notice_type: 'skill_credential_warning'``
    的 SYSTEM_NOTICE，让 LLM / 用户可感知 "env 注入成功但变量名可能不符
    预期"。
    """
    user = request.auth
    user_id = str(user.id)
    space_id = (payload.space_id or "").strip()
    agent_id = (payload.agent_id or "").strip()
    skill_key = (payload.skill_key or "").strip()
    primary_env_hint = (payload.primary_env or "").strip() or None

    if not space_id or not agent_id or not skill_key:
        return JsonResponse(
            {
                "success": False,
                "message": "space_id、agent_id 与 skill_key 均为必填",
                "code": "INVALID_SPACE_SKILL",
            },
            status=400,
        )

    # ── 1. 限流 ──
    allowed, retry_after = _check_skill_reveal_rate_limit(user_id)
    if not allowed:
        logger.warning(
            "[CredentialVault] skill-reveal rate limited for user=%s space=%s skill=%s retry_after=%ds",
            user_id, space_id, skill_key, retry_after,
        )
        # Wave 2a 补丁 P1-1（独立质疑 8）：429 响应必须带 ``Retry-After`` header
        # + body 里的 ``retry_after_seconds``；skill-reveal 与 autofill-reveal
        # 对称——都是 Agent 端消费的限流响应，让命令工具 / 前端能统一按
        # retry_after 退避。
        resp = JsonResponse(
            {
                "success": False,
                "message": _("middleware.rate_limited"),
                "code": "RATE_LIMITED",
                "retry_after_seconds": retry_after,
            },
            status=429,
        )
        resp["Retry-After"] = str(retry_after)
        return resp

    # ── 2. 反查 credential_id ──
    try:
        credential_id = _lookup_credential_id_from_space(
            user_id=user_id,
            space_id=space_id,
            agent_id=agent_id,
            skill_key=skill_key,
        )
    except SkillSpaceContextError as exc:
        return JsonResponse(
            {
                "success": False,
                "message": str(exc),
                "code": "INVALID_SPACE_SKILL",
            },
            status=400,
        )
    if credential_id is None:
        logger.info(
            "[CredentialVault] skill-reveal no binding: user=%s space=%s skill=%s",
            user_id, space_id, skill_key,
        )
        return JsonResponse(
            {
                "success": False,
                "message": _("credential_vault.skill_not_bound"),
                "code": "SKILL_NOT_BOUND",
            },
            status=404,
        )

    # ── 3. 查凭据 + category 校验（api_key 专属） ──
    try:
        credential: UserCredential = UserCredential.objects.get(
            id=credential_id,
            user=user,
            category=CredentialCategory.API_KEY,
        )
    except UserCredential.DoesNotExist:
        logger.warning(
            "[CredentialVault] skill-reveal not found / category mismatch: "
            "user=%s space=%s skill=%s credential=%s",
            user_id, space_id, skill_key, credential_id,
        )
        return JsonResponse(
            {
                "success": False,
                "message": _("credential_vault.credential_not_found"),
                "code": "NOT_FOUND",
            },
            status=404,
        )
    except (ValueError, TypeError):
        return JsonResponse(
            {
                "success": False,
                "message": _("credential_vault.credential_not_found"),
                "code": "NOT_FOUND",
            },
            status=404,
        )

    # ── 4. 过期 / 停用（与 autofill-reveal 对齐） ──
    if credential.expires_at and credential.expires_at < timezone.now():
        logger.info(
            "[CredentialVault] skill-reveal denied — credential expired: "
            "user=%s skill=%s credential=%s",
            user_id, skill_key, credential_id,
        )
        return JsonResponse(
            {
                "success": False,
                "message": _("credential_vault.credential_expired"),
                "code": "CREDENTIAL_EXPIRED",
            },
            status=410,
        )
    if not credential.is_active:
        logger.info(
            "[CredentialVault] skill-reveal denied — credential inactive: "
            "user=%s skill=%s credential=%s",
            user_id, skill_key, credential_id,
        )
        return JsonResponse(
            {
                "success": False,
                "message": _("credential_vault.credential_inactive"),
                "code": "CREDENTIAL_INACTIVE",
            },
            status=410,
        )

    # ── 5. 派生 env（带 meta） ──
    env, derive_meta = derive_env_with_meta(
        service_name=credential.service_name,
        encrypted_data=credential.encrypted_data or {},
        primary_env_hint=primary_env_hint,
        credential_id_hint=str(credential_id),
    )
    if not env:
        reason = derive_meta.get("reason") or "ENV_DERIVATION_FAILED"
        logger.warning(
            "[CredentialVault] skill-reveal env derivation failed: "
            "user=%s skill=%s credential=%s service=%s primary_env=%s reason=%s",
            user_id, skill_key, credential_id, credential.service_name,
            primary_env_hint, reason,
        )
        # Review G + 用户视角 P1：分子码让 UI / LLM 能精准归因。
        # 所有子码仍走 422 status（语义：凭据数据层面的问题，非权限/存在性问题）
        return JsonResponse(
            {
                "success": False,
                "message": _("credential_vault.env_derivation_failed"),
                "code": reason,
                # 用户可识别的可读提示（短），按 reason 差异化文案——
                # 不引入 i18n key 扩展以避免本次补丁面扩大，而是内联英文
                # 短句（LLM 能直接理解，UI 也能展示；Wave 5 UI 细化时再
                # 分出 i18n key）。
                "hint": _RESOLUTION_HINTS.get(reason, _RESOLUTION_HINTS["ENV_DERIVATION_FAILED"]),
            },
            status=422,
        )

    # ── 6. 成功审计（不含明文！）──
    # 日志里记录：user / space / skill / credential / service / env 变量**名列表**，
    # env 变量的**值**绝对不写。env.keys() 是**名字**集合，可安全落盘。
    warnings = derive_meta.get("warnings") or []
    logger.info(
        "[CredentialVault] skill-reveal issued: user=%s space=%s skill=%s "
        "credential=%s service=%s env_vars=%s warnings=%s",
        user_id, space_id, skill_key, credential_id,
        credential.service_name, sorted(env.keys()), warnings,
    )

    response: Dict[str, Any] = {
        "success": True,
        "credential_id": str(credential_id),
        "service_name": credential.service_name,
        "env": env,
    }
    if warnings:
        # 只在有 warnings 时才写字段（减小 200 响应体积）
        response["warnings"] = warnings
    return JsonResponse(response, status=200)


# ---------------------------------------------------------------------------
# 用户可读的 resolution hint 映射（Review G）
# ---------------------------------------------------------------------------

_RESOLUTION_HINTS: Dict[str, str] = {
    "SHORT_SECRET": (
        "凭据里的密钥字段过短（需 ≥ 8 字符），请在「登录与密钥」里更新为完整密钥后重试。"
    ),
    "UNKNOWN_SERVICE": (
        "该服务不在内置映射表内，请在 Skill 的 SKILL.md frontmatter 里声明 "
        "primary_env 字段（如 `primary_env: CUSTOM_LLM_API_KEY`）。"
    ),
    "MISSING_PRIMARY_ENV": (
        "该服务不在内置映射表内，Skill 的 SKILL.md frontmatter 需声明 "
        "primary_env 字段（如 `primary_env: CUSTOM_LLM_API_KEY`）。"
    ),
    "INVALID_PRIMARY_ENV": (
        "SKILL.md 里 primary_env 的值不是合法的环境变量名（只允许字母/数字/下划线，"
        "且不以数字起头）。请修正后重试。"
    ),
    "EMPTY_CREDENTIAL": (
        "凭据内容为空，请在「登录与密钥」里补全字段后重试。"
    ),
    "ENV_DERIVATION_FAILED": (
        "无法从凭据派生环境变量，请检查凭据字段是否完整（多字段服务需要把所有必填字段都填上）。"
    ),
}
