"""
低余额预警服务 (PR 2)

per-organization 多级阈值检测 + 邮件通知。
阈值存储在 OrganizationBillingPolicy.metadata 中，解决 BillingRuntimeConfig
全局单例不支持 per-organization 配置的问题 (BLOCK-2)。

阈值以绝对点券值配置（warning_credits / critical_credits）。历史版本按
月度配额百分比配置（warning_pct / critical_pct），读取时懒兼容：无新 key
时按当前月度配额换算成等效绝对值展示，用户保存后即固化为绝对值。
TE-1: 缓存 TTL 增加 jitter 防止 thundering herd。
"""

from __future__ import annotations

import logging
import random
from dataclasses import dataclass
from decimal import Decimal
from typing import Optional

from django.core.cache import cache

logger = logging.getLogger(__name__)

_DEFAULT_WARNING_CREDITS = Decimal("50")
_DEFAULT_CRITICAL_CREDITS = Decimal("10")

_DEDUP_TTL_WARNING = 86400
_DEDUP_TTL_CRITICAL = 43200

_METADATA_KEY = "low_balance_alert"
_LEGACY_PCT_KEYS = ("warning_pct", "critical_pct")


@dataclass(frozen=True)
class LowBalanceThresholds:
    warning_credits: Decimal
    critical_credits: Decimal
    email_enabled: bool


