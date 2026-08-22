from __future__ import annotations

import logging
from typing import List
from uuid import UUID

from apps.i18n import _
from django.core.cache import cache
from django.db import transaction
from django.http import JsonResponse
from django.shortcuts import get_object_or_404
from django.utils import timezone
from ninja import Router

from apps.users.auth.permissions import JWTAuth
from .models import (
    CredentialCategory,
    SaveBlacklistEntry,
    UserCredential,
    UserOnboardingState,
)
from .schemas import (
    AppCredentialCreateIn,
    AppCredentialOut,
    CredentialCreateIn,
    CredentialUpdateIn,
    CredentialOut,
    OnboardingStateOut,
    OnboardingStateUpdateIn,
    RevealCredentialIn,
    SaveBlacklistAddIn,
    SaveBlacklistOut,
    SkillRevealIn,
    WebsiteCredentialCreateIn,
    WebsiteCredentialBatchImportIn,
    WebsiteCredentialUpdateIn,
    WebsiteCredentialOut,
)
from .skill_reveal import skill_reveal_view

logger = logging.getLogger(__name__)

jwt_auth = JWTAuth()

router = Router(auth=jwt_auth)

REVEAL_RATE_LIMIT_MAX = 5
REVEAL_RATE_LIMIT_WINDOW = 300

# W2-PRE-3：元数据列表端点的宽松限流。
#
# 威胁模型：JWT 被窃取后，攻击者即便不能直接解密（reveal 需要密码二次验证 +
# 严格限流），也可以脚本化调用 ``GET /list`` 批量枚举用户凭据的元数据
# （service_name / display_name / category / username），拼装出 "这个人用
# 过哪些网站" 的画像——这本身就是隐私泄漏。
#
# 设计取舍：
#   - 100 次 / 分钟 = 平均每秒 1.67 次。正常 UI 场景下用户切换分类也就几次
#     调用，远低于此；但对脚本化枚举是强硬约束（一次 page=20 的话 5 秒就
#     用完）。
#   - per-user 而非 per-IP：与 ``_check_reveal_rate_limit`` 同口径，JWT 决定
#     归属。
#   - 与 reveal / autofill 限流**独立 cache key**：list 是高频元数据 read，
#     reveal 是低频明文 read，二者共用会让正常浏览把 reveal 配额顶掉。
LIST_RATE_LIMIT_MAX = 100
LIST_RATE_LIMIT_WINDOW = 60


def _rate_limited_response(retry_after: int) -> JsonResponse:
    """Wave 2a 补丁 P1-1（独立质疑 8）：统一 429 响应构造器。

    RFC 6585 要求 429 响应 **应当** 携带 ``Retry-After`` 指明客户端重试窗口；
    各 autofill 限流内部已返回 ``retry_after`` tuple，但之前被直接丢弃，
    导致客户端（Electron / 移动端 / 第三方 SDK）只能按自己估计的退避跑。

    为什么同时放 header 和 body 字段：
      - HTTP 标准客户端（fetch / axios）读 ``Retry-After`` header 即可，对通用
        HTTP 工具链 friendly；
      - 但 Django Ninja 的 JSON schema 客户端往往只 parse body（渲染错误气泡时），
        body 里加 ``retry_after_seconds`` 方便前端直接展示"还剩 N 秒"倒计时；
      - 两处同源（来自 ``retry_after`` 参数），不会出现漂移。

    参数 ``retry_after`` 单位秒，最小 1（``_check_*_rate_limit`` 已保证）。
    """
    # Wave 2A(L-8 修复):body 与全局 middleware 信封完全对齐 — 加入 ``data: null``
    # 字段。两条 429 路径(全局 ``RateLimitMiddleware`` + 端点级 vault)从此返回
    # ``{success, code, message, data, retry_after_seconds}`` 同一结构,客户端
    # 写一套解析就能覆盖。详见 ``docs/api/rate-limit-protocol.md`` §5.4。
    resp = JsonResponse(
        {
            "success": False,
            "code": "RATE_LIMITED",
            "message": _("middleware.rate_limited"),
            "data": None,
            "retry_after_seconds": retry_after,
        },
        status=429,
    )
    resp["Retry-After"] = str(retry_after)
    return resp


def _check_list_rate_limit(user_id: str) -> tuple[bool, int]:
    """凭据元数据 list 端点的宽松限流（W2-PRE-3）。

    返回 ``(allowed, retry_after_seconds)``。拒绝时 retry_after_seconds >= 1。
    """
    cache_key = f"credential_list_rate:{user_id}"
    cache.add(cache_key, 0, LIST_RATE_LIMIT_WINDOW)
    try:
        count = cache.incr(cache_key)
    except ValueError:
        cache.set(cache_key, 1, LIST_RATE_LIMIT_WINDOW)
        count = 1
    if count > LIST_RATE_LIMIT_MAX:
        ttl = cache.ttl(cache_key) if hasattr(cache, 'ttl') else LIST_RATE_LIMIT_WINDOW
        return False, max(ttl, 1)
    return True, 0


