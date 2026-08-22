"""
Tabtin Space 数据模型

核心模型：
1. Organization - 组织
2. OrganizationMember - 组织成员
3. Device - 设备（执行设备: Electron/Daemon/Cloud，能力设备: Mobile/IoT）
4. SecureCredential - 加密凭据存储（SSH 密钥 / 密码）
5. RemoteServer - SSH 远程服务器（挂在 Device 下）
6. Space - 协作空间（通用容器，类型: bot/group/dm/team）
7. SpaceMembership - 成员关系（Identity 加入 Space 的关联）
8. ContextItem - 上下文条目（browser/table/crawl/...）
9. OrganizationAppInstall - Organization 级应用安装记录

Agent 领域模型已迁至 ``apps.agent.models.Agent``（表 ``agent_agent``）；
本模块末尾保留兼容再导出。
"""

import uuid
from django.conf import settings
from django.core.exceptions import ImproperlyConfigured, ValidationError
from django.db import models
from django.db.models import Q
from django.contrib.auth import get_user_model
from django.contrib.postgres.indexes import GinIndex
from django.contrib.postgres.search import SearchVectorField

from apps.services.common.base_models import ResourcePermission

User = get_user_model()


class Organization(models.Model):
    """组织模型

    type 字段区分身份上下文：
    - personal: 个人身份，注册自动创建，不可删除/邀请成员，每用户唯一
    - team: 团队，用户主动创建或被邀请加入，支持成员协作
    """

    class OrganizationType(models.TextChoices):
        PERSONAL = 'personal', '个人身份'
        TEAM = 'team', '团队'

    class Status(models.TextChoices):
        ACTIVE = 'active', '正常'
        DELETING = 'deleting', '删除中'

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=255, verbose_name='组织名称')
    description = models.TextField(blank=True, verbose_name='描述')
    icon = models.CharField(max_length=50, blank=True, verbose_name='图标')

    # 所有者（跨数据库外键，不创建数据库约束）
    owner = models.ForeignKey(
        User,
        on_delete=models.PROTECT,
        related_name='owned_organizations',
        verbose_name='所有者',
    )

    type = models.CharField(
        max_length=20,
        choices=OrganizationType.choices,
        default=OrganizationType.TEAM,
        verbose_name='类型',
        db_index=True,
    )

    # Deprecated: 使用 type='personal' 替代。保留以兼容现有查询，后续移除。
    is_default = models.BooleanField(default=False, verbose_name='是否为默认组织')

    # 生命周期状态：deleting 表示已发起删除（墓碑， 管线重排）。
    # 墓碑期间对所有面向用户的查询隐身（get_user_organizations /
    # check_organization_permission 收口），组织行本身保留到异步清理链
    # （OrganizationLifecycleCleanupService）末步校验子表清空后才物理删除，
    # 保证挂真 FK 的 billing 子行总是先于父行消失。
    status = models.CharField(
        max_length=20,
        choices=Status.choices,
        default=Status.ACTIVE,
        db_index=True,
        verbose_name='生命周期状态',
    )
    delete_requested_at = models.DateTimeField(
        null=True, blank=True, verbose_name='删除发起时间',
    )
    # 软引用 User：墓碑期间发起人账号可能先被注销，保留 id 供审计追溯即可。
    delete_requested_by_id = models.CharField(
        max_length=36, blank=True, default='', verbose_name='删除发起人ID',
    )

    # 配置
    settings = models.JSONField(default=dict, verbose_name='组织设置')

    # 统计
    space_count = models.IntegerField(
        default=0,
        verbose_name='Space 数量',
        help_text='由 signal 维护的非规范化计数，实际数以 Space 查询为准。',
    )
    table_count = models.IntegerField(default=0, verbose_name='表格数量')
    member_count = models.IntegerField(
        default=0,
        verbose_name='成员数量',
        help_text='由 signal 维护的非规范化计数，实际成员数以 OrganizationMember 查询为准。'
                  '初始值 0，由 provision_organization_defaults 最终覆写为正确值。',
    )

    # 时间戳
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'tabtinspace_organization'
        verbose_name = '组织'
        verbose_name_plural = '组织'
        ordering = ['-updated_at']
        indexes = [
            models.Index(fields=['owner', 'created_at'], name='ctx_ws_owner_created_idx'),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=['owner'],
                condition=models.Q(is_default=True),
                name='ctx_ws_owner_default_unique',
            ),
            models.UniqueConstraint(
                fields=['owner'],
                condition=models.Q(type='personal'),
                name='ctx_ws_owner_personal_unique',
            ),
        ]

    @property
    def is_personal(self) -> bool:
        return self.type == self.OrganizationType.PERSONAL

    @property
    def is_team(self) -> bool:
        return self.type == self.OrganizationType.TEAM

    def __str__(self):
        return f"{self.name} ({self.owner.get_display_name()})"


class OrganizationProviderCreditClaim(models.Model):
    """记录用户前四个自有组织的专享券资格；组织删除后仍保留占位。"""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user_id = models.CharField(max_length=36, editable=False, verbose_name='创建用户ID')
    organization_id = models.UUIDField(
        unique=True,
        editable=False,
        verbose_name='资格组织ID',
    )
    eligibility_order = models.PositiveSmallIntegerField(
        editable=False,
        verbose_name='资格顺序',
    )
    eligible_campaign_ids = models.JSONField(
        default=list,
        blank=True,
        verbose_name='创建时适用的供应商额度活动ID',
    )
    last_reconciled_at = models.DateTimeField(
        null=True,
        blank=True,
        db_index=True,
        verbose_name='最近补偿扫描时间',
    )
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')

    class Meta:
        db_table = 'tabtinspace_organization_provider_credit_claim'
        verbose_name = '用户自有组织专享券资格'
        verbose_name_plural = '用户自有组织专享券资格'
        constraints = [
            models.CheckConstraint(
                check=Q(eligibility_order__gte=1, eligibility_order__lte=4),
                name='ctx_org_credit_claim_order_1_4',
            ),
            models.UniqueConstraint(
                fields=['user_id', 'eligibility_order'],
                name='ctx_org_credit_claim_user_order_unique',
            ),
        ]

    def matches_organization_kind(self, organization: Organization) -> bool:
        return (
            self.eligibility_order == 1
            and organization.type == Organization.OrganizationType.PERSONAL
            and organization.is_default
        ) or (
            2 <= self.eligibility_order <= 4
            and organization.type == Organization.OrganizationType.TEAM
            and not organization.is_default
        )

    def __str__(self):
        return f'{self.user_id}:{self.eligibility_order}:{self.organization_id}'


