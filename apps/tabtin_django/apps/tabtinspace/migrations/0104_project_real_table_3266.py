#  终态 · 步骤 1/N：Project 独立真表落地 + 数据镜像（团队协作层退出 Space 壳）。
#
# 关键决策：
# - **id 复用**：Project.id 沿用源 Space(team_space).id ——
#   前端 project_id / 会话历史 / ProjectTask.project_id 与 ProjectMemberWorkspace.project_id
#   同值切换，后续迁移只需 AlterField FK target 就能无缝切到 Project。
# - **成员镜像**：SpaceMembership 中挂在 team_space 上的 user 行 → ProjectMembership；
#   Agent-membership 在 team_space 上没有落地（PRD Q3：Project 里的 Agent 归属由 Task 与
#   PrimaryAgent 语义承接），本步骤不复制 agent-scope 成员。
# - **本步骤不改 FK、不删 Space 行**：因为 ProjectTask/ProjectMemberWorkspace 的 project
#   FK 仍指 Space，且 ~10 个 project 服务/路由仍以 ``Space(type=team_space)`` 读写；把
#   FK 切换与服务收敛放到同 PR 的后续 commit，这里仅建立目标终态可用的表结构与数据镜像。
# - **反向可回退**：开发期反向直接清空 Project/ProjectMembership，源 Space 行未动。
#
# 产品未正式上线团队 Project，dogfood 数据可有损；彩排失败按执行计划重置 dev-db-dumps。
# 0.0.3 分支 PR2b（0098_pr2b_*）**不 cherry-pick**——本迁移编号独立。

from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion
import uuid


def forwards_migrate_team_space(apps, schema_editor):
    """team_space Space 行 → Project 行；SpaceMembership team_space → ProjectMembership。"""
    Space = apps.get_model('tabtinspace', 'Space')
    SpaceMembership = apps.get_model('tabtinspace', 'SpaceMembership')
    Project = apps.get_model('tabtinspace', 'Project')
    ProjectMembership = apps.get_model('tabtinspace', 'ProjectMembership')

    team_spaces = list(
        Space.objects.filter(type='team_space').iterator()
    )
    if not team_spaces:
        return

    valid_statuses = {'active', 'paused', 'completed', 'archived', 'trashed'}
    valid_visibility = {'private', 'shared'}
    project_ids = []
    projects = []
    for s in team_spaces:
        project_ids.append(s.id)
        projects.append(Project(
            id=s.id,
            organization_id=s.organization_id,
            name=s.name or '',
            description=s.description or '',
            avatar=s.avatar or '',
            color=s.color or '',
            status=s.status if s.status in valid_statuses else 'active',
            order=s.order or 0,
            is_archived=bool(s.is_archived),
            is_default=bool(s.is_default),
            visibility=s.visibility if s.visibility in valid_visibility else 'private',
            config_version=s.config_version or 0,
            last_activity_at=s.last_activity_at,
            start_date=s.start_date,
            end_date=s.end_date,
            trashed_at=s.trashed_at,
            trashed_by=s.trashed_by,
            previous_status=s.previous_status or '',
            created_at=s.created_at,
            updated_at=s.updated_at,
        ))
    Project.objects.bulk_create(projects, batch_size=500)

    memberships = list(
        SpaceMembership.objects
        .filter(space_id__in=project_ids, user__isnull=False)
        .iterator()
    )
    project_memberships = [
        ProjectMembership(
            id=m.id,
            project_id=m.space_id,
            user_id=m.user_id,
            role=m.role or 'viewer',
            permissions=m.permissions or {},
            is_active=bool(m.is_active),
            status='pending' if m.status == 'pending' else 'active',
            invited_by=m.invited_by,
            role_label=m.role_label or '',
            responsibility=m.responsibility or '',
            joined_at=m.joined_at,
            updated_at=m.updated_at,
        )
        for m in memberships
    ]
    if project_memberships:
        ProjectMembership.objects.bulk_create(project_memberships, batch_size=500)


def reverse_migrate_team_space(apps, schema_editor):
    """开发期反向：清空新表；源 Space team_space 行仍在。"""
    apps.get_model('tabtinspace', 'ProjectMembership').objects.all().delete()
    apps.get_model('tabtinspace', 'Project').objects.all().delete()


