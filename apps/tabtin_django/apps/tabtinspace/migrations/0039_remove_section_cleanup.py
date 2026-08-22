"""
Collection 嵌套（文件夹化）— 第 2 步

移除已废弃的 ContextItem.section 字段和 CollectionSection 模型。
数据已在 0038 中迁移完毕。
"""
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ('tabtinspace', '0038_collection_nesting_remove_section'),
    ]

    operations = [
        migrations.RemoveIndex(
            model_name='contextitem',
            name='ctx_item_sec_order_idx',
        ),
        migrations.RemoveField(
            model_name='contextitem',
            name='section',
        ),
        migrations.AlterField(
            model_name='contextitem',
            name='collection',
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name='items',
                to='tabtinspace.collection',
                verbose_name='所属文件夹',
            ),
        ),
        migrations.DeleteModel(
            name='CollectionSection',
        ),
    ]