def _check_reveal_rate_limit(user_id: str) -> tuple[bool, int]:
    """原子递增式速率限制，复用项目既有的 cache.add + cache.incr 模式。"""
    cache_key = f"credential_reveal_rate:{user_id}"

    cache.add(cache_key, 0, REVEAL_RATE_LIMIT_WINDOW)
    try:
        count = cache.incr(cache_key)
    except ValueError:
        cache.set(cache_key, 1, REVEAL_RATE_LIMIT_WINDOW)
        count = 1

    if count > REVEAL_RATE_LIMIT_MAX:
        ttl = cache.ttl(cache_key) if hasattr(cache, 'ttl') else REVEAL_RATE_LIMIT_WINDOW
        return False, max(ttl, 1)

    return True, 0


@router.get("/list", response=List[CredentialOut])
def list_credentials(request, category: str = None):
    """获取当前用户的所有凭据（脱敏展示）。

    W2-PRE-3：加宽松限流——100 次/分钟 per-user。防止 JWT 被盗后脚本化枚举
    凭据元数据（service_name / username / category）构造用户画像。
    正常 UI 使用不会触发。超限返回 429 ``RATE_LIMITED``。
    """
    allowed, retry_after = _check_list_rate_limit(str(request.auth.id))
    if not allowed:
        logger.warning(
            "[CredentialVault] list rate limited for user=%s retry_after=%ds",
            request.auth.id, retry_after,
        )
        return _rate_limited_response(retry_after)
    qs = UserCredential.objects.filter(user=request.auth)
    if category:
        qs = qs.filter(category=category)
    return [CredentialOut.from_model(c) for c in qs]


@router.post("/create", response=CredentialOut)
def create_credential(request, payload: CredentialCreateIn):
    """创建新凭据。"""
    credential = UserCredential.objects.create(
        user=request.auth,
        category=payload.category,
        service_name=payload.service_name,
        display_name=payload.display_name,
        encrypted_data=payload.credential_data,
        metadata=payload.metadata,
        expires_at=payload.expires_at,
    )
    return CredentialOut.from_model(credential)


# ---------------------------------------------------------------------------
# Wave 3 G5 / PD-8：保存密码黑名单（"不为此网站保存"）
#
# ⚠️ 路由顺序锁：这块**必须**放在 ``/{credential_id}`` 通配路由**之前**。
# Django Ninja 把 ``credential_id: UUID`` 翻译成 ``<credential_id>`` 通用 path
# converter（不是 ``<uuid:credential_id>``），所以 ``/save-blacklist`` 会被
# ``/<credential_id>`` 抢先匹配 → POST 返回 405（PUT/DELETE 已注册），UUID 解析
# 失败时还会 500。多段路径（``/website/...`` / ``/app/...``）天然不冲突——
# 单段路径**只能**靠注册顺序取胜。
# ---------------------------------------------------------------------------


@router.get("/save-blacklist", response=List[SaveBlacklistOut])
def list_save_blacklist(request):
    """列出当前用户的"不为此网站保存"黑名单。

    用于：
      - Electron 主进程 ``checkDomainBlacklist`` 缓存查询（5min TTL）；
      - Wave 5 设置页的"网站登录"区块管理黑名单（用户撤回不再提示）。

    无独立限流：黑名单本身无敏感信息泄漏（只暴露 domain 列表给已登录用户
    自己），且复用全局 list 限流（100/min）就够。
    """
    qs = SaveBlacklistEntry.objects.filter(user=request.auth)
    return [SaveBlacklistOut.from_model(e) for e in qs]


@router.post("/save-blacklist", response=SaveBlacklistOut)
def add_save_blacklist(request, payload: SaveBlacklistAddIn):
    """加入黑名单（用户在保存密码提示条点"不为此网站保存"）。

    幂等：同一 (user, domain) 已存在时返回旧记录而非 422——避免前端缓存
    漂移导致重复加入失败。
    """
    entry, _created = SaveBlacklistEntry.objects.get_or_create(
        user=request.auth,
        domain=payload.domain,
    )
    logger.info(
        "[CredentialVault] save-blacklist add: user=%s domain=%s created=%s",
        request.auth.id, payload.domain, _created,
    )
    return SaveBlacklistOut.from_model(entry)


@router.get("/onboarding/state", response=OnboardingStateOut)
def get_onboarding_state(request):
    """Wave 5c T1：拉取首次引导跨设备状态。

    幂等：从未交互的用户返回全 null（前端按"未引导过"展示气泡）；
    `get_or_create` 不在 GET 里建行——避免读端点产生写副作用。
    """
    state = UserOnboardingState.objects.filter(user=request.auth).first()
    if state is None:
        return OnboardingStateOut()
    return OnboardingStateOut(
        onboarding_dismissed_at=state.onboarding_dismissed_at,
        browser_import_completed_at=state.browser_import_completed_at,
        browser_import_source=state.browser_import_source or "",
    )


