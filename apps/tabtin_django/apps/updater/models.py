"""
应用更新数据模型
"""
from pathlib import PurePosixPath
from urllib.parse import SplitResult, urljoin, urlsplit, urlunsplit

from django.db import models
from django.contrib.auth import get_user_model
from django.utils import timezone

User = get_user_model()


class AppRelease(models.Model):
    """版本发布记录"""

    # 平台选项
    PLATFORM_CHOICES = [
        ('mac', 'macOS'),
        ('win', 'Windows'),
        ('linux', 'Linux'),
    ]

    ARCH_CHOICES = [
        ('x64', 'x64'),
        ('arm64', 'ARM64'),
    ]

    CHANNEL_CHOICES = [
        ('stable', 'Stable'),
        ('beta', 'Beta'),
        ('alpha', 'Alpha'),
    ]

    PRIORITY_CHOICES = [
        ('low', 'Low'),
        ('normal', 'Normal'),
        ('high', 'High'),
        ('critical', 'Critical'),
    ]

    # 基础信息
    version = models.CharField(max_length=20, help_text="语义化版本号，如 1.2.3")
    platform = models.CharField(max_length=10, choices=PLATFORM_CHOICES)
    arch = models.CharField(max_length=10, choices=ARCH_CHOICES, default='x64')
    channel = models.CharField(max_length=20, choices=CHANNEL_CHOICES, default='stable')

    # 文件信息
    file_url = models.URLField(blank=True, default="", help_text="安装包下载地址 (CDN)")
    website_file_url = models.URLField(
        blank=True,
        default="",
        help_text="官网手动下载安装包地址 (CDN)；mac 为 .dmg，win 可空并回退 file_url",
    )
    feed_url = models.URLField(
        blank=True,
        help_text="更新源目录地址（electron-updater generic provider base URL）；留空时按安装包目录推导"
    )
    file_size = models.BigIntegerField(default=0, help_text="文件大小（字节）")
    checksum_sha256 = models.CharField(max_length=64, blank=True, default="", help_text="SHA256 校验和")
    checksum_sha512 = models.CharField(
        max_length=128,
        blank=True,
        default="",
        help_text="SHA512 校验和（base64，用于生成 electron manifest）",
    )

    # 版本控制
    is_draft = models.BooleanField(default=True, help_text="草稿状态，不会推送给用户")
    published_at = models.DateTimeField(null=True, blank=True, help_text="发布时间")
    deprecated_at = models.DateTimeField(null=True, blank=True, help_text="废弃时间")

    # 更新策略
    is_mandatory = models.BooleanField(default=False, help_text="是否强制更新")
    min_compatible_version = models.CharField(
        max_length=20,
        blank=True,
        help_text="最低兼容版本，低于此版本必须更新"
    )
    priority = models.CharField(
        max_length=20,
        choices=PRIORITY_CHOICES,
        default='normal',
        help_text="更新优先级"
    )

    # 内容
    release_notes = models.TextField(help_text="更新日志（中文）")
    release_notes_en = models.TextField(blank=True, help_text="更新日志（英文）")

    # 灰度控制
    rollout_percentage = models.IntegerField(
        default=0,
        help_text="灰度发布百分比 (0-100)，0表示未推送"
    )
    rollout_target_users = models.JSONField(
        default=list,
        blank=True,
        help_text="白名单用户 ID 列表（用于内测）"
    )

    # 元数据
    created_by = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        related_name='created_releases'
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'updater_app_release'
        unique_together = [['version', 'platform', 'arch', 'channel']]
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['platform', 'arch', 'channel', 'is_draft']),
            models.Index(fields=['published_at']),
            models.Index(fields=['version']),
        ]
        verbose_name = '应用版本'
        verbose_name_plural = '应用版本'

    def __str__(self):
        return f"{self.version} ({self.platform}/{self.arch}/{self.channel})"

    @staticmethod
    def _ensure_trailing_slash(url: str) -> str:
        normalized = (url or "").strip()
        if not normalized:
            return normalized
        return normalized if normalized.endswith("/") else f"{normalized}/"

    def get_effective_feed_url(self) -> str:
        explicit_feed_url = self._ensure_trailing_slash(self.feed_url)
        if explicit_feed_url:
            return explicit_feed_url

        if not (self.file_url or "").strip():
            return ""

        parsed = urlsplit(self.file_url)
        directory = parsed.path.rsplit("/", 1)[0] if "/" in parsed.path else ""
        normalized = SplitResult(
            scheme=parsed.scheme,
            netloc=parsed.netloc,
            path=f"{directory}/" if directory else "/",
            query="",
            fragment="",
        )
        return self._ensure_trailing_slash(urlunsplit(normalized))

    def get_manifest_file(self) -> str:
        channel_name = "latest" if self.channel == "stable" else self.channel
        if self.platform == "mac":
            suffix = "-mac"
        elif self.platform == "linux":
            suffix = "-linux" if self.arch == "x64" else f"-linux-{self.arch}"
        else:
            suffix = ""
        return f"{channel_name}{suffix}.yml"

    def get_manifest_url(self) -> str:
        effective_feed_url = self.get_effective_feed_url()
        if not effective_feed_url:
            return ""
        return urljoin(effective_feed_url, self.get_manifest_file())

    def get_asset_name(self) -> str:
        file_url = (self.file_url or "").strip()
        if not file_url:
            return ""
        return PurePosixPath(urlsplit(file_url).path).name

    def get_website_asset_name(self) -> str:
        website_file_url = (self.website_file_url or "").strip()
        if not website_file_url:
            return ""
        return PurePosixPath(urlsplit(website_file_url).path).name

    def get_download_file_url(self) -> str:
        """官网/短链优先用官网安装包，否则回退自动更新主包。"""
        return (self.website_file_url or self.file_url or "").strip()

    def get_storage_prefix(self) -> str:
        return f"desktop-updates/{self.channel}/{self.platform}/{self.arch}/{self.version}/"

    def is_feed_url_derived(self) -> bool:
        return not bool((self.feed_url or "").strip())

    def get_source_warnings(self) -> list[str]:
        warnings: list[str] = []
        file_url = (self.file_url or "").strip()
        effective_feed_url = self.get_effective_feed_url()

        if not file_url:
            warnings.append("尚未配置安装包地址，发布前需要先上传安装包或填写下载 URL。")

        website_file_url = (self.website_file_url or "").strip()
        if self.platform == "mac" and self.channel == "stable" and not website_file_url:
            warnings.append("正式版 macOS 尚未上传官网 .dmg，发布前需要托管官网安装包。")

        if self.is_feed_url_derived() and file_url:
            warnings.append("未显式配置更新源目录，当前按安装包所在目录自动推导。")

        if not effective_feed_url:
            warnings.append("尚未形成可用的更新源目录，客户端无法拉取 manifest。")
            return warnings

        feed_parts = urlsplit(effective_feed_url)
        file_parts = urlsplit(file_url)

        if feed_parts.scheme not in {"http", "https"}:
            warnings.append("更新源目录必须使用 http 或 https。")
        if file_url and file_parts.scheme not in {"http", "https"}:
            warnings.append("安装包地址必须使用 http 或 https。")

        if file_url and not self.get_asset_name():
            warnings.append("安装包地址缺少文件名，electron-updater 无法解析下载目标。")

        if file_url and feed_parts.netloc and file_parts.netloc and feed_parts.netloc != file_parts.netloc:
            warnings.append("安装包与更新源不在同一域名，请确认 manifest 中 files[].url 使用绝对地址。")
        elif file_url and feed_parts.path and file_parts.path and not file_parts.path.startswith(feed_parts.path):
            warnings.append("安装包不在更新源目录下，请确认 manifest 中 files[].url 指向正确资源。")

        if file_url and not (self.checksum_sha256 or "").strip():
            warnings.append("尚未记录 SHA256，建议通过后台上传安装包自动回填。")

        return warnings

    def publish(self):
        """发布版本"""
        if not self.published_at:
            self.published_at = timezone.now()
            self.is_draft = False
            self.save(update_fields=['published_at', 'is_draft', 'updated_at'])

    def deprecate(self):
        """废弃版本"""
        if not self.deprecated_at:
            self.deprecated_at = timezone.now()
            self.save(update_fields=['deprecated_at', 'updated_at'])

    @property
    def is_published(self):
        return not self.is_draft and self.published_at is not None

    @property
    def is_deprecated(self):
        return self.deprecated_at is not None


