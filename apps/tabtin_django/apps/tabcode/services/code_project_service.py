"""TabCode 代码项目 Service"""

import logging

from django.db import transaction

from apps.tabtinspace.services.base import BaseService
from apps.tabtinspace.services.resource_bridge import ResourceBridge
from apps.tabcode.models import CodeProject

logger = logging.getLogger(__name__)


class CodeProjectService(BaseService):
    """代码项目 CRUD 服务"""

    def list_projects(self, space_id: str, user) -> list[CodeProject]:
        """列出智能体空间下所有活跃的代码项目"""
        self.check_space_permission(space_id, "viewer")
        return list(
            CodeProject.objects.filter(
                space_id=space_id,
                status="active",
            ).order_by("-updated_at")
        )

    def create_project(self, space_id: str, organization_id: str, user, **kwargs) -> CodeProject:
        """创建代码项目记录"""
        self.check_space_permission(space_id, "editor")
        code_project = CodeProject.objects.create(
            space_id=space_id,
            organization_id=organization_id,
            created_by=user,
            **kwargs,
        )
        ResourceBridge.on_create(code_project, user)
        return code_project

    def get_project(self, space_id: str, code_project_id: str, user) -> CodeProject:
        """获取单个代码项目"""
        self.check_space_permission(space_id, "viewer")
        return CodeProject.objects.get(
            id=code_project_id,
            space_id=space_id,
            status="active",
        )

    def update_project(self, space_id: str, code_project_id: str, user, **kwargs) -> CodeProject:
        """更新代码项目"""
        self.check_space_permission(space_id, "editor")
        code_project = CodeProject.objects.get(
            id=code_project_id,
            space_id=space_id,
        )
        for key, value in kwargs.items():
            if value is not None:
                setattr(code_project, key, value)
        code_project.save()
        ResourceBridge.on_update(code_project, user)
        return code_project

    def archive_project(self, space_id: str, code_project_id: str, user) -> CodeProject:
        """归档代码项目"""
        self.check_space_permission(space_id, "editor")
        code_project = CodeProject.objects.get(
            id=code_project_id,
            space_id=space_id,
        )
        code_project.status = "archived"
        code_project.save(update_fields=["status", "updated_at"])
        ResourceBridge.on_archive(code_project, user)
        return code_project

    @transaction.atomic
    def trash_project(self, space_id: str, code_project_id: str, user) -> CodeProject:
        """将代码项目移入回收站。

        ：源已 trashed 时幂等成功，仅补齐 ContextItem 投影。
        """
        self.check_space_permission(space_id, "editor")
        code_project = CodeProject.objects.get(
            id=code_project_id,
            space_id=space_id,
        )
        if code_project.trashed_at is not None:
            if not ResourceBridge.on_trash(code_project, user):
                raise ValueError("移入回收站失败：资源投影同步未完成，请重试")
            return code_project
        code_project.trash(user_id=user.id)
        if not ResourceBridge.on_trash(code_project, user):
            raise ValueError("移入回收站失败：资源投影同步未完成，请重试")
        return code_project

    @transaction.atomic
    def restore_project_from_trash(self, space_id: str, code_project_id: str, user) -> CodeProject:
        """从回收站恢复代码项目"""
        self.check_space_permission(space_id, "editor")
        code_project = CodeProject.objects.get(
            id=code_project_id,
            space_id=space_id,
        )
        if code_project.trashed_at is None:
            raise ValueError("项目不在回收站中")

        ResourceBridge.check_restore_quota(code_project)

        code_project.restore_from_trash()
        ResourceBridge.on_restore(code_project, user)
        return code_project

    @transaction.atomic
    def permanent_delete_project(self, space_id: str, code_project_id: str, user) -> None:
        """永久删除代码项目（仅限回收站中的项目）"""
        self.check_space_permission(space_id, "editor")
        code_project = CodeProject.objects.get(
            id=code_project_id,
            space_id=space_id,
        )
        if code_project.status != "trashed":
            raise ValueError("只能永久删除回收站中的项目")

        user_id = getattr(user, "id", None)
        logger.debug(
            "[PermanentDelete] module=tabcode resource=%s name=%r user=%s",
            code_project.id, getattr(code_project, "title", ""), user_id,
        )

        if not ResourceBridge.on_delete(code_project, user=user):
            logger.warning(
                "[PermanentDelete] ResourceBridge.on_delete 返回 False, "
                "ContextItem 可能未清理: %s(%s)",
                type(code_project).__name__, code_project.id,
            )
        code_project.delete()