@router.put("/onboarding/state", response=OnboardingStateOut)
def update_onboarding_state(request, payload: OnboardingStateUpdateIn):
    """Wave 5c T1：更新首次引导状态。

    支持的 action：
      - `dismiss`: 用户点了"稍后再说"或 ×。写 onboarding_dismissed_at = now。
      - `complete`: 成功完成"从浏览器导入"流程。写 browser_import_completed_at = now
        + browser_import_source（埋点）。
      - `reset`: 把两个时间戳清空（仅供 dev / debug，生产 UI 不暴露）。

    幂等：dismiss / complete 已经是 not null 时**不覆盖**——避免重发把
    "用户最初 dismiss 时间"刷新成最近值，污染追溯。
    """
    state, _created = UserOnboardingState.objects.get_or_create(user=request.auth)
    now = timezone.now()
    if payload.action == "dismiss":
        if state.onboarding_dismissed_at is None:
            state.onboarding_dismissed_at = now
            state.save(update_fields=["onboarding_dismissed_at", "updated_at"])
    elif payload.action == "complete":
        update_fields = ["updated_at"]
        if state.browser_import_completed_at is None:
            state.browser_import_completed_at = now
            update_fields.append("browser_import_completed_at")
        if payload.browser_import_source:
            state.browser_import_source = payload.browser_import_source[:32]
            update_fields.append("browser_import_source")
        state.save(update_fields=update_fields)
    elif payload.action == "reset":
        state.onboarding_dismissed_at = None
        state.browser_import_completed_at = None
        state.browser_import_source = ""
        state.save(update_fields=[
            "onboarding_dismissed_at",
            "browser_import_completed_at",
            "browser_import_source",
            "updated_at",
        ])
    logger.info(
        "[CredentialVault] onboarding update: user=%s action=%s source=%s",
        request.auth.id, payload.action, payload.browser_import_source or "-",
    )
    return OnboardingStateOut(
        onboarding_dismissed_at=state.onboarding_dismissed_at,
        browser_import_completed_at=state.browser_import_completed_at,
        browser_import_source=state.browser_import_source or "",
    )


@router.delete("/save-blacklist/{domain}")
def remove_save_blacklist(request, domain: str):
    """从黑名单移除（用户在设置页"撤回"）。

    domain 走 path 参数：与 GET / POST 形成 RESTful 三元组；URL 编码由
    Django 自动 decode。
    """
    domain = (domain or "").strip().lower().lstrip(".")
    if not domain:
        return JsonResponse(
            {"success": False, "message": _("validation.invalid_field_value", field_name="domain")},
            status=400,
        )
    deleted, _by_label = SaveBlacklistEntry.objects.filter(
        user=request.auth, domain=domain,
    ).delete()
    logger.info(
        "[CredentialVault] save-blacklist remove: user=%s domain=%s deleted=%d",
        request.auth.id, domain, deleted,
    )
    return {"success": True, "deleted": deleted}


@router.put("/{credential_id}", response=CredentialOut)
def update_credential(request, credential_id: UUID, payload: CredentialUpdateIn):
    """更新凭据。"""
    credential = get_object_or_404(
        UserCredential, id=credential_id, user=request.auth
    )

    if payload.display_name is not None:
        credential.display_name = payload.display_name
    if payload.credential_data is not None:
        if not payload.credential_data:
            return JsonResponse(
                {"success": False, "message": _("validation.invalid_field_value", field_name="credential_data")},
                status=400,
            )
        credential.encrypted_data = payload.credential_data
    if payload.metadata is not None:
        credential.metadata = payload.metadata
    if payload.is_active is not None:
        credential.is_active = payload.is_active
    if payload.expires_at is not None:
        credential.expires_at = payload.expires_at

    credential.save()
    return CredentialOut.from_model(credential)


@router.delete("/{credential_id}")
def delete_credential(request, credential_id: UUID):
    """删除凭据。"""
    credential = get_object_or_404(
        UserCredential, id=credential_id, user=request.auth
    )
    credential.delete()
    return {"success": True}


@router.post("/{credential_id}/reveal")
def reveal_credential(request, credential_id: UUID, payload: RevealCredentialIn):
    """获取凭据明文数据，要求用户密码二次验证 + 速率限制。"""
    user = request.auth
    user_id = str(user.id)

    allowed, retry_after = _check_reveal_rate_limit(user_id)
    if not allowed:
        logger.warning(
            "[CredentialVault] reveal rate limited for user=%s retry_after=%ds",
            user_id, retry_after,
        )
        return _rate_limited_response(retry_after)

    if not user.check_password(payload.password):
        logger.warning(
            "[CredentialVault] reveal password mismatch for user=%s", user_id
        )
        return JsonResponse(
            {
                "success": False,
                "message": _("credential_vault.password_verification_failed"),
                "code": "PASSWORD_MISMATCH",
            },
            status=403,
        )

    credential = get_object_or_404(
        UserCredential, id=credential_id, user=user
    )
    return {
        "success": True,
        "data": credential.encrypted_data,
    }