class UpdatePushRecord(models.Model):
    """推送记录"""

    STATUS_CHOICES = [
        ('pending', 'Pending'),
        ('sent', 'Sent'),
        ('failed', 'Failed'),
    ]

    release = models.ForeignKey(
        AppRelease,
        on_delete=models.CASCADE,
        related_name='push_records'
    )

    # 推送配置
    target_group = models.CharField(
        max_length=100,
        help_text="目标 WebSocket 分组名，如 app.update.mac.x64.stable"
    )
    rollout_percentage = models.IntegerField(help_text="本次推送的灰度比例")
    silent = models.BooleanField(default=False, help_text="是否静默下载")

    # 推送结果
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default='pending')
    pushed_at = models.DateTimeField(auto_now_add=True)
    pushed_by = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        related_name='pushed_updates'
    )
    error_message = models.TextField(blank=True)

    # 统计数据（后续可通过 UpdateLog 聚合）
    notes = models.TextField(blank=True, help_text="推送备注")

    class Meta:
        db_table = 'updater_push_record'
        ordering = ['-pushed_at']
        indexes = [
            models.Index(fields=['release', 'status']),
            models.Index(fields=['pushed_at']),
        ]
        verbose_name = '推送记录'
        verbose_name_plural = '推送记录'

    def __str__(self):
        return f"Push {self.release.version} to {self.target_group} ({self.status})"