class OrganizationControlPolicy(models.Model):
    """团队级客户端控制策略。

    这是运营控制面状态，不代表账务余额或套餐权益；Organization 主表继续只承载
    生命周期基础状态，避免把冻结/只读/AI 禁用等治理状态塞进主对象。
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    organization = models.OneToOneField(
        Organization,
        on_delete=models.CASCADE,
        related_name='control_policy',
        verbose_name='组织',
    )
    is_suspended = models.BooleanField(default=False, db_index=True, verbose_name='是否暂停团队')
    is_readonly = models.BooleanField(default=False, db_index=True, verbose_name='是否只读')
    ai_disabled = models.BooleanField(default=False, db_index=True, verbose_name='是否禁用 AI')
    resource_write_disabled = models.BooleanField(default=False, db_index=True, verbose_name='是否禁用资源写入')
    app_tool_disabled = models.BooleanField(default=False, db_index=True, verbose_name='是否禁用 App/Tool')
    invite_disabled = models.BooleanField(default=False, db_index=True, verbose_name='是否禁用邀请')
    member_join_disabled = models.BooleanField(default=False, db_index=True, verbose_name='是否禁用成员加入')
    reason_snapshot = models.CharField(max_length=500, blank=True, default='', verbose_name='最近控制原因')
    updated_by_admin_account = models.ForeignKey(
        'users_auth.AdminAccount',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='updated_organization_control_policies',
        verbose_name='最近更新后台账号',
    )
    metadata_json = models.JSONField(default=dict, blank=True, verbose_name='扩展元数据')
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'tabtinspace_organization_control_policy'
        verbose_name = 'Organization 控制策略'
        verbose_name_plural = 'Organization 控制策略'
        indexes = [
            models.Index(fields=['organization', 'updated_at'], name='ctx_wtcp_wt_updated_idx'),
        ]

    def __str__(self):
        return f"control_policy:{self.organization_id}"


class OrganizationMember(models.Model):
    """组织成员模型"""

    ROLE_CHOICES = [
        ('owner', '所有者'),
        ('admin', '管理员'),
        ('editor', '编辑者'),
        ('viewer', '查看者'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    organization = models.ForeignKey(
        Organization,
        on_delete=models.CASCADE,
        related_name='members',
        verbose_name='组织'
    )
    user = models.ForeignKey(
        User,
        on_delete=models.CASCADE,
        related_name='organization_memberships',
        verbose_name='用户',
    )

    role = models.CharField(
        max_length=20,
        choices=ROLE_CHOICES,
        default='viewer',
        verbose_name='角色'
    )
    permissions = models.JSONField(default=dict, verbose_name='自定义权限')

    joined_at = models.DateTimeField(auto_now_add=True, verbose_name='加入时间')

    class Meta:
        db_table = 'tabtinspace_organization_member'
        verbose_name = '组织成员'
        verbose_name_plural = '组织成员'
        unique_together = [['organization', 'user']]
        indexes = [
            models.Index(fields=['organization', 'role'], name='ctx_wm_workspace_role_idx'),
            models.Index(fields=['organization', '-joined_at'], name='ctx_wm_wt_joined_desc_idx'),
            models.Index(fields=['user', 'joined_at'], name='ctx_wm_user_joined_idx'),
        ]

    def __str__(self):
        return f"{self.user.get_display_name()} - {self.organization.name} ({self.get_role_display()})"


class OrganizationMemberIdentitySnapshot(models.Model):
    """成员离开组织时保留的展示身份，不代表当前成员资格。"""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    organization = models.ForeignKey(
        Organization,
        on_delete=models.CASCADE,
        related_name='member_identity_snapshots',
        verbose_name='组织',
    )
    user_id = models.UUIDField(verbose_name='用户 ID')
    display_name = models.CharField(max_length=255, verbose_name='离开时显示名称')
    left_at = models.DateTimeField(verbose_name='离开时间')

    class Meta:
        db_table = 'tabtinspace_organization_member_identity_snapshot'
        verbose_name = '组织成员历史身份'
        verbose_name_plural = '组织成员历史身份'
        constraints = [
            models.UniqueConstraint(
                fields=['organization', 'user_id'],
                name='ctx_member_ident_org_user_uq',
            ),
        ]
        indexes = [
            models.Index(
                fields=['organization', '-left_at'],
                name='ctx_member_ident_org_left_idx',
            ),
        ]

    def __str__(self):
        return f"{self.display_name} ({self.user_id})"


class Device(models.Model):
    """设备 — 任何注册到 TabTin 后端的运行环境

    执行设备（control）：Electron 桌面端、Agent Daemon、云实例，可绑定为 Agent 的执行主机。
    能力设备（data）：移动端、IoT 等，提供特定 capability 供 Agent 调用，作用域为 Organization。
    Space 通过 bound_device / control_device 绑定到执行设备，从而确定其工具可用性。
    """

    DEVICE_TYPE_CHOICES = [
        ('electron', 'Electron 桌面端'),
        ('daemon', 'Agent Daemon'),
        ('cloud', '云实例'),
        ('mobile', '移动设备'),
        ('iot', 'IoT 设备'),
    ]
    ROLE_CHOICES = [
        ('control', '执行设备'),
        ('data', '能力设备'),
    ]
    STATUS_CHOICES = [
        ('online', '在线'),
        ('busy', '忙碌'),
        ('offline', '离线'),
    ]
    CONTROL_STATUS_CHOICES = [
        ('active', '可用'),
        ('blocked', '已封禁'),
        ('revoked', '已吊销'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    organization = models.ForeignKey(
        Organization,
        on_delete=models.CASCADE,
        related_name='devices',
        verbose_name='所属组织',
    )
    user = models.ForeignKey(
        User,
        on_delete=models.CASCADE,
        related_name='devices',
        verbose_name='注册用户',
    )

    name = models.CharField(max_length=200, verbose_name='设备名称', help_text='如：MacBook Pro、生产服务器')
    device_type = models.CharField(
        max_length=20,
        choices=DEVICE_TYPE_CHOICES,
        default='electron',
        verbose_name='设备类型',
    )
    role = models.CharField(
        max_length=20,
        choices=ROLE_CHOICES,
        default='control',
        verbose_name='设备角色',
        help_text='control=执行设备，data=能力设备',
    )
    # Electron：硬件锚定后为 electron-{sha256(machineId:profile)[:32]}；历史数据可能仍是随机 UUID
    fingerprint = models.CharField(
        max_length=255,
        unique=True,
        db_index=True,
        verbose_name='设备指纹',
        help_text='全局唯一标识，Electron 对应 device_id，Daemon 对应安装时生成的 UUID',
    )
    # 机+档派生密钥；同 user + machine_key + device_type 注册时复用 Device.id
    machine_key = models.CharField(
        max_length=64,
        blank=True,
        default='',
        db_index=True,
        verbose_name='机器锚定密钥',
        help_text='客户端上报的 sha256(machineId+profile)[:32]；空表示未锚定的历史设备',
    )
    os_info = models.JSONField(default=dict, verbose_name='操作系统信息', help_text='{"os": "macOS", "arch": "arm64", ...}')
    capabilities = models.JSONField(
        default=list,
        verbose_name='设备能力列表',
        help_text='如 ["terminal_execute", "file", "code_search"]，决定 Space 可用工具域',
    )
    status = models.CharField(
        max_length=20,
        choices=STATUS_CHOICES,
        default='offline',
        verbose_name='在线状态',
    )
    last_heartbeat_at = models.DateTimeField(null=True, blank=True, verbose_name='最后心跳时间')
    control_status = models.CharField(
        max_length=20,
        choices=CONTROL_STATUS_CHOICES,
        default='active',
        db_index=True,
        verbose_name='管控状态',
    )
    app_version = models.CharField(max_length=64, blank=True, default='', db_index=True, verbose_name='客户端版本')
    ip_address = models.GenericIPAddressField(null=True, blank=True, verbose_name='最近 IP 地址')
    blocked_reason = models.TextField(blank=True, default='', verbose_name='封禁原因')
    blocked_by_admin_account_id = models.CharField(
        max_length=36,
        blank=True,
        default='',
        verbose_name='封禁后台账号 ID',
    )
    blocked_at = models.DateTimeField(null=True, blank=True, verbose_name='封禁时间')
    metadata_json = models.JSONField(default=dict, verbose_name='治理元数据')

    created_at = models.DateTimeField(auto_now_add=True, verbose_name='注册时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'tabtinspace_device'
        verbose_name = '设备'
        verbose_name_plural = '设备'
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['organization', 'status'], name='ctx_device_ws_status_idx'),
            models.Index(fields=['user', 'status'], name='ctx_device_user_status_idx'),
            models.Index(fields=['user', 'control_status'], name='ctx_device_user_ctrl_idx'),
            models.Index(fields=['fingerprint', 'control_status'], name='ctx_device_fp_ctrl_idx'),
            models.Index(
                fields=['user', 'machine_key', 'device_type'],
                name='ctx_device_user_mkey_type_idx',
            ),
        ]

    def __str__(self):
        return f"{self.name} ({self.get_device_type_display()}) [{self.status}]"


class SecureCredential(models.Model):
    """加密凭据存储 — SSH 密钥、密码等敏感信息的安全存储。

    使用 Fernet 对称加密，密文以 base64 字符串形式存入 TextField。
    """

    CREDENTIAL_TYPE_CHOICES = [
        ('ssh_key', 'SSH 私钥'),
        ('ssh_password', 'SSH 密码'),
        # 通用 token/secret 类型：MCP 的 http bearer/token、stdio env secret 等都复用它。
        # 与 ssh_* 解耦、向后兼容——不改动既有 ssh_key/ssh_password 行为。
        ('api_key', 'API Key / Token'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    organization = models.ForeignKey(
        Organization,
        on_delete=models.CASCADE,
        related_name='secure_credentials',
        verbose_name='所属组织',
    )
    user = models.ForeignKey(
        User,
        on_delete=models.CASCADE,
        related_name='secure_credentials',
        verbose_name='创建用户',
    )
    # "仅本机用" 凭证下沉设备级（PRD §8.4）：null 兼容现有 organization+user 归属，
    # 不破坏存量；如 MCP stdio 的本地 env secret 只在某台设备的进程里用。
    device = models.ForeignKey(
        'Device',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='secure_credentials_device',
        verbose_name='归属设备（仅本机用凭证）',
    )

    name = models.CharField(max_length=200, verbose_name='凭据名称', help_text='如：生产服务器密钥')
    credential_type = models.CharField(
        max_length=50,
        choices=CREDENTIAL_TYPE_CHOICES,
        verbose_name='凭据类型',
    )
    encrypted_value = models.TextField(
        verbose_name='加密后的值',
        help_text='Fernet 加密的 base64 字符串',
    )
    metadata = models.JSONField(default=dict, verbose_name='元数据', help_text='如 key 指纹等附加信息')

    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'tabtinspace_secure_credential'
        verbose_name = '加密凭据'
        verbose_name_plural = '加密凭据'
        ordering = ['-created_at']

    def __str__(self):
        return f"{self.name} ({self.get_credential_type_display()})"

    @staticmethod
    def _get_fernet():
        """Return a Fernet instance for credential encryption.

        Checks CREDENTIAL_ENCRYPTION_KEY first, then falls back to the
        legacy SSH_CREDENTIAL_ENCRYPTION_KEY. If neither is configured,
        derives a key from SECRET_KEY (not recommended for production).
        """
        import base64
        import hashlib
        import logging
        from cryptography.fernet import Fernet
        logger = logging.getLogger(__name__)

        key = (
            getattr(settings, 'CREDENTIAL_ENCRYPTION_KEY', None)
            or getattr(settings, 'SSH_CREDENTIAL_ENCRYPTION_KEY', None)
        )
        if key:
            try:
                key_bytes = key if isinstance(key, bytes) else key.encode()
                return Fernet(key_bytes)
            except (ValueError, Exception) as exc:
                raise ValueError(
                    f"CREDENTIAL_ENCRYPTION_KEY is not a valid Fernet key "
                    f"(must be 32 url-safe base64-encoded bytes): {exc}"
                ) from exc

        is_production = not getattr(settings, 'DEBUG', True)
        if is_production:
            raise ImproperlyConfigured(
                "CREDENTIAL_ENCRYPTION_KEY 未配置。"
                "生产环境必须显式配置此密钥，禁止回退到 SECRET_KEY 派生。"
                "设置方法：在环境变量或 settings 中配置 CREDENTIAL_ENCRYPTION_KEY 为合法的 Fernet key。"
            )
        logger.log(
            logging.WARNING,
            "CREDENTIAL_ENCRYPTION_KEY not configured — falling back to SECRET_KEY derivation. "
            "Set CREDENTIAL_ENCRYPTION_KEY in env to avoid credential loss on SECRET_KEY rotation."
        )
        derived = hashlib.sha256(settings.SECRET_KEY.encode()).digest()
        return Fernet(base64.urlsafe_b64encode(derived))

    def set_value(self, plain_value: str) -> None:
        """加密并存储明文凭据。"""
        f = self._get_fernet()
        self.encrypted_value = f.encrypt(plain_value.encode()).decode()

    def get_value(self) -> str:
        """解密并返回明文凭据。"""
        f = self._get_fernet()
        return f.decrypt(self.encrypted_value.encode()).decode()


class RemoteServer(models.Model):
    """SSH 远程服务器配置 — 挂在 Device 下。

    "从这台机器能 SSH 到哪些服务器" 是机器的属性，
    同一 Device 上的所有 Space 共享 SSH 配置。
    """

    AUTH_METHOD_CHOICES = [
        ('key', 'SSH 私钥'),
        ('password', '密码'),
    ]
    STATUS_CHOICES = [
        ('active', '启用'),
        ('disabled', '禁用'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    device = models.ForeignKey(
        Device,
        on_delete=models.CASCADE,
        related_name='ssh_servers',
        verbose_name='所属设备',
    )

    name = models.CharField(max_length=200, verbose_name='服务器名称', help_text='如：生产服务器')
    host = models.CharField(max_length=500, verbose_name='主机地址')
    port = models.IntegerField(default=22, verbose_name='端口')
    username = models.CharField(max_length=200, verbose_name='登录用户名')
    auth_method = models.CharField(
        max_length=20,
        choices=AUTH_METHOD_CHOICES,
        verbose_name='认证方式',
    )
    credential = models.ForeignKey(
        SecureCredential,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='servers',
        verbose_name='关联凭据',
    )
    status = models.CharField(
        max_length=20,
        choices=STATUS_CHOICES,
        default='active',
        verbose_name='状态',
    )
    last_connected_at = models.DateTimeField(null=True, blank=True, verbose_name='最后连接时间')
    os_info = models.JSONField(default=dict, verbose_name='远程系统信息')

    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'tabtinspace_remote_server'
        verbose_name = 'SSH 远程服务器'
        verbose_name_plural = 'SSH 远程服务器'
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['device', 'status'], name='ctx_rs_device_status_idx'),
        ]

    def __str__(self):
        return f"{self.name} ({self.username}@{self.host}:{self.port})"


class MCPConnection(models.Model):
    """MCP（Model Context Protocol）server 连接配置。

    照 ``LLMProvider`` 的 scope 范式表达「本地 vs 远程」（PRD §2.3）：
    - ``scope=local``：连接跟着**执行设备**（``device`` 非空）——MCP server 跑在
      本机，"从这台机能连到哪个 MCP" 是设备属性，同 Device 上的 Space 共享；
    - ``scope=remote``：连接跟着**团队**（``organization`` 非空）——远程 / SaaS MCP，
      团队统一登记共享（本期仅预留字段，API 只做 device 维度）。

    归属二选一互斥（device XOR organization）：``save()`` 按归属归一 ``scope``
    （照抄 LLMProvider.save() llm/models.py:161-170），``clean()`` 强校验互斥，
    partial ``UniqueConstraint`` 保证同归属下 ``name`` 唯一（照抄 LLMProvider
    的 condition 写法 llm/models.py:108-124）。

    凭据（http bearer/token、stdio env secret 等）不落本表明文，统一走
    ``SecureCredential``（Fernet 加密），``config`` 只存非敏感的 key 名 / 开关。
    """

    SCOPE_CHOICES = [
        ('local', '本地（跟设备）'),
        ('remote', '远程（跟团队）'),
    ]
    TRANSPORT_CHOICES = [
        ('stdio', 'Stdio'),
        ('http', 'Streamable HTTP'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=200, verbose_name='连接名称', help_text='如：本地文件 MCP')
    description = models.TextField(
        blank=True,
        default='',
        verbose_name='描述',
        help_text='可选；卡片与组织精选优先展示',
    )
    scope = models.CharField(
        max_length=20,
        choices=SCOPE_CHOICES,
        default='local',
        db_index=True,
        verbose_name='作用域',
        help_text='由 save() 按 device/organization 归属自动归一，无需手动维护',
    )
    device = models.ForeignKey(
        Device,
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name='mcp_connections',
        verbose_name='归属设备（scope=local）',
        help_text='对仗 RemoteServer.device：连接活在设备上，设备删除则连接一并级联删除',
    )
    organization = models.ForeignKey(
        Organization,
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name='mcp_connections',
        verbose_name='归属组织（scope=remote）',
    )
    created_by = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='shared_mcp_connections',
        verbose_name='分享者',
        help_text='组织精选快照的创建者；旧数据与本地连接允许为空',
    )
    transport = models.CharField(
        max_length=20,
        choices=TRANSPORT_CHOICES,
        default='stdio',
        verbose_name='传输方式',
    )
    command = models.TextField(blank=True, default='', verbose_name='启动命令', help_text='stdio：MCP server 可执行命令')
    args = models.JSONField(default=list, blank=True, verbose_name='启动参数', help_text='stdio：命令行参数数组')
    cwd = models.TextField(blank=True, default='', verbose_name='工作目录', help_text='stdio：进程工作目录')
    endpoint = models.URLField(blank=True, default='', verbose_name='服务地址', help_text='http：Streamable HTTP url')
    config = models.JSONField(
        default=dict,
        blank=True,
        verbose_name='非敏感配置',
        help_text='env / headers 的 key 名等非敏感配置；敏感值走 credential',
    )
    credential = models.ForeignKey(
        SecureCredential,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='mcp_connections',
        verbose_name='关联加密凭据',
    )
    enabled = models.BooleanField(default=True, verbose_name='是否启用')
    last_probe = models.JSONField(
        default=dict,
        blank=True,
        verbose_name='最近探针结果',
        help_text='Electron 端 probe 回写的健康检查结果（后端只存不真连）',
    )

    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'tabtinspace_mcp_connection'
        verbose_name = 'MCP 连接'
        verbose_name_plural = 'MCP 连接'
        ordering = ['-created_at']
        constraints = [
            models.UniqueConstraint(
                fields=['device', 'name'],
                condition=models.Q(device__isnull=False),
                name='ctx_mcp_device_name_unique',
            ),
            models.UniqueConstraint(
                fields=['organization', 'name'],
                condition=models.Q(organization__isnull=False),
                name='ctx_mcp_workteam_name_unique',
            ),
            # DB 级 XOR 兜底：device / organization 必须恰好一个非空。clean() 是
            # 应用层友好校验，但 save()/objects.create() 从不自动调 clean()、DB
            # 也无约束——remote 走同一 create 路径、误传双归属、device 删除等都能
            # 静默写出非法态，故必须在 DB 层加这条护栏（光靠 partial unique 不够：
            # 它只管「同归属下唯一」，不管「归属本身合法」）。
            models.CheckConstraint(
                check=(
                    models.Q(device__isnull=False, organization__isnull=True) |
                    models.Q(device__isnull=True, organization__isnull=False)
                ),
                name='ctx_mcp_owner_xor',
            ),
        ]
        indexes = [
            models.Index(fields=['device', 'enabled'], name='ctx_mcp_device_enabled_idx'),
        ]

    def save(self, *args, **kwargs):
        # 照抄 LLMProvider.save() 的「归属 → scope」归一范式（llm/models.py:161-170）：
        # device 优先（本地），其次 organization（远程）。两者皆空时保留默认 'local'，
        # 由 clean() 在 full_clean 路径拦截。
        if self.device_id:
            self.scope = 'local'
        elif self.organization_id:
            self.scope = 'remote'
        super().save(*args, **kwargs)

    def clean(self):
        super().clean()
        # 本地 vs 远程归属互斥（PRD §2.3）：device(local) XOR organization(remote)。
        # 覆盖 spec 全部分支——both 非空 / both 空都报错；device-only→local、
        # organization-only→remote 为唯一两种合法态。
        has_device = self.device_id is not None
        has_organization = self.organization_id is not None
        if has_device and has_organization:
            raise ValidationError(
                'MCP 连接归属互斥：device（本地）与 organization（远程）只能二选一'
            )
        if not has_device and not has_organization:
            raise ValidationError(
                'MCP 连接必须指定归属：device（本地）或 organization（远程）其一'
            )

    def __str__(self):
        owner = f"device={self.device_id}" if self.device_id else f"organization={self.organization_id}"
        return f"{self.name} ({self.get_transport_display()}, {self.scope}, {owner})"


class Workspace(models.Model):
    """执行现场（ PR2 终态建模）——「在哪台设备的哪个目录干活」。

    个人域终态两概念之一（另一个是 Agent 纯人格）：Workspace = (设备,
    规范化目录) 的本地执行现场，持有目录策略、信任状态、git 现场快照。
    会话 = 谁干（Agent）× 在哪干（Workspace）双键直挂（ChatSession.workspace）。

    与 Space 的关系：workspace 型 Space 的执行现场字段整体迁入本表
    （迁移保 id 复用：Workspace.id 沿用源 Space.id）；Space 仅存
    team_space 形态（二期 Project 宿主），个人域 Space 壳的物理消解在
    PR2b。主场（每设备静默供给的默认现场， P1）是本表 kind='home'
    的一行，建模需求 M-1~M-7 见
    docs/prd/home-workspace-p1-implementation-v1.md §2。
    """

    class Kind(models.TextChoices):
        # M-1：主场标识用枚举不用布尔（互斥天然、可扩展；对齐
        # Organization.is_default → type 的既有教训）。
        HOME = 'home', '主场'
        STANDARD = 'standard', '普通'

    class TrustStatus(models.TextChoices):
        TRUSTED = 'trusted', '已信任'
        UNTRUSTED = 'untrusted', '未信任'

    class TrustSource(models.TextChoices):
        # M-3：区分「系统自建默认受信」与「用户手动确认」——主场供给写
        # system_provisioned（首次进入不弹 Trust 确认）；W3 Trust UI 共用。
        SYSTEM_PROVISIONED = 'system_provisioned', '系统自建默认受信'
        USER_CONFIRMED = 'user_confirmed', '用户确认'
        NONE = 'none', '无'

    class ApprovalGrant(models.TextChoices):
        ALWAYS_ASK = 'always_ask', '每次询问'
        AUTO = 'auto', '自动批准低风险操作'
        FULL_ACCESS = 'full_access', '完全访问'

    class ProvisioningSource(models.TextChoices):
        # ：侧栏隐藏看「系统供给来源」，不看是否关联了 Project。
        USER = 'user', '用户主动创建'
        SYSTEM_PROJECT = 'system_project', '系统随 Project 自动供给'
        SYSTEM_TASK = 'system_task', '系统随 Task 自动供给'

    SYSTEM_PROVISIONING_SOURCES = frozenset({
        ProvisioningSource.SYSTEM_PROJECT,
        ProvisioningSource.SYSTEM_TASK,
    })

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    organization = models.ForeignKey(
        Organization,
        on_delete=models.CASCADE,
        related_name='workspaces',
        verbose_name='所属组织',
    )
    # 执行设备（单字段，不再有 Space 时代 bound/control 双字段冗余）。
    # on_delete=CASCADE：现场是「设备上的目录」，设备行删除（管理员清理）
    # 后现场无立足点；会话侧 ChatSession.workspace 是 SET_NULL，对话历史
    # 不连带删除。
    device = models.ForeignKey(
        Device,
        on_delete=models.CASCADE,
        related_name='workspaces',
        verbose_name='执行设备',
    )
    name = models.CharField(
        max_length=255,
        blank=True,
        default='',
        verbose_name='展示名',
        help_text='本地化展示名（主场存「主场/Home」，M-4）；目录路径才是身份，名字只是标签。',
    )
    description = models.TextField(
        blank=True,
        default='',
        verbose_name='简介',
        help_text='执行现场的简短用途说明，不参与目录身份或运行时策略判定。',
    )
    working_dir = models.TextField(
        verbose_name='工作目录',
        help_text='设备上的工作目录绝对路径（客户端解析后传入，后端不臆造路径）。',
    )
    normalized_working_dir = models.TextField(
        db_index=True,
        verbose_name='标准化工作目录',
        help_text='用于 (device, path) 唯一约束的规范化路径（SpaceService._canonical_working_dir 口径）。',
    )
    working_dir_type = models.CharField(
        max_length=20,
        blank=True,
        default='',
        verbose_name='工作目录类型',
        help_text='code/mixed/doc；空值表示未设置。',
    )
    kind = models.CharField(
        max_length=16,
        choices=Kind.choices,
        default=Kind.STANDARD,
        verbose_name='现场类别',
        help_text="home=每设备静默供给的主场（ P1）；standard=用户开目录建的普通现场。",
    )
    provisioning_source = models.CharField(
        max_length=32,
        choices=ProvisioningSource.choices,
        default=ProvisioningSource.USER,
        verbose_name='供给来源',
        help_text=(
            '决定普通 Workspace 导航是否默认隐藏。'
            'system_project/system_task=系统自动供给的内部现场；'
            'user=用户主动创建或主动新建的资产。'
            '改绑 Project/Task 执行关联不得改写本字段。'
        ),
    )
    # ── Workspace Trust（正典 §5；M-3。UI 归 W3，本批只落字段）──
    trust_status = models.CharField(
        max_length=16,
        choices=TrustStatus.choices,
        default=TrustStatus.UNTRUSTED,
        verbose_name='信任状态',
    )
    trust_source = models.CharField(
        max_length=32,
        choices=TrustSource.choices,
        default=TrustSource.NONE,
        verbose_name='信任来源',
    )
    trusted_at = models.DateTimeField(null=True, blank=True, verbose_name='信任时间')
    # git 现场快照（PR1 遗留 TODO 归位：原错挂 Agent.agent_config['git_status']，
    # 它是 (设备, 目录) 的现场状态，归属本表；设备心跳经 device_service 写入）。
    git_status = models.JSONField(
        default=dict,
        blank=True,
        verbose_name='git 状态快照',
        help_text='Daemon 心跳上报的仓库状态（is_repo/branch/…）；仅现场快照，不承载业务语义。',
    )
    approval_grant = models.CharField(
        max_length=16,
        choices=ApprovalGrant.choices,
        default=ApprovalGrant.FULL_ACCESS,
        verbose_name='现场审批授权档位',
        help_text='进入该 Workspace 的所有自有 Agent 共用；仍受 Organization 天花板约束。',
    )
    approval_memo = models.JSONField(
        default=dict,
        blank=True,
        verbose_name='现场审批记忆',
        help_text='审批 always 决策，结构为 {version, entries, generation}。',
    )
    # ：现场自有规则与执行限额——与 Agent.custom_rules / agent_config 解耦。
    custom_rules = models.TextField(
        blank=True,
        default='',
        verbose_name='现场自定义规则',
        help_text='进入本 Workspace 干活时遵守的现场规则；不复用 Agent 人设。',
    )
    execution_limits = models.JSONField(
        default=dict,
        blank=True,
        verbose_name='现场执行限制',
        help_text=(
            '结构为 {enabled, max_iterations_per_run, max_credits_per_run}；'
            '空 dict / enabled=false 表示未启用执行限制；'
            '旧数据无 enabled 但有数值键时视为已启用。'
        ),
    )
    created_by = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='created_workspaces',
        verbose_name='创建者',
        help_text='个人执行现场的归属用户（个人域 Space 壳消解后的归属锚点）。',
    )
    # ：不再挂默认执行 Agent。身份与现场解耦；运行时组合在
    # ChatSession.agent_id + workspace_id（及显式 API agent_id）。
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'tabtinspace_workspace'
        verbose_name = 'Workspace'
        verbose_name_plural = 'Workspaces'
        constraints = [
            # 目录身份按 Organization + 所有者用户 + 设备 + 规范化路径隔离。
            # Electron 切换账号时会复用 Device 行；不同账号或 Organization
            # 必须能各自建立私有 Workspace。created_by 为空的极旧数据不参与
            # 账号级占用，继续交由异常数据巡检处理。
            #
            # 保留约束名以兼容滚动发布期间旧服务实例的 IntegrityError 映射。
            models.UniqueConstraint(
                fields=[
                    'organization',
                    'created_by',
                    'device',
                    'normalized_working_dir',
                ],
                condition=models.Q(
                    created_by__isnull=False,
                ) & ~models.Q(normalized_working_dir=''),
                name='ctx_ws_device_dir_unique',
            ),
            # ：同一用户在一个 Organization 的一台设备上最多一个主场。
            # Electron 切换账号时会复用 Device 行，用户必须属于幂等键；无 created_by
            # 的极旧数据不自动归属任何用户，也不阻止新用户供给自己的主场。
            models.UniqueConstraint(
                fields=['organization', 'device', 'created_by'],
                condition=models.Q(kind='home', created_by__isnull=False),
                name='ctx_ws_org_dev_user_home_uniq',
            ),
        ]
        indexes = [
            models.Index(fields=['organization', 'kind'], name='ctx_ws_org_kind_idx'),
            models.Index(fields=['created_by'], name='ctx_ws_created_by_idx'),
        ]

    # M-7：「一目录多 Project」预留为 Workspace 之外的 join 表
    # （WorkspaceProjectLink，二期随 Project 落地），本表不放单 project FK。

    @property
    def is_system_provisioned(self) -> bool:
        """系统自动供给的内部现场（侧栏默认隐藏）。"""
        return self.provisioning_source in self.SYSTEM_PROVISIONING_SOURCES

    def __str__(self):
        return f"{self.name or self.working_dir} ({self.get_kind_display()})"



class SpaceType:
    """#3266：历史 Space.type 枚举，供退役窗口调用方兼容读取。"""
    WORKSPACE = 'workspace'
    TEAM_SPACE = 'team_space'


