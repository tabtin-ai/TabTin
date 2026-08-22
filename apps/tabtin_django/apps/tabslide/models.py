"""
TabSlide 演示文稿模块数据模型

基于 SpaceResourceModel 基类，继承统一的 UUID 主键、时间戳和智能体空间关联字段。

存储架构：
  - SlidePage 是唯一 source of truth（每页一行，页面级存储）
  - CAS 版本控制：latest_version + atomic update 防并发覆盖
  - 版本历史：SlideHistory 支持全量快照 + 增量 diff，TTL 分级降采样
  - 变更记录：SlideChange 记录每次编辑操作的摘要
  - PPTX 按需生成：导出时从 SlidePage 聚合生成
  - 二进制资源走 OSS：图片/视频/音频/字体文件存 OSS，DB 只存 CDN URL
  - pages_data / page_meta 字段已废弃，不参与运行时读写
"""

import uuid

from django.contrib.auth import get_user_model
from django.db import models

from apps.services.common.base_models import ResourcePermission, SpaceResourceModel, TrashableModelMixin

User = get_user_model()


# ── 版本历史配置 ──
HISTORY_TTL_FREE = 7 * 24 * 3600       # 免费用户: 7 天
HISTORY_TTL_PRO = 30 * 24 * 3600       # Pro 用户: 30 天
HISTORY_TTL_TEAM = 90 * 24 * 3600      # Team 用户: 90 天
HISTORY_MIN_INTERVAL = 5                # 最小间隔 5 秒（过滤连续高频保存）
HISTORY_SNAPSHOT_MAX_AGE = 30 * 60      # 每 30 分钟至少创建一个快照
HISTORY_SNAPSHOT_INTERVAL = 10          # 每 10 次增量 diff 后创建一个全量锚点


