"""
用户认证数据模型
"""

import math
import uuid
from datetime import timedelta
from django.conf import settings
from django.contrib.auth.models import AbstractBaseUser, PermissionsMixin, Permission
from django.contrib.sessions.models import Session
from django.db import models
from django.utils import timezone
from django.core.validators import RegexValidator
from django.utils.translation import gettext_lazy as _
from .managers import UserManager


def generate_uuid():
    """生成UUID字符串"""
    return str(uuid.uuid4())


class User(AbstractBaseUser, PermissionsMixin):
    """自定义用户模型"""

    # 基础字段
    id = models.CharField(max_length=36, primary_key=True, default=generate_uuid, editable=False)
    username = models.CharField(
        max_length=150,
        unique=True,
        null=True,
        blank=True,
        validators=[
            RegexValidator(
                regex=r'^[a-zA-Z0-9_]+$',
                message='用户名只能包含字母、数字和下划线'
            )
        ],
        verbose_name='用户名',
        help_text='用于@username主页标识，可选'
    )
    email = models.EmailField(unique=True, null=True, blank=True, verbose_name='邮箱')
    phone = models.CharField(
        max_length=20,
        unique=True,
        null=True,
        blank=True,
        validators=[
            RegexValidator(
                regex=r'^\+?[1-9]\d{6,14}$',
                message=_('请输入有效的手机号码'),
            )
        ],
        verbose_name='手机号'
    )

    # 个人信息
    nickname = models.CharField(max_length=50, blank=True, null=True, verbose_name='昵称')
    nickname_pinyin = models.CharField(
        max_length=300,
        blank=True,
        default='',
        verbose_name='昵称全拼搜索键',
    )
    nickname_pinyin_initials = models.CharField(
        max_length=50,
        blank=True,
        default='',
        verbose_name='昵称拼音首字母搜索键',
    )
    avatar = models.CharField(
        max_length=500,
        blank=True,
        verbose_name='头像文件引用',
        help_text='优先保存 OSS object key / FileRecord.file_key；旧完整 URL 仅作兼容',
    )
    profile_revision = models.PositiveBigIntegerField(
        default=0,
        verbose_name='公开资料版本',
        help_text='昵称、用户名或头像更新时单调递增，供跨端缓存拒绝旧资料。',
    )
    bio = models.TextField(blank=True, verbose_name='个人简介')

    # 状态字段
    is_active = models.BooleanField(default=True, verbose_name='是否激活')
    is_staff = models.BooleanField(default=False, verbose_name='是否为员工')
    is_verified_email = models.BooleanField(default=False, verbose_name='邮箱是否验证')
    is_verified_phone = models.BooleanField(default=False, verbose_name='手机是否验证')

    # 时间字段
    date_joined = models.DateTimeField(auto_now_add=True, verbose_name='注册时间')
    last_login = models.DateTimeField(null=True, blank=True, verbose_name='最后登录时间')

    # 统计字段
    login_count = models.PositiveIntegerField(default=0, verbose_name='登录次数')
    failed_login_attempts = models.PositiveIntegerField(default=0, verbose_name='登录失败次数')
    last_failed_login = models.DateTimeField(null=True, blank=True, verbose_name='最后失败登录时间')

    # 使用自定义管理器
    objects = UserManager()

    # 设置登录字段
    USERNAME_FIELD = 'email'  # 默认使用邮箱登录
    REQUIRED_FIELDS = []  # 创建超级用户时需要的额外字段

    class Meta:
        db_table = 'users_auth_user'
        verbose_name = '用户'
        verbose_name_plural = '用户'
        ordering = ['-date_joined']
        indexes = [
            models.Index(fields=['email']),
            models.Index(fields=['phone']),
            models.Index(fields=['username']),
            models.Index(fields=['is_active', 'date_joined']),
        ]

    def __str__(self):
        return self.get_display_name()

    def save(self, *args, **kwargs):
        """归一化手机号，并维护中文昵称的拼音搜索键。"""
        update_fields = kwargs.get('update_fields')
        if self.phone and (update_fields is None or 'phone' in update_fields):
            from .phone import canonicalize_phone

            canonical = canonicalize_phone(self.phone)
            if canonical:
                self.phone = canonical
        if update_fields is None or 'nickname' in update_fields:
            from .pinyin_search import build_pinyin_search_keys

            self.nickname_pinyin, self.nickname_pinyin_initials = build_pinyin_search_keys(
                self.nickname or ''
            )
            if update_fields is not None:
                kwargs['update_fields'] = set(update_fields) | {
                    'nickname_pinyin',
                    'nickname_pinyin_initials',
                }
        super().save(*args, **kwargs)

    def get_display_name(self):
        """获取显示名称"""
        if self.nickname:
            return self.nickname
        elif self.username:
            return f"@{self.username}"
        elif self.email:
            return self.email.split('@')[0]
        elif self.phone:
            return f"{self.phone[:3]}****{self.phone[-4:]}"
        else:
            return f"用户{str(self.id)[:8]}"

    def get_short_name(self):
        """获取短名称"""
        return self.get_display_name()

    def get_full_name(self):
        """获取全名"""
        return self.get_display_name()

    def has_usable_password(self):
        """检查是否有可用密码"""
        # 验证码自动注册的历史账号曾把 password 留成空字符串。Django 只把
        # `!` 前缀识别为不可用密码，但空字符串同样无法通过 check_password，
        # 因此这里统一把两种“没有密码”的存量形态归一为 False。
        return bool(self.password) and super().has_usable_password()

    def increment_login_count(self):
        """增加登录次数（原子更新）"""
        from django.db.models import F
        User.objects.filter(id=self.id).update(
            login_count=F('login_count') + 1,
            last_login=timezone.now(),
            failed_login_attempts=0,
            last_failed_login=None,
        )
        self.refresh_from_db(fields=[
            'login_count', 'last_login', 'failed_login_attempts', 'last_failed_login',
        ])

    def increment_failed_login(self):
        """增加登录失败次数（原子更新）"""
        from django.db.models import F

        # 过期锁定代表上一个失败周期已经结束。必须先清零再计本次失败，
        # 否则第 5 次失败在 30 分钟后仍会保留，下一次错误会从 6 开始并立即续锁。
        self.reset_expired_login_lockout()
        User.objects.filter(id=self.id).update(
            failed_login_attempts=F('failed_login_attempts') + 1,
            last_failed_login=timezone.now(),
        )
        self.refresh_from_db(fields=['failed_login_attempts', 'last_failed_login'])

    @staticmethod
    def login_attempt_limit():
        """返回密码登录失败阈值，统一使用服务端配置。"""
        return max(1, int(getattr(settings, 'LOGIN_ATTEMPT_LIMIT', 5)))

    @staticmethod
    def account_lockout_duration_seconds():
        """返回账号锁定窗口秒数，统一使用服务端配置。"""
        return max(0, int(getattr(settings, 'ACCOUNT_LOCKOUT_DURATION', 1800)))

    def account_lockout_remaining_seconds(self, *, now=None):
        """返回当前锁定剩余秒数；未锁定或锁定已到期时返回 0。"""
        if self.failed_login_attempts < self.login_attempt_limit() or not self.last_failed_login:
            return 0

        duration = self.account_lockout_duration_seconds()
        if duration <= 0:
            return 0

        current_time = now or timezone.now()
        elapsed = max(0.0, (current_time - self.last_failed_login).total_seconds())
        return max(0, min(duration, math.ceil(duration - elapsed)))

    def reset_expired_login_lockout(self, *, now=None):
        """原子结束已经到期的失败周期，避免下一次错误立即续锁。"""
        if self.failed_login_attempts < self.login_attempt_limit():
            return False

        from django.db.models import Q

        current_time = now or timezone.now()
        duration = self.account_lockout_duration_seconds()
        cutoff = current_time - timedelta(seconds=duration)
        if self.last_failed_login and duration > 0 and self.last_failed_login > cutoff:
            return False

        updated = User.objects.filter(
            id=self.id,
            failed_login_attempts__gte=self.login_attempt_limit(),
        ).filter(
            Q(last_failed_login__isnull=True) | Q(last_failed_login__lte=cutoff),
        ).update(
            failed_login_attempts=0,
            last_failed_login=None,
        )
        self.refresh_from_db(fields=['failed_login_attempts', 'last_failed_login'])
        return updated > 0

    def reset_login_failures(self):
        """清理密码登录失败状态，供成功登录、验证码登录和密码重置复用。"""
        User.objects.filter(id=self.id).update(
            failed_login_attempts=0,
            last_failed_login=None,
        )
        self.failed_login_attempts = 0
        self.last_failed_login = None

    def is_account_locked(self):
        """检查账号是否被锁定"""
        return self.account_lockout_remaining_seconds() > 0

    def verify_email(self):
        """验证邮箱"""
        self.is_verified_email = True
        self.save(update_fields=['is_verified_email'])

    def verify_phone(self):
        """验证手机号"""
        self.is_verified_phone = True
        self.save(update_fields=['is_verified_phone'])


