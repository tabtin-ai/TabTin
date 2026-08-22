# Generated manually for TabData association schema §1

import uuid

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('tabdata', '0044_rename_tabdata_api_worktea_1e337f_idx_tabdata_api_organiz_1f949b_idx_and_more'),
    ]

    operations = [
        migrations.CreateModel(
            name='LinkRelation',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('organization_id', models.UUIDField(db_index=True, verbose_name='所属组织')),
                ('host_relationship', models.CharField(choices=[('OneOne', '一对一'), ('OneMany', '一对多'), ('ManyOne', '多对一'), ('ManyMany', '多对多')], default='ManyOne', max_length=16, verbose_name='宿主侧关系基数')),
                ('is_one_way', models.BooleanField(default=False, verbose_name='是否单向')),
                ('created_at', models.DateTimeField(auto_now_add=True, verbose_name='创建时间')),
                ('updated_at', models.DateTimeField(auto_now=True, verbose_name='更新时间')),
                ('foreign_table', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='foreign_link_relations', to='tabdata.table', verbose_name='目标表')),
                ('host_field', models.OneToOneField(on_delete=django.db.models.deletion.CASCADE, related_name='link_relation_as_host', to='tabdata.tablefield', verbose_name='宿主关联字段')),
                ('host_table', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='hosted_link_relations', to='tabdata.table', verbose_name='宿主表')),
                ('symmetric_field', models.OneToOneField(blank=True, null=True, on_delete=django.db.models.deletion.CASCADE, related_name='link_relation_as_symmetric', to='tabdata.tablefield', verbose_name='对称关联字段')),
            ],
            options={
                'verbose_name': '关联关系定义',
                'verbose_name_plural': '关联关系定义',
                'db_table': 'tabdata_link_relation',
            },
        ),
        migrations.CreateModel(
            name='LinkEdge',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('host_order', models.IntegerField(default=0, verbose_name='宿主侧顺序')),
                ('foreign_order', models.IntegerField(default=0, verbose_name='目标侧顺序')),
                ('created_at', models.DateTimeField(auto_now_add=True, verbose_name='创建时间')),
                ('foreign_record', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='foreign_link_edges', to='tabdata.tablerecord', verbose_name='目标记录')),
                ('host_record', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='hosted_link_edges', to='tabdata.tablerecord', verbose_name='宿主记录')),
                ('relation', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='edges', to='tabdata.linkrelation', verbose_name='所属关系')),
            ],
            options={
                'verbose_name': '关联边',
                'verbose_name_plural': '关联边',
                'db_table': 'tabdata_link_edge',
            },
        ),
        migrations.AddIndex(
            model_name='linkrelation',
            index=models.Index(fields=['organization_id', 'host_table'], name='tabdata_lin_organiz_3c8a1d_idx'),
        ),
        migrations.AddIndex(
            model_name='linkrelation',
            index=models.Index(fields=['organization_id', 'foreign_table'], name='tabdata_lin_organiz_9f2b4e_idx'),
        ),
        migrations.AddConstraint(
            model_name='linkrelation',
            constraint=models.CheckConstraint(
                check=(
                    models.Q(('is_one_way', True), ('symmetric_field__isnull', True))
                    | models.Q(('is_one_way', False), ('symmetric_field__isnull', False))
                ),
                name='tabdata_lrel_oway_sym_chk',
            ),
        ),
        migrations.AddIndex(
            model_name='linkedge',
            index=models.Index(fields=['relation', 'host_record'], name='tabdata_ledge_rel_host_idx'),
        ),
        migrations.AddIndex(
            model_name='linkedge',
            index=models.Index(fields=['relation', 'foreign_record'], name='tabdata_ledge_rel_fgn_idx'),
        ),
        migrations.AddConstraint(
            model_name='linkedge',
            constraint=models.UniqueConstraint(
                fields=('relation', 'host_record', 'foreign_record'),
                name='tabdata_ledge_uniq_triple',
            ),
        ),
    ]