class SlideProject(SpaceResourceModel, TrashableModelMixin):
    """
    TabSlide 演示文稿项目

    继承自 SpaceResourceModel，自动获得:
      - id (UUID), created_at, updated_at
      - organization_id, space_id
    """

    PRESET_CHOICES = [
        ("ppt", "TabSlide 演示文稿 (1280×720)"),
        ("4:3", "4:3 传统比例 (1024×768)"),
        ("xiaohongshu", "小红书笔记 (1080×1440)"),
        ("poster", "海报 (1080×1920)"),
        ("custom", "自定义尺寸"),
    ]

    PRESET_FE_TO_BE: dict[str, str] = {
        "16:9": "ppt",
        "ppt": "ppt",
        "4:3": "4:3",
        "xiaohongshu": "xiaohongshu",
        "poster": "poster",
        "custom": "custom",
    }

    @classmethod
    def normalize_preset(cls, value: str) -> str:
        """将前端 preset（如 '16:9'）规范化为后端存储值（如 'ppt'）。"""
        return cls.PRESET_FE_TO_BE.get(value, "ppt")

    STATUS_CHOICES = [
        ("active", "Active"),
        ("archived", "Archived"),
        ("trashed", "Trashed"),
    ]

    name = models.CharField(max_length=255, default="未命名演示文稿")
    preset = models.CharField(max_length=32, choices=PRESET_CHOICES, default="ppt")
    #  canvas 统一：新建默认 1280×720，与 html-spec / PPTX EMU 1:1 对齐；
    # 存量 1920 项目不迁移（导出按比例映射 EMU）
    canvas_width = models.IntegerField(default=1280)
    canvas_height = models.IntegerField(default=720)
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default="active")

    # ── [DEPRECATED] 旧版全量存储，已被 SlidePage 替代 ──
    # 运行时不再读写这两个字段。仅保留供数据迁移回滚使用。
    # 参见 docs/tabslide/single-source-of-truth.md
    pages_data = models.JSONField(
        null=True, blank=True, default=None,
        help_text="[DEPRECATED] 旧版全量页面 JSON，已被 SlidePage 替代",
    )
    page_meta = models.JSONField(
        null=True, blank=True, default=None,
        help_text="[DEPRECATED] 旧版页面元数据，已合并到 SlidePage 列",
    )
    font_meta = models.JSONField(
        null=True, blank=True, default=None,
        help_text="字体嵌入元数据 {embedded_fonts: [...], theme_fonts: {...}}",
    )

    # ── 主题配置 ──
    theme = models.JSONField(null=True, blank=True, help_text="主题配色/字体配置 JSON")

    # ── 版本控制（CAS）──
    latest_version = models.BigIntegerField(
        default=0,
        help_text="单调递增版本号，每次 save_pages / update_element 时 +1，CAS 防并发覆盖",
    )

    # ── 归属追踪 ──
    last_editor_type = models.CharField(
        max_length=16, blank=True, default="",
        help_text="最后编辑者类型: user / agent",
    )
    last_editor_id = models.CharField(
        max_length=64, blank=True, default="",
        help_text="最后编辑者 ID (user_id / agent_id)",
    )

    # ── 派生/缓存字段 ──
    page_count = models.IntegerField(default=0)
    thumbnail = models.CharField(max_length=512, blank=True, default="")

    # ── PPTX 导出（按需生成，非数据源）──
    pptx_file = models.CharField(
        max_length=512, blank=True, default="",
        help_text="[废弃] 旧版本地临时路径，保留字段兼容，新逻辑使用 pptx_oss_url",
    )
    pptx_oss_url = models.CharField(
        max_length=1024, blank=True, default="",
        help_text="最近一次生成的 PPTX 文件 OSS URL（持久化，替代本地临时路径）",
    )
    pptx_dirty = models.BooleanField(default=True,
                                     help_text="SlidePage 变更后标记为脏，导出时重新生成 PPTX")
    dirty_page_ids = models.JSONField(
        null=True, blank=True, default=None,
        help_text="自上次 PPTX 生成以来变更的页面 ID 列表（增量脏标记，Phase 3）",
    )

    # ── 审计 ──
    created_by = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="slide_projects_created",
    )
    updated_by = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="slide_projects_updated",
    )

    class Meta:
        db_table = "tabslide_project"
        ordering = ["-updated_at"]
        indexes = [
            models.Index(fields=["organization_id", "space_id"], name="ppt_ws_proj_idx"),
            models.Index(fields=["organization_id", "space_id", "status"], name="ppt_ws_proj_status_idx"),
            models.Index(fields=["created_by", "-updated_at"], name="ppt_user_updated_idx"),
        ]

    def __str__(self):
        return f"{self.name} ({self.preset})"

    # ── ContextSyncMixin 实现 ──

    def get_context_type(self) -> str:
        return "tabslide"

    def get_context_title(self) -> str:
        return self.name or "未命名演示文稿"

    def get_context_metadata(self) -> dict:
        return {
            "preset": self.preset,
            "canvas_width": self.canvas_width,
            "canvas_height": self.canvas_height,
            "page_count": self.page_count,
            "thumbnail": self.thumbnail or None,
        }

    def get_context_preview(self) -> str:
        return f"{self.get_preset_display()} · {self.page_count}页"

    def get_context_status(self) -> str:
        return self.status or ""

    def is_context_archived(self) -> bool:
        return self.status == "archived"

    @property
    def preset_dimensions(self) -> dict:
        """获取预设的默认尺寸"""
        presets = {
            "ppt": {"width": 1280, "height": 720},
            "4:3": {"width": 1024, "height": 768},
            "xiaohongshu": {"width": 1080, "height": 1440},
            "poster": {"width": 1080, "height": 1920},
            "custom": {"width": self.canvas_width, "height": self.canvas_height},
        }
        return presets.get(self.preset, presets["ppt"])


