"""
UserPortrait 核心业务服务（/#4118 画像 per-(user, organization, agent)）

职责：
  - UserPortrait CRUD（按 (user, organization, agent) 三元组维度，每个组合最多一份）
  - Hint 队列管理（D7: 用户提交 → pending_hints 暂存 → 蒸馏后清空）
  - Snapshot 归档（每次蒸馏前快照旧 content_md）
  - 蒸馏状态机（idle / pending / failed）
  - 成员身份校验（用户必须是 organization 成员才能读写画像；agent 归属校验在 API 层）

不在本 Service 范围（M1.2 才做）：
  - 实际的 LLM 蒸馏调用（distill_portrait_task）
  - 增量检测（每晚定时任务的逻辑）
  - 跟 TabMemo 的查询整合（TabMemo 输入 → LLM）

权限设计：
  - 用户只能操作自己 (user=self.user) 的画像
  - 必须是 organization_id 对应 Organization 的成员或所有者
  - API 层通过 JWTAuth + 本 Service 的成员身份校验双层保证

关键不变量（画像 per-Agent 化后的隔离原则）：
  - 任何方法签名都要 organization_id + agent_id —— 没有"用户级"操作
  - 任何查询都按 (user_id, organization_id, agent_id) 复合 lookup
  - 没有"获取用户所有画像"的方法 —— 防止跨 Organization/跨 Agent 数据汇聚
"""

from __future__ import annotations

import logging
import uuid as _uuid
from typing import Any, Dict, List, Optional

from django.db import transaction
from django.utils import timezone

from apps.user_portrait.constants import (
    HINT_HARD_LIMIT_CHARS,
    MAX_PENDING_HINTS,
    USER_PORTRAIT_DB,
)
from apps.user_portrait.error_codes import ErrorCode, ServiceError
from apps.user_portrait.models import UserPortrait, UserPortraitSnapshot
from apps.user_portrait.user_messages import (
    INVALID_HINT_TOO_LONG_MESSAGE_TEMPLATE,
    humanize_api_error,
)

logger = logging.getLogger(__name__)


def is_valid_uuid(value: Any) -> bool:
    """判断是否合法 UUID（接受 str / UUID 实例）。供本 app 内复用（api 层等）。"""
    if value is None:
        return False
    try:
        _uuid.UUID(str(value))
        return True
    except (TypeError, ValueError):
        return False


# 向后兼容别名（本模块内旧引用）。
_is_valid_uuid = is_valid_uuid


def _normalize_organization_id(value: Any) -> str:
    """归一化 organization_id 为 str；非法格式抛 ServiceError（v0.2 🟡-4：人话）。"""
    if not _is_valid_uuid(value):
        # 技术原文进 logger；用户只看到"团队信息有误，请刷新后重试"
        logger.warning("[Portrait] invalid organization_id received: %r", value)
        raise ServiceError(
            ErrorCode.INVALID_ORGANIZATION_ID,
            humanize_api_error(ErrorCode.INVALID_ORGANIZATION_ID),
            400,
            data={"raw_detail": f"invalid organization_id: {value!r}"},
        )
    return str(value)


def _normalize_agent_id(value: Any) -> str:
    """归一化 agent_id 为 str；缺失 / 非法格式抛 ServiceError（/#4118 画像 per-Agent）。

    画像已按 Agent 完全隔离——任何单份画像操作都必须显式带非空 agent_id。
    缺失（None / 空）也视为非法：绝不落 agent_id=NULL 的无主画像行（fail-closed，
    与 AgentMemory「缺归属显式失败」同口径）。
    """
    if not value or not _is_valid_uuid(value):
        logger.warning("[Portrait] invalid/missing agent_id received: %r", value)
        raise ServiceError(
            ErrorCode.INVALID_AGENT_ID,
            humanize_api_error(ErrorCode.INVALID_AGENT_ID),
            400,
            data={"raw_detail": f"invalid agent_id: {value!r}"},
        )
    return str(value)