class UpdateLog(models.Model):
    """客户端更新日志"""

    TRIGGER_CHOICES = [
        ('ws_push', 'WebSocket Push'),
        ('http_poll', 'HTTP Poll'),
        ('manual', 'Manual Check'),
    ]

    STATUS_CHOICES = [
        ('checking', 'Checking'),
        ('available', 'Available'),
        ('downloading', 'Downloading'),
        ('downloaded', 'Downloaded'),
        ('installing', 'Installing'),
        ('installed', 'Installed'),
        ('failed', 'Failed'),
        ('skipped', 'Skipped'),
    ]

    # 用户信息
    user_id = models.CharField(max_length=100, db_index=True, blank=True)
    device_id = models.CharField(max_length=100, db_index=True)
    organization_id = models.CharField(max_length=100, blank=True)

    # 版本信息
    from_version = models.CharField(max_length=20)
    to_version = models.CharField(max_length=20, db_index=True)
    platform = models.CharField(max_length=10)
    arch = models.CharField(max_length=10)
    channel = models.CharField(max_length=20, default='stable')

    # 更新过程
    trigger_source = models.CharField(
        max_length=20,
        choices=TRIGGER_CHOICES,
        help_text="触发来源"
    )
    status = models.CharField(
        max_length=20,
        choices=STATUS_CHOICES,
        help_text="当前状态"
    )
    progress = models.FloatField(default=0, help_text="下载进度 0-100")

    # 结果
    success = models.BooleanField(null=True, help_text="是否成功")
    error_code = models.CharField(max_length=50, blank=True)
    error_message = models.TextField(blank=True)

    # 时间统计
    started_at = models.DateTimeField(auto_now_add=True)
    completed_at = models.DateTimeField(null=True, blank=True)
    download_duration_ms = models.IntegerField(null=True, help_text="下载耗时（毫秒）")

    # 元数据
    client_metadata = models.JSONField(default=dict, blank=True, help_text="客户端元数据")

    class Meta:
        db_table = 'updater_log'
        ordering = ['-started_at']
        indexes = [
            models.Index(fields=['to_version', 'status']),
            models.Index(fields=['user_id', 'started_at']),
            models.Index(fields=['device_id', 'started_at']),
            models.Index(fields=['trigger_source', 'success']),
        ]
        verbose_name = '更新日志'
        verbose_name_plural = '更新日志'

    def __str__(self):
        return f"{self.device_id}: {self.from_version} → {self.to_version} ({self.status})"

    def mark_success(self):
        """标记为成功"""
        self.status = 'installed'
        self.success = True
        self.completed_at = timezone.now()
        if self.started_at:
            delta = self.completed_at - self.started_at
            self.download_duration_ms = int(delta.total_seconds() * 1000)
        self.save()

    def mark_failed(self, error_code: str, error_message: str):
        """标记为失败"""
        self.status = 'failed'
        self.success = False
        self.error_code = error_code
        self.error_message = error_message
        self.completed_at = timezone.now()
        self.save()


