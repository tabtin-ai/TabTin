#  终态 · 0108 壳表改挂 Workspace 的 schema cutover（步骤 4c/N）
#
# 0108 已加字段，0108a 已回填。本迁移单独：
# - Drop 壳表 / Collection / ContextItem 的 space FK
# - 重建唯一约束与索引到 workspace

from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ('tabtinspace', '0108a_personal_shell_fk_backfill_3266'),
    ]

    operations = [
        # 约束/索引：先拆 space 侧，再 DropField，再挂 workspace 侧
        migrations.AlterUniqueTogether(
            name='spaceappsettings',
            unique_together=set(),
        ),
        migrations.RemoveConstraint(
            model_name='spacepermission',
            name='ctx_sp_unique_subject',
        ),
        migrations.RemoveConstraint(
            model_name='spacemembership',
            name='ctx_sm_space_agent_unique',
        ),
        migrations.RemoveConstraint(
            model_name='spacemembership',
            name='ctx_sm_space_user_unique',
        ),
        migrations.RemoveConstraint(
            model_name='spacemembership',
            name='ctx_sm_space_primary_agent_unique',
        ),
        migrations.RemoveConstraint(
            model_name='collection',
            name='ctx_coll_child_name_unique',
        ),
        migrations.RemoveConstraint(
            model_name='collection',
            name='ctx_coll_root_name_unique',
        ),
        migrations.RemoveConstraint(
            model_name='collection',
            name='ctx_coll_unique_system_key_per_space',
        ),
        migrations.RemoveIndex(
            model_name='spaceappsettings',
            name='ctx_space_app_user_idx',
        ),
        migrations.RemoveIndex(
            model_name='spacepermission',
            name='ctx_sp_space_active_idx',
        ),
        migrations.RemoveIndex(
            model_name='spacemembership',
            name='ctx_sm_space_role_idx',
        ),
        migrations.RemoveIndex(
            model_name='collection',
            name='ctx_coll_space_order_idx',
        ),
        migrations.RemoveIndex(
            model_name='contextitem',
            name='ctx_item_space_type_idx',
        ),
        migrations.RemoveIndex(
            model_name='contextitem',
            name='ctx_item_space_archived_idx',
        ),
        migrations.RemoveIndex(
            model_name='contextitem',
            name='ctx_item_space_order_idx',
        ),
        migrations.RemoveIndex(
            model_name='contextitem',
            name='ctx_item_pinned_idx',
        ),
        migrations.RemoveField(model_name='spaceappsettings', name='space'),
        migrations.RemoveField(model_name='spacepermission', name='space'),
        migrations.RemoveField(model_name='spacemembership', name='space'),
        migrations.RemoveField(model_name='collection', name='space'),
        migrations.RemoveField(model_name='contextitem', name='space'),
        # workspace 非空（壳表已删孤儿）
        migrations.AlterField(
            model_name='spaceappsettings',
            name='workspace',
            field=models.ForeignKey(
                on_delete=django.db.models.deletion.CASCADE,
                related_name='app_settings',
                to='tabtinspace.workspace',
                verbose_name='所属 Workspace',
            ),
        ),
        migrations.AlterField(
            model_name='spacepermission',
            name='workspace',
            field=models.ForeignKey(
                on_delete=django.db.models.deletion.CASCADE,
                related_name='permissions',
                to='tabtinspace.workspace',
                verbose_name='所属 Workspace',
            ),
        ),
        migrations.AlterField(
            model_name='spacemembership',
            name='workspace',
            field=models.ForeignKey(
                on_delete=django.db.models.deletion.CASCADE,
                related_name='memberships',
                to='tabtinspace.workspace',
                verbose_name='所属 Workspace',
            ),
        ),
        migrations.AlterUniqueTogether(
            name='spaceappsettings',
            unique_together={('workspace', 'user')},
        ),
        migrations.AddIndex(
            model_name='spaceappsettings',
            index=models.Index(fields=['workspace', 'user'], name='ctx_ws_app_user_idx'),
        ),
        migrations.AddConstraint(
            model_name='spacepermission',
            constraint=models.UniqueConstraint(
                fields=('workspace', 'subject_type', 'subject_id'),
                name='ctx_wp_unique_subject',
            ),
        ),
        migrations.AddIndex(
            model_name='spacepermission',
            index=models.Index(fields=['workspace', 'is_active'], name='ctx_wp_ws_active_idx'),
        ),
        migrations.AddConstraint(
            model_name='spacemembership',
            constraint=models.UniqueConstraint(
                fields=('workspace', 'agent'),
                condition=models.Q(('agent__isnull', False)),
                name='ctx_sm_ws_agent_unique',
            ),
        ),
        migrations.AddConstraint(
            model_name='spacemembership',
            constraint=models.UniqueConstraint(
                fields=('workspace', 'user'),
                condition=models.Q(('user__isnull', False)),
                name='ctx_sm_ws_user_unique',
            ),
        ),
        migrations.AddConstraint(
            model_name='spacemembership',
            constraint=models.UniqueConstraint(
                fields=('workspace',),
                condition=models.Q(
                    ('agent__isnull', False),
                    ('is_active', True),
                    ('is_primary', True),
                ),
                name='ctx_sm_ws_primary_agent_unique',
            ),
        ),
        migrations.AddIndex(
            model_name='spacemembership',
            index=models.Index(fields=['workspace', 'role'], name='ctx_sm_ws_role_idx'),
        ),
        migrations.AddConstraint(
            model_name='collection',
            constraint=models.UniqueConstraint(
                fields=('workspace', 'parent', 'name'),
                condition=models.Q(('parent__isnull', False), ('workspace__isnull', False)),
                name='ctx_coll_ws_child_name_unique',
            ),
        ),
        migrations.AddConstraint(
            model_name='collection',
            constraint=models.UniqueConstraint(
                fields=('workspace', 'name'),
                condition=models.Q(('parent__isnull', True), ('workspace__isnull', False)),
                name='ctx_coll_ws_root_name_unique',
            ),
        ),
        migrations.AddConstraint(
            model_name='collection',
            constraint=models.UniqueConstraint(
                fields=('workspace', 'system_key'),
                condition=models.Q(('system_key__isnull', False), ('workspace__isnull', False)),
                name='ctx_coll_ws_system_key_unique',
            ),
        ),
        migrations.AddIndex(
            model_name='contextitem',
            index=models.Index(
                fields=['workspace', 'is_archived'],
                name='ctx_item_ws_archived_idx',
            ),
        ),
        migrations.AddIndex(
            model_name='contextitem',
            index=models.Index(
                fields=['workspace', 'order'],
                name='ctx_item_ws_order_idx',
            ),
        ),
        migrations.AddIndex(
            model_name='contextitem',
            index=models.Index(
                fields=['workspace', '-is_pinned', '-pinned_at'],
                name='ctx_item_ws_pinned_idx',
            ),
        ),
    ]
