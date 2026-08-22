# ：ContextItem 知识库式自引用父节点（空列 + 索引，不做数据回填）。

from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ('tabtinspace', '0127_collection_organization_host_exclusive_7140'),
    ]

    operations = [
        migrations.AddField(
            model_name='contextitem',
            name='parent',
            field=models.ForeignKey(
                blank=True,
                help_text='云文档知识库树父节点；仅允许挂到同宿主且未回收的 tabdoc/tabdata。',
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name='children',
                to='tabtinspace.contextitem',
                verbose_name='父资源',
            ),
        ),
        migrations.AddIndex(
            model_name='contextitem',
            index=models.Index(fields=['parent', 'order'], name='ctx_item_parent_order_idx'),
        ),
    ]
