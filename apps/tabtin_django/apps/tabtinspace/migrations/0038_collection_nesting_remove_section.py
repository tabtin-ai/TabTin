"""
Collection 嵌套（文件夹化）— 第 1 步

1. Collection 新增 parent 自引用外键
2. 替换唯一约束为条件约束
3. 更新 Collection 元数据
4. 数据迁移：CollectionSection → 子 Collection + ContextItem.section → collection
"""
import uuid

from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


def migrate_sections_to_child_collections(apps, schema_editor):
    CollectionSection = apps.get_model('tabtinspace', 'CollectionSection')
    Collection = apps.get_model('tabtinspace', 'Collection')
    ContextItem = apps.get_model('tabtinspace', 'ContextItem')

    for section in CollectionSection.objects.select_related('collection').all():
        parent_coll = section.collection
        child = Collection.objects.create(
            id=uuid.uuid4(),
            space_id=parent_coll.space_id,
            parent=parent_coll,
            name=section.name,
            icon='📁',
            color='',
            order=section.order,
            is_expanded=section.is_expanded,
            created_by_id=parent_coll.created_by_id,
        )
        ContextItem.objects.filter(section_id=section.id).update(
            collection_id=child.id,
        )


def reverse_migrate(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    atomic = False

    dependencies = [
        ('tabtinspace', '0037_add_soul_preset_welcome_message'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.AddField(
            model_name='collection',
            name='parent',
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.CASCADE,
                related_name='children',
                to='tabtinspace.collection',
                verbose_name='父文件夹',
            ),
        ),

        migrations.RemoveConstraint(
            model_name='collection',
            name='ctx_coll_space_name_unique',
        ),

        migrations.AddConstraint(
            model_name='collection',
            constraint=models.UniqueConstraint(
                condition=models.Q(('parent__isnull', False)),
                fields=['space', 'parent', 'name'],
                name='ctx_coll_child_name_unique',
            ),
        ),
        migrations.AddConstraint(
            model_name='collection',
            constraint=models.UniqueConstraint(
                condition=models.Q(('parent__isnull', True)),
                fields=['space', 'name'],
                name='ctx_coll_root_name_unique',
            ),
        ),

        migrations.AddIndex(
            model_name='collection',
            index=models.Index(
                fields=['parent', 'order'],
                name='ctx_coll_parent_order_idx',
            ),
        ),

        migrations.AlterModelOptions(
            name='collection',
            options={
                'ordering': ['order', 'name'],
                'verbose_name': '文件夹',
                'verbose_name_plural': '文件夹',
            },
        ),
        migrations.AlterField(
            model_name='collection',
            name='icon',
            field=models.CharField(
                blank=True, default='📁', max_length=50, verbose_name='图标',
            ),
        ),
        migrations.AlterField(
            model_name='collection',
            name='name',
            field=models.CharField(max_length=255, verbose_name='名称'),
        ),

        migrations.RunPython(
            migrate_sections_to_child_collections,
            reverse_migrate,
        ),
    ]
