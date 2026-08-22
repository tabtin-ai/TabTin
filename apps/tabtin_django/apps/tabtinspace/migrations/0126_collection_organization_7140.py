# ：Collection 新增 Organization 归属（云文档/云盘文件夹 org-only）。
# 本文件只 AddField；索引与 CheckConstraint 见 0127（对齐 ）。

from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ('tabtinspace', '0125_merge_20260723_1115'),
    ]

    operations = [
        migrations.AddField(
            model_name='collection',
            name='organization',
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.CASCADE,
                related_name='collections',
                to='tabtinspace.organization',
                verbose_name='所属 Organization',
                help_text='组织级云盘文件夹（不挂 workspace/project）；#7140 org-only。',
            ),
        ),
    ]