class Migration(migrations.Migration):

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ('tabtinspace', '0103_project_task_run_mvp'),
    ]

    operations = [
        migrations.CreateModel(
            name='Project',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('name', models.CharField(max_length=255, verbose_name='名称')),
                ('description', models.TextField(blank=True, default='', verbose_name='描述')),
                ('avatar', models.CharField(blank=True, default='', help_text='优先保存 OSS object key / FileRecord.file_key；旧完整 URL 仅作兼容', max_length=500, verbose_name='头像文件引用')),
                ('color', models.CharField(blank=True, default='', max_length=20, verbose_name='标签颜色')),
                ('status', models.CharField(choices=[('active', '进行中'), ('paused', '暂停'), ('completed', '已完成'), ('archived', '已归档'), ('trashed', '已删除')], default='active', max_length=20, verbose_name='状态')),
                ('order', models.IntegerField(default=0, verbose_name='排序')),
                ('is_archived', models.BooleanField(default=False, verbose_name='是否归档')),
                ('is_default', models.BooleanField(default=False, verbose_name='是否默认')),
                ('visibility', models.CharField(choices=[('private', '仅创建者'), ('shared', '已共享')], default='private', max_length=20, verbose_name='可见范围')),
                ('config_version', models.PositiveIntegerField(default=0, help_text='乐观并发控制版本号', verbose_name='配置版本号')),
                ('last_activity_at', models.DateTimeField(blank=True, db_index=True, help_text='由各子系统通过信号统一更新，用于列表排序', null=True, verbose_name='最后活跃时间')),
                ('start_date', models.DateField(blank=True, null=True, verbose_name='开始日期')),
                ('end_date', models.DateField(blank=True, null=True, verbose_name='结束日期')),
                ('trashed_at', models.DateTimeField(blank=True, db_index=True, null=True, verbose_name='回收站时间')),
                ('trashed_by', models.UUIDField(blank=True, null=True, verbose_name='回收站操作人')),
                ('previous_status', models.CharField(blank=True, default='', max_length=20, verbose_name='回收前状态')),
                ('created_at', models.DateTimeField(auto_now_add=True, verbose_name='创建时间')),
                ('updated_at', models.DateTimeField(auto_now=True, verbose_name='更新时间')),
                ('organization', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='projects', to='tabtinspace.organization', verbose_name='所属组织')),
            ],
            options={
                'verbose_name': 'Project',
                'verbose_name_plural': 'Projects',
                'db_table': 'tabtinspace_project',
                'ordering': ['order', '-created_at'],
                'indexes': [
                    models.Index(fields=['organization', 'status'], name='ctx_project_org_status_idx'),
                    models.Index(fields=['organization', 'is_archived'], name='ctx_project_org_archived_idx'),
                    models.Index(fields=['organization', 'last_activity_at'], name='ctx_project_org_activity_idx'),
                ],
            },
        ),
        migrations.CreateModel(
            name='ProjectMembership',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('role', models.CharField(choices=[('owner', '所有者'), ('admin', '管理员'), ('editor', '编辑者'), ('viewer', '查看者'), ('participant', '参与者')], default='viewer', max_length=20, verbose_name='角色')),
                ('permissions', models.JSONField(default=dict, verbose_name='自定义权限')),
                ('is_active', models.BooleanField(default=True, verbose_name='是否有效')),
                ('status', models.CharField(choices=[('active', '已生效'), ('pending', '待接受')], db_index=True, default='active', max_length=20, verbose_name='成员状态')),
                ('invited_by', models.UUIDField(blank=True, null=True, verbose_name='邀请人用户 ID')),
                ('role_label', models.CharField(blank=True, default='', max_length=50, verbose_name='角色标签')),
                ('responsibility', models.TextField(blank=True, default='', verbose_name='职责描述')),
                ('joined_at', models.DateTimeField(auto_now_add=True, verbose_name='加入时间')),
                ('updated_at', models.DateTimeField(auto_now=True, verbose_name='更新时间')),
                ('project', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='memberships', to='tabtinspace.project', verbose_name='所属 Project')),
                ('user', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='project_memberships', to=settings.AUTH_USER_MODEL, verbose_name='成员')),
            ],
            options={
                'verbose_name': 'Project 成员',
                'verbose_name_plural': 'Project 成员',
                'db_table': 'tabtinspace_project_membership',
                'indexes': [
                    models.Index(fields=['project', 'role'], name='ctx_pm_project_role_idx'),
                    models.Index(fields=['user', 'joined_at'], name='ctx_pm_user_joined_idx'),
                    models.Index(fields=['user', 'status'], name='ctx_pm_user_status_idx'),
                ],
                'constraints': [
                    models.UniqueConstraint(fields=('project', 'user'), name='ctx_pm_project_user_unique'),
                ],
            },
        ),
        migrations.RunPython(
            forwards_migrate_team_space,
            reverse_migrate_team_space,
        ),
    ]