class IntentUser(models.Model):
    """手机号预约意向用户。"""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    phone = models.CharField(
        max_length=20,
        unique=True,
        validators=[
            RegexValidator(
                regex=r'^\+?[1-9]\d{6,14}$',
                message=_('请输入有效的手机号码'),
            )
        ],
        verbose_name='手机号',
    )
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='预约时间')

    class Meta:
        db_table = 'users_auth_intent_user'
        verbose_name = '意向用户'
        verbose_name_plural = '意向用户'
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['created_at'], name='intent_user_created_at'),
        ]

    def save(self, *args, **kwargs):
        """入库时中国大陆手机号去掉 +86，统一存 11 位。"""
        update_fields = kwargs.get('update_fields')
        if self.phone and (update_fields is None or 'phone' in update_fields):
            from .phone import canonicalize_phone

            canonical = canonicalize_phone(self.phone)
            if canonical:
                self.phone = canonical
        super().save(*args, **kwargs)

    def __str__(self):
        return self.phone


class AdminAccount(models.Model):
    """AdminDash 后台操作者账号，不改变客户端 User 语义。"""

    STATUS_ACTIVE = 'active'
    STATUS_DISABLED = 'disabled'
    STATUS_LOCKED = 'locked'
    STATUS_CHOICES = [
        (STATUS_ACTIVE, '启用'),
        (STATUS_DISABLED, '禁用'),
        (STATUS_LOCKED, '锁定'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.OneToOneField(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name='admin_account',
        verbose_name='关联用户',
    )
    display_name = models.CharField(max_length=100, blank=True, default='', verbose_name='后台显示名')
    employee_no = models.CharField(max_length=64, blank=True, default='', db_index=True, verbose_name='员工编号')
    department = models.CharField(max_length=100, blank=True, default='', db_index=True, verbose_name='部门')
    position = models.CharField(max_length=100, blank=True, default='', verbose_name='岗位')
    status = models.CharField(
        max_length=20,
        choices=STATUS_CHOICES,
        default=STATUS_ACTIVE,
        db_index=True,
        verbose_name='后台账号状态',
    )
    admin_login_enabled = models.BooleanField(default=True, db_index=True, verbose_name='允许后台登录')
    last_admin_login_at = models.DateTimeField(null=True, blank=True, verbose_name='最近后台登录时间')
    last_admin_login_ip = models.GenericIPAddressField(null=True, blank=True, verbose_name='最近后台登录 IP')
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='created_admin_accounts',
        verbose_name='创建人',
    )
    disabled_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='disabled_admin_accounts',
        verbose_name='禁用人',
    )
    disabled_reason = models.CharField(max_length=500, blank=True, default='', verbose_name='禁用原因')
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'users_auth_admin_account'
        verbose_name = '后台账号'
        verbose_name_plural = '后台账号'
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['status', 'admin_login_enabled'], name='admin_account_status_login'),
            models.Index(fields=['department', 'status'], name='admin_account_dept_status'),
        ]

    def __str__(self):
        return self.display_name or str(self.user_id)

    @property
    def is_active_for_admin(self) -> bool:
        return self.admin_login_enabled and self.status == self.STATUS_ACTIVE


