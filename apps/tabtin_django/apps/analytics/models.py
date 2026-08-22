"""
通用埋点与获客分析数据模型

设计意图（见 GitHub ）：
  - AnalyticsEvent 是**通用事件表**，通吃各来源（官网 / Electron / Daemon / 未来移动端）。
    事件语义靠 (source, event_name) 命名空间区分，业务字段放 props(JSONB)，
    维度字段（platform/utm/referrer/geo）平铺出来方便聚合与建索引。
  - ShortLink 是运营维护的下载短链：官网下载按钮挂短链 → 公网 302 到真实安装包，
    途中落一条 download 事件，从而能按平台 / 渠道核对真实下载量。

刻意不做的事（第一期边界）：
  - 不写入 agent-runtime telemetry / UpdateLog / OSS download_count——三条线语义不同，保持独立。
  - 事件按原始行存储 + 查询时聚合；数据量大后再引入按天汇总表 / 分区（已知限制）。
"""

from __future__ import annotations

import uuid

from django.db import models


class EventSource(models.TextChoices):
    WEB = "web", "官网"
    ELECTRON = "electron", "桌面客户端"
    DAEMON = "daemon", "Daemon"
    MOBILE = "mobile", "移动端"
    SERVER = "server", "服务端"
    OTHER = "other", "其它"


class AnalyticsEvent(models.Model):
    """通用埋点事件（平台级，无 organization 归属）。"""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    # 事件命名空间：source + event_name 唯一定位一类事件
    source = models.CharField(
        max_length=32, choices=EventSource.choices, default=EventSource.WEB,
        db_index=True, verbose_name="事件来源",
    )
    event_name = models.CharField(
        max_length=64, db_index=True, verbose_name="事件名",
        help_text="如 page_view / download / cta_click",
    )
    occurred_at = models.DateTimeField(
        db_index=True, verbose_name="发生时间",
        help_text="事件真实发生时间（客户端提供，缺省用入库时间）",
    )

    # 访客 / 会话 / 用户（都可空；官网访客通常只有 anon_id）
    anon_id = models.CharField(max_length=64, blank=True, default="", verbose_name="匿名访客 ID")
    session_id = models.CharField(max_length=64, blank=True, default="", verbose_name="会话 ID")
    user_id = models.CharField(max_length=64, blank=True, default="", db_index=True, verbose_name="用户 ID")

    # 页面 / 来源上下文
    path = models.CharField(max_length=512, blank=True, default="", verbose_name="页面路径")
    referrer = models.CharField(max_length=1024, blank=True, default="", verbose_name="来源 URL")
    referrer_host = models.CharField(max_length=255, blank=True, default="", db_index=True, verbose_name="来源域名")

    # 渠道归因
    utm_source = models.CharField(max_length=128, blank=True, default="", db_index=True, verbose_name="UTM Source")
    utm_medium = models.CharField(max_length=128, blank=True, default="", verbose_name="UTM Medium")
    utm_campaign = models.CharField(max_length=128, blank=True, default="", verbose_name="UTM Campaign")

    # 环境维度
    platform = models.CharField(max_length=32, blank=True, default="", verbose_name="平台")
    arch = models.CharField(max_length=16, blank=True, default="", verbose_name="架构")
    app_version = models.CharField(max_length=64, blank=True, default="", verbose_name="版本")
    geo_country = models.CharField(max_length=64, blank=True, default="", db_index=True, verbose_name="国家/地区")
    geo_province = models.CharField(
        max_length=64, blank=True, default="", db_index=True, verbose_name="省份/州",
        help_text="采集入口用客户端 IP 现算，只落地域、不存原始 IP（隐私）",
    )
    ua_hash = models.CharField(
        max_length=64, blank=True, default="", verbose_name="UA 指纹",
        help_text="User-Agent 的哈希，用于粗粒度去重，不存原始 UA（隐私）",
    )

    # 下载事件关联的短链（其它事件为空）
    short_link = models.ForeignKey(
        "analytics.ShortLink", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="events", verbose_name="关联短链",
    )

    # 通用扩展点：事件特有字段
    props = models.JSONField(default=dict, blank=True, verbose_name="事件属性")

    created_at = models.DateTimeField(auto_now_add=True, db_index=True, verbose_name="入库时间")

    class Meta:
        db_table = "analytics_event"
        ordering = ["-occurred_at"]
        indexes = [
            models.Index(fields=["source", "event_name", "occurred_at"], name="ana_evt_src_name_time_idx"),
            models.Index(fields=["event_name", "occurred_at"], name="ana_evt_name_time_idx"),
        ]
        verbose_name = "埋点事件"
        verbose_name_plural = "埋点事件"

    def __str__(self):
        return f"AnalyticsEvent({self.source}/{self.event_name} @ {self.occurred_at:%Y-%m-%d %H:%M})"


