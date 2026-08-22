# Generated manually for TabMemo space_id nullable + MemoAgentGrant

from django.db import migrations, models
import uuid


class Migration(migrations.Migration):

    dependencies = [
        ('tabmemo', '0005_alter_memo_space_id_alter_memocollection_space_id'),
    ]

    operations = [
        # ── 1. space_id 改为 nullable ──
        migrations.AlterField(
            model_name='memo',
            name='space_id',
            field=models.UUIDField(blank=True, db_index=True, null=True),
        ),
        migrations.AlterField(
            model_name='memocollection',
            name='space_id',
            field=models.UUIDField(blank=True, db_index=True, null=True),
        ),

        # ── 2. 移除旧索引并重建 ──
        # 移除旧的 tm_ws_as_status_idx（无 condition 的版本）
        migrations.RemoveIndex(
            model_name='memo',
            name='tm_ws_as_status_idx',
        ),
        # 移除旧的 tm_ws_as_created_idx
        migrations.RemoveIndex(
            model_name='memo',
            name='tm_ws_as_created_idx',
        ),

        # 新增 workspace 级索引（不含 space_id，用于个人碎片查询）
        migrations.AddIndex(
            model_name='memo',
            index=models.Index(
                fields=['workspace_id', 'status'],
                name='tm_ws_status_idx',
            ),
        ),
        migrations.AddIndex(
            model_name='memo',
            index=models.Index(
                fields=['workspace_id', '-created_at'],
                name='tm_ws_created_idx',
            ),
        ),

        # 重建带 condition 的部分索引（仅对有 space_id 的记录）
        migrations.AddIndex(
            model_name='memo',
            index=models.Index(
                fields=['workspace_id', 'space_id', 'status'],
                name='tm_ws_as_status_idx',
                condition=models.Q(space_id__isnull=False),
            ),
        ),

        # ── 3. 创建 MemoAgentGrant 表 ──
        migrations.CreateModel(
            name='MemoAgentGrant',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('workspace_id', models.UUIDField(db_index=True)),
                ('target_space_id', models.UUIDField(db_index=True)),
                ('permission', models.CharField(
                    choices=[('read', '只读'), ('write', '读写')],
                    default='read',
                    max_length=10,
                    verbose_name='权限级别',
                )),
                ('granted_by', models.UUIDField()),
                ('memo', models.ForeignKey(
                    blank=True,
                    null=True,
                    on_delete=models.deletion.CASCADE,
                    related_name='agent_grants',
                    to='tabmemo.memo',
                )),
                ('collection', models.ForeignKey(
                    blank=True,
                    null=True,
                    on_delete=models.deletion.CASCADE,
                    related_name='agent_grants',
                    to='tabmemo.memocollection',
                )),
            ],
            options={
                'db_table': 'tabmemo_agent_grant',
                'indexes': [
                    models.Index(
                        fields=['target_space_id', 'workspace_id'],
                        name='tm_grant_space_ws_idx',
                    ),
                ],
                'constraints': [
                    models.UniqueConstraint(
                        fields=['memo', 'target_space_id'],
                        name='tm_grant_memo_space_uniq',
                        condition=models.Q(memo__isnull=False),
                    ),
                    models.UniqueConstraint(
                        fields=['collection', 'target_space_id'],
                        name='tm_grant_coll_space_uniq',
                        condition=models.Q(collection__isnull=False),
                    ),
                    models.CheckConstraint(
                        check=(
                            models.Q(memo__isnull=False, collection__isnull=True)
                            | models.Q(memo__isnull=True, collection__isnull=False)
                        ),
                        name='tm_grant_memo_or_coll_xor',
                    ),
                ],
            },
        ),
    ]