class SlideHistory(models.Model):
    """
    [已废弃 — 写入路径已下线] TabSlide 版本历史

    写入路径已于 P2 阶段下线，新版本历史统一写入 collab.VersionHistory。
    表结构和存量数据保留，供以下场景只读使用：
      - 旧数据恢复（restore_history 回退分支）
      - 存量数据迁移（migrate_slide_histories_incremental 任务）
      - 清理任务（cleanup_slide_history 清理存量过期数据）

    原设计：
      支持全量快照（is_snapshot=True）和增量 diff（is_snapshot=False），
      TTL 分级降采样。
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    project = models.ForeignKey(
        SlideProject, on_delete=models.CASCADE, related_name="histories",
    )
    organization_id = models.UUIDField(verbose_name="Organization ID")

    # ── 快照数据 ──
    version = models.BigIntegerField(
        help_text="创建快照时的 project.latest_version",
    )
    blob = models.BinaryField(
        verbose_name="zlib 压缩数据（全量快照或增量 diff）",
    )
    page_meta_snapshot = models.JSONField(
        null=True, blank=True, default=None,
        verbose_name="page_meta 快照",
    )
    page_count = models.IntegerField(default=0)

    # ── 增量 diff 支持（Phase 4） ──
    is_snapshot = models.BooleanField(
        default=True,
        help_text="True=全量快照（zlib JSON），False=增量 diff",
    )
    base_history = models.ForeignKey(
        "self", null=True, blank=True, on_delete=models.SET_NULL,
        related_name="diff_children",
        help_text="增量 diff 的基版本（is_snapshot=False 时指向最近的全量锚点）",
    )
    blob_size = models.IntegerField(
        default=0,
        help_text="blob 的字节数（用于存储分析和告警）",
    )

    # ── 归属追踪 ──
    editor_type = models.CharField(
        max_length=16, blank=True, default="",
        verbose_name="触发者类型 (user/agent)",
    )
    editor_id = models.CharField(
        max_length=64, blank=True, default="",
        verbose_name="触发者 ID",
    )

    # ── TTL ──
    expired_at = models.DateTimeField(
        db_index=True, null=True, blank=True,
        verbose_name="过期时间（TTL，命名版本为 NULL）",
    )

    # ── 命名版本 ──
    is_named = models.BooleanField(default=False, verbose_name="是否用户手动保存的命名版本")
    name = models.CharField(max_length=200, blank=True, default="", verbose_name="版本名称")
    pinned = models.BooleanField(default=False, verbose_name="是否置顶（不受 TTL/降采样影响）")

    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "tabslide_history"
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["project", "created_at"], name="slidehist_proj_created_idx"),
            models.Index(fields=["project", "is_named"], name="slidehist_proj_named_idx"),
            models.Index(fields=["project", "version"], name="slidehist_proj_ver_idx"),
            models.Index(
                fields=["project", "is_snapshot", "-created_at"],
                name="slidehist_proj_snap_idx",
            ),
        ]

    def save(self, *args, **kwargs):
        if isinstance(self.blob, (bytes, memoryview)):
            raw = bytes(self.blob) if isinstance(self.blob, memoryview) else self.blob
            self.blob_size = len(raw)
        super().save(*args, **kwargs)

    def __str__(self):
        mode = "snapshot" if self.is_snapshot else "diff"
        if self.is_named:
            label = self.name or "命名版本"
            return f"SlideHistory {self.id} ({label}, {mode}) for {self.project_id} v{self.version}"
        return f"SlideHistory {self.id} ({mode}) for {self.project_id} v{self.version}"


class SlideChange(models.Model):
    """
    TabSlide 变更记录（操作日志）

    记录每次编辑操作的摘要信息，用于：
      - 变更时间线：展示谁在什么时候做了什么修改
      - 审计追踪：配合 SlideHistory 支持精确回溯
      - 增量感知：前端通过 since_version 判断是否有新变更

    与 SlideHistory 的区别：
      - SlideHistory 存全量快照（可恢复），受 TTL 控制
      - SlideChange 只存摘要（不可恢复），长期保留，轻量级
    """

    CHANGE_TYPES = [
        ("save_pages", "保存页面"),
        ("collab_persist", "协作同步"),
        ("update_element", "修改元素"),
        ("create_slides", "AI 生成"),
        ("import_pptx", "导入 PPTX"),
        ("restore_history", "恢复历史版本"),
        ("update_meta", "更新元数据"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    project = models.ForeignKey(
        SlideProject, on_delete=models.CASCADE, related_name="changes",
    )

    # ── 变更信息 ──
    version = models.BigIntegerField(help_text="本次变更产生的版本号")
    change_type = models.CharField(max_length=32, choices=CHANGE_TYPES)
    summary = models.CharField(max_length=500, blank=True, default="")
    pages_affected = models.JSONField(
        null=True, blank=True, default=None,
        help_text="受影响的页面 ID 列表（可选）",
    )

    # ── 归属追踪 ──
    editor_type = models.CharField(max_length=16, blank=True, default="")
    editor_id = models.CharField(max_length=64, blank=True, default="")
    agent_run_id = models.CharField(
        max_length=64,
        blank=True,
        default="",
        db_index=True,
        help_text="关联 Agent 操作批次的 run_id",
    )

    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "tabslide_change"
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["project", "-version"], name="slidechange_proj_ver_idx"),
            models.Index(fields=["project", "created_at"], name="slidechange_proj_time_idx"),
        ]

    def __str__(self):
        return f"SlideChange {self.change_type} v{self.version} for {self.project_id}"


class SlidePage(models.Model):
    """
    TabSlide 页面级存储（Phase 1 架构升级）

    将 SlideProject.pages_data 的单 JSONField 全量存储拆分为每页一行，支持：
      - 页面级增量保存（只更新变更的页面，不全量覆盖）
      - 页面级并发控制（为 Phase 2 实时协作做准备）
      - 更高效的 Agent 元素编辑（只读写目标页面）

    与 SlideProject.pages_data 的关系：
      - Phase 1a: 双写模式 — save 时同时写 pages_data 和 SlidePage
      - Phase 1b: SlidePage 为读写主路径，pages_data 降级为快照缓存
      - 长期: pages_data 仅在版本历史快照时使用

    数据来源：
      - 每个 SlidePage 行对应前端 Slide 对象的一个页面
      - page_id 对应前端的 slide.id（由前端生成的 UUID/nanoid）
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    project = models.ForeignKey(
        SlideProject, on_delete=models.CASCADE, related_name="slide_pages",
    )

    # ── 页面标识 ──
    page_id = models.CharField(
        max_length=64,
        help_text="前端页面 ID（slide.id），同一 project 下唯一",
    )

    # ── 页面内容 ──
    elements_data = models.JSONField(
        default=list,
        help_text="该页的 PPTElement[] JSON",
    )
    html_source = models.TextField(
        blank=True,
        default="",
        help_text=(
            "Agent 创作期 HTML 原文快照（read-only after creation）。"
            "仅作 Agent 后续创作的'风格参考语料'，**不参与渲染、不参与协同、不参与导出**。"
            "运行时真相源是 elements_data（PPTElement[]）。"
            "由 _SEALED_AFTER_CREATION_MODEL_FIELDS 守卫保证创建后不再被任何写入路径更新。"
        ),
    )
    # @deprecated Phase 5：HTML 模式已于 2026-05 下线。
    # choices 保留 ('html',) 仅为了让 Django 不对存量 'html' 行报 ValidationError；
    # 写入侧（field_mapping._SEALED_AFTER_CREATION_MODEL_FIELDS）已强制 'json'。
    # 等存量数据通过 migrate_html_pages_to_json 全部转为 'json' 后，
    # 通过 migration 收敛 choices 并最终删除此字段。
    CONTENT_FORMAT_CHOICES = [
        ("json", "JSON"),
        ("html", "HTML (deprecated, 仅存量兼容)"),
    ]
    content_format = models.CharField(
        max_length=16,
        default="json",
        choices=CONTENT_FORMAT_CHOICES,
        help_text="@deprecated 永远落 'json'。HTML 模式已下线（2026-05），字段待 Phase 5 删除。",
    )
    background = models.JSONField(
        null=True, blank=True, default=None,
        help_text="SlideBackground 配置",
    )
    master_elements = models.JSONField(
        null=True, blank=True, default=None,
        help_text="母版/版式只读元素层 PPTElement[]",
    )
    layout_ref = models.JSONField(
        null=True, blank=True, default=None,
        help_text="SlideLayoutRef 版式引用",
    )
    remark = models.TextField(
        blank=True, default="",
        help_text="演讲者备注",
    )

    # ── 页面语义元数据 ──
    section_tag = models.JSONField(
        null=True, blank=True, default=None,
        help_text="章节标签 {id, title}，用于大纲视图分组",
    )
    slide_type = models.CharField(
        max_length=32, blank=True, default="",
        help_text="页面语义类型：cover/contents/transition/content/end",
    )
    slide_notes = models.JSONField(
        null=True, blank=True, default=None,
        help_text="批注数组 SlideNote[]，与演讲备注 remark 独立",
    )

    # ── 动画/翻页（从 page_meta 回归到页面级）──
    animations = models.JSONField(
        null=True, blank=True, default=None,
        help_text="PPTAnimation[] 元素动画集合",
    )
    turning_mode = models.CharField(
        max_length=32, blank=True, default="",
        help_text="翻页动画模式",
    )

    # ── 排序和版本 ──
    order = models.FloatField(
        default=0,
        help_text="页面排序位置（支持中间插入，同 TabData record order）",
    )
    version = models.BigIntegerField(
        default=0,
        help_text="页面级版本号（从 project.latest_version 分配）",
    )

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "tabslide_page"
        ordering = ["order"]
        constraints = [
            models.UniqueConstraint(
                fields=["project", "page_id"],
                name="slidepage_proj_pageid_uniq",
            ),
        ]
        indexes = [
            models.Index(fields=["project", "order"], name="slidepage_proj_order_idx"),
            models.Index(fields=["project", "version"], name="slidepage_proj_ver_idx"),
        ]

    def __str__(self):
        return f"SlidePage {self.page_id} (order={self.order}) in {self.project_id}"


