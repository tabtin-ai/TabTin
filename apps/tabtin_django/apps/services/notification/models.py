"""
团队通知模型
"""
import uuid
from django.db import models


class Notification(models.Model):
    """应用内通知"""

    TYPE_CHOICES = [
        ('invite_received', '收到邀请'),
        ('invite_accepted', '邀请被接受'),
        ('member_added', '被添加为成员'),
        ('member_removed', '被移除'),
        ('role_changed', '角色变更'),
        ('ownership_transfer', '所有权转让'),
        ('resource_shared', '资源被共享'),
        ('resource_access_request', '资源访问申请'),
        ('quota_warning', '配额预警'),
        ('balance_low', '余额不足预警'),
        ('cash_recharged', '现金钱包充值到账'),
        ('trash_expiry_warning', '回收站过期预警'),
        ('system', '系统通知'),
        ('extension_event', 'Extension 事件通知'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user_id = models.CharField(max_length=64, db_index=True, verbose_name='接收用户 ID')
    organization_id = models.CharField(
        max_length=64, blank=True, default='', db_index=True, verbose_name='关联组织 ID',
    )
    type = models.CharField(max_length=50, choices=TYPE_CHOICES, verbose_name='通知类型')
    title = models.CharField(max_length=255, verbose_name='标题')
    body = models.TextField(blank=True, default='', verbose_name='正文')
    metadata = models.JSONField(default=dict, verbose_name='附加数据')
    source_event_id = models.CharField(max_length=100, blank=True, default='', verbose_name='来源事件ID')
    dedupe_key = models.CharField(
        max_length=160,
        null=True,
        blank=True,
        unique=True,
        verbose_name='投递幂等键',
        help_text='仅新通知链路写入；包含接收人维度，历史通知保持 NULL。',
    )
    source_extension_id = models.CharField(max_length=64, blank=True, default='', verbose_name='来源 Extension')
    space_id = models.CharField(max_length=100, blank=True, default='', verbose_name='所属空间')
    priority = models.CharField(max_length=16, default='normal', verbose_name='优先级')
    channels_delivered = models.JSONField(default=list, verbose_name='已投递渠道')
    category = models.CharField(max_length=64, default='general', verbose_name='分类')

    is_read = models.BooleanField(default=False, db_index=True, verbose_name='是否已读')
    read_at = models.DateTimeField(null=True, blank=True, verbose_name='已读时间')
    created_at = models.DateTimeField(auto_now_add=True, db_index=True, verbose_name='创建时间')

    class Meta:
        db_table = 'notification_notification'
        app_label = 'notification'
        verbose_name = '通知'
        verbose_name_plural = '通知'
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['user_id', 'is_read', '-created_at'], name='notif_user_read_time_idx'),
            models.Index(fields=['user_id', 'organization_id'], name='notif_user_ws_idx'),
        ]

    def __str__(self):
        return f"[{self.type}] {self.title} -> {self.user_id}"


class DevicePushRegistration(models.Model):
    """移动端远程推送注册。

    一条记录 = 一个 APNs device token 推送地址。路由主键是
    **user**（一个人所有能收推送的端），Device 只做弱关联：

    - APNs token 卸载重装或系统恢复后可能变化，同设备历史上可能有多个失效 token，
      生命周期与 Device.fingerprint（稳定指纹）不同，故不在 Device 上加列；
    - user_id 用 CharField 软引用（与本 app 的 Notification.user_id 同口径：
      users 在 default alias、notification 路由到 postgresql alias，跨 alias
      无法建物理 FK）。
    """

    PROVIDER_CHOICES = [
        ('apns', 'Apple Push Notification service'),
    ]
    PLATFORM_CHOICES = [
        ('ios', 'iOS'),
    ]
    ENVIRONMENT_CHOICES = [
        ('sandbox', 'Sandbox'),
        ('production', 'Production'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user_id = models.CharField(max_length=64, db_index=True, verbose_name='接收用户 ID')
    device_fingerprint = models.CharField(
        max_length=128, blank=True, default='', verbose_name='设备指纹',
        help_text='软引用 tabtinspace.Device.fingerprint，仅用于排障归因，可为空',
    )
    provider = models.CharField(
        max_length=32, choices=PROVIDER_CHOICES, default='apns', verbose_name='推送服务商',
    )
    registration_id = models.CharField(max_length=255, verbose_name='APNs device token')
    platform = models.CharField(max_length=16, choices=PLATFORM_CHOICES, verbose_name='平台')
    environment = models.CharField(
        max_length=16,
        choices=ENVIRONMENT_CHOICES,
        default='production',
        verbose_name='APNs 环境',
    )
    app_version = models.CharField(max_length=32, blank=True, default='', verbose_name='App 版本')
    is_active = models.BooleanField(default=True, verbose_name='是否有效')
    last_seen_at = models.DateTimeField(auto_now=True, verbose_name='最近上报时间')
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')

    class Meta:
        db_table = 'notification_device_push_registration'
        app_label = 'notification'
        verbose_name = '设备推送注册'
        verbose_name_plural = '设备推送注册'
        constraints = [
            models.UniqueConstraint(
                fields=['provider', 'registration_id'],
                name='push_reg_provider_regid_uniq',
            ),
        ]
        indexes = [
            # 发送查询：按用户取全部有效注册
            models.Index(fields=['user_id', 'is_active'], name='push_reg_user_active_idx'),
        ]

    def __str__(self):
        return f"[{self.provider}/{self.platform}] {self.registration_id[:16]}… -> {self.user_id}"
