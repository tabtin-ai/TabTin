# : Collection（云盘文件夹）支持置顶，对齐 ContextItem

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('tabtinspace', '0130_merge_20260723_2053'),
    ]

    operations = [
        migrations.AlterModelOptions(
            name='collection',
            options={
                'ordering': ['-is_pinned', '-pinned_at', 'order', 'name'],
                'verbose_name': '文件夹',
                'verbose_name_plural': '文件夹',
            },
        ),
        migrations.AddField(
            model_name='collection',
            name='is_pinned',
            field=models.BooleanField(db_index=True, default=False, verbose_name='是否置顶'),
        ),
        migrations.AddField(
            model_name='collection',
            name='pinned_at',
            field=models.DateTimeField(blank=True, null=True, verbose_name='置顶时间'),
        ),
        migrations.AddIndex(
            model_name='collection',
            index=models.Index(
                fields=['workspace', '-is_pinned', '-pinned_at'],
                name='ctx_coll_ws_pinned_idx',
            ),
        ),
        migrations.AddIndex(
            model_name='collection',
            index=models.Index(
                fields=['project', '-is_pinned', '-pinned_at'],
                name='ctx_coll_project_pinned_idx',
            ),
        ),
        migrations.AddIndex(
            model_name='collection',
            index=models.Index(
                fields=['organization', '-is_pinned', '-pinned_at'],
                name='ctx_coll_org_pinned_idx',
            ),
        ),
    ]
