"""
用户画像数据模型（USER 层 / v0.2 per-Organization）

核心模型：
1. UserPortrait     — 当前生效的用户画像（一份 5 段 markdown 叙事，per-(user, organization)）
2. UserPortraitSnapshot — 画像历史快照（蒸馏前归档，便于回溯/调试）

设计要点（来自专题_USER画像_per_Organization修正.md 与 PRD 决策）：
  - **per-(user, organization) 复合唯一**：用户在 N 个 Organization 有 N 份独立画像
  - 隔离原则：跨 Organization 物理隔离，没有任何配置能跨 Organization 串台
  - 自然计费归属：直接用 organization_id 走 Organization 钱包
  - 级联清理：Organization 删除 / 成员退出时清理对应画像（决策 N3 / N4）
  - D1: 5 段 schema（Work / Personal / Top of mind / Brief history / Long-term）
  - D3: 字符上限藏在蒸馏 Prompt 里，不在数据模型上做硬限制
  - D5: 增量驱动 + hint 实时触发——last_distilled_at 由蒸馏任务对比 MAX(memo.created_at) 决定是否要跑
  - D7: M1 不做段落直接编辑，但保留 hint 输入区——pending_hints 暂存用户提交的 hint

跨库引用：
  - user 用 ForeignKey（单库治理后恢复物理外键约束）
  - organization_id 用 UUIDField（Organization 在 PG 同库，理论上可建 FK，但跟 SpaceResourceModel 模式保持一致）
"""

from __future__ import annotations

import uuid

from django.conf import settings
from django.db import models

from apps.services.common.base_models import TimeStampedModel


class UserPortrait(TimeStampedModel):
    """当前生效的用户画像。

    每个 (user, organization) 组合最多一份。由蒸馏 Agent 周期性重写。
    跨 Organization 完全隔离——同一用户在不同 Organization 的画像物理上是独立的两条记录。
    """

    class DistillStatus(models.TextChoices):
        IDLE = "idle", "空闲（从未蒸馏 / 上次蒸馏成功）"
        PENDING = "pending", "蒸馏中"
        FAILED = "failed", "上次蒸馏失败"

    # ── 关联：(user, organization) 复合维度 ──
    # User 在 MySQL（users_auth），UserPortrait 在 PG，用 UUID + db_constraint=False
    # 跟 Organization.owner / approval_memo.user 等模式一致
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="portraits_v2",  # 复数：用户跨 Organization 有多份
        verbose_name="所属用户",
    )
    # Organization 跟 UserPortrait 同在 PG 库；不做 FK 是为了跟 SpaceResourceModel.organization_id
    # 现有模式保持一致——后续如果要加 cascade signal 可以集中放在 Organization 删除信号里
    organization_id = models.UUIDField(
        db_index=True,
        verbose_name="所属 Organization",
        help_text="(user, organization_id, agent_id) 复合唯一——画像按 Agent 完全隔离",
    )
    # /#4090 画像 per-Agent 化：画像也随 Agent 完全隔离——同一 subject 用户在同一
    # Organization 下、与不同 Agent 交互蒸馏出的画像物理独立，互不串台（与 AgentMemory
    # 的 (agent, owner, organization) 三键隔离一致）。用 UUIDField 而非 FK：Agent 在
    # apps.agent（PG），画像在 user_portrait（PG），沿用同库 UUID 引用策略（与
    # organization_id 一致），Agent 硬删时由 signals 级联清理画像（非 DB FK cascade）。
    #
    # NULL 语义：历史 per-(user, organization) 画像行（画像 per-Agent 化之前生成）
    # agent_id 为 NULL——per-Agent GET 一律不召回它们（fail-closed）。
    # 清偿见 migration 0006 / ``migrate_legacy_user_portraits``。
    # 新写入路径（蒸馏 / get_or_create）永远带非空 agent_id，不产生 NULL 行。
    agent_id = models.UUIDField(
        null=True,
        blank=True,
        db_index=True,
        verbose_name="所属 Agent",
        help_text="per-Agent 画像隔离维度；NULL 为历史 per-organization 画像（兼容清偿留待后续）",
    )

    # ── 画像主体（5 段 markdown） ──
    # 由蒸馏 Agent 整体重写，不做段落级拆分（D1 决定用一份 markdown）
    # 段落标题固定：## 工作背景 / 个人背景 / 最近在想 / 近期历史 / 长期背景
    content_md = models.TextField(
        blank=True,
        default="",
        verbose_name="画像 Markdown",
        help_text="5 段叙事，由蒸馏 Agent 整体重写。空字符串表示 Portrait 尚未生成。",
    )

    # ── 蒸馏元数据 ──
    version = models.PositiveIntegerField(
        default=0,
        verbose_name="蒸馏版本号",
        help_text="每成功蒸馏一次 +1，初始为 0（未蒸馏）",
    )
    last_distilled_at = models.DateTimeField(
        null=True,
        blank=True,
        verbose_name="上次蒸馏成功时间",
        help_text="增量检测的锚点：对比 MAX(memo.created_at) 决定是否需要新一轮蒸馏",
    )
    last_distill_status = models.CharField(
        max_length=16,
        choices=DistillStatus.choices,
        default=DistillStatus.IDLE,
        verbose_name="上次蒸馏状态",
    )
    last_distill_error = models.TextField(
        blank=True,
        default="",
        verbose_name="上次蒸馏错误信息",
        help_text="last_distill_status=failed 时填充，便于 UI 展示和调试",
    )

    # ── 用户 hint（D7） ──
    # 用户提交的修正 hint，暂存等待下次蒸馏使用；蒸馏成功后由 Service 清空
    # 结构：[{"text": "我已经把狗送人了", "submitted_at": "2026-04-22T10:00:00Z"}]
    pending_hints = models.JSONField(
        default=list,
        blank=True,
        verbose_name="待处理 hint 列表",
        help_text="用户最近提交的 hint，蒸馏完成后清空",
    )

    class Meta:
        db_table = "user_portrait_portrait"
        verbose_name = "用户画像"
        verbose_name_plural = "用户画像"
        constraints = [
            # 画像 per-Agent 化：唯一维度由 (user, organization) 扩为
            # (user, organization, agent)。agent_id 可空——历史 per-organization
            # 行 (user, org, NULL) 在 PG 下 NULL 互不相等，不与新 per-Agent 行冲突；
            # 旧约束下每 (user, org) 至多一行，故至多一条 NULL 行，不破坏唯一性保证。
            models.UniqueConstraint(
                fields=["user", "organization_id", "agent_id"],
                name="up_user_org_agent_unique",
            ),
        ]
        indexes = [
            models.Index(fields=["organization_id"], name="up_organization_idx"),
            # Agent 硬删级联清理画像（signals）按 (organization_id, agent_id) 定位。
            models.Index(fields=["organization_id", "agent_id"], name="up_org_agent_idx"),
            models.Index(fields=["last_distilled_at"], name="up_last_distilled_idx"),
            models.Index(fields=["last_distill_status"], name="up_status_idx"),
        ]

    def __str__(self) -> str:
        return (
            f"UserPortrait(user={self.user_id}, organization={self.organization_id}, "
            f"agent={self.agent_id}, v{self.version})"
        )