# ---------------------------------------------------------------------------
# 网站凭据（Website Login）专用端点
# ---------------------------------------------------------------------------


def _extract_domain(url: str) -> str:
    """从 URL 中提取域名用于匹配。"""
    from urllib.parse import urlparse
    try:
        parsed = urlparse(url if "://" in url else f"https://{url}")
        host = parsed.hostname or url
        return host.lower().lstrip(".")
    except Exception:
        return url.lower()


@router.post("/website/create", response=WebsiteCredentialOut)
def create_website_credential(request, payload: WebsiteCredentialCreateIn):
    """创建网站登录凭据。"""
    domain = _extract_domain(payload.url)
    credential = UserCredential.objects.create(
        user=request.auth,
        category=CredentialCategory.WEBSITE_LOGIN,
        service_name=domain,
        display_name=payload.display_name or domain,
        encrypted_data={
            "url": payload.url,
            "username": payload.username,
            "password": payload.password,
        },
    )
    return WebsiteCredentialOut.from_model(credential)


@router.post("/website/batch-import")
def batch_import_website_credentials(request, payload: WebsiteCredentialBatchImportIn):
    """批量导入网站登录凭据（从浏览器密码提取器调用）。"""
    existing = UserCredential.objects.filter(
        user=request.auth,
        category=CredentialCategory.WEBSITE_LOGIN,
    )
    existing_keys: set[tuple[str, str]] = set()
    for cred in existing:
        data = cred.encrypted_data or {}
        existing_keys.add((data.get("url", ""), data.get("username", "")))

    created = 0
    skipped = 0
    with transaction.atomic():
        for item in payload.credentials:
            key = (item.url, item.username)
            if key in existing_keys:
                skipped += 1
                continue
            domain = _extract_domain(item.url)
            UserCredential.objects.create(
                user=request.auth,
                category=CredentialCategory.WEBSITE_LOGIN,
                service_name=domain,
                display_name=item.display_name or domain,
                encrypted_data={
                    "url": item.url,
                    "username": item.username,
                    "password": item.password,
                },
            )
            existing_keys.add(key)
            created += 1
    return {"success": True, "created": created, "skipped": skipped}


@router.get("/website/list", response=List[WebsiteCredentialOut])
def list_website_credentials(request):
    """列出当前用户所有网站凭据（脱敏）。"""
    qs = UserCredential.objects.filter(
        user=request.auth,
        category=CredentialCategory.WEBSITE_LOGIN,
    )
    return [WebsiteCredentialOut.from_model(c) for c in qs]


@router.get("/website/match", response=List[WebsiteCredentialOut])
def match_website_credentials(request, domain: str):
    """按域名模糊匹配网站凭据。

    匹配逻辑：精确匹配或上级域名匹配。
    例如 domain=login.github.com 可匹配 service_name=github.com。

    Wave 4 PD-10 排序：``last_used_at DESC NULLS LAST, created_at DESC``。
    多匹配场景下 Agent 后台 view 取**第一条**自动填充（autofill-service
    onViewDomReady 的 Agent 分支）。语义：
      - 同一域名下用户最近用过哪个账号 → Agent 跟着用；
      - 从未用过的（last_used_at IS NULL）排到所有"用过的"之后；
      - 同样从未用过的，按创建时间倒序——最新创建的更可能是用户当前关心的。

    数据库层 NULLS LAST 兼容：
      - PostgreSQL 直接支持 ``NULLS LAST``；
      - MySQL 默认 NULL 排到最前——这里用 Django 的 ``F('last_used_at').desc(nulls_last=True)``
        在两库都能产出正确 SQL（MySQL 走 ``IS NULL ASC`` 兜底）。
    """
    from django.db.models import F

    domain = domain.lower().strip().lstrip(".")
    if not domain:
        return []
    # 一次查全量再 Python 过滤——用户的 website_login 总数一般 < 100，
    # 不值得在 SQL 层做后缀匹配（且 ORM 表达式跨库不一致）。排序在
    # SQL 层做，保证 last_used_at 顺序权威。
    candidates = UserCredential.objects.filter(
        user=request.auth,
        category=CredentialCategory.WEBSITE_LOGIN,
        is_active=True,
    ).order_by(
        F("last_used_at").desc(nulls_last=True),
        "-created_at",
    )

    matched = []
    for cred in candidates:
        svc = cred.service_name.lower()
        if svc == domain or domain.endswith(f".{svc}"):
            matched.append(WebsiteCredentialOut.from_model(cred))
    return matched