class AdminPermission(models.Model):
    """AdminDash 权限点。"""

    RISK_LOW = 'low'
    RISK_MEDIUM = 'medium'
    RISK_HIGH = 'high'
    RISK_CRITICAL = 'critical'

    RISK_LEVEL_CHOICES = [
        (RISK_LOW, '低风险'),
        (RISK_MEDIUM, '中风险'),
        (RISK_HIGH, '高风险'),
        (RISK_CRITICAL, '极高风险'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    code = models.CharField(max_length=128, unique=True, verbose_name='权限编码')
    name = models.CharField(max_length=100, verbose_name='权限名称')
    category = models.CharField(max_length=64, db_index=True, verbose_name='权限分类')
    risk_level = models.CharField(
        max_length=20,
        choices=RISK_LEVEL_CHOICES,
        default=RISK_LOW,
        db_index=True,
        verbose_name='风险等级',
    )
    description = models.CharField(max_length=255, blank=True, default='', verbose_name='说明')
    is_active = models.BooleanField(default=True, db_index=True, verbose_name='是否启用')
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'users_auth_admin_permission'
        verbose_name = '后台权限点'
        verbose_name_plural = '后台权限点'
        ordering = ['category', 'code']
        indexes = [
            models.Index(fields=['category', 'is_active'], name='admin_perm_category_active'),
            models.Index(fields=['risk_level', 'is_active'], name='admin_perm_risk_active'),
        ]

    def __str__(self):
        return self.code


class AdminRole(models.Model):
    """AdminDash 角色。"""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    code = models.CharField(max_length=64, unique=True, verbose_name='角色编码')
    name = models.CharField(max_length=100, verbose_name='角色名称')
    description = models.CharField(max_length=255, blank=True, default='', verbose_name='说明')
    is_system = models.BooleanField(default=False, db_index=True, verbose_name='系统内置')
    is_active = models.BooleanField(default=True, db_index=True, verbose_name='是否启用')
    permissions = models.ManyToManyField(
        AdminPermission,
        through='AdminRolePermission',
        related_name='roles',
        verbose_name='权限点',
    )
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'users_auth_admin_role'
        verbose_name = '后台角色'
        verbose_name_plural = '后台角色'
        ordering = ['code']
        indexes = [
            models.Index(fields=['is_active', 'is_system'], name='admin_role_active_system'),
        ]

    def __str__(self):
        return self.code


class AdminRolePermission(models.Model):
    """AdminDash 角色与权限点关系。"""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    role = models.ForeignKey(AdminRole, on_delete=models.CASCADE, related_name='role_permissions')
    permission = models.ForeignKey(
        AdminPermission,
        on_delete=models.CASCADE,
        related_name='role_permissions',
    )
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')

    class Meta:
        db_table = 'users_auth_admin_role_permission'
        verbose_name = '后台角色权限关系'
        verbose_name_plural = '后台角色权限关系'
        constraints = [
            models.UniqueConstraint(
                fields=['role', 'permission'],
                name='uniq_admin_role_permission',
            ),
        ]

    def __str__(self):
        return f'{self.role_id}:{self.permission_id}'


class AdminAccountRole(models.Model):
    """AdminDash 后台账号与角色关系。"""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    admin_account = models.ForeignKey(
        AdminAccount,
        on_delete=models.CASCADE,
        related_name='role_assignments',
        verbose_name='后台账号',
    )
    role = models.ForeignKey(AdminRole, on_delete=models.CASCADE, related_name='account_assignments')
    assigned_by_admin_account = models.ForeignKey(
        AdminAccount,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='assigned_account_roles',
        verbose_name='分配后台账号',
    )
    reason = models.CharField(max_length=500, blank=True, default='', verbose_name='分配原因')
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')

    class Meta:
        db_table = 'users_auth_admin_account_role'
        verbose_name = '后台账号角色关系'
        verbose_name_plural = '后台账号角色关系'
        constraints = [
            models.UniqueConstraint(
                fields=['admin_account', 'role'],
                name='uniq_admin_account_role',
            ),
        ]

    def __str__(self):
        return f'{self.admin_account_id}:{self.role_id}'


class AdminUserRole(models.Model):
    """兼容旧后台用户角色关系；新逻辑使用 AdminAccountRole。"""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name='admin_role_assignments',
    )
    role = models.ForeignKey(AdminRole, on_delete=models.CASCADE, related_name='user_assignments')
    assigned_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='assigned_admin_roles',
        verbose_name='分配人',
    )
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')

    class Meta:
        db_table = 'users_auth_admin_user_role'
        verbose_name = '后台用户角色关系'
        verbose_name_plural = '后台用户角色关系'
        constraints = [
            models.UniqueConstraint(fields=['user', 'role'], name='uniq_admin_user_role'),
        ]

    def __str__(self):
        return f'{self.user_id}:{self.role_id}'


