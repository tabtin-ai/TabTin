"""进宝 User 和 OrganizationMember 的幂等 provisioning。

幂等性是核心：worker 重启、signal 重复触发、management command 重跑都不能炸。

P0-3 修正：ensure_jinbao_user() 创建 User 前必须先 disconnect
`apps.tabtinspace.signals.create_default_organization`，否则会触发：
  - 给进宝创建 personal Organization + bot Space + provision_billing（真的会跑账户开通）
  - 污染 Agent 表 / SpaceMembership / 各种统计计数
finally 中 reconnect，保证退出对其他 User 创建无影响。
"""

from __future__ import annotations

import logging

from django.contrib.auth import get_user_model
from django.db import transaction

from apps.tabtinspace.models import Organization, OrganizationMember
from apps.services.common.db_router import postgres_app_db_alias

from .constants import (
    JINBAO_BIO,
    JINBAO_EMAIL,
    JINBAO_NICKNAME,
    JINBAO_USER_ID,
)

User = get_user_model()
logger = logging.getLogger(__name__)


def ensure_jinbao_user() -> 'User':
    """幂等创建进宝 User。返回 User 实例。

    P0-3：临时 disconnect create_default_organization，避免触发 personal organization
    / bot Space / Agent / billing 的开通副作用。
    """
    from django.db.models.signals import post_save
    from apps.tabtinspace.signals import create_default_organization

    post_save.disconnect(create_default_organization, sender=User)
    try:
        user, created = User.objects.using('default').get_or_create(
            id=JINBAO_USER_ID,
            defaults={
                'email': JINBAO_EMAIL,
                'nickname': JINBAO_NICKNAME,
                'bio': JINBAO_BIO,
                'is_active': True,
            },
        )
        if created:
            user.set_unusable_password()  # 永远不可登录
            user.save(using='default', update_fields=['password'])
            logger.info('[jinbao] User created (id=%s)', JINBAO_USER_ID)
        else:
            # 二次刷新 nickname/bio——允许后续调整文案后重跑 seed 自动同步
            dirty = False
            if user.nickname != JINBAO_NICKNAME:
                user.nickname = JINBAO_NICKNAME
                dirty = True
            if user.bio != JINBAO_BIO:
                user.bio = JINBAO_BIO
                dirty = True
            if dirty:
                user.save(using='default', update_fields=['nickname', 'bio'])
                logger.info('[jinbao] User profile refreshed')
    finally:
        post_save.connect(create_default_organization, sender=User)
    return user


def ensure_jinbao_in_organization(organization_id: str) -> bool:
    """幂等把进宝加入指定 organization（仅 TEAM 类型）。

    返回 True 表示新加，False 表示已存在 / 跳过。

    P0-4：只处理 TEAM organization；personal organization 是 owner-only 的个人身份，
    加进宝会破坏「不可邀请成员」契约 + provision_organization_defaults 会覆写
    member_count=1 造成 off-by-one。
    """
    ensure_jinbao_user()

    # Organization / OrganizationMember 都在 PG，事务范围限定 PG
    with transaction.atomic(using=postgres_app_db_alias()):
        try:
            organization = Organization.objects.using(postgres_app_db_alias()).get(id=organization_id)
        except Organization.DoesNotExist:
            logger.warning('[jinbao] organization=%s not found, skip', organization_id)
            return False

        if organization.type != Organization.OrganizationType.TEAM:
            return False

        _, created = OrganizationMember.objects.using(postgres_app_db_alias()).get_or_create(
            organization=organization,
            user_id=JINBAO_USER_ID,
            defaults={'role': 'editor'},  # editor 而非 viewer——能在 IM 收发消息
        )
        if created:
            logger.info('[jinbao] joined organization=%s', organization_id)
        return created


def ensure_jinbao_in_all_organizations() -> int:
    """给所有现存 TEAM organization 批量加进宝。返回新增成员数。

    P0-5：filter(type=TEAM)，跳过 personal。
    """
    ensure_jinbao_user()
    count = 0
    qs = (
        Organization.objects
        .using(postgres_app_db_alias())
        .filter(type=Organization.OrganizationType.TEAM)
        .values_list('id', flat=True)
    )
    for wt_id in qs:
        try:
            if ensure_jinbao_in_organization(str(wt_id)):
                count += 1
        except Exception:
            logger.exception('[jinbao] backfill failed for organization=%s', wt_id)
    logger.info('[jinbao] backfill done: %d new memberships', count)
    return count
