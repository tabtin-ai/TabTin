"""
会员体系常量定义

将 feature key 集中定义，避免魔法字符串散落在 seed data / models / check_feature 调用中。
参考: MEM-15 (A1-15)
"""


class MembershipFeature:
    """
    功能权限键常量 — 用于 tier.features dict 的键名。

    使用示例:
        # seed data
        "features": {
            MembershipFeature.API_ACCESS: True,
            MembershipFeature.ADVANCED_EXPORT: False,
        }

        # 检查
        QuotaService().check_feature(
            organization_id=organization_id,
            feature_key=MembershipFeature.API_ACCESS,
        )

    [D6] 当前策略：用户增长期暂不执行 feature gate；
    api_access / advanced_export 等基础能力对所有等级开放。
    中期仅对企业级功能（sso、audit_log）加门控。
    """

    # ── 基础功能（所有付费等级及免费版均开放）──
    API_ACCESS = "api_access"
    """Open API 访问权限"""

    # ── 高级功能（basic 及以上）──
    ADVANCED_EXPORT = "advanced_export"
    """高级导出（PDF / Excel 带格式 / ZIP 批量）"""

    PRIORITY_SUPPORT = "priority_support"
    """优先技术支持"""

    CUSTOM_BRANDING = "custom_branding"
    """自定义品牌/Logo"""

    # ── 企业级功能（enterprise 专属，[D6] 中期门控）──
    SSO = "sso"
    """单点登录（SAML/OIDC）"""

    AUDIT_LOG = "audit_log"
    """操作审计日志"""

    DEDICATED_SUPPORT = "dedicated_support"
    """专属客户成功经理"""

    # ── 所有已知 feature key 集合（用于合法性校验）──
    ALL = frozenset({
        API_ACCESS,
        ADVANCED_EXPORT,
        PRIORITY_SUPPORT,
        CUSTOM_BRANDING,
        SSO,
        AUDIT_LOG,
        DEDICATED_SUPPORT,
    })


# 各会员等级的建议默认 features（与 seed_membership_tiers.py 保持同步）
TIER_DEFAULT_FEATURES = {
    "free": {
        MembershipFeature.API_ACCESS: True,
        MembershipFeature.ADVANCED_EXPORT: False,
    },
    "basic": {
        MembershipFeature.API_ACCESS: True,
        MembershipFeature.ADVANCED_EXPORT: True,
    },
    "pro": {
        MembershipFeature.API_ACCESS: True,
        MembershipFeature.ADVANCED_EXPORT: True,
        MembershipFeature.PRIORITY_SUPPORT: True,
        MembershipFeature.CUSTOM_BRANDING: True,
    },
    "enterprise": {
        MembershipFeature.API_ACCESS: True,
        MembershipFeature.ADVANCED_EXPORT: True,
        MembershipFeature.PRIORITY_SUPPORT: True,
        MembershipFeature.CUSTOM_BRANDING: True,
        MembershipFeature.SSO: True,
        MembershipFeature.AUDIT_LOG: True,
        MembershipFeature.DEDICATED_SUPPORT: True,
    },
}


# ── 支付方式白名单（MEM-32）──
ALLOWED_PAYMENT_METHODS = frozenset({"alipay", "wechat"})
"""
当前支持的支付方式。
新增支付渠道（如 stripe）时只需在此处添加，api.py 的校验逻辑无需修改。
参考: MEM-32 (A2-16)
"""
