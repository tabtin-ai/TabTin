#  终态 · 步骤 2b/N：team_space Space 壳物理消解（数据步）。
#
# 0105 已完成 Project FK schema。本迁移只做 RunPython：
# 清理已镜像走的 team_space Space 行（及其 SpaceMembership / SpaceAppSettings /
# Collection / SpacePermission），确保只留下 workspace 型个人现场。
#
# 与 0105 AddField(FK) 拆事务，避  /  pending trigger events。

from django.db import migrations, models
import uuid


def forwards_delete_team_space_shells(apps, schema_editor):
    """删除已经镜像到 :class:`Project` 的 team_space Space 行。"""
    Space = apps.get_model('tabtinspace', 'Space')
    SpaceMembership = apps.get_model('tabtinspace', 'SpaceMembership')
    SpaceAppSettings = apps.get_model('tabtinspace', 'SpaceAppSettings')
    SpacePermission = apps.get_model('tabtinspace', 'SpacePermission')
    Collection = apps.get_model('tabtinspace', 'Collection')
    ContextItem = apps.get_model('tabtinspace', 'ContextItem')
    ProjectMemberWorkspace = apps.get_model('tabtinspace', 'ProjectMemberWorkspace')

    team_space_ids = list(
        Space.objects.filter(type='team_space').values_list('id', flat=True)
    )
    if not team_space_ids:
        return
    # 团队 App 设置落到成员伴生 Workspace（id-reuse：workspace_id == 个人 Space.id），
    # 避免直接 DELETE 丢失房间级禁用/白名单配置。
    for sas in SpaceAppSettings.objects.filter(space_id__in=team_space_ids).iterator():
        companion_ws_ids = (
            ProjectMemberWorkspace.objects
            .filter(project_id=sas.space_id)
            .values_list('workspace_id', flat=True)
        )
        for ws_id in companion_ws_ids:
            if ws_id is None:
                continue
            if SpaceAppSettings.objects.filter(space_id=ws_id, user_id=sas.user_id).exists():
                continue
            SpaceAppSettings.objects.create(
                id=uuid.uuid4(),
                space_id=ws_id,
                user_id=sas.user_id,
                disabled_apps=sas.disabled_apps or [],
                optional_tools_allowlist=sas.optional_tools_allowlist or {},
                created_at=sas.created_at,
                updated_at=sas.updated_at,
            )
    # 显式清理：Membership / AppSettings / Permission 已由 ProjectMembership 承接
    # （或团队侧无独立资产语义）。Collection / ContextItem 必须先挂 Project，
    # 禁止 delete——否则团队文件夹与交付物资产永久丢失。
    SpaceMembership.objects.filter(space_id__in=team_space_ids).delete()
    SpaceAppSettings.objects.filter(space_id__in=team_space_ids).delete()
    SpacePermission.objects.filter(space_id__in=team_space_ids).delete()
    # id-reuse：team_space.id == Project.id。先写 project_id 再清空 space。
    Collection.objects.filter(space_id__in=team_space_ids).update(
        project_id=models.F('space_id'),
    )
    Collection.objects.filter(space_id__in=team_space_ids).update(space_id=None)
    ContextItem.objects.filter(space_id__in=team_space_ids).update(
        project_id=models.F('space_id'),
    )
    ContextItem.objects.filter(space_id__in=team_space_ids).update(space_id=None)
    Space.objects.filter(id__in=team_space_ids).delete()


def reverse_delete_team_space_shells(apps, schema_editor):
    """开发期反向：从 Project 反向重建 team_space Space 壳。"""
    Space = apps.get_model('tabtinspace', 'Space')
    Project = apps.get_model('tabtinspace', 'Project')
    ProjectMembership = apps.get_model('tabtinspace', 'ProjectMembership')
    SpaceMembership = apps.get_model('tabtinspace', 'SpaceMembership')

    space_rows = []
    membership_rows = []
    for p in Project.objects.iterator():
        space_rows.append(Space(
            id=p.id,
            organization_id=p.organization_id,
            name=p.name,
            description=p.description,
            avatar=p.avatar,
            color=p.color,
            status=p.status,
            order=p.order,
            is_archived=p.is_archived,
            is_default=p.is_default,
            visibility=p.visibility,
            config_version=p.config_version,
            last_activity_at=p.last_activity_at,
            start_date=p.start_date,
            end_date=p.end_date,
            trashed_at=p.trashed_at,
            trashed_by=p.trashed_by,
            previous_status=p.previous_status,
            type='team_space',
            working_dir='',
            normalized_working_dir='',
            working_dir_type='',
            icon='',
            table_count=0,
            created_at=p.created_at,
            updated_at=p.updated_at,
        ))
    if space_rows:
        Space.objects.bulk_create(space_rows, batch_size=500)
    for m in ProjectMembership.objects.iterator():
        membership_rows.append(SpaceMembership(
            id=m.id,
            space_id=m.project_id,
            user_id=m.user_id,
            agent=None,
            role=m.role,
            permissions=m.permissions,
            is_active=m.is_active,
            status=m.status,
            invited_by=m.invited_by,
            role_label=m.role_label,
            responsibility=m.responsibility,
            joined_at=m.joined_at,
            updated_at=m.updated_at,
        ))
    if membership_rows:
        SpaceMembership.objects.bulk_create(membership_rows, batch_size=500)


class Migration(migrations.Migration):

    dependencies = [
        ('tabtinspace', '0105_project_fk_cutover_3266'),
    ]

    operations = [
        migrations.RunPython(
            forwards_delete_team_space_shells,
            reverse_delete_team_space_shells,
        ),
    ]