class ClientVersionPolicy(models.Model):
    """移动端（iOS / Android）版本门禁策略。

    与桌面 ``AppRelease`` 有意分开：移动端不能自动下载安装更新，只能把用户引导到
    应用商店；因此这里存的不是安装包，而是「最低支持版本 + 去哪更新 + 文案」。
    每个平台只有一条策略（``platform`` 唯一）。

    版本比较统一走**单调递增 build 号**（Android ``versionCode`` / iOS
    ``CFBundleVersion``），而不是语义版本字符串——语义版本仅用于展示文案。
    """

    PLATFORM_CHOICES = [
        ('ios', 'iOS'),
        ('android', 'Android'),
    ]

    ACTION_NONE = 'none'
    ACTION_SOFT = 'soft'
    ACTION_FORCE = 'force'

    platform = models.CharField(
        max_length=16,
        choices=PLATFORM_CHOICES,
        unique=True,
        help_text="平台，每个平台仅一条策略",
    )
    enabled = models.BooleanField(
        default=True,
        help_text="总开关；关闭时门禁对该平台恒返回 none（出问题可一键停用）",
    )
    soft_prompt_enabled = models.BooleanField(
        default=False,
        help_text="软提示（推荐更新）开关，默认关；关闭时只保留强更，不因有新版本就打扰用户",
    )

    # 门禁阈值（build 号，单调递增）
    min_supported_build = models.PositiveIntegerField(
        default=0,
        help_text="最低支持 build 号；当前 build 低于此值 → 强制更新（force）",
    )
    latest_build = models.PositiveIntegerField(
        default=0,
        help_text="最新 build 号；最低支持 ≤ 当前 < 最新 → 推荐更新（soft）；0 表示不做软提示",
    )

    # 语义版本，仅用于展示文案
    min_supported_version = models.CharField(
        max_length=32,
        blank=True,
        default="",
        help_text="最低支持语义版本，仅展示",
    )
    latest_version = models.CharField(
        max_length=32,
        blank=True,
        default="",
        help_text="最新语义版本，仅展示",
    )

    # 跳转与文案
    store_url = models.URLField(
        blank=True,
        default="",
        help_text="去更新跳转地址；Android 建议填官网落地页（国内多商店）",
    )
    force_title = models.CharField(
        max_length=128,
        blank=True,
        default="",
        help_text="强制更新弹窗标题；留空用默认文案",
    )
    force_message = models.TextField(
        blank=True,
        default="",
        help_text="强制更新弹窗正文；留空用默认文案",
    )
    soft_title = models.CharField(
        max_length=128,
        blank=True,
        default="",
        help_text="推荐更新弹窗标题；留空用默认文案",
    )
    soft_message = models.TextField(
        blank=True,
        default="",
        help_text="推荐更新弹窗正文；留空用默认文案",
    )

    updated_by = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='client_version_policies',
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    DEFAULT_FORCE_TITLE = "需要更新"
    DEFAULT_FORCE_MESSAGE = "当前版本过旧，无法继续使用，请更新到最新版本后继续。"
    DEFAULT_SOFT_TITLE = "发现新版本"
    DEFAULT_SOFT_MESSAGE = "有新版本可用，建议更新以获得更好的体验。"

    class Meta:
        db_table = 'updater_client_version_policy'
        verbose_name = '移动端版本门禁'
        verbose_name_plural = '移动端版本门禁'

    def __str__(self):
        return f"{self.platform} (min={self.min_supported_build}, latest={self.latest_build}, enabled={self.enabled})"

    def evaluate(self, build: int) -> dict:
        """根据客户端上报的 build 号计算门禁决策。

        由后端算出 action，客户端只执行不自比，避免三端比较逻辑不一致。

        Returns:
            dict: {action, store_url, title, message, latest_version, latest_build,
                   min_supported_version, min_supported_build}
        """
        action = self.ACTION_NONE
        if self.enabled:
            if build < self.min_supported_build:
                action = self.ACTION_FORCE
            elif self.soft_prompt_enabled and self.latest_build and build < self.latest_build:
                action = self.ACTION_SOFT

        if action == self.ACTION_FORCE:
            title = self.force_title or self.DEFAULT_FORCE_TITLE
            message = self.force_message or self.DEFAULT_FORCE_MESSAGE
        elif action == self.ACTION_SOFT:
            title = self.soft_title or self.DEFAULT_SOFT_TITLE
            message = self.soft_message or self.DEFAULT_SOFT_MESSAGE
        else:
            title = ""
            message = ""

        return {
            "action": action,
            "store_url": self.store_url,
            "title": title,
            "message": message,
            "latest_version": self.latest_version,
            "latest_build": self.latest_build,
            "min_supported_version": self.min_supported_version,
            "min_supported_build": self.min_supported_build,
        }

    @staticmethod
    def default_decision() -> dict:
        """无策略配置 / 未知平台时的默认放行决策。"""
        return {
            "action": ClientVersionPolicy.ACTION_NONE,
            "store_url": "",
            "title": "",
            "message": "",
            "latest_version": "",
            "latest_build": 0,
            "min_supported_version": "",
            "min_supported_build": 0,
        }