class SlidePageCache(models.Model):
    """
    TabSlide 页面级 PPTX 缓存（Phase 3 增量生成）

    每个页面的 PPTX slide XML 独立缓存，变更时只重新生成受影响的页面。

    工作原理：
      1. PPTX 生成时，每页的 slide XML 独立缓存（zlib 压缩）
      2. 通过 content_hash（SHA256）判断缓存是否有效
      3. 增量导出：只重新生成 dirty_page_ids 中的页面
      4. 缓存命中的页面直接从 DB 读取 XML，无需重新渲染

    存储效率：
      - 典型页面 slide XML 压缩后 2-10KB
      - 100 页缓存总计 ~1MB（vs 每次全量生成 10-30 秒）
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    project = models.ForeignKey(
        SlideProject, on_delete=models.CASCADE, related_name="page_caches",
    )

    # ── 页面标识 ──
    page_id = models.CharField(
        max_length=64,
        help_text="对应 SlidePage.page_id",
    )

    # ── 缓存内容 ──
    content_hash = models.CharField(
        max_length=64,
        help_text="页面 elements_data 的 SHA256，用于判断缓存是否有效",
    )
    slide_xml = models.BinaryField(
        help_text="zlib 压缩的 slide XML（PPTX 内部格式）",
    )
    rels_xml = models.BinaryField(
        null=True, blank=True,
        help_text="zlib 压缩的 slide relationships XML",
    )
    media_refs = models.JSONField(
        default=list,
        help_text="该页引用的媒体文件列表 [{rId, target, content_type}]",
    )

    # ── 版本追踪 ──
    version = models.BigIntegerField(
        help_text="缓存创建时的页面版本",
    )

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "tabslide_page_cache"
        constraints = [
            models.UniqueConstraint(
                fields=["project", "page_id"],
                name="slidepagecache_proj_page_uniq",
            ),
        ]
        indexes = [
            models.Index(fields=["project", "-updated_at"], name="slidepagecache_proj_upd_idx"),
        ]

    def __str__(self):
        return f"SlidePageCache {self.page_id} (hash={self.content_hash[:8]}) in {self.project_id}"


class SlideElementChange(models.Model):
    """
    TabSlide 元素级变更记录

    记录"谁在何时改了哪个元素的哪些属性"，对标 TabData 的字段级 before/after。

    用途：
      - 审计追溯：查看某个元素的修改历史
      - 冲突分析：协作时判断哪些编辑产生了冲突
      - 版本对比：展示两个版本间的元素级差异

    存储策略：
      - before_data / after_data 存储变更的属性子集（而非整个元素 JSON）
      - changed_fields 记录变更的属性名列表（便于索引和过滤）
      - TTL 30 天自动过期，命名版本关联的变更永不过期
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    project = models.ForeignKey(
        SlideProject, on_delete=models.CASCADE, related_name="element_changes",
    )

    # ── 变更上下文 ──
    page_id = models.CharField(max_length=64, help_text="所在页面 ID")
    element_id = models.CharField(max_length=64, help_text="元素 ID")
    version = models.BigIntegerField(help_text="该变更对应的项目版本号")

    # ── 变更类型 ──
    change_type = models.CharField(
        max_length=32,
        choices=[
            ("create", "新增元素"),
            ("update", "修改元素属性"),
            ("delete", "删除元素"),
            ("move", "移动/缩放"),
            ("style", "样式变更"),
        ],
        default="update",
    )

    # ── 变更内容（存储变更的属性子集，而非完整元素数据） ──
    changed_fields = models.JSONField(
        default=list,
        help_text='变更的属性名列表，如 ["x", "y", "width", "content"]',
    )
    before_data = models.JSONField(
        null=True, blank=True,
        help_text="变更前的属性值（仅变更字段）",
    )
    after_data = models.JSONField(
        null=True, blank=True,
        help_text="变更后的属性值（仅变更字段）",
    )

    # ── 编辑者信息 ──
    editor_type = models.CharField(
        max_length=16, default="user",
        help_text="user / agent / system",
    )
    editor_id = models.CharField(
        max_length=64, blank=True, default="",
        help_text="编辑者 user ID 或 agent ID",
    )

    created_at = models.DateTimeField(auto_now_add=True)
    expired_at = models.DateTimeField(
        null=True, blank=True, default=None,
        help_text="过期时间（DB 层保底约束）。命名版本关联的变更设为 None（永不过期），"
                  "其余由 save 逻辑设置为 created_at + TTL",
    )

    class Meta:
        db_table = "tabslide_element_change"
        ordering = ["-created_at"]
        indexes = [
            models.Index(
                fields=["project", "page_id", "element_id", "-created_at"],
                name="elemchange_proj_page_el_idx",
            ),
            models.Index(
                fields=["project", "-created_at"],
                name="elemchange_proj_created_idx",
            ),
            models.Index(
                fields=["project", "version"],
                name="elemchange_proj_ver_idx",
            ),
            models.Index(
                fields=["created_at"],
                name="elemchange_created_at_idx",
            ),
            models.Index(
                fields=["expired_at"],
                name="elemchange_expired_at_idx",
                condition=models.Q(expired_at__isnull=False),
            ),
        ]

    def __str__(self):
        return (
            f"SlideElementChange {self.change_type} "
            f"el={self.element_id} page={self.page_id} "
            f"v{self.version} by {self.editor_type}:{self.editor_id}"
        )


