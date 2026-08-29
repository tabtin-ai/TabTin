"""
组织管理服务
"""
import logging
import threading
from typing import Optional, Dict, Any, Callable, NamedTuple, Type
from uuid import UUID, uuid4
from django.conf import settings
from django.core.exceptions import ImproperlyConfigured
from django.db import IntegrityError, models as dj_models, transaction
from django.db.utils import OperationalError, ProgrammingError
from django.db.models import Count, Q, QuerySet, Sum
from django.contrib.auth import get_user_model
from django.utils import timezone

from apps.services.common.db_router import postgres_app_db_alias
from apps.services.common.device_capability_registry import is_user_level_device
from apps.services.common.agent_governance_resolver import (
    ORG_ALLOW_MEMBER_YOLO_DEFAULT,
    ORG_ALLOW_MEMBER_YOLO_KEY,
)
from apps.tabtinspace.models import (
    Agent,
    Device,
    Organization,
    OrganizationMember,
    OrganizationMemberIdentitySnapshot,
    OrganizationProviderCreditClaim,
    Space,
    Workspace,
)
from apps.tabdata.models import Table
from .base import BaseService, ROLE_LEVELS, ORGANIZATION_ASSIGNABLE_ROLES, ServiceError
from .onboarding_defaults import (
    DEFAULT_ONBOARDING_AGENT_NAME,
    DEFAULT_ONBOARDING_SPACE_DESCRIPTION,
    DEFAULT_ONBOARDING_SPACE_NAME,
    build_system_default_agent_settings,
    resolve_onboarding_defaults,
)

User = get_user_model()
logger = logging.getLogger(__name__)


class ResourceBinding(NamedTuple):
    """声明一个需要随 organization/space 删除时清理的业务资源模型。

    删除路径（delete_*_resources）不使用 count_label / count_filter，
    会无条件删除全部匹配记录（含 archived/inactive）。

    统计路径使用方式：
    - count_label: admin 面板展示的计数 key。None 表示不纳入列表统计和 Impact 预检。
    - count_filter: 仅在列表序列化统计（_build_space_resource_count_map）中使用，
      用于过滤活跃资源（如 status='active'）。Impact 预检不使用此字段，
      以确保 dry_run 展示的数字与实际删除量一致。
    """
    model: Type[dj_models.Model]
    ws_field: Optional[str]
    as_field: Optional[str]
    ws_transform: Optional[Callable] = None
    count_label: Optional[str] = None
    count_filter: Optional[Dict] = None


def _get_organization_resource_models() -> list[ResourceBinding]:
    """返回需要在 organization 删除时清理的业务资源模型注册表。

    同时作为 admin 面板 count 统计的 Single Source of Truth。
    Space 是本地执行现场，不再拥有云资源；as_field 只保留给真正的
    Space-local 关系/运行态记录，不能用于删除 Table/Document 等团队资源。
    """
    from apps.tabdata.models import Table
    from apps.tabdoc.models import Document
    from apps.tabslide.models import SlideProject
    # 单根契约（见 docs/single-root-space-prd.md §2.7）：CodeProject 模型已废弃，
    # tabcode 不再有云侧资源实体；resource binding 移除。
    from apps.tabmemo.models import Memo
    from apps.tabtinspace.models import ContextItem
    from apps.tabdata.models_webhook import TableWebhook
    from apps.collab.models import SpaceCheckpoint, VersionHistory
    from apps.tins.models import Tin, TinInstance

    return [
        ResourceBinding(Table,          'organization_id', None, None, 'table_count',        {'is_archived': False}),
        ResourceBinding(Document,       'organization_id', None, None, 'document_count',     {'status': 'active'}),
        ResourceBinding(SlideProject,   'organization_id', None, None, 'ppt_count',          {'status': 'active'}),
        ResourceBinding(Memo,           'organization_id', None, None, 'memo_count',         {'status': 'active'}),
        ResourceBinding(ContextItem,    None,           'workspace_id', None, 'context_item_count', {'is_archived': False}),
        ResourceBinding(TableWebhook,   'organization_id',  None),
        ResourceBinding(SpaceCheckpoint,'organization_id', 'space_id'),
        ResourceBinding(VersionHistory, 'organization_id', None),
        ResourceBinding(Tin,            'organization_id', None, None, 'tin_count',          {'status': 'active'}),
        ResourceBinding(TinInstance,    'organization_id', None),
    ]


