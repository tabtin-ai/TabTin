import uuid

from django.conf import settings
from django.db import models

from apps.extensions.fields import EncryptedJSONField


class CredentialCategory(models.TextChoices):
    API_KEY = "api_key", "API Key"
    OAUTH = "oauth", "OAuth Token"
    SECRET = "secret", "Secret / Password"
    WEBSITE_LOGIN = "website_login", "Website Login"
    APP_LOGIN = "app_login", "App Login"
    OTHER = "other", "Other"


class UserCredential(models.Model):
    """用户凭据保险箱条目。

    用于集中管理第三方服务的 API Key、App Secret 等。
    敏感数据使用 EncryptedJSONField（Fernet 加密）存储，
    前端展示时通过 API 层脱敏。
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="credentials",
    )

    category = models.CharField(
        max_length=20,
        choices=CredentialCategory.choices,
        default=CredentialCategory.API_KEY,
    )
    service_name = models.CharField(max_length=100, help_text="服务标识，如 openai / serper / sendgrid")
    display_name = models.CharField(max_length=200, blank=True, default="")

    encrypted_data = EncryptedJSONField(
        help_text="加密存储的凭据数据，格式 {'key': '...', 'secret': '...', ...}"
    )

    metadata = models.JSONField(
        default=dict,
        blank=True,
        help_text="非敏感元数据（描述、标签等）",
    )

    is_active = models.BooleanField(default=True)
    expires_at = models.DateTimeField(null=True, blank=True)

    # Wave 4 PD-10：多匹配自动选择策略
    #
    # 由 autofill-reveal 端点在每次成功 issue 明文时回写 timezone.now()——
    # 这样"被 Agent / 用户实际用过"的事件天然反映到字段。
    # 用途：
    #   1. /website/match 按 last_used_at DESC NULLS LAST 排序，**多匹配
    #      场景下 Agent 后台 view 自动取第一条**填充（Wave 4 H1）
    #   2. Wave 5 设置页"网站登录"展示"最近使用时间"，让用户能看到
    #      "Agent 自动选了哪个账号"并改默认
    # NULL 语义：从未被用过——排在 created_at DESC 兜底之前是劣势，避免
    # 把"创建很久但从没用过"的僵尸账号顶到自动选择第一位。
    last_used_at = models.DateTimeField(null=True, blank=True)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "credential_vault_user_credential"
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["user", "category"]),
            models.Index(fields=["user", "service_name"]),
        ]

    def __str__(self):
        return f"{self.display_name or self.service_name} ({self.category})"


class SaveBlacklistEntry(models.Model):
    """Wave 3 PD-8：用户在保存密码提示条点"不为此网站保存"的黑名单。

    设计取舍：
      - **存后端**：PD-8 拍板与 PD-2 / PD-6 同原则——跨设备保留用户配置；
        同一用户 macOS/Windows 都不再被 google.com 提示。
      - 仅按 (user, domain) 唯一约束——不区分 username。Chrome 也是这个粒度
        （如果用户后续想在该域名保存其它账号，可以从设置页"网站登录" tab 的
        黑名单管理中移除 domain）。
      - 与 UserCredential 同库（MySQL）：黑名单是用户级配置，访问频率与
        credential_vault 列表查询相当；放 MySQL 避免跨库 join 损耗。
      - **不**用 EncryptedField：domain 是非敏感数据，明文存储让 admin / 运营
        排查更方便。
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="save_blacklist_entries",
    )
    domain = models.CharField(
        max_length=253,  # RFC 1035 域名上限
        help_text="完整域名（小写、去前导点），如 google.com / login.example.com",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "credential_vault_save_blacklist"
        ordering = ["-created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["user", "domain"],
                name="uq_save_blacklist_user_domain",
            ),
        ]
        indexes = [
            models.Index(fields=["user", "domain"]),
        ]

    def __str__(self):
        return f"{self.user_id}:{self.domain}"


class UserOnboardingState(models.Model):
    """Wave 5c T1：首次引导（PRD Story 1）状态。

    场景：用户首次打开 TabWeb，所有网站都未登录 → 引导气泡"从你的浏览器
    导入登录状态？"——但用户点了"稍后再说"或成功导入后**不应再次引导**。

    设计取舍：
      - **存后端**：与 PD-6 / PD-8 同原则——跨设备保留用户配置；同一用户在
        macOS 已经选过"稍后再说"，Windows 上不应再被打扰。
      - 一行一用户（user_id 当 PK）：onboarding 是个人状态，不是租户级。
      - 用 *_at 字段而不是 boolean：
          - 用户支持复盘（如何/何时跳过的）；
          - 给将来"30 天后提醒一次" 留入口（不在本期）。
      - 无 EncryptedField：状态不敏感。
    """

    user = models.OneToOneField(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="onboarding_state",
        primary_key=True,
    )
    # 用户在引导气泡点了"稍后再说" / "×"
    onboarding_dismissed_at = models.DateTimeField(null=True, blank=True)
    # 用户成功完成了"从浏览器一键导入"流程（cookie 至少注入了一条）
    browser_import_completed_at = models.DateTimeField(null=True, blank=True)
    # 用户当时选择导入的浏览器名（chrome / edge / firefox / safari）—— 仅做埋点
    browser_import_source = models.CharField(max_length=32, blank=True, default="")

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "credential_vault_onboarding_state"

    def __str__(self):
        return (
            f"OnboardingState(user={self.user_id}, dismissed_at={self.onboarding_dismissed_at}, "
            f"completed_at={self.browser_import_completed_at})"
        )
