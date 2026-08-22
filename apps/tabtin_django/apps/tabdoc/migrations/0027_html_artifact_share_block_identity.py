# Schema cutover: drop file_record identity, require block_id unique per document.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("tabdoc", "0026_html_artifact_share_backfill_block_id"),
    ]

    operations = [
        migrations.RemoveConstraint(
            model_name="htmlartifactshare",
            name="htmlashare_one_active_per_artifact",
        ),
        migrations.RemoveIndex(
            model_name="htmlartifactshare",
            name="htmlashare_doc_file_active_idx",
        ),
        migrations.RemoveField(
            model_name="htmlartifactshare",
            name="file_record",
        ),
        migrations.AlterField(
            model_name="htmlartifactshare",
            name="block_id",
            field=models.CharField(
                help_text="文档顶层 htmlBlock 的 attrs.blockId；分享链接始终解析该块当前 fileId",
                max_length=64,
                verbose_name="HTML 块 ID",
            ),
        ),
        migrations.AddConstraint(
            model_name="htmlartifactshare",
            constraint=models.UniqueConstraint(
                condition=models.Q(("is_active", True)),
                fields=("document", "block_id"),
                name="htmlashare_one_active_per_block",
            ),
        ),
    ]