class OrganizationService(BaseService):
    """
    组织管理服务
    """

    @staticmethod
    def provision_community_membership(organization_id: str) -> None:
        if getattr(settings, "TABTIN_EDITION", "saas") != "community":
            return
        from apps.maintenance.community_bootstrap import (
            ensure_community_organization_membership,
        )

        ensure_community_organization_membership(organization_id)

    @staticmethod
    def _normalize_public_logo_settings(settings: Dict[str, Any]) -> Dict[str, Any]:
        logo_ref = settings.get('logo_url')
        if not isinstance(logo_ref, str) or not logo_ref.strip():
            return settings

        from apps.services.oss.services.factory import get_oss_service
        from apps.services.oss.services.public_assets import public_asset_object_key_from_ref

        object_key = public_asset_object_key_from_ref(logo_ref)
        if not object_key:
            return settings

        oss_service = get_oss_service()
        public_acl_ok = oss_service.set_object_public_read(object_key)
        if not public_acl_ok and getattr(oss_service, "config", {}).get("access_mode") == "private":
            raise ServiceError(
                'PUBLIC_ASSET_ACL_FAILED',
                '组织 Logo 公开访问权限设置失败，请检查 OSS Bucket/AK 权限',
                400,
            )
        if not public_acl_ok:
            logger.warning("团队 Logo public-read ACL 设置失败，沿用 bucket 公共访问口径: %s", object_key)
        return {**settings, 'logo_url': object_key}

    @staticmethod
    def _build_personal_organization_settings(extra_settings: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        settings = {
            'is_default': True,
            'auto_created': True,
        }
        if extra_settings:
            settings.update(extra_settings)
        return OrganizationService._with_default_organization_settings(settings)

    @staticmethod
    def _with_default_organization_settings(settings: Dict[str, Any]) -> Dict[str, Any]:
        return {
            ORG_ALLOW_MEMBER_YOLO_KEY: ORG_ALLOW_MEMBER_YOLO_DEFAULT,
            **settings,
        }

    @staticmethod
    def _snapshot_new_org_campaign_ids(*, created_at) -> list[str]:
        from apps.services.billing.models import ProviderCreditCampaign

        return [
            str(campaign_id)
            for campaign_id in (
                ProviderCreditCampaign.objects.filter(
                    enabled=True,
                    status=ProviderCreditCampaign.Status.ACTIVE,
                    trigger_type=ProviderCreditCampaign.TriggerType.NEW_ORG,
                    start_at__lte=created_at,
                )
                .filter(Q(end_at__isnull=True) | Q(end_at__gt=created_at))
                .order_by("created_at", "id")
                .values_list("id", flat=True)
            )
        ]

    @classmethod
    def _claim_provider_credit_eligibility(
        cls,
        *,
        organization: Organization,
        user_id,
    ) -> tuple[Optional[OrganizationProviderCreditClaim], bool]:
        existing = OrganizationProviderCreditClaim.objects.filter(
            organization_id=organization.id
        ).first()
        if existing is not None:
            return existing, False

        if organization.type == Organization.OrganizationType.PERSONAL:
            eligibility_order = 1
        elif organization.type == Organization.OrganizationType.TEAM:
            used_orders = set(
                OrganizationProviderCreditClaim.objects.filter(
                    user_id=user_id,
                    eligibility_order__gte=2,
                    eligibility_order__lte=4,
                ).values_list("eligibility_order", flat=True)
            )
            eligibility_order = next(
                (order for order in range(2, 5) if order not in used_orders),
                None,
            )
            if eligibility_order is None:
                return None, False
        else:
            return None, False

        eligible_campaign_ids = cls._snapshot_new_org_campaign_ids(
            created_at=organization.created_at
        )
        claim = OrganizationProviderCreditClaim.objects.create(
            user_id=user_id,
            organization_id=organization.id,
            eligibility_order=eligibility_order,
            eligible_campaign_ids=eligible_campaign_ids,
        )
        return claim, True

    @classmethod
    def ensure_personal_organization(
        cls,
        user,
        *,
        extra_settings: Optional[Dict[str, Any]] = None,
    ) -> tuple[Organization, bool]:
        """幂等确保用户存在 personal organization。"""
        existing = Organization.objects.filter(
            owner_id=user.id,
            type=Organization.OrganizationType.PERSONAL,
        ).first()
        if existing:
            return existing, False

        settings = cls._build_personal_organization_settings(extra_settings)

        should_dispatch_credit = False
        with transaction.atomic(using=postgres_app_db_alias()):
            locked_user = (
                User.objects.using(postgres_app_db_alias())
                .select_for_update()
                .get(pk=user.id)
            )
            existing = Organization.objects.filter(
                owner_id=locked_user.id,
                type=Organization.OrganizationType.PERSONAL,
            ).first()
            if existing:
                return existing, False
            try:
                with transaction.atomic(using=postgres_app_db_alias()):
                    organization = Organization.objects.create(
                        name=cls.allocate_unique_organization_name(
                            f"{locked_user.get_display_name()}的组织",
                        ),
                        description="个人默认组织",
                        icon="🏠",
                        owner=locked_user,
                        type=Organization.OrganizationType.PERSONAL,
                        is_default=True,
                        settings=settings,
                    )
            except IntegrityError:
                existing = Organization.objects.get(
                    owner_id=user.id,
                    type=Organization.OrganizationType.PERSONAL,
                )
                return existing, False

            claim, created_claim = cls._claim_provider_credit_eligibility(
                organization=organization,
                user_id=locked_user.id,
            )
            should_dispatch_credit = bool(
                created_claim and claim and claim.eligible_campaign_ids
            )
            cls.provision_organization_defaults(organization, locked_user)

        cls.provision_community_membership(str(organization.id))
        cls.provision_billing(str(organization.id))
        cls.provision_builtin_extensions(str(organization.id))
        if should_dispatch_credit:
            transaction.on_commit(
                lambda organization_id=str(organization.id): (
                    cls._dispatch_new_organization_provider_credits(organization_id)
                ),
                using=postgres_app_db_alias(),
            )
        return organization, True

    def list_organizations(
        self,
        search: Optional[str] = None,
        is_default: Optional[bool] = None,
        type: Optional[str] = None,
    ) -> QuerySet:
        queryset = self.get_user_organizations()

        if search:
            queryset = queryset.filter(
                Q(name__icontains=search) |
                Q(description__icontains=search)
            )

        if is_default is not None:
            queryset = queryset.filter(is_default=is_default)

        if type is not None:
            queryset = queryset.filter(type=type)

        return queryset.order_by('-created_at')

    def get_organization(self, organization_id: UUID) -> Organization:
        if not self.check_organization_permission(str(organization_id), 'viewer'):
            raise ServiceError('ORGANIZATION_NOT_FOUND', '组织不存在', 404)

        try:
            return Organization.objects.get(id=organization_id)
        except Organization.DoesNotExist:
            raise ServiceError('ORGANIZATION_NOT_FOUND', '组织不存在', 404)

    @staticmethod
    def _resolve_default_agent_device(
        organization: Organization,
        user,
        device_fingerprint: Optional[str],
    ) -> Optional[Device]:
        if not device_fingerprint or not user:
            return None
        try:
            candidate = Device.objects.get(
                fingerprint=device_fingerprint,
                user_id=user.id,
                role='control',
            )
        except Device.DoesNotExist:
            logger.warning(
                "默认 Space 设备绑定失败：未找到 fingerprint=%s user=%s organization=%s",
                device_fingerprint,
                user.id,
                organization.id,
            )
            return None
        if is_user_level_device(candidate.device_type) or str(candidate.organization_id) == str(organization.id):
            return candidate
        logger.warning(
            "默认 Space 设备绑定失败：非用户级设备不能跨团队绑定 fingerprint=%s device_wt=%s target_wt=%s",
            device_fingerprint,
            candidate.organization_id,
            organization.id,
        )
        return None

    @classmethod
    def provision_organization_defaults(
        cls,
        organization: Organization,
        user,
        *,
        default_agent_device_fingerprint: Optional[str] = None,
        default_agent_working_dir: Optional[str] = None,
        default_agent_working_dir_type: Optional[str] = None,
        request=None,
    ) -> Optional[Space]:
        """
        为已创建的 organization 初始化默认资源：
        OrganizationMember (owner) / 默认 Space / CORE_APPS 安装 / 计数覆写。

        创建流程：
        - OrganizationMember.create() → 建立用户组织身份
        - Agent.objects.create() → 创建用户私有 bot Agent（只含身份/配置）
        - Workspace.objects.create(...) → 建个人执行现场（ 不写 agent FK）并写用户 owner membership
        - Workspace.objects.create() → 独立保存设备与工作目录

        调用方负责在外层包裹事务和创建 Organization 本身。
        """
        OrganizationMember.objects.create(
            organization=organization,
            user=user,
            role='owner'
        )

        from apps.tabtinspace.models import Agent, Workspace
        from apps.tabtinspace.services.agent_service import AgentService
        bound_device = cls._resolve_default_agent_device(
            organization,
            user,
            default_agent_device_fingerprint,
        )
        working_dir = default_agent_working_dir or ''
        working_dir_type = default_agent_working_dir_type or ('mixed' if working_dir else '')
        if working_dir and not bound_device:
            raise ServiceError('DEVICE_REQUIRED', '初始化默认 Space 必须绑定执行设备', 400)

        onboarding = resolve_onboarding_defaults(user, request=request)

        bot_agent = Agent.objects.create(
            organization=organization,
            owner_user=user,
            name=onboarding.agent_name,
            type='bot',
            is_default=True,
            agent_config=AgentService.DEFAULT_AGENT_CONFIG,
            # ：系统供给默认小Tin，与 Space 迁移分身区分
            settings=build_system_default_agent_settings(),
        )
        space = None
        if bound_device and working_dir:
            #  / ：只建 Workspace，不写 Agent FK；bot 身份独立供给。
            # HOME 按 Organization + 用户 + 设备隔离；同一设备上的其他账号、
            # 其他 Organization 均不应改变当前默认现场的 kind。
            scope_has_home = Workspace.objects.filter(
                organization=organization,
                created_by=user,
                device=bound_device,
                kind=Workspace.Kind.HOME,
            ).exists()
            _ = bot_agent
            space = Workspace.objects.create(
                organization=organization,
                device=bound_device,
                name=onboarding.space_name,
                working_dir=working_dir,
                normalized_working_dir=working_dir,
                working_dir_type=working_dir_type,
                created_by=user,
                kind=(
                    Workspace.Kind.STANDARD
                    if scope_has_home
                    else Workspace.Kind.HOME
                ),
                trust_status=Workspace.TrustStatus.TRUSTED,
                trust_source=Workspace.TrustSource.SYSTEM_PROVISIONED,
                trusted_at=timezone.now(),
            )
            from apps.tabtinspace.services.membership_utils import ensure_user_membership
            ensure_user_membership(space, user.id, 'owner')

        # 显式覆写 signal 的 F() 增量，确保初始化后计数为确切值。
        # signal 会将 member_count 从 0→1、space_count 从 0→1，
        # 但为防止并发或重入导致的偏差，此处用确定值覆写。
        organization.space_count = 1 if space is not None else 0
        organization.member_count = 1
        organization.save(update_fields=['space_count', 'member_count'])

        # 为新 Organization 自动安装全部 CORE_APPS（同一事务内）。
        # 失败不阻断 Organization 创建，记录日志供后续补偿。
        try:
            from apps.tabtinspace.services.app_catalog_service import OrganizationAppCatalogService
            OrganizationAppCatalogService.auto_install_core_apps(organization, user)
        except Exception as exc:
            logger.warning(
                "CORE_APPS 自动安装失败（非阻断）: organization=%s, error=%s",
                organization.id, exc, exc_info=True,
            )

        # ：默认 Agent 携带全部 platform + 已装 App skill（装完 CORE 后再灌）。
        from apps.skills.services.default_agent_skill_seed import (
            run_default_agent_skill_seed_safe,
            seed_default_agent_skills,
        )
        run_default_agent_skill_seed_safe(
            lambda: seed_default_agent_skills(bot_agent, user),
            event="default_agent_skill_seed.provision",
            organization=organization.id,
            agent=bot_agent.id,
        )

        return space

    @classmethod
    def ensure_default_space_for_member(
        cls,
        organization: Organization,
        user,
    ) -> Optional[Space]:
        """已退役：读取列表不得隐式创建无设备、无目录的 Space。

        保留方法签名用于兼容尚未更新的外部调用方；Workspace 必须由携带明确
        device + working_dir 的创建/主场供给入口产生。
        """
        return None

    @staticmethod
    def assert_organization_name_available(
        name: Optional[str],
        *,
        exclude_id: Optional[UUID] = None,
    ) -> str:
        """全表 active 组织名称不可重复（大小写不敏感）。

        删除中（status=deleting）的组织不占名，便于同名重建。
        跨 owner 也不可同名，避免被邀请加入后切换器出现重名。
        """
        normalized = (name or '').strip()
        if not normalized:
            raise ServiceError('VALIDATION_ERROR', '组织名称不能为空', 400)

        qs = Organization.objects.filter(
            status=Organization.Status.ACTIVE,
            name__iexact=normalized,
        )
        if exclude_id is not None:
            qs = qs.exclude(id=exclude_id)
        if qs.exists():
            raise ServiceError(
                'ORGANIZATION_NAME_CONFLICT',
                f'已存在同名组织「{normalized}」，请换一个名称',
                409,
            )
        return normalized

    @classmethod
    def allocate_unique_organization_name(cls, preferred: str) -> str:
        """为系统自动命名（如个人组织）分配全表唯一名称，撞名则追加 (2)/(3)…"""
        preferred = (preferred or '').strip() or '组织'
        try:
            return cls.assert_organization_name_available(preferred)
        except ServiceError as exc:
            if exc.code != 'ORGANIZATION_NAME_CONFLICT':
                raise
        for index in range(2, 100):
            candidate = f'{preferred} ({index})'
            try:
                return cls.assert_organization_name_available(candidate)
            except ServiceError as exc:
                if exc.code != 'ORGANIZATION_NAME_CONFLICT':
                    raise
        raise ServiceError(
            'ORGANIZATION_NAME_CONFLICT',
            f'无法为「{preferred}」分配可用组织名称',
            409,
        )

    @transaction.atomic(using=postgres_app_db_alias())
    def create_organization(
        self,
        name: str,
        description: Optional[str] = None,
        icon: Optional[str] = None,
        settings: Optional[Dict[str, Any]] = None,
        default_agent_device_fingerprint: Optional[str] = None,
        default_agent_working_dir: Optional[str] = None,
        default_agent_working_dir_type: Optional[str] = None,
        enforce_owner_limit: bool = True,
        request=None,
    ) -> Organization:
        if not self.user:
            raise ServiceError('AUTH_REQUIRED', '用户未登录', 401)

        locked_user = (
            User.objects.using(postgres_app_db_alias())
            .select_for_update()
            .get(pk=self.user.id)
        )

        if enforce_owner_limit:
            from apps.platform_config.services import PlatformRuntimeConfigService

            policy = PlatformRuntimeConfigService.get_organization_create_policy(locked_user)
            if not policy.allowed:
                raise ServiceError('ORGANIZATION_LIMIT_EXCEEDED', policy.message, 400)

        normalized_name = self.assert_organization_name_available(name)

        organization_settings = self._with_default_organization_settings(
            self._normalize_public_logo_settings(settings or {}),
        )
        organization = Organization.objects.create(
            name=normalized_name,
            description=description or '',
            icon=icon or '📁',
            owner_id=locked_user.id,
            type=Organization.OrganizationType.TEAM,
            is_default=False,
            settings=organization_settings,
        )
        provider_credit_claim, created_claim = self._claim_provider_credit_eligibility(
            organization=organization,
            user_id=locked_user.id,
        )

        self.provision_organization_defaults(
            organization,
            locked_user,
            default_agent_device_fingerprint=default_agent_device_fingerprint,
            default_agent_working_dir=default_agent_working_dir,
            default_agent_working_dir_type=default_agent_working_dir_type,
            request=request,
        )

        OrganizationService.provision_community_membership(str(organization.id))
        OrganizationService.provision_billing(str(organization.id))
        OrganizationService.provision_builtin_extensions(str(organization.id))
        if (
            created_claim
            and provider_credit_claim
            and provider_credit_claim.eligible_campaign_ids
        ):
            transaction.on_commit(
                lambda organization_id=str(organization.id): (
                    OrganizationService._dispatch_new_organization_provider_credits(
                        organization_id
                    )
                ),
                using=postgres_app_db_alias(),
            )

        return organization

    @staticmethod
    def _dispatch_new_organization_provider_credits(organization_id: str) -> None:
        """提交后立即交给后台线程投递 Celery，不阻塞组织创建响应。"""
        try:
            threading.Thread(
                target=OrganizationService._enqueue_new_organization_provider_credits,
                args=(organization_id,),
                daemon=True,
                name=f"new-org-provider-credit-{organization_id}",
            ).start()
        except Exception as exc:
            logger.error(
                "new_org Provider Credit 后台投递线程启动失败，等待定时补偿: "
                "organization=%s error=%s",
                organization_id,
                exc,
                exc_info=True,
            )

    @staticmethod
    def _enqueue_new_organization_provider_credits(organization_id: str) -> None:
        try:
            from apps.services.billing.tasks import (
                grant_new_organization_provider_credits_async,
            )

            grant_new_organization_provider_credits_async.delay(organization_id)
            logger.info(
                "已异步投递 new_org Provider Credit: organization=%s",
                organization_id,
            )
        except Exception as exc:
            logger.error(
                "new_org Provider Credit 异步投递失败，等待定时补偿: "
                "organization=%s error=%s",
                organization_id,
                exc,
                exc_info=True,
            )

    @staticmethod
    def _is_non_retriable_provision_error(exc: Exception) -> bool:
        if isinstance(exc, ImproperlyConfigured):
            return True
        if isinstance(exc, ProgrammingError):
            return True
        if isinstance(exc, OperationalError):
            message = str(exc).lower()
            return any(
                marker in message
                for marker in (
                    "unknown column",
                    "doesn't exist",
                    "does not exist",
                    "no such column",
                    "no such table",
                    "undefined column",
                )
            )
        return False

    @classmethod
    def provision_billing(cls, organization_id: str):
        """为 organization 创建默认计费基础设施（非阻断，内部有 try/catch）。

        XM-15 彻底修复: Policy + Entitlement + Wallet 在同一个 MySQL 事务中初始化，
        任何一步失败整体回滚，杜绝半初始化状态。
        补偿任务通过 transaction.on_commit 调度，确保外层 postgresql 事务提交
        （organization 已持久化）后才触发重试。

        创建：OrganizationBillingPolicy / OrganizationBillingEntitlement / OrganizationWallet。
        调用方无需额外捕获异常。
        """
        try:
            from apps.services.billing.models import (
                OrganizationBillingPolicy,
                OrganizationBillingEntitlement,
            )
            from apps.services.billing.services import OrganizationEntitlementSyncService
            from apps.services.billing.services.entitlement_service import BillingProvisionHardFailure
            from apps.services.billing.services.policy_service import OrganizationBillingPolicyService
            from apps.users.wallet.services.organization_wallet_service import OrganizationWalletService

            with transaction.atomic(using='default'):
                # 计费模式默认值以 OrganizationBillingPolicyService 常量为准（当前
                # llm=quota_only），不要写死——否则 migration 0037 把默认切到
                # quota_only 后，新建组织仍会被这里的硬编码盖回旧的 quota_then_paygo。
                OrganizationBillingPolicy.objects.get_or_create(
                    organization_id=organization_id,
                    defaults=OrganizationBillingPolicyService.default_policy_create_kwargs(),
                )

                OrganizationBillingEntitlement.objects.get_or_create(
                    organization_id=organization_id,
                    defaults={
                        'included_storage_bytes': 0,
                        'included_llm_credits_monthly': 0,
                        'is_active': True,
                    },
                )
                OrganizationEntitlementSyncService.sync_organization_entitlement(organization_id)

                OrganizationWalletService().get_or_create_wallet(organization_id)
        except Exception as e:
            if isinstance(e, BillingProvisionHardFailure) or cls._is_non_retriable_provision_error(e):
                logger.error(
                    "初始化 organization billing 硬失败（不会自动重试）: organization=%s, error=%s",
                    organization_id, e, exc_info=True,
                )
                raise ImproperlyConfigured(
                    f"billing provision blocked for organization {organization_id}: {e}"
                ) from e
            logger.warning(
                "初始化 organization billing 失败（已回滚）: organization=%s, error=%s",
                organization_id, e,
            )
            cls._schedule_provision_billing_retry(organization_id)

    @classmethod
    def _schedule_provision_billing_retry(cls, organization_id: str):
        """XM-15 补偿: 通过 on_commit 调度异步重试，确保外层事务提交后才触发。

        在 create_organization 路径中，外层有 postgresql 事务；on_commit 保证
        organization 行已持久化后 Celery 任务才入队，避免补偿任务因 organization
        不存在而被跳过。
        在 signal 路径中（无活跃 postgresql 事务），on_commit 立即执行。
        """
        def _do_schedule():
            try:
                from apps.tabtinspace.tasks import retry_provision_billing
                retry_provision_billing.delay(organization_id)
                logger.info("已调度 billing 初始化补偿任务: organization=%s", organization_id)
            except Exception as exc:
                logger.error(
                    "billing 初始化补偿任务调度失败，需人工介入: organization=%s, err=%s",
                    organization_id, exc,
                )

        try:
            transaction.on_commit(_do_schedule, using=postgres_app_db_alias())
        except Exception:
            _do_schedule()

    @classmethod
    def provision_builtin_extensions(cls, organization_id: str):
        """幂等创建 builtin extension organization 级连接和默认通知规则。"""
        try:
            from apps.extensions.api import _ensure_builtin_connections
            created = _ensure_builtin_connections(organization_id)
            if created:
                logger.info("Organization %s: 自动创建 %d 个 builtin extension connection", organization_id, created)
        except Exception as e:
            if isinstance(e, ImproperlyConfigured):
                logger.error(
                    "初始化 builtin extensions 硬失败（配置问题）: organization=%s, error=%s",
                    organization_id, e, exc_info=True,
                )
                raise
            logger.warning("初始化 builtin extensions 失败（非阻断）: organization=%s, error=%s", organization_id, e)

        try:
            from apps.extensions.api import _ensure_system_rules
            rules_created = _ensure_system_rules(organization_id)
            if rules_created:
                logger.info("Organization %s: 自动创建 %d 条系统通知规则", organization_id, rules_created)
        except Exception as e:
            if isinstance(e, ImproperlyConfigured):
                logger.error(
                    "初始化系统通知规则硬失败（配置问题）: organization=%s, error=%s",
                    organization_id, e, exc_info=True,
                )
                raise
            logger.warning("初始化系统通知规则失败（非阻断）: organization=%s, error=%s", organization_id, e)

    @staticmethod
    def _build_organization_updated_payload(organization: Organization) -> Dict[str, Any]:
        return {
            'organization_id': str(organization.id),
            'name': organization.name,
            'description': organization.description or '',
            'icon': organization.icon or '',
            'settings': organization.settings or {},
            'updated_at': organization.updated_at.isoformat(),
        }

    @classmethod
    def _collect_organization_member_user_ids(cls, organization_id: UUID) -> list[str]:
        member_user_ids = list(
            OrganizationMember.objects.filter(organization_id=organization_id)
            .values_list('user_id', flat=True)
        )
        try:
            owner_id = Organization.objects.values_list('owner_id', flat=True).get(id=organization_id)
        except Organization.DoesNotExist:
            owner_id = None
        user_ids = {str(user_id) for user_id in member_user_ids if user_id}
        if owner_id:
            user_ids.add(str(owner_id))
        return sorted(user_ids)

    @classmethod
    def broadcast_organization_updated(cls, organization: Organization) -> None:
        """向组织全部成员（含 owner）推送 ``organization.updated`` 用户级 WS 事件。"""
        try:
            from apps.services.common.ws.bus import publish_to_user
            from apps.services.common.ws.protocol import build_envelope, new_event_id

            payload = cls._build_organization_updated_payload(organization)
            envelope = build_envelope('organization.updated', new_event_id(), payload)
            organization_id = organization.id
            for user_id in cls._collect_organization_member_user_ids(organization_id):
                delivered = publish_to_user(user_id, envelope)
                if not delivered:
                    logger.warning(
                        "[update_organization] organization.updated push skipped: user=%s organization=%s",
                        user_id,
                        organization_id,
                    )
        except Exception:
            logger.warning(
                "[update_organization] organization.updated push failed: organization=%s",
                organization.id,
                exc_info=True,
            )

    @transaction.atomic(using=postgres_app_db_alias())
    def update_organization(
        self,
        organization_id: UUID,
        name: Optional[str] = None,
        description: Optional[str] = None,
        icon: Optional[str] = None,
        settings: Optional[Dict[str, Any]] = None
    ) -> Organization:
        # 两级模型（2026-06-10）：团队名/描述/图标/设置改为 owner-only
        if not self.check_organization_permission(str(organization_id), 'owner'):
            raise ServiceError('PERMISSION_DENIED', '仅团队所有者可编辑团队设置', 403)

        try:
            organization = Organization.objects.get(id=organization_id)
        except Organization.DoesNotExist:
            raise ServiceError('ORGANIZATION_NOT_FOUND', '组织不存在', 404)

        update_fields = []
        if name is not None:
            organization.name = self.assert_organization_name_available(
                name,
                exclude_id=organization.id,
            )
            update_fields.append('name')
        if description is not None:
            organization.description = description
            update_fields.append('description')
        if icon is not None:
            organization.icon = icon
            update_fields.append('icon')
        if settings is not None:
            organization.settings = self._normalize_public_logo_settings(settings)
            update_fields.append('settings')

        if update_fields:
            update_fields.append('updated_at')
            organization.save(update_fields=update_fields)

            def _notify_organization_updated() -> None:
                self.broadcast_organization_updated(organization)

            transaction.on_commit(_notify_organization_updated, using=postgres_app_db_alias())
        return organization

    @transaction.atomic(using=postgres_app_db_alias())
    def delete_organization(self, organization_id: UUID) -> bool:
        """发起删除组织：仅做权限校验 + 标记 deleting（墓碑）并即时返回。

        真正的重资源清理（表格/文档/blob/计费/Chat/Mail 等）由后台任务
        ``tabtinspace.purge_organization`` 异步完成，避免大型团队的同步删除拖垮
        单次 HTTP 请求（客户端 IPC 默认 30s 超时，见 ）。标记 deleting 后
        该团队立即对用户隐身（get_user_organizations /
        check_organization_permission 收口）；组织行本体保留到清理链末步
        才物理删除（ 墓碑管线）。
        """
        try:
            organization = Organization.objects.get(id=organization_id)
        except Organization.DoesNotExist:
            raise ServiceError('ORGANIZATION_NOT_FOUND', '组织不存在', 404)

        if organization.owner_id != self.user.id:
            raise ServiceError('PERMISSION_DENIED', '仅所有者可以删除组织', 403)

        if organization.is_default or organization.type == 'personal':
            raise ServiceError('CANNOT_DELETE_DEFAULT', '无法删除个人身份', 400)

        wt_name = organization.name
        user = self.user

        if organization.status != Organization.Status.DELETING:
            from django.utils import timezone
            organization.status = Organization.Status.DELETING
            organization.delete_requested_at = timezone.now()
            organization.delete_requested_by_id = str(user.id)
            organization.save(update_fields=[
                'status', 'delete_requested_at', 'delete_requested_by_id', 'updated_at',
            ])

        def _after_commit():
            self._enqueue_purge_organization(str(organization_id))
            from apps.tabtinspace.services.audit_service import AuditService
            AuditService.log(
                'organization_delete', 'organization', organization_id,
                organization_id=organization_id,
                operator=user,
                message=f"用户删除组织「{wt_name}」",
            )

        transaction.on_commit(_after_commit, using=postgres_app_db_alias())
        return True

    @staticmethod
    def _enqueue_purge_organization(organization_id_str: str) -> None:
        """调度后台 purge 任务。入队失败不抛错——定时兜底任务
        ``repurge_stuck_deleting_organizations`` 会重扫卡在 deleting 的团队补偿。"""
        try:
            from apps.tabtinspace.tasks import purge_organization
            purge_organization.delay(organization_id_str)
            logger.info("[OrganizationDelete] purge 任务已入队: organization=%s", organization_id_str)
        except Exception:
            logger.exception(
                "[OrganizationDelete] purge 任务入队失败，等待定时兜底补偿: organization=%s",
                organization_id_str,
            )

    @classmethod
    def purge_organization_by_id(cls, organization_id: str) -> bool:
        """后台任务入口：对已标记 deleting 的团队执行全量物理清理。

        幂等：团队不存在视为已完成；force_delete_organization 内部按 filter 删除，
        重入安全。返回 True 表示已执行清理，False 表示无需处理。

        墓碑管线：组织行保留到清理链末步才物理删除，因此 repurge
        兜底任务会持续扫到 deleting 墓碑。若清理作业已建立（阶段 A 已完成、
        billing 清理链已接管），直接跳过，避免绕过清理链的退避重试节奏——
        后续推进由 billing beat（retry_organization_lifecycle_cleanups）负责。
        """
        try:
            organization = Organization.objects.get(id=organization_id)
        except Organization.DoesNotExist:
            logger.info("[OrganizationPurge] organization=%s 已不存在，跳过", organization_id)
            return False

        if organization.status != Organization.Status.DELETING:
            logger.warning(
                "[OrganizationPurge] organization=%s 状态为 %s（非 deleting），跳过",
                organization_id, organization.status,
            )
            return False

        from apps.services.billing.models import OrganizationLifecycleCleanupJob

        job = OrganizationLifecycleCleanupJob.objects.filter(
            organization_id=str(organization_id),
        ).first()
        if job and job.status in (
            "pending", "running", "failed", "permanently_failed",
        ):
            logger.info(
                "[OrganizationPurge] organization=%s 清理链已接管（job=%s），跳过重复 purge",
                organization_id, job.status,
            )
            return False

        with transaction.atomic(using=postgres_app_db_alias()):
            cls.force_delete_organization(organization)
        return True

    @classmethod
    def force_delete_organization(cls, organization) -> None:
        """删除 organization 及其全部业务资源（需在 postgresql 事务内调用）。

        供 signal（用户删除）、admin 删除和 Service 内部使用，不做权限和
        is_default 检查。通过 _deleting_organization_ids 标记，让 CASCADE 触发的
        post_delete signal 跳过无意义的计数 UPDATE，避免 N 次废 SQL。

        墓碑管线三段式：
        1. 阶段 A（本方法，同步）：置墓碑状态 + 清理 PG 业务资源与核心子行，
           组织行本体保留（对用户已隐身）。
        2. 阶段 B（on_commit）：触发 default DB 清理链
           ``OrganizationLifecycleCleanupService``（billing/钱包/OSS 等，
           失败按 job 退避重试）。
        3. 终步（清理链末尾）：校验各真 FK 子表已清空后物理删除组织行
           （见 ``OrganizationLifecycleCleanupService._finalize_organization_row``）。
           由此操作类 billing 表可安全挂 on_delete=PROTECT 的真 FK——子行
           总是先于父行消失，PROTECT 仅作误删兜底。
        """
        from apps.tabtinspace.signals import _deleting_organization_ids

        organization_id = organization.id
        organization_id_str = str(organization_id)

        # 用户注销 / admin 强删路径不经过 delete_organization，这里兜底置墓碑，
        # 保证组织行在物理删除前对用户隐身、且 repurge 兜底任务可见。
        from django.utils import timezone
        Organization.objects.filter(id=organization_id).exclude(
            status=Organization.Status.DELETING,
        ).update(
            status=Organization.Status.DELETING,
            delete_requested_at=timezone.now(),
            updated_at=timezone.now(),
        )

        space_ids = list(
            Workspace.objects.filter(organization_id=organization_id).values_list('id', flat=True)
        )
        logger.info(
            "[OrganizationDelete] phase=%s organization=%s space_count=%d",
            "start", organization_id_str, len(space_ids),
        )
        cls.delete_organization_resources(organization_id, space_ids)
        logger.info(
            "[OrganizationDelete] phase=%s organization=%s",
            "resources_deleted", organization_id_str,
        )

        def _cleanup_default_db_resources():
            try:
                from apps.services.billing.services import OrganizationLifecycleCleanupService

                OrganizationLifecycleCleanupService.enqueue_cleanup(
                    organization_id_str,
                    trigger_source="organization_delete",
                    run_inline=True,
                    force=True,
                )
            except Exception:
                logger.exception(
                    "organization default DB 清理失败（PostgreSQL 已提交）: organization=%s",
                    organization_id_str,
                )

        _deleting_organization_ids.add(organization_id)
        try:
            # default / postgresql 不是分布式事务，但至少保证“方法内部任一步失败”
            # 时，default 库的脱钩更新不会先于异常提交，降低半成功状态。
            with transaction.atomic(using='default'):
                cls._delete_organization_core_rows(organization_id, space_ids)
            transaction.on_commit(_cleanup_default_db_resources, using=postgres_app_db_alias())
            logger.info(
                "[OrganizationDelete] phase=%s organization=%s",
                "on_commit_registered", organization_id_str,
            )
        finally:
            _deleting_organization_ids.discard(organization_id)

    @classmethod
    def _delete_organization_core_rows(cls, organization_id: UUID, space_ids: list) -> None:
        from apps.tracker.models import Tracker

        organization_id_str = str(organization_id)

        # 先显式删除 organization 直挂依赖，再移除 Space / Organization 本体。
        # 否则 Django collector 会沿着跨库 reverse FK（如 conversation.ChatSession.space）
        # 去错误的数据库执行 SET_NULL / CASCADE，导致 no such table 之类的问题。
        # 2026-05-28 收编：ScheduledJob 子系统已下线，无需再清理 scheduler_job 表。
        Tracker.objects.filter(organization_id=organization_id).delete()

        if space_ids:
            cls._detach_default_db_space_references(space_ids)
            logger.info(
                "[OrganizationDelete] phase=%s organization=%s space_count=%d",
                "detach_default_db", organization_id_str, len(space_ids),
            )
            cls._detach_postgresql_space_references(space_ids)
            logger.info(
                "[OrganizationDelete] phase=%s organization=%s space_count=%d",
                "detach_postgresql", organization_id_str, len(space_ids),
            )
            cls._delete_space_rows(space_ids)
            logger.info(
                "[OrganizationDelete] phase=%s organization=%s space_count=%d",
                "delete_space_rows", organization_id_str, len(space_ids),
            )

        cls._delete_organization_rows(organization_id)
        logger.info(
            "[OrganizationDelete] phase=%s organization=%s",
            "delete_organization_rows", organization_id_str,
        )

    @classmethod
    def _detach_default_db_space_references(cls, space_ids: list) -> None:
        from apps.chat.conversation.models import ChatContext, ChatSession

        space_id_strs = [str(space_id) for space_id in space_ids]
        deleted_space_ids = set(space_id_strs)

        # ：ChatSession.space FK 已 Drop；个人会话挂 workspace（id-reuse）
        ChatSession.objects.using('default').filter(workspace_id__in=space_ids).update(workspace=None)
        ChatContext.objects.using('default').filter(current_space_id__in=space_id_strs).update(
            current_space_id="",
        )

        for context in ChatContext.objects.using('default').exclude(
            recent_spaces=[]
        ).exclude(
            recent_spaces__isnull=True
        ).only('id', 'recent_spaces').iterator(chunk_size=200):
            pruned_recent_spaces = cls._prune_deleted_space_refs(
                context.recent_spaces,
                deleted_space_ids,
            )
            if pruned_recent_spaces == (context.recent_spaces or []):
                continue
            context.recent_spaces = pruned_recent_spaces
            context.save(update_fields=['recent_spaces', 'updated_at'])

    @classmethod
    def _detach_postgresql_space_references(cls, space_ids: list) -> None:
        from apps.tabdata.models_token import TableApiToken

        space_id_strs = [str(space_id) for space_id in space_ids]
        deleted_space_ids = set(space_id_strs)

        # ：TableApiToken.space FK 已 Drop；归属只走 space_ids JSON。
        # 命中被删 Space 的 Token：剪 scope，并停用（等价原 FK 命中后 is_active=False）。
        for token in TableApiToken.objects.exclude(
            space_ids__isnull=True
        ).exclude(
            space_ids=[]
        ).only('id', 'space_ids', 'is_active').iterator(chunk_size=200):
            pruned_space_ids = cls._prune_deleted_space_refs(
                token.space_ids,
                deleted_space_ids,
                keep_none=True,
            )
            if pruned_space_ids == token.space_ids:
                continue
            token.space_ids = pruned_space_ids
            token.is_active = False
            token.save(
                update_fields=['space_ids', 'is_active', 'updated_at'],
                validate_scopes=False,
                validate_scope_targets=False,
                validate_delegation=False,
            )

    @staticmethod
    def _delete_space_rows(space_ids: list) -> None:
        from apps.login_relay.models import LoginRelayPackage
        from apps.tabtinspace.models import (
            Collection,
            ContextItem,
            SpaceAppSettings,
            SpaceMembership,
            SpacePermission,
        )

        # ：个人壳表挂 workspace；id-reuse 下 workspace_id == space.id
        SpaceMembership.objects.filter(workspace_id__in=space_ids).delete()
        SpaceAppSettings.objects.filter(workspace_id__in=space_ids).delete()
        ContextItem.objects.filter(
            Q(workspace_id__in=space_ids) | Q(project_id__in=space_ids)
        ).delete()
        Collection.objects.filter(
            Q(workspace_id__in=space_ids) | Q(project_id__in=space_ids)
        ).delete()
        SpacePermission.objects.filter(workspace_id__in=space_ids).delete()
        LoginRelayPackage.objects.filter(space_id__in=space_ids).delete()
        Workspace.objects.filter(id__in=space_ids)._raw_delete(postgres_app_db_alias())

    @staticmethod
    def _delete_organization_rows(organization_id: UUID) -> None:
        """清理 organization 直挂子行，但保留墓碑行到清理链终步。

         墓碑管线要求 billing / wallet 真 FK 子行先删除，组织行本体再由
        ``OrganizationLifecycleCleanupService._finalize_organization_row`` 物理删除。
        """
        from apps.tabtinspace.models import (
            Device,
            OrganizationControlPolicy,
            SecureCredential,
            OrganizationAppInstall,
            OrganizationInvitation,
            OrganizationMember,
        )

        OrganizationMember.objects.filter(organization_id=organization_id).delete()
        OrganizationAppInstall.objects.filter(organization_id=organization_id).delete()
        OrganizationInvitation.objects.filter(organization_id=organization_id).delete()
        OrganizationControlPolicy.objects.filter(organization_id=organization_id).delete()
        SecureCredential.objects.filter(organization_id=organization_id).delete()
        Agent.objects.filter(organization_id=organization_id).delete()
        Device.objects.filter(organization_id=organization_id).delete()

    @staticmethod
    def _prune_deleted_space_refs(
        refs: list | None,
        deleted_space_ids: set[str],
        *,
        keep_none: bool = False,
    ) -> list | None:
        if refs is None:
            return None if keep_none else []
        return [
            ref for ref in refs
            if not (isinstance(ref, str) and ref in deleted_space_ids)
        ]

    @classmethod
    def delete_space_resources(cls, space_ids: list) -> None:
        """删除 Space 本地关系/运行态记录。

        Organization 级云资源（Table/Document/Webhook 等）不再随 Space 删除。
        """
        if not space_ids:
            return

        for b in _get_organization_resource_models():
            if b.as_field:
                b.model.objects.filter(**{f'{b.as_field}__in': space_ids}).delete()

    @classmethod
    def _cleanup_db_readonly_connections(cls, space_ids: list) -> None:
        """清理 DbReadOnlyConnection 及其 PostgreSQL ROLE（安全清理，best-effort）。

        每次 DROP ROLE 用独立 savepoint 保护，防止 DDL 失败导致外层事务 aborted。
        """
        try:
            from apps.tabdata.models_db_connection import DbReadOnlyConnection
            from apps.tabdata.services.db_connection_service import DbConnectionService

            conns = list(DbReadOnlyConnection.objects.filter(space_id__in=space_ids))
            for conn in conns:
                try:
                    with transaction.atomic(using=postgres_app_db_alias()):
                        DbConnectionService._drop_pg_role(conn.pg_role, conn.pg_schema)
                except Exception:
                    logger.warning(
                        "DROP ROLE %s 失败，继续清理 DbReadOnlyConnection 记录",
                        conn.pg_role, exc_info=True,
                    )
                try:
                    conn.delete()
                except Exception:
                    logger.warning("删除 DbReadOnlyConnection 记录失败: %s", conn.id, exc_info=True)
        except ImportError:
            pass
        except Exception:
            logger.warning("DbReadOnlyConnection 清理异常", exc_info=True)

    @classmethod
    def delete_organization_resources(cls, organization_id: UUID, space_ids: list) -> None:
        """删除 Organization 及其 Space 关联的所有业务资源。

        先按 space_id 精确删除，再按 organization_field 兜底删除
        （覆盖 space_id 为 NULL 或直挂 organization 的记录）。

        SC-001: 在删除 Table/Document 之前先清理 RAG embedding 数据，
        因为 TableEmbedding/RecordEmbedding 通过 table_id 关联，
        Table 被删除后就无法找到需要清理的 embedding 了。
        """
        cls._cleanup_rag_embeddings(organization_id)
        cls.delete_space_resources(space_ids)
        for b in _get_organization_resource_models():
            if b.ws_field:
                val = b.ws_transform(organization_id) if b.ws_transform else organization_id
                b.model.objects.filter(**{b.ws_field: val}).delete()

    @classmethod
    def _cleanup_rag_embeddings(cls, organization_id: UUID) -> None:
        """清理 organization 关联的所有 RAG embedding 数据。

        必须在 delete_space_resources / 注册表删除 Table 之前调用，
        因为 TableEmbedding/RecordEmbedding 需要通过 table_id 反查。
        DocumentEmbedding/CodeChunkEmbedding/EmbeddingTask 有直接的 organization_id 字段。
        """
        try:
            from apps.rag.models import (
                CodeChunkEmbedding,
                DocumentEmbedding,
                EmbeddingTask,
                RecordEmbedding,
                TableEmbedding,
            )

            table_ids = list(
                Table.objects.filter(organization_id=organization_id)
                .values_list('id', flat=True)
            )

            deleted_te = deleted_re = 0
            if table_ids:
                _BATCH = 5000
                for i in range(0, len(table_ids), _BATCH):
                    batch = table_ids[i:i + _BATCH]
                    deleted_te += TableEmbedding.objects.filter(table_id__in=batch).delete()[0]
                    deleted_re += RecordEmbedding.objects.filter(table_id__in=batch).delete()[0]

            deleted_de = DocumentEmbedding.objects.filter(organization_id=organization_id).delete()[0]
            deleted_ce = CodeChunkEmbedding.objects.filter(organization_id=organization_id).delete()[0]
            deleted_et = EmbeddingTask.objects.filter(organization_id=organization_id).delete()[0]

            total = deleted_te + deleted_re + deleted_de + deleted_ce + deleted_et
            if total:
                logger.info(
                    "RAG embedding 清理完成: organization=%s, "
                    "TableEmb=%d RecordEmb=%d DocEmb=%d CodeEmb=%d EmbTask=%d",
                    organization_id, deleted_te, deleted_re, deleted_de, deleted_ce, deleted_et,
                )
        except ImportError:
            logger.debug("RAG 模块不可用，跳过 embedding 清理")
        except Exception:
            logger.exception("RAG embedding 清理失败: organization=%s", organization_id)

    @classmethod
    def cleanup_user_postgresql_data(cls, user_id: str) -> dict:
        """清理用户在 PostgreSQL 侧的全部关联数据（用户删除时调用）。

        必须在 transaction.atomic(using=postgres_app_db_alias()) 内调用。
        返回清理统计 dict：{'owned_organizations': int, 'memberships': int}。
        """
        from apps.tabtinspace.models import (
            Organization, OrganizationMember, Agent, Device,
            SecureCredential, SpaceAppSettings, ContextItem,
        )

        Device.objects.filter(user_id=user_id).delete()
        SecureCredential.objects.filter(user_id=user_id).delete()
        SpaceAppSettings.objects.filter(user_id=user_id).delete()

        total_membership_count = OrganizationMember.objects.filter(user_id=user_id).count()

        owned_organizations = list(Organization.objects.filter(owner_id=user_id))
        owned_count = len(owned_organizations)
        for wt in owned_organizations:
            if wt.type == Organization.OrganizationType.TEAM:
                next_admin = OrganizationMember.objects.filter(
                    organization=wt,
                    role__in=['admin', 'owner'],
                ).exclude(user_id=user_id).first()
                if next_admin:
                    wt.owner_id = next_admin.user_id
                    wt.save(update_fields=['owner_id', 'updated_at'])
                    logger.info(
                        "[UserCleanup] team organization ownership transferred: "
                        "organization=%s new_owner=%s",
                        wt.id, next_admin.user_id,
                    )
                    continue
            cls.force_delete_organization(wt)

        # owned organization 的 member 已被 force_delete_organization → CASCADE 清理，
        # 此处清理用户作为非 owner 成员加入的其他 organization 的成员关系。
        OrganizationMember.objects.filter(user_id=user_id).delete()

        ContextItem.objects.filter(created_by_id=user_id).update(created_by=None)
        ContextItem.objects.filter(updated_by_id=user_id).update(updated_by=None)

        try:
            from apps.tabdata.models import TableRecord
            TableRecord.objects.filter(created_by_id=user_id).update(created_by=None)
            TableRecord.objects.filter(updated_by_id=user_id).update(updated_by=None)
        except ImportError:
            pass

        return {
            'owned_organizations': owned_count,
            'memberships': total_membership_count,
        }

    @staticmethod
    def _schedule_collab_revoke(user_id: str, organization_id: str) -> None:
        """事务提交后异步撤销用户在 organization 下的 collab-live 协作连接（RB-004）。"""
        def _do_revoke():
            try:
                from apps.collab.tasks import async_revoke_collab_access
                async_revoke_collab_access.delay(user_id, organization_id)
            except Exception:
                logger.warning(
                    "Failed to schedule collab revocation: user=%s organization=%s",
                    user_id, organization_id, exc_info=True,
                )

        transaction.on_commit(_do_revoke, using=postgres_app_db_alias())

    @staticmethod
    def _sync_collab_revoke(user_id: str, organization_id: str) -> None:
        """事务提交后同步撤销用户的 collab-live 连接（RV-014：高危操作绕过 Celery 队列）。"""
        def _do_sync_revoke():
            try:
                from apps.collab.tasks import sync_revoke_collab_access
                sync_revoke_collab_access(user_id, organization_id)
            except Exception:
                logger.warning(
                    "Failed to sync revoke collab: user=%s organization=%s",
                    user_id, organization_id, exc_info=True,
                )

        transaction.on_commit(_do_sync_revoke, using=postgres_app_db_alias())

    @staticmethod
    def _sync_im_dm_revoke(user_id: str, organization_id: str) -> None:
        """先同步撤销组织身份对应的单聊，再允许成员关系消失。"""
        try:
            from apps.tabtinspace.services.organization_member_im_sync import (
                revoke_organization_member_dm_access,
            )

            successor_members = (
                OrganizationMember.objects.filter(
                    organization_id=organization_id,
                    user__is_active=True,
                )
                .exclude(user_id=user_id)
                .order_by('joined_at', 'user_id')
            )
            successor_admin_user_id = successor_members.filter(
                role='admin',
            ).values_list('user_id', flat=True).first()
            successor_owner_user_id = None
            if successor_admin_user_id is None:
                successor_owner_user_id = successor_members.filter(
                    role='owner',
                ).values_list('user_id', flat=True).first()

            successor_admin_user_ids = (
                [str(successor_admin_user_id)]
                if successor_admin_user_id is not None
                else []
            )
            successor_member_user_ids = (
                [str(successor_owner_user_id)]
                if successor_owner_user_id is not None
                else []
            )

            revoke_organization_member_dm_access(
                organization_id=organization_id,
                user_id=user_id,
                successor_admin_user_ids=successor_admin_user_ids,
                successor_member_user_ids=successor_member_user_ids,
            )
        except Exception as exc:
            logger.error(
                "Failed to revoke IM access before removing organization member: "
                "user=%s organization=%s",
                user_id,
                organization_id,
                exc_info=True,
            )
            raise ServiceError(
                'IM_REVOCATION_FAILED',
                '消息权限撤销失败，成员尚未移除，请重试',
                503,
            ) from exc

    @staticmethod
    def _sync_session_share_revoke(user_id: str, organization_id: str) -> None:
        """成员关系消失前停止其参与的共享任务。"""
        try:
            from apps.chat.conversation.services.session_share_card_service import (
                revoke_membership_shares,
            )

            revoke_membership_shares(
                organization_id=organization_id,
                user_id=user_id,
            )
        except Exception as exc:
            logger.error(
                "Failed to revoke shared tasks before removing organization member: "
                "user=%s organization=%s",
                user_id,
                organization_id,
                exc_info=True,
            )
            raise ServiceError(
                'SESSION_SHARE_REVOCATION_FAILED',
                '共享任务停止失败，成员尚未移除，请重试',
                503,
            ) from exc

    @staticmethod
    def _schedule_collab_downgrade(user_id: str, organization_id: str) -> None:
        """事务提交后异步降级用户为只读模式（RV-013：viewer 降级不断连）。"""
        def _do_downgrade():
            try:
                from apps.collab.tasks import async_downgrade_collab_to_readonly
                async_downgrade_collab_to_readonly.delay(user_id, organization_id)
            except Exception:
                logger.warning(
                    "Failed to schedule collab downgrade: user=%s organization=%s",
                    user_id, organization_id, exc_info=True,
                )

        transaction.on_commit(_do_downgrade, using=postgres_app_db_alias())

    # ==================== 成员管理 ====================

    @staticmethod
    def _snapshot_departing_member_identity(member: OrganizationMember) -> None:
        """固化成员离开组织当下的名称，供历史资源继续解析用户 ID。"""
        OrganizationMemberIdentitySnapshot.objects.update_or_create(
            organization_id=member.organization_id,
            user_id=member.user_id,
            defaults={
                'display_name': member.user.get_display_name(),
                'left_at': timezone.now(),
            },
        )

    def list_members(
        self,
        organization_id: UUID,
        *,
        search: str = '',
        search_mode: str = '',
        role: str = '',
        offset: int = 0,
        limit: int = 0,
    ) -> tuple:
        """返回成员查询结果；nickname 模式排除邮箱和手机号，limit=0 不分页。"""
        if not self.check_organization_permission(str(organization_id), 'viewer'):
            raise ServiceError('ORGANIZATION_NOT_FOUND', '组织不存在', 404)
        if search_mode not in ('', 'nickname'):
            raise ServiceError('INVALID_SEARCH_MODE', '不支持的成员搜索模式', 400)

        requester_role = self.get_member_role(organization_id, str(self.user.id))
        can_search_private_identity = requester_role == 'owner'

        qs = OrganizationMember.objects.filter(organization_id=organization_id)

        if role:
            qs = qs.filter(role=role)

        if search and len(search.strip()) >= 1:
            q = search.strip()
            # 分享弹窗只按用户可见身份匹配，避免短数字误命中未展示的
            # phone / email / user.id。默认模式仍保留
            # 组织成员管理与 CLI 反查 user-id 所需的宽搜索契约。
            member_filter = (
                Q(user__nickname__icontains=q)
                | Q(user__username__icontains=q)
                | Q(user__nickname_pinyin__icontains=q.lower())
                | Q(user__nickname_pinyin_initials__icontains=q.lower())
            )
            if search_mode != 'nickname' and can_search_private_identity:
                member_filter |= (
                    Q(user__email__icontains=q)
                    | Q(user__phone__icontains=q)
                    | Q(user__id__icontains=q)
                )
            qs = qs.filter(member_filter)

        qs = qs.order_by('-joined_at')
        total = qs.count()

        if limit > 0:
            qs = qs[offset:offset + limit]

        return qs, total

    def list_member_identity_snapshots(self, organization_id: UUID):
        """返回历史身份快照；它们只用于展示，不代表当前成员资格。"""
        if not self.check_organization_permission(str(organization_id), 'viewer'):
            raise ServiceError('ORGANIZATION_NOT_FOUND', '组织不存在', 404)
        return OrganizationMemberIdentitySnapshot.objects.filter(
            organization_id=organization_id,
        ).order_by('-left_at', 'user_id')

    def search_users_for_organization(self, organization_id: UUID, query: str, limit: int = 20) -> list:
        if not self.check_organization_permission(str(organization_id), 'owner'):
            raise ServiceError('PERMISSION_DENIED', '仅团队所有者可搜索可邀请用户', 403)

        if len(query.strip()) < 2:
            return []

        existing_user_ids = set(
            OrganizationMember.objects.filter(organization_id=organization_id)
            .values_list('user_id', flat=True)
        )

        q = query.strip()
        results = User.objects.filter(
            Q(email__icontains=q) | Q(phone__icontains=q) |
            Q(username__icontains=q) | Q(nickname__icontains=q)
        ).exclude(
            id__in=existing_user_ids
        ).values('id', 'nickname', 'username', 'email', 'avatar')[:limit]

        return list(results)

    def get_member_role(self, organization_id: UUID, user_id: str) -> str:
        if not self.check_organization_permission(str(organization_id), 'viewer'):
            raise ServiceError('ORGANIZATION_NOT_FOUND', '组织不存在', 404)

        try:
            organization = Organization.objects.get(id=organization_id)
        except Organization.DoesNotExist:
            raise ServiceError('ORGANIZATION_NOT_FOUND', '组织不存在', 404)

        if str(organization.owner_id) == str(user_id):
            return 'owner'

        try:
            member = OrganizationMember.objects.get(
                organization_id=organization_id,
                user_id=user_id
            )
            return member.role
        except OrganizationMember.DoesNotExist:
            raise ServiceError('MEMBER_NOT_FOUND', '该用户不是组织成员', 404)

    @transaction.atomic(using=postgres_app_db_alias())
    def add_member(
        self,
        organization_id: UUID,
        user_id: str,
        role: str = 'editor',
        *,
        notification_actor: Any = None,
    ) -> OrganizationMember:
        # 锁定 organization 行，序列化并发席位检查 + 成员创建（QTA-04 fix）
        try:
            organization = Organization.objects.select_for_update().get(id=organization_id)
        except Organization.DoesNotExist:
            raise ServiceError('ORGANIZATION_NOT_FOUND', '组织不存在', 404)

        self.assert_team_organization(organization)

        operator_role = self._get_operator_role(organization)
        if not operator_role or ROLE_LEVELS.get(operator_role, 0) < ROLE_LEVELS['owner']:
            raise ServiceError('PERMISSION_DENIED', '仅团队所有者可管理成员', 403)

        if role not in ORGANIZATION_ASSIGNABLE_ROLES:
            raise ServiceError('INVALID_ROLE', f'角色 {role} 不合法，可选: {", ".join(sorted(ORGANIZATION_ASSIGNABLE_ROLES))}')

        if not self._can_manage_target(operator_role, role):
            raise ServiceError('ROLE_ESCALATION', '不能分配高于或等于自己级别的角色', 403)

        try:
            user = User.objects.using('default').get(id=user_id)
        except User.DoesNotExist:
            raise ServiceError('USER_NOT_FOUND', '用户不存在', 404)

        if OrganizationMember.objects.filter(organization_id=organization_id, user_id=user_id).exists():
            raise ServiceError('ALREADY_MEMBER', '该用户已是组织成员')

        try:
            from apps.services.billing.services.seat_billing_service import SeatBillingService
            if not SeatBillingService.check_seat_quota(str(organization_id)):
                raise ServiceError('SEAT_QUOTA_EXCEEDED', '席位配额已满，请升级套餐')
        except ServiceError:
            raise
        except Exception as e:
            logger.warning("席位检查失败，拒绝添加成员: %s", e)
            raise ServiceError('SEAT_CHECK_FAILED', '席位检查异常，请稍后重试')

        member = OrganizationMember.objects.create(
            organization_id=organization_id,
            user_id=user_id,
            role=role
        )
        # Agent 与 SpaceMembership 由 post_save(OrganizationMember) signal 统一创建

        from apps.services.notification.services.organization_notification_projection import (
            OrganizationMemberAddedFact,
            safe_project_organization_notification,
        )

        fact_actor = notification_actor or self.user
        actor_name = fact_actor.get_display_name() if fact_actor else ''
        member_added_fact = OrganizationMemberAddedFact(
            organization_id=str(organization_id),
            organization_name=organization.name,
            actor_id=str(getattr(fact_actor, 'id', '')),
            actor_name=actor_name or str(getattr(fact_actor, 'id', '')),
            affected_user_id=str(user.id),
            affected_user_name=user.get_display_name() or str(user.id),
            role=role,
            membership_id=str(member.id),
            operation_id=str(member.id),
        )
        transaction.on_commit(
            lambda: safe_project_organization_notification(member_added_fact),
            using=postgres_app_db_alias(),
        )

        return member

    @transaction.atomic(using=postgres_app_db_alias())
    def update_member_role(
        self,
        organization_id: UUID,
        user_id: str,
        role: str,
        *,
        notification_actor: Any = None,
    ) -> bool:
        try:
            organization = Organization.objects.get(id=organization_id)
        except Organization.DoesNotExist:
            raise ServiceError('ORGANIZATION_NOT_FOUND', '组织不存在', 404)

        self.assert_team_organization(organization)

        operator_role = self._get_operator_role(organization)
        if not operator_role or ROLE_LEVELS.get(operator_role, 0) < ROLE_LEVELS['admin']:
            raise ServiceError('PERMISSION_DENIED', '仅团队管理员可管理成员', 403)

        if str(organization.owner_id) == str(user_id):
            raise ServiceError('CANNOT_CHANGE_OWNER', '不能变更所有者的角色', 403)

        try:
            member = OrganizationMember.objects.get(organization_id=organization_id, user_id=user_id)
        except OrganizationMember.DoesNotExist:
            raise ServiceError('MEMBER_NOT_FOUND', '成员不存在', 404)

        if role not in ORGANIZATION_ASSIGNABLE_ROLES:
            raise ServiceError('INVALID_ROLE', f'角色 {role} 不合法，可选: {", ".join(sorted(ORGANIZATION_ASSIGNABLE_ROLES))}')

        if not self._can_manage_target(operator_role, member.role):
            raise ServiceError('PERMISSION_DENIED', '无权管理该成员', 403)

        if not self._can_manage_target(operator_role, role):
            raise ServiceError('ROLE_ESCALATION', '不能分配高于或等于自己级别的角色', 403)

        old_role = member.role
        member.role = role
        member.save(update_fields=['role'])

        from apps.services.notification.services.organization_notification_projection import (
            OrganizationRoleChangedFact,
            safe_project_organization_notification,
        )

        fact_actor = notification_actor or self.user
        actor_name = fact_actor.get_display_name() if fact_actor else ''
        role_changed_fact = OrganizationRoleChangedFact(
            organization_id=str(organization_id),
            organization_name=organization.name,
            actor_id=str(getattr(fact_actor, 'id', '')),
            actor_name=actor_name or str(getattr(fact_actor, 'id', '')),
            affected_user_id=str(member.user_id),
            affected_user_name=member.user.get_display_name() or str(member.user_id),
            old_role=old_role,
            new_role=role,
            membership_id=str(member.id),
            operation_id=str(uuid4()),
        )
        transaction.on_commit(
            lambda: safe_project_organization_notification(role_changed_fact),
            using=postgres_app_db_alias(),
        )

        old_level = ROLE_LEVELS.get(old_role, 0)
        new_level = ROLE_LEVELS.get(role, 0)
        if old_level >= ROLE_LEVELS['editor'] and new_level < ROLE_LEVELS['editor']:
            # RV-013: viewer 降级时切换为只读模式而非断开连接
            self._schedule_collab_downgrade(str(user_id), str(organization_id))

        changed_user_id = str(user_id)
        changed_organization_id = str(organization_id)

        def _notify_role_change():
            BaseService.broadcast_permission_changed(changed_user_id, changed_organization_id)
            try:
                from django.core.cache import cache as _mc
                from apps.services.billing.services.member_budget_service import MemberBudgetService
                _mc.delete(f"member_budget:role:{changed_organization_id}:{changed_user_id}")
                _mc.delete(f"billing:organization_admins:{changed_organization_id}")
                MemberBudgetService._invalidate_policy_caches(changed_organization_id, changed_user_id)
            except Exception:
                logger.warning("[update_member_role] member_budget cache clear failed: user=%s wt=%s", changed_user_id, changed_organization_id, exc_info=True)

        transaction.on_commit(_notify_role_change, using=postgres_app_db_alias())

        return True

    @transaction.atomic(using=postgres_app_db_alias())
    def remove_member(
        self,
        organization_id: UUID,
        user_id: str,
        *,
        notification_actor: Any = None,
    ) -> bool:
        try:
            organization = Organization.objects.get(id=organization_id)
        except Organization.DoesNotExist:
            raise ServiceError('ORGANIZATION_NOT_FOUND', '组织不存在', 404)

        # 个人身份允许移除历史遗留成员，不做 assert_team_organization

        operator_role = self._get_operator_role(organization)
        if not operator_role or ROLE_LEVELS.get(operator_role, 0) < ROLE_LEVELS['admin']:
            raise ServiceError('PERMISSION_DENIED', '仅团队管理员可管理成员', 403)

        if str(organization.owner_id) == str(user_id):
            raise ServiceError('CANNOT_REMOVE_OWNER', '不能移除所有者', 403)

        try:
            member = OrganizationMember.objects.select_for_update().get(
                organization_id=organization_id,
                user_id=user_id,
            )
        except OrganizationMember.DoesNotExist:
            raise ServiceError('MEMBER_NOT_FOUND', '成员不存在', 404)

        if not self._can_manage_target(operator_role, member.role):
            raise ServiceError('PERMISSION_DENIED', '无权管理该成员', 403)

        from apps.services.notification.services.organization_notification_projection import (
            OrganizationMemberRemovedFact,
            safe_project_organization_notification,
        )

        fact_actor = notification_actor or self.user
        actor_name = fact_actor.get_display_name() if fact_actor else ''
        member_removed_fact = OrganizationMemberRemovedFact(
            organization_id=str(organization_id),
            organization_name=organization.name,
            actor_id=str(getattr(fact_actor, 'id', '')),
            actor_name=actor_name or str(getattr(fact_actor, 'id', '')),
            affected_user_id=str(member.user_id),
            affected_user_name=member.user.get_display_name() or str(member.user_id),
            membership_id=str(member.id),
            operation_id=str(member.id),
        )

        # 删除组织成员前同步撤销消息域权限；失败时 fail closed，保留成员关系供重试。
        self._sync_im_dm_revoke(str(user_id), str(organization_id))
        self._sync_session_share_revoke(str(user_id), str(organization_id))

        self._snapshot_departing_member_identity(member)
        member.delete()
        # Agent deactivation 由 post_delete(OrganizationMember) signal 统一处理

        # ：旧通用链接在移除后仍 pending；把该用户打进 accepted_users，堵住重入
        from apps.tabtinspace.services.invitation_service import InvitationService
        InvitationService.stamp_user_on_pending_link_invitations(
            organization_id,
            str(user_id),
            source='member_removed',
        )

        Device.objects.filter(user_id=user_id, organization_id=organization_id).update(status='offline')

        # RV-014: 移除成员属于高危操作，绕过 Celery 直接同步撤销
        self._sync_collab_revoke(str(user_id), str(organization_id))

        # DS-027: 主动撤销被移除用户的 Centrifugo 连接和频道订阅
        removed_user_id = str(user_id)
        removed_organization_id = str(organization_id)
        def _revoke_centrifugo_and_runs():
            self._notify_member_removed_from_organization(
                removed_user_id,
                removed_organization_id,
            )
            try:
                from django.core.cache import cache as _mc
                from apps.services.billing.services.member_budget_service import MemberBudgetService
                _mc.delete(f"member_budget:role:{removed_organization_id}:{removed_user_id}")
                _mc.delete(f"billing:organization_admins:{removed_organization_id}")
                MemberBudgetService._invalidate_policy_caches(removed_organization_id, removed_user_id)
                from apps.services.billing.models import MemberLlmBudgetPolicy
                MemberLlmBudgetPolicy.objects.filter(
                    organization_id=removed_organization_id, user_id=removed_user_id,
                ).update(is_active=False)
            except Exception:
                logger.warning("[remove_member] member_budget cache clear failed: user=%s wt=%s", removed_user_id, removed_organization_id, exc_info=True)
            # G5: 按 organization 粒度吊销被移除用户的 API Key
            try:
                from apps.users.auth.models import UserApiKey
                UserApiKey.objects.filter(
                    user_id=removed_user_id, organization_id=removed_organization_id,
                ).update(is_active=False)
            except Exception:
                logger.warning(
                    "API Key revocation after remove_member failed: user=%s wt=%s",
                    removed_user_id, removed_organization_id, exc_info=True,
                )
            try:
                from apps.tabchat.centrifugo_proxy import (
                    unsubscribe_centrifugo_user_from_organization,
                )
                # 只撤销该组织的 chat 频道，不能断开用户在其他组织的合法实时连接。
                unsubscribe_centrifugo_user_from_organization(
                    removed_user_id,
                    removed_organization_id,
                    synchronous=True,
                )
            except Exception:
                logger.warning(
                    "Centrifugo revocation after remove_member failed (non-blocking): "
                    "user=%s wt=%s",
                    removed_user_id, removed_organization_id, exc_info=True,
                )
        transaction.on_commit(_revoke_centrifugo_and_runs, using=postgres_app_db_alias())
        transaction.on_commit(
            lambda: safe_project_organization_notification(member_removed_fact),
            using=postgres_app_db_alias(),
        )
        return True

    @staticmethod
    def _notify_member_removed_from_organization(user_id: str, organization_id: str) -> None:
        """Prompt online clients before IM/Centrifugo revocation looks like a disconnect."""
        try:
            from django.db.models import Q
            from apps.services.common.ws.bus import publish_to_user
            from apps.services.common.ws.protocol import build_envelope, new_event_id

            all_ids = [
                str(item)
                for item in Organization.objects.filter(
                    Q(owner_id=user_id) | Q(members__user_id=user_id),
                ).distinct().values_list('id', flat=True)
            ]
            payload = {
                'added': [],
                'removed': [organization_id],
                'all_ids': sorted(all_ids),
                'primary_id': None,
                'reason': 'removed_from_all_organizations' if not all_ids else 'removed_from_organization',
            }
            delivered = publish_to_user(
                user_id,
                build_envelope('organization.membership_changed', new_event_id(), payload),
            )
            if not delivered:
                logger.warning(
                    "[remove_member] membership_changed push skipped: user=%s wt=%s",
                    user_id,
                    organization_id,
                )
        except Exception:
            logger.warning(
                "[remove_member] membership_changed push failed: user=%s wt=%s",
                user_id,
                organization_id,
                exc_info=True,
            )

    @transaction.atomic(using=postgres_app_db_alias())
    def transfer_ownership(
        self,
        organization_id: UUID,
        new_owner_user_id: str,
        *,
        as_staff: bool = False,
        notification_actor: Any = None,
    ) -> bool:
        """将组织所有权转让给现有成员。

        as_staff=True 时供后台代操作跳过「必须是当前 Owner」校验。
        """
        from apps.tabtinspace.models import SpaceMembership

        try:
            organization = Organization.objects.select_for_update().get(id=organization_id)
        except Organization.DoesNotExist:
            raise ServiceError('ORGANIZATION_NOT_FOUND', '组织不存在', 404)

        self.assert_team_organization(organization)

        if not as_staff and organization.owner_id != self.user.id:
            raise ServiceError('PERMISSION_DENIED', '只有所有者可以转让', 403)

        if str(organization.owner_id) == str(new_owner_user_id):
            raise ServiceError('SELF_TRANSFER', '不能将所有权转让给自己')

        try:
            new_owner_member = OrganizationMember.objects.select_for_update().get(
                organization_id=organization_id, user_id=new_owner_user_id,
            )
        except OrganizationMember.DoesNotExist:
            raise ServiceError('MEMBER_NOT_FOUND', '目标用户不是组织成员', 404)

        from apps.platform_config.services import PlatformRuntimeConfigService

        locked_new_owner = (
            User.objects.using(postgres_app_db_alias())
            .select_for_update()
            .get(pk=new_owner_user_id)
        )
        ownership_policy = PlatformRuntimeConfigService.get_organization_create_policy(
            locked_new_owner,
        )
        if not ownership_policy.allowed:
            raise ServiceError(
                'ORGANIZATION_LIMIT_EXCEEDED',
                ownership_policy.message,
                400,
            )

        try:
            old_owner_member = OrganizationMember.objects.select_for_update().get(
                organization_id=organization_id, user_id=organization.owner_id,
            )
        except OrganizationMember.DoesNotExist:
            raise ServiceError('MEMBER_NOT_FOUND', '当前所有者成员记录缺失', 500)

        # 两级模型（2026-06-10）：新写入不再产生 admin，旧 owner 降为 editor
        old_owner_member.role = 'editor'
        old_owner_member.save(update_fields=['role'])

        new_owner_member.role = 'owner'
        new_owner_member.save(update_fields=['role'])

        organization.owner_id = new_owner_user_id
        organization.save(update_fields=['owner_id', 'updated_at'])

        SpaceMembership.objects.filter(
            workspace__organization_id=organization_id,
            user_id=old_owner_member.user_id,
            role='owner',
            is_active=True,
        ).update(role='editor')
        SpaceMembership.objects.filter(
            workspace__organization_id=organization_id,
            user_id=new_owner_user_id,
            is_active=True,
        ).update(role='owner')

        from apps.services.notification.services.organization_notification_projection import (
            OrganizationOwnershipTransferredFact,
            safe_project_organization_notification,
        )

        fact_actor = notification_actor or self.user
        actor_name = fact_actor.get_display_name() if fact_actor else ''
        ownership_transferred_fact = OrganizationOwnershipTransferredFact(
            organization_id=str(organization_id),
            organization_name=organization.name,
            actor_id=str(getattr(fact_actor, 'id', '')),
            actor_name=actor_name or str(getattr(fact_actor, 'id', '')),
            old_owner_id=str(old_owner_member.user_id),
            old_owner_name=(
                old_owner_member.user.get_display_name() or str(old_owner_member.user_id)
            ),
            new_owner_id=str(new_owner_user_id),
            new_owner_name=locked_new_owner.get_display_name() or str(new_owner_user_id),
            recipient_user_ids=tuple(sorted({
                str(value)
                for value in OrganizationMember.objects.filter(
                    organization_id=organization_id,
                ).values_list('user_id', flat=True)
            })),
            operation_id=str(uuid4()),
        )

        old_owner_uid = str(old_owner_member.user_id)
        new_owner_uid = str(new_owner_user_id)
        wt_id_str = str(organization_id)

        def _notify_ownership_transfer():
            BaseService.broadcast_permission_changed(old_owner_uid, wt_id_str)
            BaseService.broadcast_permission_changed(new_owner_uid, wt_id_str)

        transaction.on_commit(_notify_ownership_transfer, using=postgres_app_db_alias())

        def _refresh_billing():
            try:
                from apps.services.billing.services.guard_service import BillingGuardService
                BillingGuardService.clear_guard_cache(wt_id_str)
                from apps.services.billing.services.entitlement_service import OrganizationEntitlementSyncService
                OrganizationEntitlementSyncService.sync_organization_entitlement(wt_id_str)
                logger.info("[transfer_ownership] billing caches refreshed: organization=%s", wt_id_str)
            except Exception:
                logger.warning("[transfer_ownership] billing refresh failed: organization=%s", wt_id_str, exc_info=True)
            try:
                from django.core.cache import cache as _mc
                from apps.services.billing.services.member_budget_service import MemberBudgetService
                _mc.delete(f"billing:organization_admins:{wt_id_str}")
                for _uid in (old_owner_uid, new_owner_uid):
                    _mc.delete(f"member_budget:role:{wt_id_str}:{_uid}")
                    MemberBudgetService._invalidate_policy_caches(wt_id_str, _uid)
            except Exception:
                logger.warning("[transfer_ownership] member_budget cache clear failed: organization=%s", wt_id_str, exc_info=True)

        transaction.on_commit(_refresh_billing, using=postgres_app_db_alias())
        transaction.on_commit(
            lambda: safe_project_organization_notification(ownership_transferred_fact),
            using=postgres_app_db_alias(),
        )

        return True

    @transaction.atomic(using=postgres_app_db_alias())
    def leave_organization(self, organization_id: UUID) -> bool:
        if not self.user:
            raise ServiceError('AUTH_REQUIRED', '需要登录', 401)

        try:
            organization = Organization.objects.get(id=organization_id)
        except Organization.DoesNotExist:
            raise ServiceError('ORGANIZATION_NOT_FOUND', '组织不存在', 404)

        if organization.owner_id == self.user.id:
            raise ServiceError('OWNER_CANNOT_LEAVE', '所有者不能离开自己的组织，请先转让所有权', 403)

        try:
            member = OrganizationMember.objects.get(
                organization_id=organization_id, user_id=self.user.id
            )
        except OrganizationMember.DoesNotExist:
            raise ServiceError('NOT_A_MEMBER', '你不是该组织的成员', 404)

        leaving_user_id = str(self.user.id)
        wt_id_str = str(organization_id)
        self._sync_im_dm_revoke(leaving_user_id, wt_id_str)
        self._sync_session_share_revoke(leaving_user_id, wt_id_str)
        self._snapshot_departing_member_identity(member)
        member.delete()
        # Agent deactivation 由 post_delete(OrganizationMember) signal 统一处理

        # ：主动离开后同样不可用旧通用链接重入
        from apps.tabtinspace.services.invitation_service import InvitationService
        InvitationService.stamp_user_on_pending_link_invitations(
            organization_id,
            leaving_user_id,
            source='member_left',
        )

        Device.objects.filter(user_id=self.user.id, organization_id=organization_id).update(status='offline')

        def _disconnect_centrifugo_and_runs():
            try:
                from django.core.cache import cache as _mc
                from apps.services.billing.services.member_budget_service import MemberBudgetService
                _mc.delete(f"member_budget:role:{wt_id_str}:{leaving_user_id}")
                _mc.delete(f"billing:organization_admins:{wt_id_str}")
                MemberBudgetService._invalidate_policy_caches(wt_id_str, leaving_user_id)
            except Exception:
                logger.warning("[leave_organization] member_budget cache clear failed: user=%s wt=%s", leaving_user_id, wt_id_str, exc_info=True)
            # G5: 按 organization 粒度吊销离开用户的 API Key
            try:
                from apps.users.auth.models import UserApiKey
                UserApiKey.objects.filter(
                    user_id=leaving_user_id, organization_id=wt_id_str,
                ).update(is_active=False)
            except Exception:
                logger.warning(
                    "API Key revocation after leave_organization failed: user=%s wt=%s",
                    leaving_user_id, wt_id_str, exc_info=True,
                )
            try:
                from apps.tabchat.centrifugo_proxy import (
                    unsubscribe_centrifugo_user_from_organization,
                )
                # 只清理离开组织的频道，保留该用户在其他组织的实时协作。
                unsubscribe_centrifugo_user_from_organization(
                    leaving_user_id,
                    wt_id_str,
                    synchronous=True,
                )
            except Exception:
                logger.warning(
                    "Centrifugo disconnect after leave_organization failed (non-blocking): user=%s wt=%s",
                    leaving_user_id, organization_id,
                )
        transaction.on_commit(_disconnect_centrifugo_and_runs, using=postgres_app_db_alias())

        # RB-004: 通知 collab-live 撤销该用户的协作连接
        self._schedule_collab_revoke(leaving_user_id, wt_id_str)
        return True

    # ==================== 统计信息 ====================

    def get_organization_stats(self, organization_id: UUID) -> Dict[str, Any]:
        if not self.check_organization_permission(str(organization_id), 'viewer'):
            raise ServiceError('ORGANIZATION_NOT_FOUND', '组织不存在', 404)

        try:
            organization = Organization.objects.get(id=organization_id)

            as_agg = Workspace.objects.filter(organization_id=organization_id).aggregate(
                total=Count('id'),
                active=Count('id'),
            )

            tbl_agg = Table.objects.filter(organization_id=organization_id).aggregate(
                total=Count('id'),
                active=Count('id', filter=Q(is_archived=False)),
                total_records=Sum('row_count', filter=Q(is_archived=False), default=0),
            )

            real_member_count = OrganizationMember.objects.filter(
                organization_id=organization_id
            ).count()

            if organization.member_count != real_member_count:
                logger.warning(
                    "[OrganizationStats] organization %s member_count 偏差: "
                    "缓存=%d 实际=%d（由定时任务修正）",
                    organization_id, organization.member_count, real_member_count,
                )

            return {
                'organization_id': str(organization.id),
                'organization_name': organization.name,
                'is_default': organization.is_default,
                'space_count': as_agg['total'],
                'active_space_count': as_agg['active'],
                'table_count': tbl_agg['total'],
                'active_table_count': tbl_agg['active'],
                'member_count': real_member_count,
                'total_records': tbl_agg['total_records'] or 0,
                'created_at': organization.created_at.isoformat(),
                'updated_at': organization.updated_at.isoformat()
            }
        except Organization.DoesNotExist:
            raise ServiceError('ORGANIZATION_NOT_FOUND', '组织不存在', 404)
