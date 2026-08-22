from __future__ import annotations

from datetime import datetime
from typing import Any, Optional
from uuid import UUID

from pydantic import Field, field_validator
from ninja import Schema

from .models import CredentialCategory

_VALID_CATEGORIES = tuple(c.value for c in CredentialCategory)


def mask_value(value: str, visible_prefix: int = 4, visible_suffix: int = 4) -> str:
    """脱敏展示：保留前后若干字符，中间用 **** 替代。

    短 secret（长度不足以在保留前后明文的同时不显著放大暴露比例）全部 mask，
    不露出任何真实字符——与 ``WebsiteCredentialOut`` / ``AppCredentialOut`` 的
    固定 ``"****"`` 口径对齐，避免短 API Key（如 len<=12）露出大部分甚至全部
    明文。长 secret 仍保留前 ``visible_prefix`` + 后 ``visible_suffix`` 字符，
    中间用 ``****`` 替代。
    """
    if len(value) <= visible_prefix + visible_suffix + 4:
        return "****"
    return value[:visible_prefix] + "****" + value[-visible_suffix:]


class CredentialCreateIn(Schema):
    category: str = "api_key"
    service_name: str
    display_name: str = ""
    credential_data: dict[str, Any]
    metadata: dict[str, Any] = {}
    expires_at: Optional[datetime] = None

    @field_validator("category")
    @classmethod
    def category_must_be_valid(cls, v):
        if v not in _VALID_CATEGORIES:
            raise ValueError(f"category 必须是 {_VALID_CATEGORIES} 之一")
        return v

    @field_validator("credential_data")
    @classmethod
    def credential_data_must_not_be_empty(cls, v):
        if not v:
            raise ValueError("credential_data 不能为空字典")
        return v


class CredentialUpdateIn(Schema):
    display_name: Optional[str] = None
    credential_data: Optional[dict[str, Any]] = None
    metadata: Optional[dict[str, Any]] = None
    is_active: Optional[bool] = None
    expires_at: Optional[datetime] = None


class RevealCredentialIn(Schema):
    password: str


class SkillRevealIn(Schema):
    """Wave 1.5 Skill 运行时密钥注入入参。

    - ``space_id``：当前执行现场 Workspace id（兼容仍称 space_id 的 API 契约）
    - ``agent_id``：Skill 归属 Agent（ 后必填，不再从 Workspace 反推）
    - ``skill_key``：canonical Skill key（如 ``user:<skill-name>`` / ``app:openai/chat``）
    - ``primary_env``：可选 Skill frontmatter 的 primary_env 字段。单密钥服务
      （encrypted_data 只有一个 api_key）且 service_name 未在
      ``SKILL_CREDENTIAL_ENV_MAP`` 注册时用它派生 env 变量名；多密钥服务由
      映射表决定，不受此字段影响。
    """

    space_id: str
    agent_id: str
    skill_key: str
    primary_env: Optional[str] = None


class WebsiteCredentialCreateIn(Schema):
    url: str = Field(max_length=2000)
    username: str = Field(max_length=200)
    password: str = Field(max_length=500)
    display_name: str = Field(default="", max_length=200)

    @field_validator("url")
    @classmethod
    def url_must_not_be_empty(cls, v):
        if not v or not v.strip():
            raise ValueError("url 不能为空")
        return v.strip()

    @field_validator("username")
    @classmethod
    def username_must_not_be_empty(cls, v):
        if not v or not v.strip():
            raise ValueError("username 不能为空")
        return v.strip()

    @field_validator("password")
    @classmethod
    def password_must_not_be_empty(cls, v):
        if not v:
            raise ValueError("password 不能为空")
        return v


class WebsiteCredentialBatchImportIn(Schema):
    credentials: list[WebsiteCredentialCreateIn]

    @field_validator("credentials")
    @classmethod
    def credentials_limit(cls, v):
        if len(v) > 500:
            raise ValueError("单次最多导入 500 条凭据")
        if len(v) == 0:
            raise ValueError("至少需要 1 条凭据")
        return v


class WebsiteCredentialUpdateIn(Schema):
    """网站凭据部分更新——所有字段可选，仅覆盖显式传入的字段。

    - ``password`` 省略 / 为空 → 保留原密码（编辑态默认不回显、不改动）；
    - ``url`` 变更时由端点同步重算 ``service_name``（域名）；
    - ``display_name`` 传空串 → 端点回退为域名。
    """

    url: Optional[str] = Field(default=None, max_length=2000)
    username: Optional[str] = Field(default=None, max_length=200)
    password: Optional[str] = Field(default=None, max_length=500)
    display_name: Optional[str] = Field(default=None, max_length=200)

    @field_validator("url")
    @classmethod
    def url_not_blank_if_present(cls, v):
        if v is None:
            return v
        if not v.strip():
            raise ValueError("url 不能为空")
        return v.strip()

    @field_validator("username")
    @classmethod
    def username_not_blank_if_present(cls, v):
        if v is None:
            return v
        if not v.strip():
            raise ValueError("username 不能为空")
        return v.strip()


class WebsiteCredentialOut(Schema):
    id: UUID
    url: str
    username: str
    masked_password: str
    display_name: str
    is_active: bool
    # Wave 4 PD-10：多匹配自动选择策略——前端 / Agent 后台 view 都需要看到
    # 哪条凭据"最近被用过"。NULL = 从未使用过；序列化为 None。
    last_used_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime

    @staticmethod
    def from_model(instance) -> "WebsiteCredentialOut":
        raw_data = instance.encrypted_data or {}
        return WebsiteCredentialOut(
            id=instance.id,
            url=raw_data.get("url", ""),
            username=raw_data.get("username", ""),
            masked_password="****" if raw_data.get("password") else "",
            display_name=instance.display_name,
            is_active=instance.is_active,
            last_used_at=instance.last_used_at,
            created_at=instance.created_at,
            updated_at=instance.updated_at,
        )