class SlidePermission(ResourcePermission):
    """演示文稿资源级权限（继承 ResourcePermission 统一基类）"""

    slide = models.ForeignKey(SlideProject, on_delete=models.CASCADE, related_name='permissions')

    class Meta(ResourcePermission.Meta):
        db_table = 'tabslide_slide_permission'
        verbose_name = '演示文稿权限'
        verbose_name_plural = '演示文稿权限'
        constraints = [
            models.UniqueConstraint(
                fields=['slide', 'subject_type', 'subject_id'],
                name='tabslide_perm_unique_subject',
            ),
        ]
        indexes = [
            models.Index(fields=['slide', 'is_active'], name='tabslide_perm_slide_active_idx'),
            models.Index(fields=['subject_type', 'subject_id'], name='tabslide_perm_subject_idx'),
        ]

    def __str__(self):
        return f"{self.subject_type}:{self.subject_id}={self.permission} on slide {self.slide_id}"


class SlideAdminActionLog(models.Model):
    """演示文稿后台治理动作日志。"""

    ACTION_TYPE_CHOICES = [
        ("batch_archive", "批量归档"),
        ("batch_restore", "批量恢复"),
        ("single_archive", "单文稿归档"),
        ("single_restore", "单文稿恢复"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    action_type = models.CharField(
        max_length=64,
        choices=ACTION_TYPE_CHOICES,
        db_index=True,
        verbose_name="动作类型",
    )

    operator_id = models.UUIDField(
        null=True,
        blank=True,
        db_index=True,
        verbose_name="操作人 ID",
    )
    operator_name = models.CharField(
        max_length=255,
        blank=True,
        default="",
        verbose_name="操作人展示名",
    )

    target_slide_ids = models.JSONField(
        default=list,
        verbose_name="目标演示文稿 ID 列表",
        help_text="治理动作影响的演示文稿 ID 列表",
    )
    target_slide_ids_text = models.TextField(
        blank=True,
        default="",
        verbose_name="目标演示文稿检索文本",
        help_text="格式: |slide_id_1|slide_id_2|，用于模糊检索",
    )

    requested_count = models.PositiveIntegerField(default=0, verbose_name="请求总数")
    updated_count = models.PositiveIntegerField(default=0, verbose_name="成功处理数")
    skipped_count = models.PositiveIntegerField(default=0, verbose_name="跳过数")
    dry_run = models.BooleanField(default=False, verbose_name="是否 dry-run")

    success = models.BooleanField(default=True, db_index=True, verbose_name="是否成功")
    result_message = models.TextField(blank=True, default="", verbose_name="结果信息")
    error_message = models.TextField(blank=True, default="", verbose_name="错误信息")

    request_payload = models.JSONField(default=dict, verbose_name="请求快照")
    result_payload = models.JSONField(default=dict, verbose_name="结果快照")

    trace_id = models.CharField(
        max_length=128,
        blank=True,
        default="",
        db_index=True,
        verbose_name="链路追踪 ID",
    )
    ip_address = models.GenericIPAddressField(
        null=True,
        blank=True,
        verbose_name="IP 地址",
    )
    user_agent = models.TextField(blank=True, default="", verbose_name="User-Agent")

    created_at = models.DateTimeField(auto_now_add=True, verbose_name="创建时间")

    class Meta:
        db_table = "tabslide_admin_action_log"
        verbose_name = "演示文稿后台治理动作日志"
        verbose_name_plural = "演示文稿后台治理动作日志"
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["action_type", "created_at"], name="slideadm_action_created_idx"),
            models.Index(fields=["operator_id", "created_at"], name="slideadm_operator_created_idx"),
            models.Index(fields=["success", "created_at"], name="slideadm_success_created_idx"),
            models.Index(fields=["dry_run", "created_at"], name="slideadm_dryrun_created_idx"),
        ]

    def __str__(self):
        status = "success" if self.success else "failed"
        return f"{self.action_type} ({status}) @ {self.created_at.isoformat()}"