class UserPortraitSnapshot(models.Model):
    """画像历史快照。

    每次蒸馏前把当前 content_md 备份一份；蒸馏失败也保留这份快照。
    用途：调试、追溯"画像怎么演化的"、未来可能的"恢复到上一版"。

    跟着 UserPortrait 级联——Organization 删除导致 portrait 删除时，snapshot 也会一起被清理。
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    portrait = models.ForeignKey(
        UserPortrait,
        on_delete=models.CASCADE,
        related_name="snapshots",
        verbose_name="所属画像",
    )

    # 快照的元数据（来自快照时刻的 portrait）
    version_at_snapshot = models.PositiveIntegerField(
        verbose_name="快照时刻的版本号",
        help_text="即 portrait.version；保留以便排序展示",
    )
    content_md = models.TextField(
        blank=True,
        default="",
        verbose_name="快照内容（Markdown）",
    )

    # 触发本次蒸馏的原因（用于审计）
    class TriggerReason(models.TextChoices):
        SCHEDULED = "scheduled", "定时任务"
        HINT = "hint", "用户提交 hint"
        MANUAL = "manual", "用户手动触发"

    trigger_reason = models.CharField(
        max_length=32,
        choices=TriggerReason.choices,
        default=TriggerReason.SCHEDULED,
        verbose_name="触发原因",
    )

    # 触发时附带的输入摘要（不存全文，只存"用了多少 memo + 多少 hint"等元信息）
    input_summary = models.JSONField(
        default=dict,
        blank=True,
        verbose_name="蒸馏输入摘要",
        help_text='例：{"memo_count": 42, "hint_count": 1}',
    )

    created_at = models.DateTimeField(auto_now_add=True, verbose_name="快照创建时间")

    class Meta:
        db_table = "user_portrait_snapshot"
        verbose_name = "画像快照"
        verbose_name_plural = "画像快照"
        ordering = ["-created_at"]
        indexes = [
            models.Index(
                fields=["portrait", "-created_at"],
                name="ups_portrait_created_idx",
            ),
        ]

    def __str__(self) -> str:
        return f"Snapshot(portrait={self.portrait_id}, v{self.version_at_snapshot})"