class UserPortraitService:
    """User Portrait 核心服务（per-(user, organization, agent)）。

    每个方法都需要 organization_id + agent_id 参数 —— 没有"用户级"操作，
    强制按 (user, organization, agent) 维度访问数据。
    """

    def __init__(self, user=None):
        self.user = user

    # ── 内部工具 ──────────────────────────────────────

    def _check_user(self) -> None:
        """确保 self.user 已设置且有 id（v0.2 🟡-4：人话）。"""
        if not self.user or not getattr(self.user, "id", None):
            raise ServiceError(
                ErrorCode.UNAUTHORIZED,
                humanize_api_error(ErrorCode.UNAUTHORIZED),
                401,
                data={"raw_detail": "user not authenticated"},
            )

    def _check_organization_membership(self, organization_id: str) -> None:
        """校验 self.user 是 organization_id 对应 Organization 的成员或所有者。

        失败抛 PERMISSION_DENIED——前端应做合理的 403 提示。

        测试 settings 没有 tabtinspace 时安全跳过——单元测试场景下 _check_user
        已经拦住未认证调用，membership 校验由集成测试覆盖。
        """
        # 用 apps.get_model 而非直接 import，避免在 tabtinspace 未注册的 settings
        # 下触发 "Model class ... isn't in an application in INSTALLED_APPS"
        from django.apps import apps as django_apps

        try:
            Organization = django_apps.get_model("tabtinspace", "Organization")
            OrganizationMember = django_apps.get_model("tabtinspace", "OrganizationMember")
        except LookupError:
            logger.debug("[Portrait] tabtinspace not available, skipping membership check")
            return

        is_owner = Organization.objects.filter(
            id=organization_id,
            owner_id=self.user.id,
        ).exists()
        if is_owner:
            return

        is_member = OrganizationMember.objects.filter(
            organization_id=organization_id,
            user_id=self.user.id,
        ).exists()
        if not is_member:
            # 技术原文进 logger；用户只看到"你不是该团队的成员"
            logger.info(
                "[Portrait] permission denied user=%s organization=%s",
                self.user.id, organization_id,
            )
            raise ServiceError(
                ErrorCode.PERMISSION_DENIED,
                humanize_api_error(ErrorCode.PERMISSION_DENIED),
                403,
                data={
                    "raw_detail": (
                        f"user {self.user.id} is not a member of organization {organization_id}"
                    ),
                },
            )

    @staticmethod
    def _portrait_qs():
        """返回正确路由到 PG 库的 UserPortrait QuerySet。"""
        return UserPortrait.objects.using(USER_PORTRAIT_DB)

    @staticmethod
    def _snapshot_qs():
        return UserPortraitSnapshot.objects.using(USER_PORTRAIT_DB)

    # ── 读 ──────────────────────────────────────────

    def get_or_create_portrait(
        self, organization_id: str, agent_id: str
    ) -> UserPortrait:
        """获取当前用户在指定 (Organization, Agent) 的 Portrait；不存在则创建空 Portrait。

        /#4118：画像按 Agent 完全隔离——归属键为 (subject_user=self.user,
        organization, agent)。首次访问该 Agent 的 USER 面板时通过此方法初始化空
        Portrait，避免 UI 处理"无数据"的特殊路径。

        权限：必须是 organization 成员/所有者（agent 归属校验由 API 层做）。
        """
        self._check_user()
        wid = _normalize_organization_id(organization_id)
        aid = _normalize_agent_id(agent_id)
        self._check_organization_membership(wid)

        portrait, _created = self._portrait_qs().get_or_create(
            user_id=self.user.id,
            organization_id=wid,
            agent_id=aid,
            defaults={
                "content_md": "",
                "version": 0,
                "last_distill_status": UserPortrait.DistillStatus.IDLE,
                "pending_hints": [],
            },
        )
        return portrait

    def get_portrait(
        self, organization_id: str, agent_id: str
    ) -> Optional[UserPortrait]:
        """获取当前用户在指定 (Organization, Agent) 的 Portrait；不存在返回 None。"""
        self._check_user()
        wid = _normalize_organization_id(organization_id)
        aid = _normalize_agent_id(agent_id)
        self._check_organization_membership(wid)
        return self._portrait_qs().filter(
            user_id=self.user.id,
            organization_id=wid,
            agent_id=aid,
        ).first()

    def list_snapshots(
        self, organization_id: str, agent_id: str, limit: int = 20
    ) -> List[UserPortraitSnapshot]:
        """列出当前用户在指定 (Organization, Agent) 的画像历史快照。"""
        self._check_user()
        wid = _normalize_organization_id(organization_id)
        aid = _normalize_agent_id(agent_id)
        self._check_organization_membership(wid)
        portrait = self.get_portrait(wid, aid)
        if not portrait:
            return []
        return list(
            self._snapshot_qs()
            .filter(portrait_id=portrait.id)
            .order_by("-created_at")[:limit]
        )

    # ── 写：Hint 提交（D7） ──────────────────────────

    def add_hint(self, organization_id: str, agent_id: str, text: str) -> UserPortrait:
        """提交一个 hint，加入指定 (Organization, Agent) 画像的 pending_hints 队列。

        语义：
            - 不立即触发蒸馏（蒸馏由 task 层负责，避免 Service 调 Celery 形成循环导入）
            - API 层在 add_hint 后**应**调用 trigger_distill(reason='hint') 触发任务
            - 超过 MAX_PENDING_HINTS 时按时间最旧的丢弃
        """
        self._check_user()
        wid = _normalize_organization_id(organization_id)
        aid = _normalize_agent_id(agent_id)
        self._check_organization_membership(wid)

        text = (text or "").strip()
        if not text:
            raise ServiceError(
                ErrorCode.INVALID_HINT,
                humanize_api_error(ErrorCode.INVALID_HINT),
                400,
                data={"raw_detail": "hint text empty after strip"},
            )
        if len(text) > HINT_HARD_LIMIT_CHARS:
            # 给"超长"用专门的人话模板（区别于"空"的 INVALID_HINT 默认文案）；
            # data.limit 也透出，前端可用模板自由组装提示
            raise ServiceError(
                ErrorCode.INVALID_HINT,
                INVALID_HINT_TOO_LONG_MESSAGE_TEMPLATE.format(limit=HINT_HARD_LIMIT_CHARS),
                400,
                data={
                    "raw_detail": (
                        f"hint length {len(text)} exceeds hard limit {HINT_HARD_LIMIT_CHARS}"
                    ),
                    "limit": HINT_HARD_LIMIT_CHARS,
                },
            )

        portrait = self.get_or_create_portrait(wid, aid)
        hints = list(portrait.pending_hints or [])
        hints.append({
            "text": text,
            "submitted_at": timezone.now().isoformat(),
        })
        # 超容量按时间最旧丢弃（保留最近 MAX_PENDING_HINTS 条）
        if len(hints) > MAX_PENDING_HINTS:
            hints = hints[-MAX_PENDING_HINTS:]

        portrait.pending_hints = hints
        portrait.save(
            using=USER_PORTRAIT_DB,
            update_fields=["pending_hints", "updated_at"],
        )
        return portrait

    def clear_pending_hints(
        self, organization_id: str, agent_id: str
    ) -> UserPortrait:
        """清空指定 (Organization, Agent) 画像的 pending_hints。蒸馏成功后由 task 层调用。

        权限语义：实际调用 ``get_or_create_portrait`` 间接走 ``_check_organization_membership``，
        所以即便从外部 API 调用也是安全的（不会绕过成员校验）。当前本方法
        在生产路径上未被任何调用方使用——``commit_distill_result`` 已直接清空
        ``pending_hints``——保留它仅作为 task 层显式清空的备用入口。
        """
        self._check_user()
        wid = _normalize_organization_id(organization_id)
        aid = _normalize_agent_id(agent_id)
        portrait = self.get_or_create_portrait(wid, aid)
        portrait.pending_hints = []
        portrait.save(
            using=USER_PORTRAIT_DB,
            update_fields=["pending_hints", "updated_at"],
        )
        return portrait

    # ── 写：蒸馏状态机 ──────────────────────────────

    def mark_distill_pending(
        self, organization_id: str, agent_id: str
    ) -> UserPortrait:
        """蒸馏开始前调用：把指定 (Organization, Agent) 画像的状态置为 pending。

        如果当前已是 pending 状态，抛 DISTILL_IN_PROGRESS（防并发蒸馏）。

        v0.2 隐私级：所有写路径（含已有行分支）必须先做成员校验——
        防止残留 portrait 行（signal handler 失败 / 历史数据）+ 非成员的边角组合
        """
        self._check_user()
        wid = _normalize_organization_id(organization_id)
        aid = _normalize_agent_id(agent_id)
        # 进事务前先做成员校验——已有 portrait 行也必须校验，
        # 否则残留行 + 非成员的组合可以触发蒸馏（隐私级缺口）
        self._check_organization_membership(wid)

        with transaction.atomic(using=USER_PORTRAIT_DB):
            portrait = (
                self._portrait_qs()
                .select_for_update()
                .filter(user_id=self.user.id, organization_id=wid, agent_id=aid)
                .first()
            )
            if not portrait:
                # 不存在就先创建（首次蒸馏的场景）；
                # get_or_create_portrait 内部会再次校验成员，幂等不冲突
                portrait = self.get_or_create_portrait(wid, aid)

            if portrait.last_distill_status == UserPortrait.DistillStatus.PENDING:
                raise ServiceError(
                    ErrorCode.DISTILL_IN_PROGRESS,
                    humanize_api_error(ErrorCode.DISTILL_IN_PROGRESS),
                    409,
                    data={
                        "raw_detail": (
                            f"distill already pending for user {self.user.id} "
                            f"organization {wid}"
                        ),
                    },
                )

            portrait.last_distill_status = UserPortrait.DistillStatus.PENDING
            portrait.last_distill_error = ""
            portrait.save(
                using=USER_PORTRAIT_DB,
                update_fields=[
                    "last_distill_status",
                    "last_distill_error",
                    "updated_at",
                ],
            )
        return portrait

    @transaction.atomic(using=USER_PORTRAIT_DB)
    def commit_distill_result(
        self,
        organization_id: str,
        agent_id: str,
        new_content_md: str,
        trigger_reason: str = "scheduled",
        input_summary: Optional[Dict[str, Any]] = None,
    ) -> UserPortrait:
        """蒸馏成功后调用：归档旧 content_md → 写入新 content_md → 更新元数据。

        原子操作：snapshot + portrait 更新在同一事务里，保证不会出现"画像更新了但快照没归档"。

        权限语义：**主路径不做成员校验**——只由 ``PortraitDistillService.run()``
        在调过 ``mark_distill_pending``（已做成员校验）之后调用，所以这里
        信任调用方。已知后果：如果蒸馏执行中途用户被踢出 Organization，本次
        ``commit`` 仍会落库（依赖任务启动时的授权快照，是有意的信任边界）；
        踢人即停写需要 task 层在 commit 前再补成员校验，不在本波范围。
        如果未来开放给外部 API 路径，必须在调用前补一次 ``_check_organization_membership``。
        """
        self._check_user()
        wid = _normalize_organization_id(organization_id)
        aid = _normalize_agent_id(agent_id)

        portrait = (
            self._portrait_qs()
            .select_for_update()
            .filter(user_id=self.user.id, organization_id=wid, agent_id=aid)
            .first()
        )
        if not portrait:
            # 防御性：理论上 mark_distill_pending 已经创建过
            portrait = self.get_or_create_portrait(wid, aid)
            portrait = (
                self._portrait_qs()
                .select_for_update()
                .filter(user_id=self.user.id, organization_id=wid, agent_id=aid)
                .first()
            )

        # 1. 归档旧版本（即使 content_md 是空的也归档，便于追溯"什么时候第一次有了画像"）
        UserPortraitSnapshot.objects.using(USER_PORTRAIT_DB).create(
            portrait=portrait,
            version_at_snapshot=portrait.version,
            content_md=portrait.content_md,
            trigger_reason=trigger_reason,
            input_summary=input_summary or {},
        )

        # 2. 更新 portrait 主体
        portrait.content_md = new_content_md
        portrait.version = (portrait.version or 0) + 1
        portrait.last_distilled_at = timezone.now()
        portrait.last_distill_status = UserPortrait.DistillStatus.IDLE
        portrait.last_distill_error = ""
        # 蒸馏成功后清空 pending_hints（hint 已被融入新画像）
        portrait.pending_hints = []
        portrait.save(
            using=USER_PORTRAIT_DB,
            update_fields=[
                "content_md",
                "version",
                "last_distilled_at",
                "last_distill_status",
                "last_distill_error",
                "pending_hints",
                "updated_at",
            ],
        )
        return portrait

    def mark_distill_failed(
        self, organization_id: str, agent_id: str, error: str
    ) -> UserPortrait:
        """蒸馏失败时调用：保留旧 content_md，仅更新状态和错误信息。

        重要：失败时不能清空 pending_hints（用户的 hint 必须保留以便下次重试）。

        权限语义：实际通过 ``get_or_create_portrait`` 间接走 ``_check_organization_membership``，
        所以即便误从外部入口调用也不会绕过成员校验。生产路径上由
        ``PortraitDistillService.run()`` 在 catch 分支调用，此时
        ``mark_distill_pending`` 已通过成员校验，二次校验也不会报错（幂等）。
        """
        self._check_user()
        wid = _normalize_organization_id(organization_id)
        aid = _normalize_agent_id(agent_id)
        portrait = self.get_or_create_portrait(wid, aid)
        portrait.last_distill_status = UserPortrait.DistillStatus.FAILED
        portrait.last_distill_error = (error or "")[:2000]  # 防止超长错误信息
        portrait.save(
            using=USER_PORTRAIT_DB,
            update_fields=[
                "last_distill_status",
                "last_distill_error",
                "updated_at",
            ],
        )
        return portrait

    # ── 级联清理（决策 N3 / N4） ────────────────────

    @classmethod
    def delete_portraits_for_organization(cls, organization_id: str) -> int:
        """决策 N3：Organization 删除时调用，清理该 Organization 内所有用户的画像。

        通常在 Organization 删除的 signal handler 里调用。
        返回删除的画像数量（用于审计日志）。
        """
        wid = _normalize_organization_id(organization_id)
        count, _ = UserPortrait.objects.using(USER_PORTRAIT_DB).filter(
            organization_id=wid,
        ).delete()
        if count:
            logger.info(
                "[Portrait] Cleaned up %d portraits for deleted organization %s",
                count, wid,
            )
        return count

    @classmethod
    def delete_portrait_for_member(cls, user_id: str, organization_id: str) -> bool:
        """决策 N4：成员退出 Organization 时调用，清理该成员在该 Organization 的画像。

        通常在 OrganizationMember 删除的 signal handler 里调用。
        画像 per-Agent 化后一个成员在同一 Organization 下可有多份 per-Agent
        画像——按 (user, organization) 一次性删除该成员名下全部（跨 Agent）画像。
        返回是否删除了画像（False 表示该成员本来就没画像）。
        """
        wid = _normalize_organization_id(organization_id)
        count, _ = UserPortrait.objects.using(USER_PORTRAIT_DB).filter(
            user_id=user_id,
            organization_id=wid,
        ).delete()
        if count:
            logger.info(
                "[Portrait] Cleaned up %d portrait(s) for user %s exiting organization %s",
                count, user_id, wid,
            )
        return count > 0

    @classmethod
    def delete_portraits_for_agent(cls, agent_id: str) -> int:
        """#4090/#4118：Agent 删除时清理该 Agent 的全部 per-Agent 画像（所有 subject 用户）。

        画像用 UUIDField 引用 Agent（无 DB 外键），Agent 硬删不会 DB 级联删画像，
        故需 signal 显式清理，避免留下召不回、也清不掉的孤儿画像。
        返回删除的画像数量（用于审计日志）。
        """
        if not _is_valid_uuid(agent_id):
            logger.warning(
                "[Portrait] delete_portraits_for_agent got invalid agent_id: %r", agent_id
            )
            return 0
        count, _ = UserPortrait.objects.using(USER_PORTRAIT_DB).filter(
            agent_id=str(agent_id),
        ).delete()
        if count:
            logger.info(
                "[Portrait] Cleaned up %d portrait(s) for deleted agent %s",
                count, agent_id,
            )
        return count
