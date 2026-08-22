"""
UserPortrait Signal Handlers — Organization / 成员变更时级联清理画像。

落实决策：
  - N3：Organization 解散时级联删除该 Organization 内所有用户的画像
  - N4：成员退出 Organization 时立即删除该成员在该 Organization 的画像

设计要点：
  - 通过 Django post_delete signal 触发，不依赖业务代码主动调用
  - 失败只记 log，不阻塞 Organization / OrganizationMember 的删除流程
  - 使用字符串 sender + lazy import 避免依赖加载顺序问题
    （测试环境可能未装 tabtinspace，模块 import 时不能直接拿 Organization 类）
"""

from __future__ import annotations

import logging

from django.apps import apps as django_apps
from django.db.models.signals import post_delete
from django.dispatch import receiver

logger = logging.getLogger(__name__)


# 使用字符串 sender（"app_label.ModelName"）让 Django 在 ready 期完成解析。
# 如果 tabtinspace 未装（测试 settings 等），@receiver 装饰器仍可注册成功，
# 只是永远不会被触发——这正是我们想要的兜底行为。
@receiver(post_delete, sender="tabtinspace.Organization")
def _cleanup_portraits_on_organization_delete(sender, instance, **kwargs):
    """决策 N3：Organization 删除时清理该 Organization 内所有用户的画像。"""
    try:
        from apps.user_portrait.services.portrait_service import UserPortraitService

        count = UserPortraitService.delete_portraits_for_organization(str(instance.id))
        if count:
            logger.info(
                "[Portrait::signal] Cleaned up %d portraits after organization %s deleted",
                count, instance.id,
            )
    except Exception as exc:
        # 不阻塞 Organization 删除流程
        logger.warning(
            "[Portrait::signal] Failed to cleanup portraits for deleted organization %s: %s",
            instance.id, exc,
        )


@receiver(post_delete, sender="agent.Agent")
def _cleanup_portraits_on_agent_delete(sender, instance, **kwargs):
    """#4090/#4118：Agent **硬删除** 时清理该 Agent 的全部 per-Agent 画像。

    画像用 UUIDField 引用 Agent（无 DB 外键，与 organization_id 同策略），Agent 硬删
    不会 DB 级联删画像——必须 signal 显式清理，避免留下召不回也清不掉的孤儿画像。

    ⚠️ 边界：产品当前删 Agent 走 **软删除**（``is_active=False`` + ``save()``），
    **不发 post_delete**，本 handler 只在硬删 / Organization 级联硬删（Agent 的
    ``organization`` FK ``on_delete=CASCADE``）时触发。AgentMemory（``agent`` FK
    ``on_delete=CASCADE``）同样只在硬删触发——两域在软删下**一致地都不清理**，
    读侧靠 ``is_active=True`` 过滤 fail-closed（软删后 GET 404、不泄漏），但数据滞留。
    软删即抹记忆/画像是否为硬隐私要求需产品拍板，且应同时覆盖 AgentMemory，不在
    本波范围（已知既有缺口，非本次改动引入）。
    """
    try:
        from apps.user_portrait.services.portrait_service import UserPortraitService

        count = UserPortraitService.delete_portraits_for_agent(str(instance.id))
        if count:
            logger.info(
                "[Portrait::signal] Cleaned up %d portrait(s) after agent %s deleted",
                count, instance.id,
            )
    except Exception as exc:
        # 不阻塞 Agent 删除流程
        logger.warning(
            "[Portrait::signal] Failed to cleanup portraits for deleted agent %s: %s",
            instance.id, exc,
        )


@receiver(post_delete, sender="tabtinspace.OrganizationMember")
def _cleanup_portrait_on_member_exit(sender, instance, **kwargs):
    """决策 N4：成员退出 Organization 时立即删除该成员在该 Organization 的画像（隐私优先）。

    注意 owner 的画像不在这里清理——owner 退出意味着 Organization 通常也被删除（或转让），
    Organization 删除走上面的 _cleanup_portraits_on_organization_delete 路径。
    """
    try:
        from apps.user_portrait.services.portrait_service import UserPortraitService

        deleted = UserPortraitService.delete_portrait_for_member(
            user_id=str(instance.user_id),
            organization_id=str(instance.organization_id),
        )
        if deleted:
            logger.info(
                "[Portrait::signal] Cleaned up portrait for user %s exiting organization %s",
                instance.user_id, instance.organization_id,
            )
    except Exception as exc:
        logger.warning(
            "[Portrait::signal] Failed to cleanup portrait for user %s "
            "exiting organization %s: %s",
            instance.user_id, instance.organization_id, exc,
        )


# 提示静态分析器：django_apps 引用是为了将来可能加上"未注册时记 warning"的扩展点
_ = django_apps
