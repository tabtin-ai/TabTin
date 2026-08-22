#  PR2（Workspace 独立成表）：执行现场 (设备, 规范化目录) 的终态建模。
#
# 吸收主场方案建模需求 M-1~M-7（docs/prd/home-workspace-p1-implementation-v1.md §2）：
# kind 枚举（M-1）、每设备一个主场 partial unique（M-2）、trust 三字段（M-3）、
# 主约束 (device, normalized_working_dir) 唯一（M-5，接管 Space 时代
# ctx_space_device_dir_unique 职能）、一目录多 Project 走未来 join 表不放
# 单 FK（M-7）。数据迁移见 0097（id 复用源 Space.id）。

from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion
import uuid


class Migration(migrations.Migration):

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ('tabtinspace', '0095c_agent_drop_user_fk'),
    ]

    operations = [
        migrations.CreateModel(
            name='Workspace',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('name', models.CharField(blank=True, default='', help_text='本地化展示名（主场存「主场/Home」，M-4）；目录路径才是身份，名字只是标签。', max_length=255, verbose_name='展示名')),
                ('working_dir', models.TextField(help_text='设备上的工作目录绝对路径（客户端解析后传入，后端不臆造路径）。', verbose_name='工作目录')),
                ('normalized_working_dir', models.TextField(db_index=True, help_text='用于 (device, path) 唯一约束的规范化路径（SpaceService._canonical_working_dir 口径）。', verbose_name='标准化工作目录')),
                ('working_dir_type', models.CharField(blank=True, default='', help_text='code/mixed/doc；空值表示未设置。', max_length=20, verbose_name='工作目录类型')),
                ('kind', models.CharField(choices=[('home', '主场'), ('standard', '普通')], default='standard', help_text='home=每设备静默供给的主场（ P1）；standard=用户开目录建的普通现场。', max_length=16, verbose_name='现场类别')),
                ('trust_status', models.CharField(choices=[('trusted', '已信任'), ('untrusted', '未信任')], default='untrusted', max_length=16, verbose_name='信任状态')),
                ('trust_source', models.CharField(choices=[('system_provisioned', '系统自建默认受信'), ('user_confirmed', '用户确认'), ('none', '无')], default='none', max_length=32, verbose_name='信任来源')),
                ('trusted_at', models.DateTimeField(blank=True, null=True, verbose_name='信任时间')),
                ('git_status', models.JSONField(blank=True, default=dict, help_text='Daemon 心跳上报的仓库状态（is_repo/branch/…）；仅现场快照，不承载业务语义。', verbose_name='git 状态快照')),
                ('approval_grant', models.CharField(choices=[('always_ask', '每次询问'), ('auto', '自动批准低风险操作'), ('full_access', '完全访问')], default='always_ask', help_text='进入该 Workspace 的所有自有 Agent 共用；仍受 Organization 天花板约束。', max_length=16, verbose_name='现场审批授权档位')),
                ('approval_memo', models.JSONField(blank=True, default=dict, help_text='审批 always 决策，结构为 {version, entries, generation}。', verbose_name='现场审批记忆')),
                ('created_at', models.DateTimeField(auto_now_add=True, verbose_name='创建时间')),
                ('updated_at', models.DateTimeField(auto_now=True, verbose_name='更新时间')),
                ('created_by', models.ForeignKey(blank=True, help_text='个人执行现场的归属用户（个人域 Space 壳消解后的归属锚点）。', null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='created_workspaces', to=settings.AUTH_USER_MODEL, verbose_name='创建者')),
                ('device', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='workspaces', to='tabtinspace.device', verbose_name='执行设备')),
                ('organization', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='workspaces', to='tabtinspace.organization', verbose_name='所属组织')),
            ],
            options={
                'verbose_name': 'Workspace',
                'verbose_name_plural': 'Workspaces',
                'db_table': 'tabtinspace_workspace',
                'indexes': [models.Index(fields=['organization', 'kind'], name='ctx_ws_org_kind_idx'), models.Index(fields=['created_by'], name='ctx_ws_created_by_idx')],
            },
        ),
        migrations.AddConstraint(
            model_name='workspace',
            constraint=models.UniqueConstraint(condition=models.Q(('normalized_working_dir', ''), _negated=True), fields=('device', 'normalized_working_dir'), name='ctx_ws_device_dir_unique'),
        ),
        migrations.AddConstraint(
            model_name='workspace',
            constraint=models.UniqueConstraint(condition=models.Q(('kind', 'home')), fields=('device',), name='ctx_ws_device_home_unique'),
        ),
    ]