class Space:
    """#3266 退役导入壳（非 Django Model）。

    ``tabtinspace_space`` 表由 migration 0110 DROP。本类仅保留
    ``Space.SpaceType`` / ``Space.DoesNotExist`` 等导入兼容；查询请改
    :class:`Workspace` / :class:`Project`。``Space.objects`` 会抛错，
    防止误写回已删除的表。
    """

    SpaceType = SpaceType
    DoesNotExist = Workspace.DoesNotExist

    class _RetiredManager:
        def __getattr__(self, name):
            raise RuntimeError(
                'Space 表已 DROP；请改用 Workspace / Project，'
                f'禁止调用 Space.objects.{name}'
            )

        def __bool__(self):
            return True

    objects = _RetiredManager()

    def __init__(self, *args, **kwargs):
        raise RuntimeError('Space 模型已退役；请改用 Workspace / Project')



class SpaceMembership(models.Model):
    """Space 成员关系 — 描述"谁以什么角色待在哪个房间"

    支持 Agent 和 User 两种身份类型（互斥，二选一）。
    """

    ROLE_CHOICES = [
        ('owner', '所有者'),
        ('admin', '管理员'),
        ('editor', '编辑者'),
        ('viewer', '查看者'),
        ('participant', '参与者'),
    ]

    class Status(models.TextChoices):
        # active：已生效成员（历史默认，全部存量记录回填为 active）。
        # pending：已被邀请进 Project 但尚未在自己的 Electron 上显式接受；
        #   接受前不生效、不占执行现场（伴生 Workspace 在接受时才供给）。
        # 与 is_active 正交：is_active=False 表示「曾生效后被停用/移除」；
        # pending 表示「从未生效、等待接受」——两者语义不同，不复用同一字段。
        ACTIVE = 'active', '已生效'
        PENDING = 'pending', '待接受'

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    # ：个人域成员关系直挂 Workspace（space FK 已 Drop）。
    workspace = models.ForeignKey(
        Workspace,
        on_delete=models.CASCADE,
        related_name='memberships',
        verbose_name='所属 Workspace',
        help_text='个人执行现场的成员关系直挂锚点。',
    )
    agent = models.ForeignKey(
        'agent.Agent',
        on_delete=models.CASCADE,
        null=True, blank=True,
        related_name='space_memberships',
        verbose_name='Agent 身份'
    )
    user = models.ForeignKey(
        User,
        on_delete=models.CASCADE,
        null=True, blank=True,
        related_name='space_memberships',
        verbose_name='User 身份',
    )
    role = models.CharField(
        max_length=20,
        choices=ROLE_CHOICES,
        default='viewer',
        verbose_name='角色'
    )
    permissions = models.JSONField(default=dict, verbose_name='自定义权限')
    is_active = models.BooleanField(default=True, verbose_name='是否有效')
    status = models.CharField(
        max_length=20,
        choices=Status.choices,
        default=Status.ACTIVE,
        db_index=True,
        verbose_name='成员状态',
        help_text='active=已生效；pending=已邀请待成员在 Electron 上显式接受。'
                  'pending 成员 is_active=False，接受后转 active + is_active=True 并当场供给伴生 Workspace。',
    )

    # 邀请元数据（仅 pending → active 生命周期使用）
    invited_by = models.UUIDField(
        null=True, blank=True,
        verbose_name='邀请人用户 ID',
        help_text='pending 成员的邀请发起人；用于通知回执与审计。',
    )

    # Group Space 中的角色特化
    role_label = models.CharField(max_length=50, blank=True, default='', verbose_name='角色标签')
    responsibility = models.TextField(blank=True, default='', verbose_name='职责描述')
    persona_override = models.TextField(blank=True, default='', verbose_name='身份覆写')
    is_primary = models.BooleanField(
        default=False,
        verbose_name='是否主要负责 Agent',
        help_text='仅 Agent membership 使用；一个 Space / Project 最多一个生效主要 Agent。',
    )

    joined_at = models.DateTimeField(auto_now_add=True, verbose_name='加入时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'tabtinspace_space_membership'
        verbose_name = 'Workspace 成员'
        verbose_name_plural = 'Workspace 成员'
        indexes = [
            models.Index(fields=['workspace', 'role'], name='ctx_sm_ws_role_idx'),
            models.Index(fields=['agent', 'joined_at'], name='ctx_sm_agent_joined_idx'),
            models.Index(fields=['user', 'joined_at'], name='ctx_sm_user_joined_idx'),
            models.Index(fields=['user', 'status'], name='ctx_sm_user_status_idx'),
        ]
        constraints = [
            models.CheckConstraint(
                check=(
                    models.Q(agent__isnull=False, user__isnull=True) |
                    models.Q(agent__isnull=True, user__isnull=False)
                ),
                name='ctx_sm_one_identity',
            ),
            models.UniqueConstraint(
                fields=['workspace', 'agent'],
                condition=models.Q(agent__isnull=False),
                name='ctx_sm_ws_agent_unique',
            ),
            models.UniqueConstraint(
                fields=['workspace', 'user'],
                condition=models.Q(user__isnull=False),
                name='ctx_sm_ws_user_unique',
            ),
            models.UniqueConstraint(
                fields=['workspace'],
                condition=models.Q(agent__isnull=False, is_active=True, is_primary=True),
                name='ctx_sm_ws_primary_agent_unique',
            ),
        ]

    def __str__(self):
        identity = self.agent.name if self.agent else (self.user.get_display_name() if self.user else '?')
        host = getattr(self.workspace, 'name', None) or str(self.workspace_id)
        return f"{host} - {identity} ({self.get_role_display()})"


class Project(models.Model):
    """团队协作场景（ 终态）——「谁跟谁一起做一件事」。

    终态模型（正典见 principle/workspace-project.md）：Project 是团队级协作房间，
    与个人执行现场 Workspace 平级；不再借 ``Space(type=team_space)`` 壳。

    - 归属：单个 Organization，成员通过 :class:`ProjectMembership` 加入
    - 不持有默认执行绑定；每个成员执行落到 :class:`ProjectMemberWorkspace`
      指向的私有 Workspace（``created_by=user``）
    - Project 不代表共享本地目录；文件/代码维度仍是 Workspace 的单根契约
    - Task / Deliverable / SpaceActivityEvent 等团队级子表以 project 为宿主

    id 沿用旧 ``Space(type=team_space)`` 行 id，让 API 契约 / 会话历史无缝续存。
    """

    class Status(models.TextChoices):
        ACTIVE = 'active', '进行中'
        PAUSED = 'paused', '暂停'
        COMPLETED = 'completed', '已完成'
        ARCHIVED = 'archived', '已归档'
        TRASHED = 'trashed', '已删除'

    class Visibility(models.TextChoices):
        PRIVATE = 'private', '仅创建者'
        SHARED = 'shared', '已共享'

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    organization = models.ForeignKey(
        Organization,
        on_delete=models.CASCADE,
        related_name='projects',
        verbose_name='所属组织',
    )
    name = models.CharField(max_length=255, verbose_name='名称')
    description = models.TextField(blank=True, default='', verbose_name='描述')
    avatar = models.CharField(
        max_length=500,
        blank=True,
        default='',
        verbose_name='头像文件引用',
        help_text='优先保存 OSS object key / FileRecord.file_key；旧完整 URL 仅作兼容',
    )
    color = models.CharField(max_length=20, blank=True, default='', verbose_name='标签颜色')
    status = models.CharField(
        max_length=20,
        choices=Status.choices,
        default=Status.ACTIVE,
        verbose_name='状态',
    )
    order = models.IntegerField(default=0, verbose_name='排序')
    is_archived = models.BooleanField(default=False, verbose_name='是否归档')
    is_default = models.BooleanField(default=False, verbose_name='是否默认')
    visibility = models.CharField(
        max_length=20,
        choices=Visibility.choices,
        default=Visibility.PRIVATE,
        verbose_name='可见范围',
    )
    config_version = models.PositiveIntegerField(
        default=0, verbose_name='配置版本号', help_text='乐观并发控制版本号',
    )
    last_activity_at = models.DateTimeField(
        null=True, blank=True, db_index=True,
        verbose_name='最后活跃时间',
        help_text='由各子系统通过信号统一更新，用于列表排序',
    )
    start_date = models.DateField(null=True, blank=True, verbose_name='开始日期')
    end_date = models.DateField(null=True, blank=True, verbose_name='结束日期')

    trashed_at = models.DateTimeField(
        null=True, blank=True, db_index=True, verbose_name='回收站时间',
    )
    trashed_by = models.UUIDField(null=True, blank=True, verbose_name='回收站操作人')
    previous_status = models.CharField(max_length=20, blank=True, default='', verbose_name='回收前状态')

    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'tabtinspace_project'
        verbose_name = 'Project'
        verbose_name_plural = 'Projects'
        ordering = ['order', '-created_at']
        indexes = [
            models.Index(fields=['organization', 'status'], name='ctx_project_org_status_idx'),
            models.Index(fields=['organization', 'is_archived'], name='ctx_project_org_archived_idx'),
            models.Index(fields=['organization', 'last_activity_at'], name='ctx_project_org_activity_idx'),
        ]

    def __str__(self):
        return f"{self.name} [{self.organization.name}]"


class ProjectMembership(models.Model):
    """Project 成员关系（ 终态）——「谁以什么角色在这个协作项目」。

    与 :class:`SpaceMembership` 的区别：
    - SpaceMembership 仅剩个人 Workspace 场景（agent/user 二选一）
    - ProjectMembership 只锚 :class:`Project` 与用户，不再和 Agent 混同
      （Project 里的 Agent 主要负责关系挂在 :class:`Space`/Agent 侧的
       ``is_primary`` 语义已由 Project.primary_agent_id 通过 ProjectTask 表达）
    - status='pending' → active 生命周期沿用（PRD Q3）
    """

    ROLE_CHOICES = [
        ('owner', '所有者'),
        ('admin', '管理员'),
        ('editor', '编辑者'),
        ('viewer', '查看者'),
        ('participant', '参与者'),
    ]

    class Status(models.TextChoices):
        ACTIVE = 'active', '已生效'
        PENDING = 'pending', '待接受'

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    project = models.ForeignKey(
        Project,
        on_delete=models.CASCADE,
        related_name='memberships',
        verbose_name='所属 Project',
    )
    user = models.ForeignKey(
        User,
        on_delete=models.CASCADE,
        related_name='project_memberships',
        verbose_name='成员',
    )
    role = models.CharField(
        max_length=20, choices=ROLE_CHOICES, default='viewer', verbose_name='角色',
    )
    permissions = models.JSONField(default=dict, verbose_name='自定义权限')
    is_active = models.BooleanField(default=True, verbose_name='是否有效')
    status = models.CharField(
        max_length=20,
        choices=Status.choices,
        default=Status.ACTIVE,
        db_index=True,
        verbose_name='成员状态',
    )
    invited_by = models.UUIDField(
        null=True, blank=True, verbose_name='邀请人用户 ID',
    )
    role_label = models.CharField(max_length=50, blank=True, default='', verbose_name='角色标签')
    responsibility = models.TextField(blank=True, default='', verbose_name='职责描述')

    joined_at = models.DateTimeField(auto_now_add=True, verbose_name='加入时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'tabtinspace_project_membership'
        verbose_name = 'Project 成员'
        verbose_name_plural = 'Project 成员'
        indexes = [
            models.Index(fields=['project', 'role'], name='ctx_pm_project_role_idx'),
            models.Index(fields=['user', 'joined_at'], name='ctx_pm_user_joined_idx'),
            models.Index(fields=['user', 'status'], name='ctx_pm_user_status_idx'),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=['project', 'user'],
                name='ctx_pm_project_user_unique',
            ),
        ]

    def __str__(self):
        return f"{self.project.name} - {self.user.get_display_name()} ({self.get_role_display()})"


class ProjectMemberWorkspace(models.Model):
    """Project 成员与其私有执行现场的显式关联。

    Project 不持有默认执行绑定；同一名成员在同一 Project 下只关联一份由自己
    控制的 Workspace。Workspace 可以被同一成员复用于多个 Project，因此唯一性
    落在 ``(project, user)``，不落在 Workspace 本身。
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    project = models.ForeignKey(
        Project,
        on_delete=models.CASCADE,
        related_name='member_workspaces',
        verbose_name='所属 Project',
    )
    user = models.ForeignKey(
        User,
        on_delete=models.CASCADE,
        related_name='project_workspaces',
        verbose_name='成员',
    )
    workspace = models.ForeignKey(
        Workspace,
        on_delete=models.PROTECT,
        related_name='project_memberships',
        verbose_name='私有 Workspace',
    )
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'tabtinspace_project_member_workspace'
        verbose_name = 'Project 成员 Workspace'
        verbose_name_plural = 'Project 成员 Workspace'
        constraints = [
            models.UniqueConstraint(
                fields=['project', 'user'],
                name='ctx_pmw_project_user_unique',
            ),
        ]
        indexes = [
            models.Index(fields=['user', 'project'], name='ctx_pmw_user_project_idx'),
            models.Index(fields=['workspace'], name='ctx_pmw_workspace_idx'),
        ]

    def __str__(self):
        return f'{self.project_id}:{self.user_id} -> {self.workspace_id}'


class ProjectTask(models.Model):
    """Project 中由真人负责的一份团队工作真相。"""

    class Priority(models.TextChoices):
        LOW = 'low', '低'
        MEDIUM = 'medium', '中'
        HIGH = 'high', '高'
        URGENT = 'urgent', '紧急'

    class AssignmentStatus(models.TextChoices):
        PENDING = 'pending', '待确认'
        ACCEPTED = 'accepted', '已接受'
        REJECTED = 'rejected', '已拒绝'

    class WorkStatus(models.TextChoices):
        TODO = 'todo', '待执行'
        IN_PROGRESS = 'in_progress', '执行中'
        IN_REVIEW = 'in_review', '待验收'
        BLOCKED = 'blocked', '受阻'
        DONE = 'done', '已完成'
        CANCELLED = 'cancelled', '已取消'

    class ResultVisibility(models.TextChoices):
        PRIVATE = 'private', '仅责任人'
        PROJECT_PREVIEW = 'project_preview', 'Project 预览'

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    project = models.ForeignKey(
        Project,
        on_delete=models.CASCADE,
        related_name='project_tasks',
        verbose_name='所属 Project',
    )
    title = models.CharField(max_length=200, verbose_name='任务标题')
    description = models.TextField(blank=True, default='', verbose_name='任务描述')
    priority = models.CharField(
        max_length=16,
        choices=Priority.choices,
        default=Priority.MEDIUM,
        verbose_name='优先级',
    )
    created_by = models.ForeignKey(
        User,
        on_delete=models.PROTECT,
        related_name='created_project_tasks',
        verbose_name='创建人',
    )
    responsible_user = models.ForeignKey(
        User,
        on_delete=models.PROTECT,
        related_name='responsible_project_tasks',
        verbose_name='责任人',
    )
    assignment_status = models.CharField(
        max_length=16,
        choices=AssignmentStatus.choices,
        default=AssignmentStatus.PENDING,
        verbose_name='任务确认状态',
    )
    work_status = models.CharField(
        max_length=16,
        choices=WorkStatus.choices,
        default=WorkStatus.TODO,
        verbose_name='工作状态',
    )
    selected_agent = models.ForeignKey(
        'agent.Agent',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='project_tasks',
        verbose_name='执行 Agent',
    )
    project_member_workspace = models.ForeignKey(
        ProjectMemberWorkspace,
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name='tasks',
        verbose_name='责任人确认的 Project Workspace',
    )
    workspace_confirmed_at = models.DateTimeField(
        null=True,
        blank=True,
        verbose_name='Workspace 确认时间',
    )
    result_summary = models.TextField(blank=True, default='', verbose_name='验收结果摘要')
    result_visibility = models.CharField(
        max_length=32,
        choices=ResultVisibility.choices,
        default=ResultVisibility.PRIVATE,
        verbose_name='结果可见性',
        help_text=(
            '历史兼容字段；未完成任务中间产物默认项目成员可读，'
            '不再依赖此开关。'
        ),
    )
    version = models.PositiveIntegerField(default=1, verbose_name='乐观并发版本')
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'tabtinspace_project_task'
        verbose_name = 'Project 任务'
        verbose_name_plural = 'Project 任务'
        ordering = ['-updated_at', '-created_at']
        indexes = [
            models.Index(fields=['project', 'work_status'], name='ctx_pt_project_status_idx'),
            models.Index(fields=['responsible_user', 'assignment_status'], name='ctx_pt_owner_assign_idx'),
            models.Index(fields=['created_by', 'created_at'], name='ctx_pt_creator_time_idx'),
            models.Index(
                fields=['selected_agent', 'updated_at', 'created_at'],
                name='ctx_pt_agent_time_idx',
            ),
        ]

    def __str__(self):
        return f'{self.title} ({self.work_status})'


class ProjectTaskEvent(models.Model):
    """Project Task 的不可变业务时间线。"""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    task = models.ForeignKey(
        ProjectTask,
        on_delete=models.CASCADE,
        related_name='events',
        verbose_name='所属任务',
    )
    actor = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='project_task_events',
        verbose_name='操作人',
    )
    actor_name = models.CharField(max_length=100, blank=True, default='', verbose_name='操作人快照')
    event_type = models.CharField(max_length=40, db_index=True, verbose_name='事件类型')
    payload = models.JSONField(default=dict, blank=True, verbose_name='事件数据')
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')

    class Meta:
        db_table = 'tabtinspace_project_task_event'
        verbose_name = 'Project 任务事件'
        verbose_name_plural = 'Project 任务事件'
        ordering = ['created_at', 'id']
        indexes = [
            models.Index(fields=['task', 'created_at'], name='ctx_pte_task_time_idx'),
        ]

    def __str__(self):
        return f'{self.task_id}:{self.event_type}'


class ProjectTaskRun(models.Model):
    """完成 Project Task 的一次执行尝试；执行绑定在创建后不可改写。"""

    class Status(models.TextChoices):
        PREPARING = 'preparing', '准备中'
        PENDING = 'pending', '等待执行'
        RUNNING = 'running', '执行中'
        COMPLETED = 'completed', '执行完成'
        FAILED = 'failed', '执行失败'
        CANCELLED = 'cancelled', '已取消'

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    task = models.ForeignKey(
        ProjectTask,
        on_delete=models.CASCADE,
        related_name='runs',
        verbose_name='所属任务',
    )
    rerun_of = models.ForeignKey(
        'self',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='reruns',
        verbose_name='重跑来源',
    )
    status = models.CharField(
        max_length=16,
        choices=Status.choices,
        default=Status.PENDING,
        verbose_name='执行状态',
    )
    responsible_user = models.ForeignKey(
        User,
        on_delete=models.PROTECT,
        related_name='project_task_runs',
        verbose_name='责任人快照',
    )
    agent = models.ForeignKey(
        'agent.Agent',
        on_delete=models.PROTECT,
        related_name='project_task_runs',
        verbose_name='Agent 快照',
    )
    workspace = models.ForeignKey(
        Workspace,
        on_delete=models.PROTECT,
        related_name='project_task_runs',
        verbose_name='Workspace 快照',
    )
    device = models.ForeignKey(
        Device,
        on_delete=models.PROTECT,
        related_name='project_task_runs',
        verbose_name='Device 快照',
    )
    chat_session = models.ForeignKey(
        'conversation.ChatSession',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='project_task_runs',
        verbose_name='执行会话',
    )
    binding_snapshot = models.JSONField(default=dict, verbose_name='执行绑定快照')
    result_summary = models.TextField(blank=True, default='', verbose_name='执行结果摘要')
    result_items = models.JSONField(
        default=list,
        blank=True,
        verbose_name='执行结果候选交付物',
        help_text='Agent 在本次执行中明确交付的云端资源快照；验收前仅责任人可见。',
    )
    safe_failure_reason = models.TextField(blank=True, default='', verbose_name='脱敏失败原因')
    started_at = models.DateTimeField(null=True, blank=True, verbose_name='开始时间')
    ended_at = models.DateTimeField(null=True, blank=True, verbose_name='结束时间')
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'tabtinspace_project_task_run'
        verbose_name = 'Project 任务执行'
        verbose_name_plural = 'Project 任务执行'
        ordering = ['-created_at']
        constraints = [
            models.UniqueConstraint(
                fields=['task'],
                condition=Q(status__in=['preparing', 'pending', 'running']),
                name='ctx_ptr_task_active_unique',
            ),
        ]
        indexes = [
            models.Index(fields=['task', 'created_at'], name='ctx_ptr_task_time_idx'),
            models.Index(fields=['status', 'created_at'], name='ctx_ptr_status_time_idx'),
        ]

    def __str__(self):
        return f'{self.task_id}:{self.status}'


class ProjectTaskDeliverable(models.Model):
    """责任人验收时明确发布到 Project 资产区的交付物。"""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    task = models.ForeignKey(
        ProjectTask,
        on_delete=models.CASCADE,
        related_name='deliverables',
        verbose_name='来源任务',
    )
    task_run = models.ForeignKey(
        ProjectTaskRun,
        on_delete=models.PROTECT,
        related_name='deliverables',
        verbose_name='来源执行',
    )
    context_item = models.OneToOneField(
        'ContextItem',
        on_delete=models.CASCADE,
        related_name='project_task_deliverable',
        verbose_name='Project 资产',
    )
    published_by = models.ForeignKey(
        User,
        on_delete=models.PROTECT,
        related_name='published_project_task_deliverables',
        verbose_name='发布人',
    )
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='发布时间')

    class Meta:
        db_table = 'tabtinspace_project_task_deliverable'
        verbose_name = 'Project 任务交付物'
        verbose_name_plural = 'Project 任务交付物'
        ordering = ['-created_at']

    def __str__(self):
        return f'{self.task_id}:{self.context_item_id}'


class SpaceAppSettings(models.Model):
    """Workspace 应用设置（用户维度；表名历史保留）"""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace = models.ForeignKey(
        Workspace,
        on_delete=models.CASCADE,
        related_name='app_settings',
        verbose_name='所属 Workspace',
    )
    user = models.ForeignKey(
        User,
        on_delete=models.CASCADE,
        related_name='space_app_settings',
        verbose_name='用户',
    )
    disabled_apps = models.JSONField(default=list, verbose_name='禁用应用列表')
    optional_tools_allowlist = models.JSONField(
        default=dict,
        verbose_name='可选工具白名单',
        help_text='格式: {"allow_all": bool, "tools": [...], "apps": [...]}'
    )
    # Skills Wave 1 曾把 ``skill_configs`` 迁到 SkillEnablement；#3266 M4.5
    # 终态已继续迁到 AgentSkillLink.config_json，由 Workspace 的确定 Agent 定位。
    # RemoveField 历史 migration 见 tabtinspace/migrations/0045_*。

    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'tabtinspace_space_app_settings'
        verbose_name = 'Workspace 应用设置'
        verbose_name_plural = 'Workspace 应用设置'
        unique_together = [['workspace', 'user']]
        indexes = [
            models.Index(fields=['workspace', 'user'], name='ctx_ws_app_user_idx'),
        ]

    def __str__(self):
        host = getattr(self.workspace, 'name', None) or str(self.workspace_id)
        return f"{host} - {self.user.get_display_name()}"


class OrganizationAppInstall(models.Model):
    """Organization 级应用安装记录

    记录 Organization 已安装的应用：
    - core：内置核心应用，Organization 创建时自动注册
    - marketplace：市场应用（installScope=organization），管理员手动安装/卸载

    注意：installScope=device 的市场应用不走此模型，安装记录在客户端本地。
    """

    APP_SOURCE_CHOICES = [
        ('core', '核心应用'),
        ('marketplace', '应用市场'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    organization = models.ForeignKey(
        Organization,
        on_delete=models.CASCADE,
        related_name='app_installs',
        verbose_name='所属组织',
    )
    app_id = models.CharField(
        max_length=64,
        db_index=True,
        verbose_name='应用 ID',
        help_text='CORE_APPS key 或 MARKETPLACE_APPS key',
    )
    app_source = models.CharField(
        max_length=16,
        choices=APP_SOURCE_CHOICES,
        default='core',
        verbose_name='应用来源',
    )
    installed_by = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='installed_apps',
        verbose_name='安装人',
        help_text='CORE_APPS 自动安装时为 Organization owner',
    )
    install_metadata = models.JSONField(
        default=dict,
        blank=True,
        verbose_name='安装元数据',
        help_text='保留官方 Plugin Release、upstream revision、adapter 等安装时快照。',
    )

    created_at = models.DateTimeField(auto_now_add=True, verbose_name='安装时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'tabtinspace_organization_app_install'
        verbose_name = 'Organization 应用安装'
        verbose_name_plural = 'Organization 应用安装'
        ordering = ['created_at']
        constraints = [
            models.UniqueConstraint(
                fields=['organization', 'app_id'],
                name='ctx_wai_workteam_app_unique',
            ),
        ]
        indexes = [
            models.Index(fields=['organization', 'app_source'], name='ctx_wai_ws_source_idx'),
        ]

    def __str__(self):
        return f"{self.app_id} @ {self.organization.name} ({self.app_source})"


class DeviceAppInstallSnapshot(models.Model):
    """Device 级 marketplace App 安装快照（PRD-v3 §5.5）。

    通过 device heartbeat 上报本机 marketplace App registry，
    AdminDash App 安装管理页据此展示"用户 X 在 device Y 上装了某 marketplace App v1.0.0"。
    """

    INSTALL_STATUS_CHOICES = [
        ('installed', '已安装'),
        ('stale', '心跳超时'),
        ('missing', '缺失'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    device_id = models.UUIDField(
        db_index=True,
        verbose_name='设备 ID',
        help_text='软引用 tabtinspace.Device.id',
    )
    organization_id = models.UUIDField(
        db_index=True,
        verbose_name='组织 ID',
        help_text='冗余索引，加速 admin 按 organization 过滤',
    )
    app_id = models.CharField(
        max_length=64,
        db_index=True,
        verbose_name='应用 ID',
    )
    version = models.CharField(
        max_length=64,
        default='',
        verbose_name='版本号',
    )
    last_seen_at = models.DateTimeField(
        verbose_name='最后心跳时间',
    )
    install_status = models.CharField(
        max_length=16,
        choices=INSTALL_STATUS_CHOICES,
        default='installed',
        db_index=True,
        verbose_name='安装状态',
    )
    extra = models.JSONField(
        default=dict,
        blank=True,
        verbose_name='扩展信息',
        help_text='预留：本地 binary 路径 / SHA256 校验结果等',
    )

    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'tabtinspace_device_app_install_snapshot'
        verbose_name = 'Device App 安装快照'
        verbose_name_plural = 'Device App 安装快照'
        constraints = [
            models.UniqueConstraint(
                fields=['device_id', 'app_id'],
                name='ctx_dais_device_app_unique',
            ),
        ]
        indexes = [
            models.Index(fields=['organization_id', 'app_id'], name='ctx_dais_wt_app_idx'),
        ]

    def __str__(self):
        return f"{self.app_id} v{self.version} @ device {self.device_id} [{self.install_status}]"


class Collection(models.Model):
    """文件夹 — 云资源的层级组织

    支持多级嵌套，最大深度由 MAX_NESTING_DEPTH 控制。

    ：个人挂 Workspace，团队挂 Project；
     / ：云文档/云盘文件夹可直挂 Organization（与 workspace/project 互斥）。
    system_key 规划夹仍只挂 Space 宿主，不进 org。
    """

    MAX_NESTING_DEPTH = 5

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    # ：个人文件夹挂 Workspace；团队挂 Project（space FK 已 Drop）。
    workspace = models.ForeignKey(
        Workspace,
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name='collections',
        verbose_name='所属 Workspace',
        help_text='个人文件夹直挂 Workspace；团队文件夹写 project。',
    )
    project = models.ForeignKey(
        Project,
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name='collections',
        verbose_name='所属 Project',
        help_text='团队文件夹直挂 Project；个人文件夹写 workspace。',
    )
    # ：组织级云盘文件夹（与 ContextItem org-only 同构）。
    organization = models.ForeignKey(
        Organization,
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name='collections',
        verbose_name='所属 Organization',
        help_text='组织级云盘文件夹（不挂 workspace/project）；#7140 org-only。',
    )
    parent = models.ForeignKey(
        'self',
        on_delete=models.CASCADE,
        null=True, blank=True,
        related_name='children',
        verbose_name='父文件夹',
    )
    name = models.CharField(max_length=255, verbose_name='名称')
    system_key = models.CharField(
        max_length=64, null=True, blank=True, default=None,
        db_index=True, verbose_name='系统预置标识',
        help_text='非空表示系统预置 Collection，同一 Space 内唯一。'
                  '查找系统 Collection 应优先按此字段，而非 name。',
    )
    icon = models.CharField(max_length=50, blank=True, default='📁', verbose_name='图标')
    color = models.CharField(max_length=20, blank=True, default='', verbose_name='颜色')
    order = models.IntegerField(default=0, verbose_name='排序')
    is_expanded = models.BooleanField(default=True, verbose_name='是否展开')
    # ：同级文件夹置顶，语义对齐 ContextItem.is_pinned / pinned_at
    is_pinned = models.BooleanField(default=False, db_index=True, verbose_name='是否置顶')
    pinned_at = models.DateTimeField(null=True, blank=True, verbose_name='置顶时间')

    created_by = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True, blank=True,
        related_name='created_collections',
        verbose_name='创建者',
    )
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'tabtinspace_collection'
        verbose_name = '文件夹'
        verbose_name_plural = '文件夹'
        ordering = ['-is_pinned', '-pinned_at', 'order', 'name']
        indexes = [
            models.Index(fields=['workspace', 'order'], name='ctx_coll_workspace_order_idx'),
            models.Index(fields=['project', 'order'], name='ctx_coll_project_order_idx'),
            models.Index(fields=['organization', 'order'], name='ctx_coll_org_order_idx'),
            # ：org-only 列表按创建者过滤 + 排序。
            models.Index(
                fields=['organization', 'created_by', 'order'],
                name='ctx_coll_org_owner_order_idx',
            ),
            models.Index(fields=['parent', 'order'], name='ctx_coll_parent_order_idx'),
            models.Index(fields=['workspace', '-is_pinned', '-pinned_at'], name='ctx_coll_ws_pinned_idx'),
            models.Index(fields=['project', '-is_pinned', '-pinned_at'], name='ctx_coll_project_pinned_idx'),
            models.Index(fields=['organization', '-is_pinned', '-pinned_at'], name='ctx_coll_org_pinned_idx'),
            models.Index(
                fields=['organization', 'created_by', '-is_pinned', '-pinned_at'],
                name='ctx_coll_org_owner_pinned_idx',
            ),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=['workspace', 'parent', 'name'],
                name='ctx_coll_ws_child_name_unique',
                condition=Q(parent__isnull=False, workspace__isnull=False),
            ),
            models.UniqueConstraint(
                fields=['workspace', 'name'],
                name='ctx_coll_ws_root_name_unique',
                condition=Q(parent__isnull=True, workspace__isnull=False),
            ),
            models.UniqueConstraint(
                fields=['workspace', 'system_key'],
                name='ctx_coll_ws_system_key_unique',
                condition=Q(system_key__isnull=False, workspace__isnull=False),
            ),
            models.UniqueConstraint(
                fields=['project', 'parent', 'name'],
                name='ctx_coll_project_child_name_unique',
                condition=Q(parent__isnull=False, project__isnull=False),
            ),
            models.UniqueConstraint(
                fields=['project', 'name'],
                name='ctx_coll_project_root_name_unique',
                condition=Q(parent__isnull=True, project__isnull=False),
            ),
            models.UniqueConstraint(
                fields=['project', 'system_key'],
                name='ctx_coll_project_system_key_unique',
                condition=Q(system_key__isnull=False, project__isnull=False),
            ),
            # ：org-only 同名唯一按创建者分桶（不同用户可同名私有根/子文件夹）。
            models.UniqueConstraint(
                fields=['organization', 'created_by', 'parent', 'name'],
                name='ctx_coll_org_owner_child_name_uniq',
                condition=Q(
                    parent__isnull=False,
                    organization__isnull=False,
                    created_by__isnull=False,
                ),
            ),
            models.UniqueConstraint(
                fields=['organization', 'created_by', 'name'],
                name='ctx_coll_org_owner_root_name_uniq',
                condition=Q(
                    parent__isnull=True,
                    organization__isnull=False,
                    created_by__isnull=False,
                ),
            ),
            models.UniqueConstraint(
                fields=['organization', 'system_key'],
                name='ctx_coll_org_system_key_unique',
                condition=Q(system_key__isnull=False, organization__isnull=False),
            ),
            # ：workspace / project / organization 三态互斥（替换 ctx_coll_ws_xor_project）。
            models.CheckConstraint(
                check=(
                    (Q(workspace__isnull=False) & Q(project__isnull=True) & Q(organization__isnull=True))
                    | (Q(workspace__isnull=True) & Q(project__isnull=False) & Q(organization__isnull=True))
                    | (Q(workspace__isnull=True) & Q(project__isnull=True) & Q(organization__isnull=False))
                ),
                name='ctx_coll_host_exclusive_7140',
            ),
        ]

    @property
    def space_id(self):
        """API 兼容：Space 宿主返回 workspace/project id；org-only 返回 None。"""
        return self.workspace_id or self.project_id

    @property
    def space(self):
        """API 兼容：宿主对象（Workspace 或 Project）；org-only 为 None。"""
        return self.workspace or self.project

    def __str__(self):
        host = None
        if self.organization_id:
            host = getattr(self.organization, 'name', None) or str(self.organization_id)
        elif self.project_id:
            host = getattr(self.project, 'name', None) or str(self.project_id)
        elif self.workspace_id:
            host = getattr(self.workspace, 'name', None) or str(self.workspace_id)
        return f"{self.icon} {self.name} ({host or '-'})"

    def get_depth(self) -> int:
        """当前文件夹的嵌套深度（根级 = 0）。通过 parent 链遍历，有环保护。"""
        depth = 0
        current = self
        seen = set()
        while current.parent_id is not None:
            if current.parent_id in seen:
                break
            seen.add(current.parent_id)
            depth += 1
            try:
                current = Collection.objects.only('id', 'parent_id').get(id=current.parent_id)
            except Collection.DoesNotExist:
                break
        return depth


class ContextItem(models.Model):
    """上下文条目"""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    # ：个人资产挂 Workspace；团队挂 Project（space FK 已 Drop）。
    workspace = models.ForeignKey(
        Workspace,
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name='context_items',
        verbose_name='所属 Workspace',
        help_text='个人资产直挂 Workspace；团队资产写 project。',
    )
    project = models.ForeignKey(
        Project,
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name='context_items',
        verbose_name='所属 Project',
        help_text='团队资产（Task Deliverable 等）直挂 Project；个人资产写 workspace。',
    )
    # ：组织级资产（不挂具体 workspace/project）第三宿主态，例如 TabFiles
    # 组织云盘裸文件。与 workspace / project 互斥，见 Meta.constraints。
    organization = models.ForeignKey(
        Organization,
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name='context_items',
        verbose_name='所属 Organization',
        help_text='组织级资产（不挂 workspace/project）时使用；#6603 org-only。',
    )

    item_type = models.CharField(max_length=50, verbose_name='上下文类型')
    title = models.CharField(max_length=255, blank=True, verbose_name='标题')
    preview = models.TextField(blank=True, verbose_name='预览摘要')
    status = models.CharField(max_length=50, blank=True, verbose_name='状态')

    resource_id = models.CharField(max_length=100, blank=True, verbose_name='资源ID')
    metadata = models.JSONField(default=dict, verbose_name='上下文元数据')

    # ── 文件夹归属 ──
    collection = models.ForeignKey(
        Collection,
        on_delete=models.SET_NULL,
        null=True, blank=True,
        related_name='items',
        verbose_name='所属文件夹',
    )

    # ── 知识库式资源树：tabdoc/tabdata 自引用父子，取代 Collection 夹层 ──
    parent = models.ForeignKey(
        'self',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='children',
        verbose_name='父资源',
        help_text='云文档知识库树父节点；仅允许挂到同宿主且未回收的 tabdoc/tabdata。',
    )

    order = models.IntegerField(default=0, verbose_name='排序')
    is_archived = models.BooleanField(default=False, verbose_name='是否归档')

    # ── 置顶 ──
    is_pinned = models.BooleanField(default=False, db_index=True, verbose_name='是否置顶')
    pinned_at = models.DateTimeField(null=True, blank=True, verbose_name='置顶时间')

    # ── 回收站 ──
    trashed_at = models.DateTimeField(
        null=True, blank=True, db_index=True, verbose_name='回收站时间',
    )
    trashed_by = models.UUIDField(null=True, blank=True, verbose_name='回收站操作人')
    previous_status = models.CharField(
        max_length=20, blank=True, default='', verbose_name='回收前状态',
    )
    cleanup_fail_count = models.PositiveSmallIntegerField(
        default=0, verbose_name='清理失败次数',
        help_text='TrashCleaner 永久删除失败时递增，超过阈值后跳过常规清理',
    )

    # 全文搜索向量（PostgreSQL tsvector + GIN 索引）
    search_vector = SearchVectorField(null=True, blank=True, verbose_name='搜索向量')

    created_by = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='created_context_items',
        verbose_name='创建者',
    )
    updated_by = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='updated_context_items',
        verbose_name='更新者',
    )

    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'tabtinspace_context_item'
        verbose_name = '上下文条目'
        verbose_name_plural = '上下文条目'
        ordering = ['-is_pinned', '-pinned_at', 'order', '-created_at']
        indexes = [
            models.Index(fields=['workspace', 'item_type'], name='ctx_item_workspace_type_idx'),
            models.Index(fields=['project', 'item_type'], name='ctx_item_project_type_idx'),
            models.Index(fields=['organization', 'item_type'], name='ctx_item_org_type_idx'),
            models.Index(fields=['workspace', 'is_archived'], name='ctx_item_ws_archived_idx'),
            models.Index(fields=['workspace', 'order'], name='ctx_item_ws_order_idx'),
            models.Index(fields=['workspace', '-is_pinned', '-pinned_at'], name='ctx_item_ws_pinned_idx'),
            models.Index(fields=['collection', 'order'], name='ctx_item_coll_order_idx'),
            models.Index(fields=['parent', 'order'], name='ctx_item_parent_order_idx'),
            GinIndex(fields=['search_vector'], name='ctx_item_search_gin_idx'),
        ]
        constraints = [
            #  终态：每一行 ContextItem 必须恰好绑 workspace / project / organization
            # 三者之一（互斥）。取代 0117 的 workspace XOR project 二态约束。
            models.CheckConstraint(
                check=(
                    (Q(workspace__isnull=False) & Q(project__isnull=True) & Q(organization__isnull=True))
                    | (Q(workspace__isnull=True) & Q(project__isnull=False) & Q(organization__isnull=True))
                    | (Q(workspace__isnull=True) & Q(project__isnull=True) & Q(organization__isnull=False))
                ),
                name='ctx_item_host_exclusive_6603',
            ),
        ]

    # 知识库树：允许作为父节点的类型 / 最大深度（根 = 0）
    TREE_PARENT_ITEM_TYPES = frozenset({'tabdoc', 'tabdata'})
    MAX_PARENT_DEPTH = 10

    def get_parent_depth(self) -> int:
        """当前节点在 ContextItem.parent 链上的深度（根级 = 0）。含环保护。"""
        depth = 0
        current = self
        seen = set()
        while current.parent_id is not None:
            if current.parent_id in seen:
                break
            seen.add(current.parent_id)
            depth += 1
            try:
                current = ContextItem.objects.only('id', 'parent_id').get(id=current.parent_id)
            except ContextItem.DoesNotExist:
                break
        return depth

    @property
    def space_id(self):
        """API 兼容：对外仍返回 space_id，值为 workspace/project id（ id-reuse）。"""
        return self.workspace_id or self.project_id

    @property
    def space(self):
        """API 兼容：宿主对象（Workspace 或 Project），供列表 enrich space_name。"""
        return self.workspace or self.project

    def __str__(self):
        display_title = self.title or self.item_type
        host = None
        if self.project_id:
            host = getattr(self.project, 'name', None) or str(self.project_id)
        elif self.workspace_id:
            host = getattr(self.workspace, 'name', None) or str(self.workspace_id)
        elif self.organization_id:
            host = getattr(self.organization, 'name', None) or str(self.organization_id)
        return f"{display_title} ({host or '-'})"


class FilePermission(ResourcePermission):
    """云盘裸文件（TabFiles / FileRecord）资源级权限。

    owner 事实来源是挂载该文件的 ContextItem.created_by（或 FileRecord.upload_user）；
    本表只承载显式协作者（subject_type=user）。组织角色不隐式授权。
    """

    file_record_id = models.UUIDField(
        db_index=True,
        verbose_name='OSS FileRecord ID',
        help_text='对应 services_oss_file_record.id / ContextItem.resource_id（item_type=tabfiles）',
    )
    created_by = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='tabfiles_permissions_created',
        verbose_name='授权创建者',
    )

    class Meta(ResourcePermission.Meta):
        db_table = 'tabtinspace_file_permission'
        verbose_name = '云盘文件权限'
        verbose_name_plural = '云盘文件权限'
        constraints = [
            models.UniqueConstraint(
                fields=['file_record_id', 'subject_type', 'subject_id'],
                name='tabfiles_perm_unique_subject',
            ),
        ]
        indexes = [
            models.Index(fields=['file_record_id', 'is_active'], name='tabfiles_perm_file_active_idx'),
            models.Index(fields=['subject_type', 'subject_id'], name='tabfiles_perm_subject_idx'),
        ]

    def __str__(self):
        return f"{self.subject_type}:{self.subject_id}={self.permission} on file {self.file_record_id}"


class SharedResourcePlacement(models.Model):
    """接收者在自己云盘中的分享资源归档位置，不改变资源所有者的 ContextItem。"""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    organization = models.ForeignKey(
        Organization, on_delete=models.CASCADE, related_name='shared_resource_placements',
    )
    user = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name='shared_resource_placements',
    )
    resource_type = models.CharField(max_length=16)
    resource_id = models.CharField(max_length=100)
    collection = models.ForeignKey(
        Collection,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='shared_resource_placements',
    )
    dismissed = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'tabtinspace_shared_resource_placement'
        constraints = [
            models.UniqueConstraint(
                fields=['organization', 'user', 'resource_type', 'resource_id'],
                name='ctx_shared_place_org_user_resource_uq',
            ),
        ]
        indexes = [
            models.Index(
                fields=['organization', 'user', 'collection'],
                name='ctx_shared_place_user_coll_idx',
            ),
        ]


class ResourceAccess(models.Model):
    """Per-user 资源最近访问记录。

    记录「某用户最近一次打开某 ContextItem 的时间」，供资源主页列表的「最近访问」列
    与排序使用。每个 (user, context_item) 一行，资源打开时 upsert last_visited_at。
    与 ResourceOpenEvent（hash 化的可见率埋点，append-only）正交：本表是 per-user
    可读的「最近访问」事实表，不做 hash，可直接 join 列表。
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(
        User,
        on_delete=models.CASCADE,
        related_name='resource_accesses',
        verbose_name='访问用户',
    )
    context_item = models.ForeignKey(
        ContextItem,
        on_delete=models.CASCADE,
        related_name='accesses',
        verbose_name='资源条目',
    )
    # 不单独建 db_index：查询都带 user 维度，由下方复合索引 (user, -last_visited_at)
    # 与唯一约束 (user, context_item) 覆盖，单列索引只增写放大。
    last_visited_at = models.DateTimeField(verbose_name='最近访问时间')

    created_at = models.DateTimeField(auto_now_add=True, verbose_name='首次访问时间')

    class Meta:
        db_table = 'tabtinspace_resource_access'
        verbose_name = '资源访问记录'
        verbose_name_plural = '资源访问记录'
        constraints = [
            # 每个用户对每个资源只保留一行最近访问；upsert 的冲突键。
            models.UniqueConstraint(
                fields=['user', 'context_item'],
                name='uniq_resource_access_user_item',
            ),
        ]
        indexes = [
            # 「我最近访问的资源」倒序列表。
            models.Index(
                fields=['user', '-last_visited_at'],
                name='res_access_user_visited_idx',
            ),
        ]

    def __str__(self):
        return f"{self.user_id} -> {self.context_item_id} @ {self.last_visited_at}"


class SpacePermission(ResourcePermission):
    """Workspace 资源级权限（表名历史保留；继承 ResourcePermission 统一基类）"""

    workspace = models.ForeignKey(
        Workspace,
        on_delete=models.CASCADE,
        related_name='permissions',
        verbose_name='所属 Workspace',
    )

    class Meta(ResourcePermission.Meta):
        db_table = 'tabtinspace_space_permission'
        verbose_name = 'Workspace 权限'
        verbose_name_plural = 'Workspace 权限'
        constraints = [
            models.UniqueConstraint(
                fields=['workspace', 'subject_type', 'subject_id'],
                name='ctx_wp_unique_subject',
            ),
        ]
        indexes = [
            models.Index(fields=['workspace', 'is_active'], name='ctx_wp_ws_active_idx'),
            models.Index(fields=['subject_type', 'subject_id'], name='ctx_sp_subject_idx'),
        ]

    def __str__(self):
        return f"{self.subject_type}:{self.subject_id}={self.permission} on {self.workspace_id}"


class OrganizationInvitation(models.Model):
    """组织邀请"""

    INVITE_TYPE_CHOICES = [
        ('email', '邮件邀请'),
        ('link', '链接邀请'),
        ('direct', '直接邀请'),
        ('phone', '手机号邀请'),
    ]
    TARGETED_INVITE_TYPES = ('direct', 'phone')
    STATUS_CHOICES = [
        ('pending', '待接受'),
        ('accepted', '已接受'),
        ('rejected', '已拒绝'),
        ('expired', '已过期'),
        ('cancelled', '已取消'),
    ]
    ROLE_CHOICES = [
        ('admin', '管理员'),
        ('editor', '编辑者'),
        ('viewer', '查看者'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    organization = models.ForeignKey(
        Organization,
        on_delete=models.CASCADE,
        related_name='invitations',
        verbose_name='组织',
    )
    invited_by = models.CharField(max_length=64, verbose_name='邀请人 ID')
    invite_type = models.CharField(max_length=10, choices=INVITE_TYPE_CHOICES, verbose_name='邀请类型')
    email = models.EmailField(null=True, blank=True, verbose_name='被邀请邮箱')
    invited_user_id = models.CharField(
        max_length=64, blank=True, default='',
        verbose_name='被邀请用户 ID',
        help_text='direct / phone 类型邀请时填写目标用户 ID',
    )
    invite_phone = models.CharField(
        max_length=32, blank=True, default='',
        verbose_name='邀请手机号',
        help_text='phone 类型邀请时保留管理员输入的手机号，供列表展示',
    )
    role = models.CharField(max_length=20, choices=ROLE_CHOICES, default='viewer', verbose_name='授予角色')
    token = models.CharField(max_length=64, unique=True, db_index=True, verbose_name='邀请令牌')
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default='pending', verbose_name='状态')
    expires_at = models.DateTimeField(verbose_name='过期时间')
    accepted_by = models.CharField(max_length=64, blank=True, default='', verbose_name='接受者 ID',
                                   help_text='已弃用，仅保留兼容。多次接受记录见 accepted_users。')
    accepted_at = models.DateTimeField(null=True, blank=True, verbose_name='接受时间')
    accepted_users = models.JSONField(default=list, blank=True, verbose_name='接受记录',
                                      help_text='[{user_id, accepted_at}, ...]，追加模式')
    max_uses = models.IntegerField(default=1, verbose_name='最大使用次数', help_text='-1 表示无限制')
    use_count = models.IntegerField(default=0, verbose_name='已使用次数')
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'tabtinspace_organization_invitation'
        verbose_name = '组织邀请'
        verbose_name_plural = '组织邀请'
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['organization', 'status'], name='ctx_inv_ws_status_idx'),
            models.Index(fields=['email', 'status'], name='ctx_inv_email_status_idx'),
            models.Index(fields=['expires_at'], name='ctx_inv_expires_idx'),
            models.Index(fields=['organization', 'email', 'invite_type', 'status'],
                         name='ctx_inv_composite_idx'),
            models.Index(fields=['invited_user_id', 'status'],
                         name='ctx_inv_user_status_idx'),
        ]

    def __str__(self):
        target = self.email or self.invite_phone or self.invited_user_id or 'link'
        return f"Invite to {self.organization.name} ({target}) [{self.status}]"