class AdminLoginLog(models.Model):
    """AdminDash 后台登录日志。"""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    admin_account = models.ForeignKey(
        AdminAccount,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='login_logs',
        verbose_name='后台账号',
    )
    user_id = models.CharField(max_length=36, blank=True, default='', db_index=True, verbose_name='User ID')
    ip = models.GenericIPAddressField(null=True, blank=True, verbose_name='IP 地址')
    user_agent = models.TextField(blank=True, default='', verbose_name='User-Agent')
    login_method = models.CharField(max_length=32, blank=True, default='', db_index=True, verbose_name='登录方式')
    success = models.BooleanField(default=True, db_index=True, verbose_name='是否成功')
    fail_reason = models.CharField(max_length=255, blank=True, default='', verbose_name='失败原因')
    created_at = models.DateTimeField(auto_now_add=True, db_index=True, verbose_name='创建时间')

    class Meta:
        db_table = 'users_auth_admin_login_log'
        verbose_name = '后台登录日志'
        verbose_name_plural = '后台登录日志'
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['admin_account', 'created_at'], name='admin_login_account_time'),
            models.Index(fields=['success', 'created_at'], name='admin_login_success_time'),
        ]

    def __str__(self):
        return f'{self.user_id}:{self.success}:{self.created_at}'


class AdminSensitiveActionLog(models.Model):
    """AdminDash 敏感操作审计。"""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    actor_user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='admin_sensitive_action_logs',
        verbose_name='操作人',
    )
    actor_admin_account = models.ForeignKey(
        AdminAccount,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='sensitive_action_logs',
        verbose_name='操作后台账号',
    )
    permission_code = models.CharField(max_length=128, db_index=True, verbose_name='权限点')
    action = models.CharField(max_length=128, blank=True, default='', db_index=True, verbose_name='操作动作')
    target_type = models.CharField(max_length=64, db_index=True, verbose_name='目标类型')
    target_id = models.CharField(max_length=128, blank=True, default='', db_index=True, verbose_name='目标 ID')
    reason = models.CharField(max_length=500, verbose_name='操作原因')
    ticket_id = models.CharField(max_length=128, blank=True, default='', db_index=True, verbose_name='工单 ID')
    related_billing_event_id = models.CharField(
        max_length=128,
        blank=True,
        default='',
        db_index=True,
        verbose_name='关联计费事件',
    )
    related_wallet_transaction_id = models.CharField(
        max_length=128,
        blank=True,
        default='',
        db_index=True,
        verbose_name='关联钱包流水',
    )
    before_json = models.JSONField(default=dict, blank=True, verbose_name='变更前')
    after_json = models.JSONField(default=dict, blank=True, verbose_name='变更后')
    ip = models.GenericIPAddressField(null=True, blank=True, verbose_name='IP 地址')
    user_agent = models.TextField(blank=True, default='', verbose_name='User-Agent')
    request_id = models.CharField(max_length=128, blank=True, default='', db_index=True, verbose_name='请求 ID')
    created_at = models.DateTimeField(auto_now_add=True, db_index=True, verbose_name='创建时间')

    class Meta:
        db_table = 'users_auth_admin_sensitive_action_log'
        verbose_name = '后台敏感操作审计'
        verbose_name_plural = '后台敏感操作审计'
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['permission_code', 'created_at'], name='admin_action_perm_created'),
            models.Index(fields=['target_type', 'target_id'], name='admin_action_target'),
            models.Index(fields=['actor_admin_account', 'created_at'], name='admin_action_account_time'),
        ]

    def __str__(self):
        return f'{self.permission_code}:{self.target_type}:{self.target_id}'


class AdminOperationLog(models.Model):
    """AdminDash 普通操作日志，用于非敏感操作的可追溯记录。"""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    actor_admin_account = models.ForeignKey(
        AdminAccount,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='operation_logs',
        verbose_name='操作后台账号',
    )
    actor_user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='admin_operation_logs',
        verbose_name='操作用户',
    )
    action = models.CharField(max_length=128, db_index=True, verbose_name='操作动作')
    target_type = models.CharField(max_length=64, blank=True, default='', db_index=True, verbose_name='目标类型')
    target_id = models.CharField(max_length=128, blank=True, default='', db_index=True, verbose_name='目标 ID')
    detail_json = models.JSONField(default=dict, blank=True, verbose_name='详情')
    ip = models.GenericIPAddressField(null=True, blank=True, verbose_name='IP 地址')
    user_agent = models.TextField(blank=True, default='', verbose_name='User-Agent')
    request_id = models.CharField(max_length=128, blank=True, default='', db_index=True, verbose_name='请求 ID')
    created_at = models.DateTimeField(auto_now_add=True, db_index=True, verbose_name='创建时间')

    class Meta:
        db_table = 'users_auth_admin_operation_log'
        verbose_name = '后台操作日志'
        verbose_name_plural = '后台操作日志'
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['action', 'created_at'], name='admin_op_action_time'),
            models.Index(fields=['target_type', 'target_id'], name='admin_op_target'),
        ]

    def __str__(self):
        return f'{self.action}:{self.target_type}:{self.target_id}'