class AppCredentialCreateIn(Schema):
    app_package: str = Field(max_length=200)
    app_name: str = Field(default="", max_length=200)
    username: str = Field(max_length=200)
    password: str = Field(max_length=500)
    display_name: str = Field(default="", max_length=200)

    @field_validator("app_package")
    @classmethod
    def app_package_must_be_valid(cls, v):
        v = v.strip().lower()
        if not v or len(v) < 3:
            raise ValueError("app_package 不能为空且至少 3 个字符")
        if " " in v:
            raise ValueError("app_package 不能包含空格")
        if "." not in v:
            raise ValueError("app_package 格式不正确，应类似 com.example.app")
        return v

    @field_validator("username")
    @classmethod
    def username_not_empty(cls, v):
        if not v or not v.strip():
            raise ValueError("username 不能为空")
        return v.strip()

    @field_validator("password")
    @classmethod
    def password_not_empty(cls, v):
        if not v:
            raise ValueError("password 不能为空")
        return v


class AppCredentialOut(Schema):
    id: UUID
    app_package: str
    app_name: str
    username: str
    masked_password: str
    display_name: str
    is_active: bool
    # Wave 4 三视角 Review 视角 3 P1 发现 2 自修：与 WebsiteCredentialOut 对称暴露
    # last_used_at——Wave 5 设置页"App 账号"区块需要展示"最近使用时间"。
    last_used_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime

    @staticmethod
    def from_model(instance) -> "AppCredentialOut":
        raw_data = instance.encrypted_data or {}
        meta = instance.metadata or {}
        return AppCredentialOut(
            id=instance.id,
            app_package=instance.service_name,
            app_name=meta.get("app_name", ""),
            username=raw_data.get("username", ""),
            masked_password="****" if raw_data.get("password") else "",
            display_name=instance.display_name,
            is_active=instance.is_active,
            last_used_at=instance.last_used_at,
            created_at=instance.created_at,
            updated_at=instance.updated_at,
        )


# ---------------------------------------------------------------------------
# Wave 3 G5：保存密码黑名单（"不为此网站保存"）
# ---------------------------------------------------------------------------


class SaveBlacklistAddIn(Schema):
    """加入黑名单的请求体。

    `domain` 由前端规整（小写、去前导点）；后端再做一次严格校验，
    避免协议头/路径混入（如 `https://github.com/foo` 必须先变成 `github.com`）。
    """

    domain: str = Field(max_length=253)

    @field_validator("domain")
    @classmethod
    def domain_must_be_valid(cls, v):
        v = (v or "").strip().lower().lstrip(".")
        if not v:
            raise ValueError("domain 不能为空")
        # 简单格式校验：必须包含 . 且无空格 / 协议头
        if " " in v or "/" in v or ":" in v:
            raise ValueError("domain 不能包含空格、协议头或路径")
        if "." not in v:
            raise ValueError("domain 必须是有效域名（如 example.com）")
        if len(v) > 253:
            raise ValueError("domain 长度超过 253")
        return v


class SaveBlacklistOut(Schema):
    id: UUID
    domain: str
    created_at: datetime

    @staticmethod
    def from_model(instance) -> "SaveBlacklistOut":
        return SaveBlacklistOut(
            id=instance.id,
            domain=instance.domain,
            created_at=instance.created_at,
        )


# ---------------------------------------------------------------------------
# Wave 5c T1：首次引导（PRD Story 1）跨设备状态
# ---------------------------------------------------------------------------


class OnboardingStateOut(Schema):
    """首次引导状态。前端用它决定是否展示引导气泡。

    判定逻辑（前端 + 后端共同执行）：
      - `onboarding_dismissed_at == null`：用户没点过"稍后再说"
      - `browser_import_completed_at == null`：用户没成功导入过
      - 且：网站凭据数 == 0（前端查 `credential-vault/website/list`）
      - 且：默认环境 partition 无 cookie（前端通过 IPC 查）
    """

    onboarding_dismissed_at: Optional[datetime] = None
    browser_import_completed_at: Optional[datetime] = None
    browser_import_source: str = ""


class OnboardingStateUpdateIn(Schema):
    """部分更新——传 null 不修改对应字段。

    幂等：前端可以在每次引导动作后随便调，后端按字段最大值合并（不会因
    重发把已完成状态推回 null）。前端按 enum 传 action 即可。
    """

    action: str = Field(description="`dismiss` / `complete` / `reset`（仅 dev）")
    browser_import_source: str = Field(default="", max_length=32)

    @field_validator("action")
    @classmethod
    def action_must_be_valid(cls, v: str) -> str:
        if v not in {"dismiss", "complete", "reset"}:
            raise ValueError("action must be one of: dismiss / complete / reset")
        return v


class CredentialOut(Schema):
    id: UUID
    category: str
    service_name: str
    display_name: str
    masked_data: dict[str, str]
    metadata: dict[str, Any]
    is_active: bool
    expires_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime

    @staticmethod
    def from_model(instance) -> "CredentialOut":
        raw_data = instance.encrypted_data or {}
        masked = {}
        for k, v in raw_data.items():
            masked[k] = mask_value(str(v)) if v else ""

        return CredentialOut(
            id=instance.id,
            category=instance.category,
            service_name=instance.service_name,
            display_name=instance.display_name,
            masked_data=masked,
            metadata=instance.metadata or {},
            is_active=instance.is_active,
            expires_at=instance.expires_at,
            created_at=instance.created_at,
            updated_at=instance.updated_at,
        )
