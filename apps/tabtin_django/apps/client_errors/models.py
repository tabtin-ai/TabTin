"""
客户端错误监控模型

记录 Electron 客户端上报的前端错误，支持错误分组、面包屑、设备信息等。
"""

import hashlib

from django.db import models
from django.db.models import Q
from django.utils import timezone

FINGERPRINT_ALGO_VERSION = 1


class ClientErrorGroup(models.Model):
    """错误分组（相同根因的错误聚合为一组）"""

    class Status(models.TextChoices):
        OPEN = "open", "待处理"
        CONFIRMED = "confirmed", "已确认"
        RESOLVED = "resolved", "已修复"
        IGNORED = "ignored", "已忽略"

    class Level(models.TextChoices):
        ERROR = "error", "Error"
        WARNING = "warning", "Warning"
        FATAL = "fatal", "Fatal"

    fingerprint = models.CharField(
        "错误指纹", max_length=64, unique=True, db_index=True
    )
    fingerprint_algo_version = models.PositiveSmallIntegerField(
        "fingerprint 算法版本",
        default=FINGERPRINT_ALGO_VERSION,
    )
    title = models.CharField("错误标题", max_length=512)
    level = models.CharField(
        "严重级别", max_length=16, choices=Level.choices, default=Level.ERROR
    )
    status = models.CharField(
        "处理状态", max_length=16, choices=Status.choices, default=Status.OPEN
    )

    first_seen = models.DateTimeField("首次出现", default=timezone.now)
    last_seen = models.DateTimeField("最近出现", default=timezone.now)
    event_count = models.PositiveIntegerField("出现次数", default=1)
    user_count = models.PositiveIntegerField("影响用户数", default=1)

    sample_stack_trace = models.TextField("示例堆栈", blank=True, default="")
    sample_app_version = models.CharField(
        "示例版本号", max_length=64, blank=True, default=""
    )

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "client_error_group"
        ordering = ["-last_seen"]

    def __str__(self):
        return f"[{self.status}] {self.title[:80]}"


class ClientErrorEvent(models.Model):
    """单条错误事件"""

    group = models.ForeignKey(
        ClientErrorGroup,
        on_delete=models.CASCADE,
        related_name="events",
        null=True,
        blank=True,
    )

    # 错误信息
    error_type = models.CharField("错误类型", max_length=128)
    message = models.TextField("错误消息")
    stack_trace = models.TextField("堆栈信息", blank=True, default="")
    # React 组件栈：`Error: ... at ComponentA (at file:line) at ComponentB ...`
    # 与 stack_trace 互补：
    #   - stack_trace 是 JS 调用栈，告诉你"哪段代码崩了"
    #   - component_stack 是 React 组件树，告诉你"在哪个组件树位置崩的"
    # 对 React （Maximum update depth）这类错误，component_stack 是定位关键。
    component_stack = models.TextField("React 组件栈", blank=True, default="")
    level = models.CharField("级别", max_length=16, default="error")

    # 来源
    source = models.CharField(
        "来源进程", max_length=32, default="renderer"
    )  # main / renderer
    file = models.CharField("文件路径", max_length=512, blank=True, default="")
    line = models.PositiveIntegerField("行号", null=True, blank=True)
    column = models.PositiveIntegerField("列号", null=True, blank=True)

    # 面包屑
    breadcrumbs = models.JSONField("操作轨迹", default=list, blank=True)

    # 上下文
    user_id = models.CharField(
        "用户ID", max_length=64, blank=True, default="", db_index=True
    )
    app_version = models.CharField(
        "应用版本", max_length=64, blank=True, default="", db_index=True
    )
    electron_version = models.CharField(
        "Electron版本", max_length=32, blank=True, default=""
    )
    os_name = models.CharField("操作系统", max_length=32, blank=True, default="")
    os_version = models.CharField("系统版本", max_length=64, blank=True, default="")
    arch = models.CharField("CPU架构", max_length=16, blank=True, default="")
    locale = models.CharField("语言", max_length=16, blank=True, default="")
    extra = models.JSONField("附加信息", default=dict, blank=True)

    # 指纹
    fingerprint = models.CharField(
        "错误指纹", max_length=64, db_index=True, blank=True, default=""
    )
    fingerprint_algo_version = models.PositiveSmallIntegerField(
        "fingerprint 算法版本",
        default=FINGERPRINT_ALGO_VERSION,
    )
    original_fingerprint = models.CharField(
        "原始指纹（merge 前备份）",
        max_length=64,
        blank=True,
        default="",
    )
    dedup_key = models.CharField(
        "客户端去重键",
        max_length=64,
        null=True,
        blank=True,
        default=None,
    )

    occurred_at = models.DateTimeField("发生时间", default=timezone.now, db_index=True)
    created_at = models.DateTimeField("入库时间", auto_now_add=True)

    class Meta:
        db_table = "client_error_event"
        ordering = ["-occurred_at"]
        constraints = [
            models.UniqueConstraint(
                fields=("dedup_key",),
                condition=Q(dedup_key__isnull=False),
                name="cee_dedup_key_uniq",
            ),
        ]

    def __str__(self):
        return f"{self.error_type}: {self.message[:60]}"

    def compute_fingerprint(self) -> str:
        """根据错误类型和堆栈前几帧计算指纹，用于分组。"""
        raw = self.error_type or ""
        if self.stack_trace:
            # 取堆栈前 3 行作为分组依据
            frames = [
                line.strip() for line in self.stack_trace.splitlines() if line.strip()
            ][:3]
            raw += "\n".join(frames)
        else:
            raw += self.message or ""
        return hashlib.sha256(raw.encode()).hexdigest()[:32]


class Release(models.Model):
    """版本发布记录（错误上报时自动创建）"""

    app_version = models.CharField("版本号", max_length=64, unique=True, db_index=True)
    first_seen = models.DateTimeField("首次出现", default=timezone.now)
    last_seen = models.DateTimeField("最近出现", default=timezone.now)
    event_count = models.PositiveIntegerField("错误事件数", default=0)
    new_group_count = models.PositiveIntegerField("新增错误分组数", default=0)
    user_count = models.PositiveIntegerField("影响用户数", default=0)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "client_error_release"
        ordering = ["-first_seen"]

    def __str__(self):
        return f"v{self.app_version} ({self.event_count} events)"


class SourceMapFile(models.Model):
    """SourceMap 文件存储（按版本 + 文件路径唯一）"""

    app_version = models.CharField("应用版本", max_length=64, db_index=True)
    file_path = models.CharField("JS文件路径", max_length=512)
    map_data = models.TextField("SourceMap JSON")
    uploaded_at = models.DateTimeField("上传时间", auto_now_add=True)

    class Meta:
        db_table = "client_error_sourcemap"
        unique_together = [("app_version", "file_path")]

    def __str__(self):
        return f"{self.app_version}: {self.file_path}"