class LowBalanceAlertService:

    @classmethod
    def get_thresholds(cls, organization_id: str) -> LowBalanceThresholds:
        """读取 per-organization 低余额阈值配置（绝对点券值）。

        优先级：metadata 绝对值 → 老版百分比懒兼容换算 → 默认 50/10。
        """
        cache_key = f"billing:low_bal_cfg:{organization_id}"
        jitter = random.randint(0, 30)
        cached = cache.get(cache_key)
        if cached is not None:
            return cached

        warning_credits: Optional[Decimal] = None
        critical_credits: Optional[Decimal] = None
        legacy_warning_pct: Optional[Decimal] = None
        legacy_critical_pct: Optional[Decimal] = None
        email_enabled = True

        try:
            from apps.services.billing.models import OrganizationBillingPolicy

            policy = OrganizationBillingPolicy.objects.filter(
                organization_id=organization_id,
            ).only("metadata").first()
            if policy and policy.metadata:
                cfg = policy.metadata.get(_METADATA_KEY) or {}
                if "warning_credits" in cfg:
                    warning_credits = Decimal(str(cfg["warning_credits"]))
                if "critical_credits" in cfg:
                    critical_credits = Decimal(str(cfg["critical_credits"]))
                if "warning_pct" in cfg:
                    legacy_warning_pct = Decimal(str(cfg["warning_pct"]))
                if "critical_pct" in cfg:
                    legacy_critical_pct = Decimal(str(cfg["critical_pct"]))
                if "email_enabled" in cfg:
                    email_enabled = bool(cfg["email_enabled"])
        except Exception as exc:
            logger.warning(
                "[LowBalanceAlert] 读取阈值配置失败，使用默认值: wt=%s err=%s",
                organization_id, exc,
            )

        # 懒兼容：仅当没有绝对值新 key、但存在历史百分比配置时，按当前
        # 月度配额换算等效绝对值（只读展示，不写回；用户保存后固化为绝对值）。
        if (warning_credits is None or critical_credits is None) and (
            legacy_warning_pct is not None or legacy_critical_pct is not None
        ):
            monthly_credits = cls._resolve_monthly_credits(organization_id)
            if monthly_credits > 0:
                if warning_credits is None and legacy_warning_pct is not None:
                    warning_credits = (
                        monthly_credits * legacy_warning_pct / Decimal("100")
                    ).quantize(Decimal("0.01"))
                if critical_credits is None and legacy_critical_pct is not None:
                    critical_credits = (
                        monthly_credits * legacy_critical_pct / Decimal("100")
                    ).quantize(Decimal("0.01"))

        if warning_credits is None:
            warning_credits = _DEFAULT_WARNING_CREDITS
        if critical_credits is None:
            critical_credits = _DEFAULT_CRITICAL_CREDITS

        result = LowBalanceThresholds(
            warning_credits=warning_credits,
            critical_credits=critical_credits,
            email_enabled=email_enabled,
        )
        cache.set(cache_key, result, 300 + jitter)
        return result

    @classmethod
    def set_thresholds(
        cls,
        organization_id: str,
        *,
        warning_credits: Optional[Decimal] = None,
        critical_credits: Optional[Decimal] = None,
        email_enabled: Optional[bool] = None,
    ) -> LowBalanceThresholds:
        """更新 per-organization 低余额阈值配置（绝对点券值）。"""
        from django.db import transaction

        from apps.services.billing.models import OrganizationBillingPolicy

        with transaction.atomic():
            policy = (
                OrganizationBillingPolicy.objects.select_for_update()
                .filter(organization_id=organization_id)
                .first()
            )
            md = dict(policy.metadata) if policy and policy.metadata else {}
            cfg = dict(md.get(_METADATA_KEY) or {})

            if warning_credits is not None:
                cfg["warning_credits"] = str(warning_credits)
            if critical_credits is not None:
                cfg["critical_credits"] = str(critical_credits)
            if email_enabled is not None:
                cfg["email_enabled"] = email_enabled

            # 写入绝对值后清掉历史百分比 key，避免两套口径并存
            if warning_credits is not None or critical_credits is not None:
                for legacy_key in _LEGACY_PCT_KEYS:
                    cfg.pop(legacy_key, None)

            md[_METADATA_KEY] = cfg

            if policy:
                policy.metadata = md
                policy.save(update_fields=["metadata", "updated_at"])
            else:
                OrganizationBillingPolicy.objects.create(
                    organization_id=organization_id,
                    metadata=md,
                )

        cache.delete(f"billing:low_bal_cfg:{organization_id}")
        return cls.get_thresholds(organization_id)

    @classmethod
    def clear_notify_dedup(cls, organization_id: str) -> None:
        """清除 warning/critical 分级去重锁（阈值变更后允许重新写铃铛 / 推 WS）。"""
        if not organization_id:
            return
        cache.delete(f"billing:low_bal:warning:{organization_id}")
        cache.delete(f"billing:low_bal:critical:{organization_id}")

    @classmethod
    def did_credit_thresholds_change(
        cls,
        before: LowBalanceThresholds,
        after: LowBalanceThresholds,
    ) -> bool:
        """warning/critical 绝对值是否真变（忽略 email_enabled 等非阈值字段）。

        设置页每次保存都会提交非空阈值；若只按「请求字段非 None」补检，
        同值重复保存或只改邮件开关会清去重锁并反复写铃铛 / 推 WS。
        """
        return (
            before.warning_credits != after.warning_credits
            or before.critical_credits != after.critical_credits
        )

    @classmethod
    def resolve_alertable_credits(
        cls,
        organization_id: str,
        *,
        model_instance=None,
    ) -> Optional[Decimal]:
        """低余额告警用的「仍可消耗点券」= 钱包可用 + 本月套餐剩余 + 当前模型定向点券。

        与聊天发送 guard / Electron toast 补检口径对齐：新建免费组织钱包为 0、
        但月度 LLM 额度仍在时，不应按「余额严重不足」误报。同理，组织持有当前模型
        的定向点券时也还能继续对话，不能只看钱包 + 月度就弹「余额不足」。

        ``model_instance`` 只在调用方明确知道本次用哪个模型时传入（如 Agent 对话
        扣费后）；定向点券按模型隔离，不能把其他模型的额度混进判定，所以组织级
        巡检（阈值变更补检 / 日扫）不传，按保守口径只算钱包 + 月度。

        无钱包记录时返回 None（调用方跳过）；读月度失败时按 0 计入。
        """
        if not organization_id:
            return None

        try:
            from apps.users.wallet.models import OrganizationWallet

            wallet = OrganizationWallet.objects.filter(
                organization_id=organization_id,
            ).first()
            if wallet is None:
                return None
            wallet_available = wallet.get_available_credits_precise()
        except Exception as exc:
            logger.warning(
                "[LowBalanceAlert] 读钱包失败: wt=%s err=%s",
                organization_id,
                exc,
            )
            return None

        monthly_remaining = Decimal("0")
        try:
            from apps.services.billing.services.llm_budget_service import (
                OrganizationLlmBudgetService,
            )

            monthly_remaining = OrganizationLlmBudgetService.get_remaining_quota_credits(
                organization_id,
            )
        except Exception as exc:
            logger.warning(
                "[LowBalanceAlert] 读月度剩余失败，按 0 计入: wt=%s err=%s",
                organization_id,
                exc,
            )

        provider_credits = Decimal("0")
        if model_instance is not None:
            try:
                from apps.services.billing.services.provider_credit_service import (
                    resolve_model_provider_credits,
                )

                provider_credits = resolve_model_provider_credits(
                    organization_id,
                    model_instance,
                )
            except Exception as exc:
                logger.warning(
                    "[LowBalanceAlert] 读定向点券失败，按 0 计入: wt=%s err=%s",
                    organization_id,
                    exc,
                )

        return wallet_available + monthly_remaining + provider_credits

    @classmethod
    def check_organization_and_notify(
        cls,
        organization_id: str,
        *,
        model_instance=None,
        source: Optional[str] = None,
    ) -> Optional[str]:
        """按可消耗点券检测并提醒（推荐调用入口）。

        ``source`` 标记本次检测的触发来源，随事件下发给各端按语义分流：
        Electron 只对 ``agent_conversation`` 弹 toast，组织级巡检只写铃铛。
        """
        balance = cls.resolve_alertable_credits(
            organization_id,
            model_instance=model_instance,
        )
        if balance is None:
            return None
        return cls.check_and_notify(organization_id, balance, source=source)

    @classmethod
    def recheck_after_threshold_change(cls, organization_id: str) -> Optional[str]:
        """阈值配置变更后：清去重，按可消耗点券重新检测并写铃铛 / 推 WS。

        覆盖「改了预警数值、余额已低于新阈值，但铃铛不再出现新提醒」的验收路径。
        钱包缺失或读失败时静默跳过，不阻断配置保存。
        调用方须先用 ``did_credit_thresholds_change`` 确认阈值真变。
        """
        if not organization_id:
            return None

        cls.clear_notify_dedup(organization_id)
        return cls.check_organization_and_notify(organization_id)

    @classmethod
    def resolve_if_healthy(cls, organization_id: str) -> int:
        """余额回升后消警：高于预警阈值则清去重锁并标已读未读 ``balance_low``。

        供点券充值 / grant 等余额增加副作用调用。仍低于预警阈值时 no-op，
        保留既有铃铛警示。读钱包失败时静默跳过，不阻断入账。
        Returns:
            被标已读的通知条数；未消警时为 0。
        """
        if not organization_id:
            return 0

        balance = cls.resolve_alertable_credits(organization_id)
        if balance is None:
            return 0

        thresholds = cls.get_thresholds(organization_id)
        if balance < thresholds.warning_credits:
            return 0

        cls.clear_notify_dedup(organization_id)
        try:
            from apps.services.notification.services.notification_service import (
                NotificationService,
            )

            marked = NotificationService.mark_balance_low_read_for_organization(
                organization_id,
            )
        except Exception as exc:
            logger.warning(
                "[LowBalanceAlert] 消警标已读失败: wt=%s err=%s",
                organization_id,
                exc,
            )
            return 0

        if marked:
            logger.info(
                "[LowBalanceAlert] 余额已恢复，已消警: wt=%s balance=%.2f marked=%d",
                organization_id,
                balance,
                marked,
            )
        return marked

    @classmethod
    def check_and_notify(
        cls,
        organization_id: str,
        current_balance: Decimal,
        *,
        source: Optional[str] = None,
    ) -> Optional[str]:
        """检查余额并在低于阈值时按端分工提醒（warning 24h / critical 12h 分级去重）。

        单一检测权威：阈值读 per-organization 配置（warning_credits/critical_credits），
        分级判定 + 分级去重都只在此处一份。命中后**同一把去重锁**下发两个出口：

        - **移动端（iOS / Android / 鸿蒙）**：组织级 WS ``billing.balance_low``，各端弹 toast。
        - **Electron 桌面端**：``publish_billing_event`` 的账户通知适配器给 Owner 写入
          消息中心，并按通知偏好投递桌面提醒。

        Owner 口径与每日邮件预警对齐（``resolve_owner_contact`` → OrganizationMember(role="owner")）。
        邮件预警走独立链路（``daily_low_balance_email_alert``），与此互不影响。

        Returns:
            None — 余额正常
            "warning" — 低于预警阈值
            "critical" — 低于严重阈值
        """
        if not organization_id:
            return None

        thresholds = cls.get_thresholds(organization_id)

        level: Optional[str] = None
        threshold_credits = Decimal("0")

        if current_balance < thresholds.critical_credits:
            level = "critical"
            threshold_credits = thresholds.critical_credits
        elif current_balance < thresholds.warning_credits:
            level = "warning"
            threshold_credits = thresholds.warning_credits

        if level is None:
            return None

        dedup_ttl = (
            _DEDUP_TTL_CRITICAL if level == "critical" else _DEDUP_TTL_WARNING
        )
        dedup_key = f"billing:low_bal:{level}:{organization_id}"
        if cache.get(dedup_key):
            return level

        cache.set(dedup_key, True, dedup_ttl)

        payload = {
            "level": level,
            "current_balance": float(current_balance),
            "threshold": float(threshold_credits),
            "warning_threshold": float(thresholds.warning_credits),
            "critical_threshold": float(thresholds.critical_credits),
        }
        if source:
            payload["source"] = source

        # 移动端出口：组织级 WS（Electron 端已不消费其 toast）
        try:
            from apps.services.billing.ws_events import publish_billing_event

            publish_billing_event(organization_id, "balance_low", payload)
        except Exception as exc:
            logger.warning(
                "[LowBalanceAlert] WS 推送失败: wt=%s level=%s err=%s",
                organization_id, level, exc,
            )

        logger.info(
            "[LowBalanceAlert] %s 预警: wt=%s balance=%.2f threshold=%.2f",
            level, organization_id, current_balance, threshold_credits,
        )
        return level

    @classmethod
    def resolve_owner_contact(cls, organization_id: str) -> dict:
        """解析组织 Owner 的邮件收件信息（供 API 展示与发信共用）。"""
        from apps.tabtinspace.models import OrganizationMember
        from apps.users.auth.models import User
        from apps.users.auth.utils import mask_email

        owner_member = (
            OrganizationMember.objects.filter(
                organization_id=organization_id,
                role="owner",
            )
            .order_by("joined_at")
            .first()
        )
        if not owner_member:
            return {
                "owner_user_id": None,
                "owner_has_email": False,
                "owner_email_masked": None,
            }

        user = User.objects.filter(id=owner_member.user_id).first()
        email = getattr(user, "email", None) if user else None
        if not email:
            return {
                "owner_user_id": str(owner_member.user_id),
                "owner_has_email": False,
                "owner_email_masked": None,
            }

        return {
            "owner_user_id": str(owner_member.user_id),
            "owner_has_email": True,
            "owner_email_masked": mask_email(email),
        }

    @classmethod
    def send_low_balance_email(
        cls,
        organization_id: str,
        current_balance: Decimal,
        level: str,
        thresholds: LowBalanceThresholds,
    ) -> bool:
        """给 organization owner 发送低余额邮件。"""
        try:
            from apps.tabtinspace.models import OrganizationMember

            owner_member = (
                OrganizationMember.objects.filter(
                    organization_id=organization_id,
                    role="owner",
                )
                .order_by("joined_at")
                .first()
            )
            if not owner_member:
                logger.info(
                    "[LowBalanceAlert] 无 owner，跳过邮件: wt=%s", organization_id,
                )
                return False

            from apps.users.auth.models import User

            user = User.objects.filter(id=owner_member.user_id).first()
            if not user or not getattr(user, "email", None):
                logger.info(
                    "[LowBalanceAlert] owner 无邮箱: wt=%s user=%s",
                    organization_id, owner_member.user_id,
                )
                return False

            from apps.tabtinspace.models import Organization

            organization = Organization.objects.filter(id=organization_id).first()
            organization_name = organization.name if organization else organization_id[:8]

            threshold_value = (
                thresholds.critical_credits
                if level == "critical"
                else thresholds.warning_credits
            )

            subject = (
                f"[TabTin] {'紧急' if level == 'critical' else ''}低余额预警 - {organization_name}"
            )
            body_lines = [
                f"您好 {getattr(user, 'display_name', '') or user.email}，",
                "",
                f"您的团队「{organization_name}」当前余额为 {current_balance:.2f} credits，"
                f"已低于{'严重' if level == 'critical' else '预警'}阈值 {threshold_value:.2f} credits。",
                "",
            ]
            if level == "critical":
                body_lines.append(
                    "余额即将耗尽，AI 服务可能随时中断。请立即充值以避免服务停摆。"
                )
            else:
                body_lines.append(
                    "建议及时充值，避免余额耗尽导致服务中断。"
                )
            body_lines.extend(["", "—— TabTin 计费系统"])
            body = "\n".join(body_lines)

            from django.core.mail import send_mail

            # fail_silently=False：SMTP 失败必须返回 False，避免 emailed 指标虚高
            sent = send_mail(
                subject=subject,
                message=body,
                from_email=None,
                recipient_list=[user.email],
                fail_silently=False,
            )
            if not sent:
                logger.error(
                    "[LowBalanceAlert] 邮件发送返回 0: wt=%s owner=%s level=%s",
                    organization_id, user.email, level,
                )
                return False

            logger.info(
                "[LowBalanceAlert] 邮件已发送: wt=%s owner=%s level=%s",
                organization_id, user.email, level,
            )
            return True
        except Exception as exc:
            logger.error(
                "[LowBalanceAlert] 邮件发送失败: wt=%s err=%s",
                organization_id, exc,
                exc_info=True,
            )
            return False

    @staticmethod
    def _resolve_monthly_credits(organization_id: str) -> Decimal:
        """解析 organization 的月度credits配额，用于计算动态阈值。"""
        try:
            from apps.services.billing.services.policy_service import (
                OrganizationBillingPolicyService,
            )

            snapshot = OrganizationBillingPolicyService.get_entitlement_snapshot(
                organization_id,
            )
            credits = Decimal(str(snapshot.get("included_llm_credits_monthly", 0)))
            if credits > 0:
                return credits
        except Exception:
            pass

        try:
            from apps.users.membership.models import OrganizationMembership

            wm = (
                OrganizationMembership.objects.filter(
                    organization_id=organization_id,
                    status="active",
                )
                .select_related("tier")
                .order_by("-start_date")
                .first()
            )
            if wm and wm.tier:
                tier_credits = getattr(
                    wm.tier, "included_llm_credits_monthly", None,
                )
                if tier_credits and Decimal(str(tier_credits)) > 0:
                    return Decimal(str(tier_credits))
        except Exception:
            pass

        return Decimal("0")