class RegistrationInviteCode(models.Model):
    """内测注册邀请码。"""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    code = models.CharField(max_length=64, unique=True, db_index=True, verbose_name='邀请码')
    description = models.CharField(max_length=255, blank=True, default='', verbose_name='描述')
    channel = models.CharField(max_length=64, blank=True, default='', db_index=True, verbose_name='渠道')
    campaign = models.CharField(max_length=64, blank=True, default='', db_index=True, verbose_name='活动/批次')
    is_active = models.BooleanField(default=True, db_index=True, verbose_name='是否启用')
    starts_at = models.DateTimeField(null=True, blank=True, verbose_name='生效时间')
    expires_at = models.DateTimeField(null=True, blank=True, db_index=True, verbose_name='过期时间')
    usage_limit = models.PositiveIntegerField(null=True, blank=True, verbose_name='使用次数上限')
    used_count = models.PositiveIntegerField(default=0, verbose_name='已使用次数')
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='created_registration_invite_codes',
        verbose_name='创建人',
    )
    disabled_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='disabled_registration_invite_codes',
        verbose_name='停用人',
    )
    disabled_at = models.DateTimeField(null=True, blank=True, verbose_name='停用时间')
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'users_auth_registration_invite_code'
        verbose_name = '注册邀请码'
        verbose_name_plural = '注册邀请码'
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['is_active', 'expires_at'], name='reg_invite_active_exp'),
            models.Index(fields=['channel', 'campaign'], name='reg_invite_channel_campaign'),
            models.Index(fields=['created_at'], name='reg_invite_created_at'),
        ]

    def __str__(self):
        return self.code

    @property
    def remaining_uses(self) -> int | None:
        if self.usage_limit is None:
            return None
        return max(int(self.usage_limit) - int(self.used_count), 0)

    @property
    def is_expired(self) -> bool:
        return bool(self.expires_at and self.expires_at <= timezone.now())


class RegistrationInviteRedemption(models.Model):
    """注册邀请码使用记录。"""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    invite_code = models.ForeignKey(
        RegistrationInviteCode,
        on_delete=models.PROTECT,
        related_name='redemptions',
        verbose_name='邀请码',
    )
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name='registration_invite_redemptions',
        verbose_name='注册用户',
    )
    identifier_hash = models.CharField(max_length=64, blank=True, default='', db_index=True, verbose_name='注册标识哈希')
    entrypoint = models.CharField(max_length=32, blank=True, default='', db_index=True, verbose_name='注册入口')
    ip_address = models.GenericIPAddressField(null=True, blank=True, verbose_name='IP 地址')
    user_agent = models.TextField(blank=True, default='', verbose_name='User-Agent')
    consumed_at = models.DateTimeField(auto_now_add=True, db_index=True, verbose_name='使用时间')

    class Meta:
        db_table = 'users_auth_registration_invite_redemption'
        verbose_name = '注册邀请码使用记录'
        verbose_name_plural = '注册邀请码使用记录'
        ordering = ['-consumed_at']
        constraints = [
            models.UniqueConstraint(
                fields=['invite_code', 'user'],
                name='uniq_registration_invite_user',
            ),
        ]
        indexes = [
            models.Index(fields=['entrypoint', 'consumed_at'], name='reg_invite_red_entry_time'),
            models.Index(fields=['invite_code', 'consumed_at'], name='reg_invite_red_code_time'),
        ]

    def __str__(self):
        return f"{self.invite_code.code} -> {self.user_id}"


class UserProfile(models.Model):
    """用户配置模型"""

    THEME_CHOICES = [
        ('light', '浅色主题'),
        ('dark', '深色主题'),
        ('auto', '自动切换'),
    ]

    LANGUAGE_CHOICES = [
        ('system', '跟随系统'),
        ('zh-CN', '简体中文'),
        ('zh-TW', '繁體中文'),
        ('en-US', 'English'),
        ('ja-JP', '日本語'),
        ('ko-KR', '한국어'),
        ('de-DE', 'Deutsch'),
        ('fr-FR', 'Français'),
        ('es-ES', 'Español'),
    ]

    user = models.OneToOneField(
        User,
        on_delete=models.CASCADE,
        related_name='profile',
        verbose_name='用户'
    )

    # 隐私设置
    is_public_profile = models.BooleanField(default=True, verbose_name='公开资料')
    allow_email_notifications = models.BooleanField(default=True, verbose_name='允许邮件通知')
    allow_sms_notifications = models.BooleanField(default=True, verbose_name='允许短信通知')

    # 个性化设置
    timezone = models.CharField(max_length=50, default='Asia/Shanghai', verbose_name='时区')
    language = models.CharField(
        max_length=10,
        choices=LANGUAGE_CHOICES,
        default='system',
        verbose_name='语言'
    )
    theme = models.CharField(
        max_length=20,
        choices=THEME_CHOICES,
        default='light',
        verbose_name='主题'
    )

    # 业务设置
    homepage_template = models.CharField(max_length=50, default='default', verbose_name='主页模板')
    max_collections = models.PositiveIntegerField(default=100, verbose_name='最大收藏数')

    # 审批偏好（跨设备同步）
    # 格式: {actionType: {approved: bool, updatedAt: number(ms epoch)}}
    approval_preferences = models.JSONField(default=dict, blank=True, verbose_name='审批偏好')

    # UI/个人偏好（跨设备同步）— 设置 IA Phase 2
    # 格式: {namespace: {value: <任意 JSON>, updatedAt: number(ms epoch)}}
    # namespace 白名单见 api/profile_routes.py::_UI_SETTINGS_NAMESPACES
    ui_settings = models.JSONField(default=dict, blank=True, verbose_name='UI/个人偏好')

    # 个人 Agent 规则（per-User 全局，跨 Organization）— 设置 IA Phase 3 §8.6
    # 三层规则模型的「个人基线」层：用户对所有 Agent 的通用口吻 / 偏好（如「请用中文」）。
    # 运行时按 个人→团队→Agent 顺序拼进 system prompt（Agent 专属层 = Agent.custom_rules）。
    # API 上限 5000 字（与 Agent.custom_rules 对齐，见 profile_routes.PersonalRulesUpdateSchema）。
    personal_rules = models.TextField(
        blank=True, default='',
        verbose_name='个人 Agent 规则',
        help_text='对所有 Agent 生效的个人通用规则，运行时作为三层规则的个人基线层注入 system prompt。',
    )

    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'users_auth_user_profile'
        verbose_name = '用户配置'
        verbose_name_plural = '用户配置'

    def __str__(self):
        return f"{self.user.get_display_name()}的配置"