# 注意：此路由必须注册在所有字面量 ``/website/<word>`` 路由（create /
# batch-import / list / match）**之后**。Django Ninja 对路径参数使用宽松的
# ``str`` 转换器（``UUID`` 类型注解只在视图内校验、不影响 URL 匹配），
# ``/website/{credential_id}`` 会贪婪匹配 ``/website/match`` 等字面量路径，
# 若注册在前会把它们顶成 405（ 回归）。三段式 ``/website/{id}/reveal``
# 等因段数不同不受影响。
@router.put("/website/{credential_id}", response=WebsiteCredentialOut)
def update_website_credential(request, credential_id: UUID, payload: WebsiteCredentialUpdateIn):
    """更新网站登录凭据（部分字段）。

    - ``password`` 省略 / 为空 → 保留原密码；
    - ``url`` 变更 → 同步重算 ``service_name``（域名）；
    - ``display_name`` 传空串 → 回退为域名。
    """
    credential = get_object_or_404(
        UserCredential,
        id=credential_id,
        user=request.auth,
        category=CredentialCategory.WEBSITE_LOGIN,
    )
    data = dict(credential.encrypted_data or {})

    if payload.url is not None:
        data["url"] = payload.url
        credential.service_name = _extract_domain(payload.url)
    if payload.username is not None:
        data["username"] = payload.username
    if payload.password:
        data["password"] = payload.password
    credential.encrypted_data = data

    if payload.display_name is not None:
        credential.display_name = payload.display_name or _extract_domain(data.get("url", ""))

    credential.save()
    return WebsiteCredentialOut.from_model(credential)


@router.post("/website/{credential_id}/reveal")
def reveal_website_credential(request, credential_id: UUID, payload: RevealCredentialIn):
    """获取网站凭据明文，复用密码二次验证和速率限制。"""
    user = request.auth
    user_id = str(user.id)

    allowed, retry_after = _check_reveal_rate_limit(user_id)
    if not allowed:
        logger.warning(
            "[CredentialVault] website reveal rate limited for user=%s retry_after=%ds",
            user_id, retry_after,
        )
        return _rate_limited_response(retry_after)

    if not user.check_password(payload.password):
        return JsonResponse(
            {"success": False, "message": _("credential_vault.password_verification_failed"), "code": "PASSWORD_MISMATCH"},
            status=403,
        )

    credential = get_object_or_404(
        UserCredential, id=credential_id, user=user, category=CredentialCategory.WEBSITE_LOGIN,
    )
    return {"success": True, "data": credential.encrypted_data}


AUTOFILL_RATE_LIMIT_MAX = 20
AUTOFILL_RATE_LIMIT_WINDOW = 300


def _check_autofill_rate_limit(user_id: str) -> tuple[bool, int]:
    """Autofill-reveal 限流：**per-user** 20 次 / 5 分钟，website + app **共用** 计数器。

    为什么 per-user 而不是 per-credential（W1-B 评审决策）：
      - per-user 总额度更紧，能限制"被盗 JWT 在窗口内批量拉取多条凭据"这种最危
        险的滥用，符合保险箱保护的主要威胁模型；
      - per-credential 总额度 = 凭据数 × 每条配额，极端情况下对用户泄露总量
        不降反升；
      - Agent 对"同一凭据反复 autofill"的合理场景是「填错→重试」，20 次在 5
        分钟窗口内已绰绰有余；超出通常意味着异常循环而非真实需求。
      - website 与 app 共用同一 key：同一窗口的**总**自动填充动作受统一保护，
        避免攻击者通过混合 website/app 调用把实际额度翻倍。
    """
    cache_key = f"credential_autofill_rate:{user_id}"
    cache.add(cache_key, 0, AUTOFILL_RATE_LIMIT_WINDOW)
    try:
        count = cache.incr(cache_key)
    except ValueError:
        cache.set(cache_key, 1, AUTOFILL_RATE_LIMIT_WINDOW)
        count = 1
    if count > AUTOFILL_RATE_LIMIT_MAX:
        ttl = cache.ttl(cache_key) if hasattr(cache, 'ttl') else AUTOFILL_RATE_LIMIT_WINDOW
        return False, max(ttl, 1)
    return True, 0