class OrganizationActivity(models.Model):
    """组织活动流"""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    organization_id = models.UUIDField(db_index=True, verbose_name='组织 ID')
    actor_id = models.CharField(max_length=64, verbose_name='操作人 ID')
    actor_name = models.CharField(max_length=100, verbose_name='操作人名称')
    action = models.CharField(max_length=30, db_index=True, verbose_name='操作')
    resource_type = models.CharField(max_length=30, db_index=True, verbose_name='资源类型')
    resource_id = models.CharField(max_length=64, verbose_name='资源 ID')
    resource_name = models.CharField(max_length=255, blank=True, verbose_name='资源名称')
    metadata = models.JSONField(default=dict, verbose_name='附加数据')
    created_at = models.DateTimeField(auto_now_add=True, db_index=True, verbose_name='创建时间')

    class Meta:
        db_table = 'tabtinspace_organization_activity'
        verbose_name = '组织活动'
        verbose_name_plural = '组织活动'
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['organization_id', 'created_at'], name='ctx_act_ws_time_idx'),
            models.Index(fields=['organization_id', 'resource_type'], name='ctx_act_ws_restype_idx'),
        ]

    def __str__(self):
        return f"{self.actor_name} {self.action} {self.resource_type}:{self.resource_name}"


class SpaceAdminActionLog(models.Model):
    """组织/智能体空间后台治理审计日志。"""

    ACTION_TYPE_CHOICES = [
        ('organization_create', '创建组织'),
        ('organization_update', '更新组织'),
        ('organization_delete', '删除组织'),
        ('space_create', '创建 Space'),
        ('space_update', '更新 Space'),
        ('space_archive', '归档 Space'),
        ('space_restore', '恢复 Space'),
        ('space_delete', '删除 Space'),
        # 团队管理
        ('member_add', '添加成员'),
        ('member_remove', '移除成员'),
        ('member_role_change', '变更成员角色'),
        ('invitation_create', '创建邀请'),
        ('invitation_accept', '接受邀请'),
        ('invitation_cancel', '取消邀请'),
        ('invitation_reject', '拒绝邀请'),
        ('ownership_transfer', '转让所有权'),
        # 资源权限
        ('permission_grant', '授予权限'),
        ('permission_revoke', '撤销权限'),
        # 资源操作
        ('resource_create', '创建资源'),
        ('resource_update', '更新资源'),
        ('resource_delete', '删除资源'),
        ('resource_share', '共享资源'),
        # Agent 配置（update_agent 字段级分类审计）
        # security 子树由 yolo PR3 单独 audit（'agent_security_update'）。
        # 其余字段按"影响范围"切粒度而不是每字段一档。
        ('agent_security_update', '更新 Agent 安全配置'),
        ('agent_profile_update', '更新 Agent 资料'),
        ('agent_prompt_update', '更新 Agent 提示词'),
        ('agent_working_dir_update', '更新 Agent 运行目录'),
        ('agent_backend_update', '更新 Agent 后端配置'),
        ('agent_capability_update', '更新 Agent 能力配置'),
        # 跨库清理
        ('user_delete_cleanup', '用户删除跨库清理'),
        # 计费/权益运营
        ('organization_wallet_recharge', '调整组织 credits'),
        ('organization_quota_grant', '发放组织扩容权益'),
        ('organization_cash_wallet_recharge', '充值组织人民币钱包'),
        ('organization_cash_purchase_credit_package', '人民币钱包购买点券包'),
        ('organization_cash_purchase_addon_package', '人民币钱包购买扩容包'),
    ]

    TARGET_TYPE_CHOICES = [
        ('organization', '组织'),
        ('space', '协作空间'),
        ('agent', 'Agent'),
        ('member', '成员'),
        ('invitation', '邀请'),
        ('table', '表格'),
        ('document', '文档'),
        ('slide', '幻灯片'),
        ('permission', '权限'),
        ('user', '用户'),
        ('entitlement', '权益'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    action_type = models.CharField(
        max_length=64,
        choices=ACTION_TYPE_CHOICES,
        db_index=True,
        verbose_name='动作类型',
    )
    target_type = models.CharField(
        max_length=32,
        choices=TARGET_TYPE_CHOICES,
        db_index=True,
        verbose_name='目标类型',
    )
    target_id = models.UUIDField(db_index=True, verbose_name='目标 ID')

    organization_id = models.UUIDField(
        null=True,
        blank=True,
        db_index=True,
        verbose_name='组织 ID',
    )
    space_id = models.UUIDField(
        null=True,
        blank=True,
        db_index=True,
        verbose_name='宿主 ID',
        help_text='#3266：软 UUID；历史 Space.id，现为 Workspace.id 或 Project.id（id-reuse）。',
    )

    operator_id = models.CharField(
        max_length=64,
        blank=True,
        default='',
        db_index=True,
        verbose_name='操作人 ID',
    )
    operator_name = models.CharField(
        max_length=255,
        blank=True,
        default='',
        verbose_name='操作人展示名',
    )

    dry_run = models.BooleanField(default=False, db_index=True, verbose_name='是否 dry-run')
    success = models.BooleanField(default=True, db_index=True, verbose_name='是否成功')
    message = models.TextField(blank=True, default='', verbose_name='结果信息')
    error_message = models.TextField(blank=True, default='', verbose_name='错误信息')

    request_payload = models.JSONField(default=dict, verbose_name='请求快照')
    result_payload = models.JSONField(default=dict, verbose_name='结果快照')

    trace_id = models.CharField(
        max_length=128,
        blank=True,
        default='',
        db_index=True,
        verbose_name='链路追踪 ID',
    )
    ip_address = models.GenericIPAddressField(
        null=True,
        blank=True,
        verbose_name='IP 地址',
    )
    user_agent = models.TextField(blank=True, default='', verbose_name='User-Agent')

    created_at = models.DateTimeField(auto_now_add=True, db_index=True, verbose_name='创建时间')

    class Meta:
        db_table = 'tabtinspace_admin_action_log'
        verbose_name = '空间后台治理动作日志'
        verbose_name_plural = '空间后台治理动作日志'
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['action_type', 'created_at'], name='ctx_admin_action_time_idx'),
            models.Index(fields=['target_type', 'target_id'], name='ctx_admin_target_idx'),
            models.Index(fields=['organization_id', 'created_at'], name='ctx_admin_ws_time_idx'),
            models.Index(fields=['space_id', 'created_at'], name='ctx_admin_space_time_idx'),
            models.Index(fields=['operator_id', 'created_at'], name='ctx_admin_operator_time_idx'),
            models.Index(fields=['success', 'created_at'], name='ctx_admin_success_time_idx'),
        ]

    def __str__(self):
        status = 'success' if self.success else 'failed'
        return f"{self.action_type} ({status}) @ {self.created_at.isoformat()}"