class ShortLink(models.Model):
    """下载短链（运营在 AdminDash 维护）。"""

    class TargetType(models.TextChoices):
        STATIC = "static", "固定 URL"
        LATEST_RELEASE = "latest_release", "跟随最新发版"

    class Platform(models.TextChoices):
        MAC = "mac", "macOS"
        WIN = "win", "Windows"
        LINUX = "linux", "Linux"

    class Arch(models.TextChoices):
        X64 = "x64", "x64"
        ARM64 = "arm64", "ARM64"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    slug = models.SlugField(
        max_length=64, unique=True, verbose_name="短链标识",
        help_text="访问地址 /dl/<slug>，如 mac-arm64、win-x64、campaign-2026q3",
    )
    name = models.CharField(max_length=128, verbose_name="名称")
    description = models.TextField(blank=True, default="", verbose_name="备注")

    # 目标解析方式
    target_type = models.CharField(
        max_length=20, choices=TargetType.choices, default=TargetType.LATEST_RELEASE,
        verbose_name="目标类型",
    )
    target_url = models.URLField(
        max_length=2048, blank=True, default="", verbose_name="固定目标 URL",
        help_text="target_type=static 时使用",
    )
    # target_type=latest_release 时用以下三项从 updater 发版记录解析安装包
    release_platform = models.CharField(
        max_length=10, choices=Platform.choices, blank=True, default="", verbose_name="发版平台",
    )
    release_arch = models.CharField(
        max_length=10, choices=Arch.choices, blank=True, default="", verbose_name="发版架构",
    )
    release_channel = models.CharField(max_length=20, blank=True, default="stable", verbose_name="发版通道")

    # 渠道归因（落到下载事件）
    channel = models.CharField(max_length=64, blank=True, default="", verbose_name="渠道标签")
    utm_source = models.CharField(max_length=128, blank=True, default="", verbose_name="UTM Source")
    utm_medium = models.CharField(max_length=128, blank=True, default="", verbose_name="UTM Medium")
    utm_campaign = models.CharField(max_length=128, blank=True, default="", verbose_name="UTM Campaign")

    is_active = models.BooleanField(default=True, db_index=True, verbose_name="是否启用")

    # 冗余计数：快速展示，明细以 AnalyticsEvent 为准
    click_count = models.PositiveIntegerField(default=0, verbose_name="累计点击")
    last_clicked_at = models.DateTimeField(null=True, blank=True, verbose_name="最近点击时间")

    created_by_id = models.UUIDField(null=True, blank=True, verbose_name="创建人")
    updated_by_id = models.UUIDField(null=True, blank=True, verbose_name="更新人")
    created_at = models.DateTimeField(auto_now_add=True, verbose_name="创建时间")
    updated_at = models.DateTimeField(auto_now=True, verbose_name="更新时间")

    class Meta:
        db_table = "analytics_short_link"
        ordering = ["-created_at"]
        verbose_name = "下载短链"
        verbose_name_plural = "下载短链"

    def __str__(self):
        return f"ShortLink({self.slug} -> {self.target_type})"