def _issue_autofill_credential(
    user,
    credential_id: UUID,
    expected_category: str,
    log_prefix: str,
) -> tuple[JsonResponse | None, UserCredential | None]:
    """Autofill-reveal 链路的**共用**前置校验（W1-B + 本次隐患修复）。

    所有 autofill-reveal 端点（website / app）在"查 category + 限流 + 过期 + 停
    用 + 审计"这些动作上是**完全对称**的；Wave 1 初版里 app 端点做了全套，
    website 漏了 expires/inactive/audit ——PD-4（自动允许）语义下 Agent 用户
    禁用凭据的意图被忽略，变相越权。抽到这里后两端点零差异复用。

    返回契约：
      - **成功**：``(None, credential)`` —— 调用方直接用 credential.encrypted_data
      - **失败**：``(JsonResponse(...), None)`` —— 调用方直接 ``return resp``

    错误码与 HTTP 状态：
      - 429 ``RATE_LIMITED``：per-user 20 次/5 分钟共享配额
      - 404 ``NOT_FOUND``：credential_id 不存在 / 不属于当前用户 / 不是期望的
        category（前端/Agent 靠 404 区分"资源不存在"与"资源失效"）
      - 410 ``CREDENTIAL_EXPIRED`` / ``CREDENTIAL_INACTIVE``：资源失效，Agent
        的 ``data-tools.ts::gone`` 分支会识别并**停止重试**，而非像 5xx 那样
        盲目退避
    """
    user_id = str(user.id)

    allowed, retry_after = _check_autofill_rate_limit(user_id)
    if not allowed:
        logger.warning(
            "[CredentialVault] %s autofill-reveal rate limited for user=%s credential=%s retry_after=%ds",
            log_prefix, user_id, credential_id, retry_after,
        )
        return (
            _rate_limited_response(retry_after),
            None,
        )

    try:
        credential = UserCredential.objects.get(
            id=credential_id,
            user=user,
            category=expected_category,
        )
    except UserCredential.DoesNotExist:
        logger.warning(
            "[CredentialVault] %s autofill-reveal not found / category mismatch for user=%s credential=%s",
            log_prefix, user_id, credential_id,
        )
        return (
            JsonResponse(
                {
                    "success": False,
                    "message": _("credential_vault.credential_not_found"),
                    "code": "NOT_FOUND",
                },
                status=404,
            ),
            None,
        )

    if credential.expires_at and credential.expires_at < timezone.now():
        logger.info(
            "[CredentialVault] %s autofill-reveal denied — credential expired: user=%s credential=%s",
            log_prefix, user_id, credential_id,
        )
        return (
            JsonResponse(
                {
                    "success": False,
                    "message": _("credential_vault.credential_expired"),
                    "code": "CREDENTIAL_EXPIRED",
                },
                status=410,
            ),
            None,
        )

    if not credential.is_active:
        logger.info(
            "[CredentialVault] %s autofill-reveal denied — credential inactive: user=%s credential=%s",
            log_prefix, user_id, credential_id,
        )
        return (
            JsonResponse(
                {
                    "success": False,
                    "message": _("credential_vault.credential_inactive"),
                    "code": "CREDENTIAL_INACTIVE",
                },
                status=410,
            ),
            None,
        )

    # Wave 5a (L-W4-4)：``last_used_at`` 不再在 reveal 成功时写入。
    #
    # 旧行为（Wave 4）：reveal 成功就写 last_used_at —— 但 reveal ≠ fill+submit
    # 都成功。多 Space + DOM 异常路径下：``RunAgentAutofill`` 走到 reveal 拿
    # 到明文，但下游 fill 失败 / submit 失败 / 凭据被网站拒绝，``last_used_at``
    # 仍被错误更新，污染 Wave 5 设置页"最近使用"排序。
    #
    # 新行为（Wave 5a）：``last_used_at`` 仅在主进程 fill+submit+verify 全部
    # 成功后通过 ``POST /website/{id}/mark-used`` 显式回写。这样：
    #   - reveal 失败 → last_used_at 不动（与旧行为一致）
    #   - reveal 成功但 fill 失败 → last_used_at 不动（**Wave 5a 修复点**）
    #   - reveal 成功但 submit 失败 → last_used_at 不动（**修复点**）
    #   - 全链路成功 → 主进程显式调 mark-used 写入
    #
    # 详见 ``mark_used_website_credential`` / ``mark_used_app_credential``。

    logger.info(
        "[CredentialVault] %s autofill-reveal issued: user=%s credential=%s service=%s",
        log_prefix, user_id, credential_id, credential.service_name,
    )
    return None, credential


def _mark_credential_used(
    user,
    credential_id: UUID,
    expected_category: str,
    log_prefix: str,
) -> JsonResponse | dict:
    """Wave 5a (L-W4-4) — mark-used 共用实现：fill+submit 都成功后显式标记凭据已用。

    与 ``_issue_autofill_credential`` **共用限流配额**（20 次 / 5 分钟 / per-user）：
      - 一次正常 autofill 流程 = 1 reveal + 1 mark-used 共占 2 个名额；
      - 攻击者用 mark-used 做"last_used_at 污染攻击"也受同一计数器制约；
      - 同 5 分钟内允许约 10 次完整 autofill，对正常用户绰绰有余。

    成功条件：credential 必须存在、属于当前用户、category 匹配。**不**校验
    ``is_active`` / ``expires_at``：mark-used 是 *事后* 标记，主进程发起这次
    调用时凭据可能已被用户禁用 / 过期，但本次 fill+submit 已经发生—— last_used_at
    反映的是"凭据被实际使用的时刻"事实，不是"凭据现在仍然可用"的判定。这与
    Wave 5 设置页"最近使用"的语义对齐：用户能看到禁用前最后一次使用时间。

    成功响应：``{"success": True, "last_used_at": ISO}``，**不返回任何 sensitive 数据**。
    """
    user_id = str(user.id)

    allowed, retry_after = _check_autofill_rate_limit(user_id)
    if not allowed:
        logger.warning(
            "[CredentialVault] %s mark-used rate limited for user=%s credential=%s retry_after=%ds",
            log_prefix, user_id, credential_id, retry_after,
        )
        return _rate_limited_response(retry_after)

    try:
        credential = UserCredential.objects.get(
            id=credential_id,
            user=user,
            category=expected_category,
        )
    except UserCredential.DoesNotExist:
        logger.warning(
            "[CredentialVault] %s mark-used not found / category mismatch for user=%s credential=%s",
            log_prefix, user_id, credential_id,
        )
        return JsonResponse(
            {
                "success": False,
                "message": _("credential_vault.credential_not_found"),
                "code": "NOT_FOUND",
            },
            status=404,
        )

    now = timezone.now()
    try:
        credential.last_used_at = now
        # 用 ``update_fields`` 避免触发 auto_now 重写 updated_at（updated_at 是
        # 用户编辑事件的语义，不该被 autofill 自动消费污染）。
        credential.save(update_fields=["last_used_at"])
    except Exception as exc:  # pragma: no cover — 记一行不阻塞主流程
        logger.warning(
            "[CredentialVault] %s mark-used last_used_at update failed for credential=%s: %s",
            log_prefix, credential_id, exc,
        )
        return JsonResponse(
            {"success": False, "message": "last_used_at update failed", "code": "UPDATE_FAILED"},
            status=500,
        )

    logger.info(
        "[CredentialVault] %s mark-used: user=%s credential=%s service=%s",
        log_prefix, user_id, credential_id, credential.service_name,
    )
    return {"success": True, "last_used_at": now.isoformat()}