class SpaceActivityEvent(models.Model):
    """团队 Space 动态流事件（不可变，append-only）。

    产品决策 Q3：动态流独立建表，而非从会话/资产等现有表拼凑时间线——
    成员退出、设置变更这类事件在现有表里无处可查，且事件必须在源对象被
    删除后仍可追溯。因此本表只允许 INSERT：不提供 update 路径，删除仅限
    运维清理。

    与 ``OrganizationActivity``（organization 维度）的区别：本表以 space 为主维度，
    服务团队 Space 项目页的「动态」Tab；organization_id 仅作租户边界冗余。
    """

    class EventType(models.TextChoices):
        # 状态机：事件不可变，无流转；枚举仅约束写入来源的合法类型。
        SPACE_CREATED = 'space_created', '创建团队 Space'
        MEMBER_JOINED = 'member_joined', '成员加入'
        MEMBER_LEFT = 'member_left', '成员退出'
        MEMBER_ROLE_CHANGED = 'member_role_changed', '成员角色变更'
        ASSET_CREATED = 'asset_created', '新增资产'
        ASSET_ARCHIVED = 'asset_archived', '归档资产'
        ASSET_RESTORED = 'asset_restored', '恢复资产'
        AGENT_RUN_STARTED = 'agent_run_started', 'Agent 任务开始'
        AGENT_RUN_COMPLETED = 'agent_run_completed', 'Agent 任务完成'
        AGENT_RUN_FAILED = 'agent_run_failed', 'Agent 任务失败'
        SETTINGS_UPDATED = 'settings_updated', '设置变更'
        CHANNEL_CREATED = 'channel_created', '创建频道'
        CHANNEL_RENAMED = 'channel_renamed', '重命名频道'
        CHANNEL_ARCHIVED = 'channel_archived', '归档频道'
        TASK_CREATED = 'task_created', '创建任务'
        TASK_ASSIGNED = 'task_assigned', '指派任务'
        TASK_ACCEPTED = 'task_accepted', '接受任务'
        TASK_REJECTED = 'task_rejected', '拒绝任务'
        TASK_EXECUTION_CONFIGURED = 'task_execution_configured', '确认任务执行配置'
        TASK_REVIEW_REQUESTED = 'task_review_requested', '任务待验收'
        TASK_COMPLETED = 'task_completed', '任务验收完成'
        TASK_RESULT_PREVIEW_CHANGED = 'task_result_preview_changed', '任务结果预览可见性变更'

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    space_id = models.UUIDField(
        verbose_name='宿主 ID',
        help_text='#3266：软 UUID；历史 Space.id，现为 Workspace.id 或 Project.id（id-reuse）。',
    )
    organization_id = models.UUIDField(verbose_name='组织 ID')
    event_type = models.CharField(
        max_length=32,
        choices=EventType.choices,
        verbose_name='事件类型',
    )
    # actor 用快照字段而非 FK：事件必须在用户离队/注销后仍可展示。
    actor_user_id = models.CharField(max_length=64, blank=True, default='', verbose_name='操作人用户 ID')
    actor_name = models.CharField(max_length=100, blank=True, default='', verbose_name='操作人展示名')
    # target 同理用快照：资产/成员被删除后动态流仍要保住历史。
    target_type = models.CharField(max_length=30, blank=True, default='', verbose_name='目标类型')
    target_id = models.CharField(max_length=64, blank=True, default='', verbose_name='目标 ID')
    target_name = models.CharField(max_length=255, blank=True, default='', verbose_name='目标名称')
    metadata = models.JSONField(default=dict, verbose_name='附加数据')
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')

    class Meta:
        db_table = 'tabtinspace_space_activity_event'
        verbose_name = 'Space 动态事件'
        verbose_name_plural = 'Space 动态事件'
        ordering = ['-created_at', '-id']
        indexes = [
            # 唯一高频查询：按 space 拉时间线（等值 → 排序），无需更多索引。
            models.Index(fields=['space_id', 'created_at'], name='ctx_sae_space_time_idx'),
        ]

    def __str__(self):
        return f"[{self.event_type}] space={self.space_id} actor={self.actor_name}"


# 兼容再导出：存量 `from apps.tabtinspace.models import Agent` 继续可用。
# 新代码请 `from apps.agent.models import Agent`。
from apps.agent.models import Agent  # noqa: E402, F401
