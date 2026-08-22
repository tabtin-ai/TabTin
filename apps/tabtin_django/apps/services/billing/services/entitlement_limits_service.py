"""Unified entitlement limit checks for non-LLM resources.

The product billing rule is that documents, tables, groups, storage and seats
are entitlement limits, not wallet consumption. This service is a small facade
over the existing quota/storage/seat implementations so resource creation paths
can call one backend gate.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Dict, Optional

from apps.users.membership.exceptions import MembershipException, QuotaExceededError
from apps.users.membership.services.quota_service import QuotaService

logger = logging.getLogger(__name__)


ENTITLEMENT_MESSAGES = {
    "max_tables": ("ENTITLEMENT_TABLE_LIMIT_EXCEEDED", "当前套餐表格额度已用完，请升级套餐或购买表格扩容包。"),
    "max_documents": ("ENTITLEMENT_DOCUMENT_LIMIT_EXCEEDED", "当前套餐文档额度已用完，请升级套餐或购买文档扩容包。"),
    "max_groups": ("ENTITLEMENT_GROUP_LIMIT_EXCEEDED", "当前套餐群组额度已用完，请升级套餐或购买群组扩容包。"),
    "max_members": ("ENTITLEMENT_MEMBER_LIMIT_EXCEEDED", "当前套餐成员席位已用完，请升级套餐或购买席位扩容包。"),
}


@dataclass
class EntitlementLimitExceeded(ValueError):
    code: str
    message: str
    quota_key: str
    used: int
    limit: int
    plan_limit: int
    addon_limit: int = 0

    def __post_init__(self):
        super().__init__(self.message)

    def to_response_data(self) -> Dict[str, Any]:
        return {
            "quotaKey": self.quota_key,
            "used": self.used,
            "limit": self.limit,
            "planLimit": self.plan_limit,
            "addonLimit": self.addon_limit,
            "upgradeOptions": ["pro"],
        }


class EntitlementLimitsService:
    """Facade for plan/add-on entitlement limit checks."""

    @classmethod
    def get_effective_entitlements(cls, organization_id: str) -> Dict[str, Any]:
        tier, source = QuotaService().get_effective_tier(organization_id=organization_id)
        if tier is None:
            return {
                "organization_id": organization_id,
                "source": source,
                "limits": {},
            }
        limits = {
            "max_tables": getattr(tier, "max_tables", None),
            "max_documents": getattr(tier, "max_documents", None),
            "max_groups": getattr(tier, "max_groups", None),
            "max_members": getattr(tier, "max_members", None),
            "max_records_per_table": getattr(tier, "max_records_per_table", None),
            "max_conversations_per_day": getattr(tier, "max_conversations_per_day", None),
            "storage_quota_bytes": getattr(tier, "included_storage_bytes", 0),
            "recycle_retention_days": getattr(tier, "trash_retention_days", None),
        }
        return {
            "organization_id": organization_id,
            "source": source,
            "tier_id": str(getattr(tier, "id", "") or ""),
            "tier_type": getattr(tier, "tier_type", ""),
            "limits": limits,
        }

    @classmethod
    def _check_quota(cls, *, organization_id: str, quota_key: str, increment: int = 1, actor=None) -> Dict[str, Any]:
        try:
            result = QuotaService().check_quota(
                quota_type=quota_key,
                increment=increment,
                organization_id=organization_id,
                actor=actor,
            )
        except QuotaExceededError as exc:
            code, message = ENTITLEMENT_MESSAGES.get(
                quota_key,
                ("ADDON_REQUIRED", str(exc)),
            )
            limit = int(exc.limit or 0)
            used = int(exc.current or 0)
            raise EntitlementLimitExceeded(
                code=code,
                message=message,
                quota_key=quota_key,
                used=used,
                limit=limit,
                plan_limit=limit,
            ) from exc
        except MembershipException as exc:
            if "未找到可用的会员等级" not in str(exc):
                raise
            logger.warning(
                "[EntitlementLimits] missing free tier; fail-open quota check: organization=%s quota=%s actor=%s",
                organization_id,
                quota_key,
                getattr(actor, "id", actor),
            )
            return {
                "allowed": True,
                "code": None,
                "message": None,
                "quota_key": quota_key,
                "used": 0,
                "limit": -1,
                "plan_limit": -1,
                "addon_limit": 0,
                "upgrade_options": ["pro"],
                "source": "missing_tier_fail_open",
            }

        limit = int(result.get("limit") or 0)
        current = int(result.get("current") or 0)
        return {
            "allowed": True,
            "code": None,
            "message": None,
            "quota_key": quota_key,
            "used": current,
            "limit": limit,
            "plan_limit": limit,
            "addon_limit": 0,
            "upgrade_options": ["pro"],
            "source": result.get("source"),
        }

    @classmethod
    def check_table_limit(cls, organization_id: str, *, actor=None) -> Dict[str, Any]:
        return cls._check_quota(organization_id=organization_id, quota_key="max_tables", actor=actor)

    @classmethod
    def check_document_limit(cls, organization_id: str, *, actor=None) -> Dict[str, Any]:
        return cls._check_quota(organization_id=organization_id, quota_key="max_documents", actor=actor)

    @classmethod
    def check_group_limit(cls, organization_id: str, *, actor=None) -> Dict[str, Any]:
        return cls._check_quota(organization_id=organization_id, quota_key="max_groups", actor=actor)

    @classmethod
    def check_member_seat_limit(cls, organization_id: str, *, actor=None) -> Dict[str, Any]:
        return cls._check_quota(organization_id=organization_id, quota_key="max_members", actor=actor)

    @classmethod
    def check_storage_limit(
        cls,
        organization_id: str,
        incoming_bytes: int,
        *,
        file_id: Optional[str] = None,
        user_id: str = "",
        biz_type: str = "entitlement_storage_check",
        biz_id: str = "",
    ) -> Dict[str, Any]:
        from apps.services.billing.services.storage_service import OrganizationStorageBillingService

        OrganizationStorageBillingService.assert_storage_upload_allowed(
            organization_id=organization_id,
            incoming_bytes=int(incoming_bytes or 0),
        )
        return {
            "allowed": True,
            "code": None,
            "message": None,
            "quota_key": "storage_quota_bytes",
            "incoming_bytes": int(incoming_bytes or 0),
        }

    @classmethod
    def get_recycle_retention_days(cls, organization_id: str) -> int:
        entitlements = cls.get_effective_entitlements(organization_id)
        return int((entitlements.get("limits") or {}).get("recycle_retention_days") or 0)