class UserAgentApprovalMemo(models.Model):
    """
    用户对某个 Agent 的"总是允许 / 总是拒绝"记忆。

    产品语义（拍板：2026-04-22 用户）：
      - 仅对 (该用户, 该 Agent) 这一对组合生效，不影响协作者跟同一 Agent 的对话；
      - 永远有效，不设过期时间（Q1=A）；
      - bash 类命令：pattern 存"整条命令字符串"，写入和匹配前都先经 normalizeCommand
        处理（trim + 多余空格折叠为单空格）。复合命令如 `npm install && npm test`
        整条作为一条记录（Q2=A）；
      - 不引入通配符 / 前缀匹配语法——pattern 是 normalizeCommand 后的精确字符串。

    跨库说明：
      - User 与 ChatSession 都在 MySQL（users_auth / conversation），可做真 FK；
      - Agent 在 PostgreSQL（tabtinspace），跨库只用 UUIDField 不做 FK，
        与 ChatSession.space 等现有"跨库 UUID 引用"模式保持一致。
    """

    RULE_KIND_ALLOW = 'allow'
    RULE_KIND_DENY = 'deny'
    RULE_KIND_CHOICES = [
        (RULE_KIND_ALLOW, '总是允许'),
        (RULE_KIND_DENY, '总是拒绝'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name='approval_memos',
        verbose_name='用户',
    )
    agent_id = models.UUIDField(
        db_index=True,
        verbose_name='Agent ID',
        help_text='指向 agent.Agent.id；跨库不做 FK',
    )

    action_type = models.CharField(
        max_length=64,
        verbose_name='动作类型',
        help_text='如 execute_in_terminal / write_file / browser_navigate 等',
    )
    pattern = models.CharField(
        max_length=512,
        verbose_name='匹配模式',
        help_text='bash 类命令 = normalizeCommand 后的整条命令字符串；'
                  '其他类型按 action_type 各自约定（不支持通配符）',
    )
    rule_kind = models.CharField(
        max_length=16,
        choices=RULE_KIND_CHOICES,
        verbose_name='规则类型',
    )

    created_in_session_id = models.UUIDField(
        null=True,
        blank=True,
        verbose_name='创建于会话 ID',
        help_text='审计用：记录这条规则是哪次对话产生的，指向 conversation.ChatSession.id。'
                  '不做 FK 的原因：users_auth 在 db_router 里被列为 _dual_db_labels，'
                  'PG 侧也建影子表；而 conversation 只在 MySQL default 库，'
                  'PG 侧没有 chat_session 表 → migrate PG 影子时 FK 创建失败。'
                  '语义上接受 dangling 引用——会话被删除时该字段保留，仅作为审计线索；'
                  'UI 渲染时若该 session 已不存在应做 fallback 文案。',
    )
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    last_matched_at = models.DateTimeField(
        null=True,
        blank=True,
        verbose_name='最后命中时间',
        help_text='find_match 命中时更新；用于 UI 展示和未来"长期未用清理"',
    )

    class Meta:
        db_table = 'users_auth_user_agent_approval_memo'
        verbose_name = '用户 Agent 审批记忆'
        verbose_name_plural = '用户 Agent 审批记忆'
        constraints = [
            models.UniqueConstraint(
                fields=['user', 'agent_id', 'action_type', 'pattern'],
                name='uniq_user_agent_action_pattern',
            ),
        ]
        indexes = [
            models.Index(
                fields=['user', 'agent_id', 'action_type'],
                name='idx_memo_user_agent_action',
            ),
        ]

    def __str__(self):
        return f"{self.user_id} → agent:{self.agent_id} / {self.action_type} / {self.rule_kind}"


class UserGroup(models.Model):
    """用户组模型"""

    GROUP_TYPE_CHOICES = [
        ('system', '系统组'),
        ('business', '业务组'),
        ('custom', '自定义组'),
    ]

    id = models.CharField(max_length=36, primary_key=True, default=generate_uuid, editable=False)
    name = models.CharField(max_length=100, unique=True, verbose_name='组名')
    description = models.TextField(blank=True, verbose_name='描述')
    group_type = models.CharField(
        max_length=20,
        choices=GROUP_TYPE_CHOICES,
        default='custom',
        verbose_name='组类型'
    )
    permissions = models.ManyToManyField(Permission, blank=True, verbose_name='权限')
    users = models.ManyToManyField(User, blank=True, related_name='user_groups', verbose_name='用户')

    # 组设置
    max_members = models.PositiveIntegerField(null=True, blank=True, verbose_name='最大成员数')
    is_active = models.BooleanField(default=True, verbose_name='是否激活')

    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'users_auth_user_group'
        verbose_name = '用户组'
        verbose_name_plural = '用户组'
        ordering = ['-created_at']

    def __str__(self):
        return self.name

    def add_user(self, user):
        """添加用户到组"""
        if self.max_members and self.users.count() >= self.max_members:
            raise ValueError(f'用户组已达到最大成员数限制：{self.max_members}')
        self.users.add(user)

    def remove_user(self, user):
        """从组中移除用户"""
        self.users.remove(user)


class UserSession(models.Model):
    """用户会话模型"""

    SESSION_TYPE_CHOICES = [
        ('web', '网页'),
        ('mobile', '移动端'),
        ('api', 'API'),
    ]

    id = models.CharField(max_length=36, primary_key=True, default=generate_uuid, editable=False)
    user = models.ForeignKey(
        User,
        on_delete=models.CASCADE,
        related_name='sessions',
        verbose_name='用户'
    )
    session_key = models.CharField(max_length=64, unique=True, verbose_name='会话密钥')
    session_type = models.CharField(
        max_length=20,
        choices=SESSION_TYPE_CHOICES,
        default='web',
        verbose_name='会话类型'
    )

    # 设备信息
    ip_address = models.GenericIPAddressField(verbose_name='IP地址')
    user_agent = models.TextField(blank=True, verbose_name='用户代理')
    device_info = models.JSONField(default=dict, verbose_name='设备信息')

    # 时间信息
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    last_activity = models.DateTimeField(auto_now=True, verbose_name='最后活动时间')
    expires_at = models.DateTimeField(verbose_name='过期时间')

    # Refresh Token 绑定（防止复用）
    refresh_token_hash = models.CharField(
        max_length=64,
        blank=True,
        null=True,
        verbose_name='刷新令牌哈希'
    )
    refresh_token_updated_at = models.DateTimeField(
        null=True,
        blank=True,
        verbose_name='刷新令牌更新时间'
    )

    is_active = models.BooleanField(default=True, verbose_name='是否激活')
    device_id = models.CharField(
        max_length=255,
        blank=True,
        default='',
        db_index=True,
        verbose_name='客户端设备标识',
        help_text='可存 Device.id 或 fingerprint；为空表示历史会话未绑定设备',
    )
    client_type = models.CharField(
        max_length=32,
        blank=True,
        default='web',
        db_index=True,
        verbose_name='客户端类型',
    )
    revoked_at = models.DateTimeField(null=True, blank=True, verbose_name='吊销时间')
    revoked_by_admin_account_id = models.CharField(
        max_length=36,
        blank=True,
        default='',
        verbose_name='吊销后台账号 ID',
    )
    revoked_reason = models.TextField(blank=True, default='', verbose_name='吊销原因')

    class Meta:
        db_table = 'users_auth_user_session'
        verbose_name = '用户会话'
        verbose_name_plural = '用户会话'
        ordering = ['-last_activity']
        indexes = [
            models.Index(fields=['user', 'is_active']),
            models.Index(fields=['session_key']),
            models.Index(fields=['expires_at']),
            models.Index(fields=['user', 'client_type'], name='users_auth__user_id_580a52_idx'),
            models.Index(fields=['revoked_at'], name='users_auth__revoked_d4f238_idx'),
        ]

    def __str__(self):
        return f"{self.user.get_display_name()} - {self.session_type}"

    def is_expired(self):
        """检查会话是否过期"""
        return timezone.now() > self.expires_at

    def extend_session(self, duration_hours=24):
        """延长会话时间"""
        self.expires_at = timezone.now() + timedelta(hours=duration_hours)
        self.save(update_fields=['expires_at'])


class UserActionLog(models.Model):
    """用户操作日志模型"""

    ACTION_TYPE_CHOICES = [
        ('login', '登录'),
        ('logout', '登出'),
        ('register', '注册'),
        ('password_change', '修改密码'),
        ('password_reset', '重置密码'),
        ('profile_update', '更新资料'),
        ('email_verify', '邮箱验证'),
        ('phone_verify', '手机验证'),
        ('avatar_upload', '上传头像'),
        ('account_lock', '账号锁定'),
        ('account_unlock', '账号解锁'),
    ]

    id = models.CharField(max_length=36, primary_key=True, default=generate_uuid, editable=False)
    user = models.ForeignKey(
        User,
        on_delete=models.CASCADE,
        related_name='action_logs',
        verbose_name='用户'
    )
    action_type = models.CharField(
        max_length=50,
        choices=ACTION_TYPE_CHOICES,
        verbose_name='操作类型'
    )
    description = models.TextField(blank=True, verbose_name='描述')

    # 请求信息
    ip_address = models.GenericIPAddressField(verbose_name='IP地址')
    user_agent = models.TextField(blank=True, verbose_name='用户代理')
    request_data = models.JSONField(default=dict, verbose_name='请求数据')

    # 结果信息
    success = models.BooleanField(default=True, verbose_name='是否成功')
    error_message = models.TextField(blank=True, verbose_name='错误信息')

    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')

    class Meta:
        db_table = 'users_auth_user_action_log'
        verbose_name = '用户操作日志'
        verbose_name_plural = '用户操作日志'
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['user', 'created_at']),
            models.Index(fields=['action_type', 'created_at']),
            models.Index(fields=['success', 'created_at']),
        ]

    def __str__(self):
        status = '成功' if self.success else '失败'
        return f"{self.user.get_display_name()} - {self.get_action_type_display()} - {status}"