@router.post("/website/{credential_id}/mark-used")
def mark_used_website_credential(request, credential_id: UUID):
    """Wave 5a (L-W4-4) — Website 凭据的 mark-used 端点。

    主进程在 ``runAgentAutofill`` 路径上 ``fillLoginForm`` + ``submitLoginForm`` +
    ``verifyLoginSuccess`` 全部成功后调用此端点显式更新 ``last_used_at``。
    旧 Wave 4 行为（reveal 成功就写）已在 ``_issue_autofill_credential`` 中删除，
    避免 fill / submit 失败时 last_used_at 被错误污染。

    详见 ``_mark_credential_used`` 共用实现。
    """
    return _mark_credential_used(
        request.auth,
        credential_id,
        CredentialCategory.WEBSITE_LOGIN,
        log_prefix="website",
    )


@router.post("/website/{credential_id}/autofill-reveal")
def autofill_reveal_website_credential(request, credential_id: UUID):
    """自动填充专用的凭据获取端点。

    由 Electron main process 在本地调用，已通过 JWT 确认用户身份。
    使用独立的速率限制（与 app autofill **共用**，20 次/5 分钟 per-user），
    不消耗手动 reveal 配额。

    与 ``/app/{credential_id}/autofill-reveal`` 对齐：
      - 过期凭据返回 410 ``CREDENTIAL_EXPIRED``
      - 停用（``is_active=False``）凭据返回 410 ``CREDENTIAL_INACTIVE``

    为什么 website 也必须检 expires/inactive（本次修复的核心）：
      - PD-4 语义下 Agent 自动使用用户凭据不弹审批；用户在设置里禁用/到期
        凭据是"撤回许可"的唯一动作。如果 website 端点无视这两个字段，用户
        禁用凭据的意图被悄悄忽略，等于变相越权。
      - 前端 ``packages/agent-runtime/src/tools/data-tools.ts`` 的 ``gone`` 分支
        需要 410 信号来判断"停止重试"——否则 Agent 拿到 200+失效密码去登录
        失败，会按"网络/密码错"策略盲目重试。
    """
    err, credential = _issue_autofill_credential(
        request.auth,
        credential_id,
        CredentialCategory.WEBSITE_LOGIN,
        log_prefix="website",
    )
    if err is not None:
        return err
    return {"success": True, "data": credential.encrypted_data}


# ---------------------------------------------------------------------------
# App 凭据（App Login）专用端点
# ---------------------------------------------------------------------------


@router.post("/app/create", response=AppCredentialOut)
def create_app_credential(request, payload: AppCredentialCreateIn):
    """创建 App 登录凭据（用于 Android 等移动设备上的应用登录）。

    同一 app_package + username 已存在时，更新密码而非创建重复项。
    """
    existing = UserCredential.objects.filter(
        user=request.auth,
        category=CredentialCategory.APP_LOGIN,
        service_name=payload.app_package,
    )
    for cred in existing:
        if (cred.encrypted_data or {}).get("username", "").strip() == payload.username:
            cred.encrypted_data = {
                "username": payload.username,
                "password": payload.password,
            }
            cred.display_name = payload.display_name or payload.app_name or payload.app_package
            cred.metadata = {
                "app_package": payload.app_package,
                "app_name": payload.app_name,
            }
            cred.is_active = True
            cred.save()
            return AppCredentialOut.from_model(cred)

    credential = UserCredential.objects.create(
        user=request.auth,
        category=CredentialCategory.APP_LOGIN,
        service_name=payload.app_package,
        display_name=payload.display_name or payload.app_name or payload.app_package,
        encrypted_data={
            "username": payload.username,
            "password": payload.password,
        },
        metadata={
            "app_package": payload.app_package,
            "app_name": payload.app_name,
        },
    )
    return AppCredentialOut.from_model(credential)


