import uuid

from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    dependencies = [
        ('tabtinspace', '0140_backfill_mcpconnection_created_by'),
    ]

    operations = [
        migrations.CreateModel(
            name='OrganizationMemberIdentitySnapshot',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('user_id', models.UUIDField(verbose_name='用户 ID')),
                ('display_name', models.CharField(max_length=255, verbose_name='离开时显示名称')),
                ('left_at', models.DateTimeField(verbose_name='离开时间')),
                ('organization', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='member_identity_snapshots', to='tabtinspace.organization', verbose_name='组织')),
            ],
            options={
                'verbose_name': '组织成员历史身份',
                'verbose_name_plural': '组织成员历史身份',
                'db_table': 'tabtinspace_organization_member_identity_snapshot',
                'indexes': [models.Index(fields=['organization', '-left_at'], name='ctx_member_ident_org_left_idx')],
                'constraints': [models.UniqueConstraint(fields=('organization', 'user_id'), name='ctx_member_ident_org_user_uq')],
            },
        ),
    ]