# ── User API Key ──────────────────────────────────────────────────

import hashlib
import hmac
import secrets

_TOKEN_PREFIX = 'ttn_'


def _gen_key_id() -> str:
    return secrets.token_hex(6)


def _gen_key_sign() -> str:
    return secrets.token_hex(16)


def _hash_key(raw: str) -> str:
    return hashlib.sha256(raw.encode('utf-8')).hexdigest()


class UserApiKey(models.Model):
    """
    Personal Access Token — CLI / Daemon / CI / 第三方集成的长期认证凭据。

    格式: ttn_{key_id}_{key_sign}
    key_sign 仅在创建时返回明文,之后只存 SHA-256 hash。
    独立于 JWT session，等价于用户本人登录。

    organization_id 可选：为空时可操作用户所有组织（同 JWT）；
    填写后限定仅能操作该组织，计费也固定归属于此。
    """

    PLATFORM_SCOPES = [
        ('*', '完全访问'),
        ('account:*', '账号管理'),
        ('account:read', '账号信息只读'),
        ('agent:*', 'Agent 对话'),
        ('space:read', 'Space 只读'),
        ('space:write', 'Space 读写'),
        ('tabdata:*', 'TabData 完全访问'),
        ('tabdata:read', 'TabData 只读'),
        ('tabdoc:*', 'TabDoc 完全访问'),
        ('tabslide:*', 'TabSlide 完全访问'),
        ('code:*', '代码操作'),
        ('browser:*', '浏览器操作'),
        ('media:*', '媒体生成'),
        ('fn:*', '云函数'),
    ]

    id = models.CharField(max_length=36, primary_key=True, default=generate_uuid, editable=False)
    user = models.ForeignKey(
        User,
        on_delete=models.CASCADE,
        related_name='api_keys',
        verbose_name='用户',
    )
    organization_id = models.CharField(
        max_length=36,
        blank=True,
        default='',
        db_index=True,
        verbose_name='限定组织',
        help_text='为空时等价于用户本人登录（可操作所有组织）；填写后仅限该组织',
    )
    name = models.CharField(max_length=100, verbose_name='名称')
    description = models.TextField(blank=True, default='', verbose_name='描述')

    key_id = models.CharField(max_length=16, unique=True, db_index=True, verbose_name='Key 标识')
    sign_hash = models.CharField(max_length=64, verbose_name='签名 Hash')

    scopes = models.JSONField(default=list, verbose_name='权限范围')
    rate_limit = models.PositiveIntegerField(default=60, verbose_name='限流(次/分钟)')

    expired_at = models.DateTimeField(null=True, blank=True, verbose_name='过期时间')
    is_active = models.BooleanField(default=True, verbose_name='是否启用')

    last_used_at = models.DateTimeField(null=True, blank=True, verbose_name='最后使用时间')
    use_count = models.PositiveIntegerField(default=0, verbose_name='使用次数')

    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'users_auth_user_api_key'
        verbose_name = 'API Key'
        verbose_name_plural = 'API Key'
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['user', 'is_active']),
            models.Index(fields=['key_id']),
            models.Index(fields=['organization_id', 'is_active']),
        ]

    def __str__(self):
        return f"{self.name} ({_TOKEN_PREFIX}{self.key_id}...) [wt:{self.organization_id[:8]}]"

    @classmethod
    def create_key(cls, user, name: str, organization_id: str = '',
                   scopes: list = None,
                   description: str = '', rate_limit: int = 60,
                   expired_at=None):
        """创建新 Key。返回 (instance, plain_key) — plain_key 仅此时可得。"""
        key_id = _gen_key_id()
        sign = _gen_key_sign()
        plain_key = f"{_TOKEN_PREFIX}{key_id}_{sign}"

        instance = cls(
            user=user,
            organization_id=organization_id or '',
            name=name,
            description=description,
            key_id=key_id,
            sign_hash=_hash_key(sign),
            scopes=scopes or ['*'],
            rate_limit=rate_limit,
            expired_at=expired_at,
        )
        instance.save(using='default')
        return instance, plain_key

    @classmethod
    def verify_key(cls, raw_key: str):
        """
        验证 Key。返回 (key_instance, user) 或 None。
        """
        if not raw_key or not raw_key.startswith(_TOKEN_PREFIX):
            return None

        body = raw_key[len(_TOKEN_PREFIX):]
        parts = body.split('_', 1)
        if len(parts) != 2:
            return None

        key_id, sign = parts

        try:
            key = cls.objects.using('default').get(key_id=key_id, is_active=True)
        except cls.DoesNotExist:
            return None

        if not hmac.compare_digest(key.sign_hash, _hash_key(sign)):
            return None

        if key.expired_at and key.expired_at < timezone.now():
            return None

        try:
            user = User.objects.using('default').get(id=key.user_id, is_active=True)
        except User.DoesNotExist:
            return None

        cls.objects.using('default').filter(pk=key.pk).update(
            last_used_at=timezone.now(),
            use_count=models.F('use_count') + 1,
        )

        return key, user

    def mask_key_id(self) -> str:
        return f"{_TOKEN_PREFIX}{self.key_id}..."

    def has_scope(self, required_scope: str) -> bool:
        if '*' in self.scopes:
            return True
        if required_scope in self.scopes:
            return True
        prefix = required_scope.split(':')[0] + ':*'
        return prefix in self.scopes