@router.get("/app/list", response=List[AppCredentialOut])
def list_app_credentials(request):
    """列出当前用户所有 App 凭据（脱敏）。"""
    qs = UserCredential.objects.filter(
        user=request.auth,
        category=CredentialCategory.APP_LOGIN,
    )
    return [AppCredentialOut.from_model(c) for c in qs]


@router.get("/app/match", response=List[AppCredentialOut])
def match_app_credentials(request, package: str):
    """按包名精确匹配 App 凭据。

    Wave 4 三视角 Review 视角 3 P1 发现 2 自修：
      与 ``/website/match`` 对称——按 ``last_used_at DESC NULLS LAST,
      created_at DESC`` 排序，让 PD-10 多匹配自动选择策略对 App 凭据也生效。
      不修则同一 app_package 多 username 的场景下 App 自动化无法借用
      "最近使用"信号选账号。
    """
    from django.db.models import F

    package = package.strip().lower()
    if not package:
        return []
    candidates = UserCredential.objects.filter(
        user=request.auth,
        category=CredentialCategory.APP_LOGIN,
        service_name=package,
        is_active=True,
    ).order_by(
        F("last_used_at").desc(nulls_last=True),
        "-created_at",
    )
    return [AppCredentialOut.from_model(c) for c in candidates]


@router.post("/app/{credential_id}/reveal")
def reveal_app_credential(request, credential_id: UUID, payload: RevealCredentialIn):
    """获取 App 凭据明文，复用密码二次验证和速率限制。"""
    user = request.auth
    user_id = str(user.id)

    allowed, retry_after = _check_reveal_rate_limit(user_id)
    if not allowed:
        logger.warning(
            "[CredentialVault] app reveal rate limited for user=%s retry_after=%ds",
            user_id, retry_after,
        )
        return _rate_limited_response(retry_after)

    if not user.check_password(payload.password):
        return JsonResponse(
            {"success": False, "message": _("credential_vault.password_verification_failed"), "code": "PASSWORD_MISMATCH"},
            status=403,
        )

    credential = get_object_or_404(
        UserCredential, id=credential_id, user=user, category=CredentialCategory.APP_LOGIN,
    )
    return {"success": True, "data": credential.encrypted_data}


# ---------------------------------------------------------------------------
# Skill 运行时密钥注入（Wave 1.5）
# ---------------------------------------------------------------------------


@router.post("/api-key/skill-reveal")
def skill_reveal(request, payload: SkillRevealIn):
    """Skill 运行时密钥注入 — 通过 (agent_id, skill_key) 反查凭据并返回
    可直接注入子进程的 **env 变量字典**（：须显式传 agent_id）。

    URL 路径选择 ``/api-key/skill-reveal``：
      - 明确表达"本端点专为 ``category=api_key`` 凭据服务"（与 website/app
        autofill-reveal 的命名风格一致）
      - **避开根级 ``/{credential_id}`` 的通配匹配**——如果放到 ``/skill-reveal``
        会被 Django 匹配到 ``PUT /{credential_id}`` 路由上返回 405（UUID
        类型转换在 Ninja 视图层做，URL 层先按字符串匹配）

    详见 ``apps.credential_vault.skill_reveal`` 模块的完整契约说明。

    关键安全不变量（由 ``skill_reveal_view`` 统一保证）：
      - 返回体只含 env 变量**名字 + 值**，不含 encrypted_data 全量
      - 所有日志写入只出现 credential_id / service_name / env 变量**名列表**
      - 未绑定 / 过期 / 停用 等错误路径与 autofill-reveal 保持错误码一致
    """
    return skill_reveal_view(request, payload)


@router.post("/app/{credential_id}/autofill-reveal")
def autofill_reveal_app_credential(request, credential_id: UUID):
    """App 凭据的自动填充端点（W1-B：打通 Agent 消费 App 密码的最后一公里）。

    设计与 ``/website/{credential_id}/autofill-reveal`` **完全对称**——具体的
    限流 / category / 过期 / 停用 / 审计规则都集中在
    ``_issue_autofill_credential`` 里，两端点零差异复用，防止单边漏加。
    """
    err, credential = _issue_autofill_credential(
        request.auth,
        credential_id,
        CredentialCategory.APP_LOGIN,
        log_prefix="app",
    )
    if err is not None:
        return err
    return {"success": True, "data": credential.encrypted_data}


@router.post("/app/{credential_id}/mark-used")
def mark_used_app_credential(request, credential_id: UUID):
    """Wave 5a (L-W4-4) — App 凭据的 mark-used 端点。

    与 ``/website/{credential_id}/mark-used`` 完全对称：fill+submit 全成功后
    主进程显式标记 ``last_used_at``，避免 fill / submit 失败时被错误污染。
    详见 ``_mark_credential_used`` 共用实现。
    """
    return _mark_credential_used(
        request.auth,
        credential_id,
        CredentialCategory.APP_LOGIN,
        log_prefix="app",
    )
