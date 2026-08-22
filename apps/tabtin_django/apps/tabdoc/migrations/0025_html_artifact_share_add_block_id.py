# Generated manually for  follow-up: bind HtmlArtifactShare to stable block_id.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("tabdoc", "0024_html_artifact_share"),
    ]

    operations = [
        migrations.AddField(
            model_name="htmlartifactshare",
            name="block_id",
            field=models.CharField(
                blank=True,
                default="",
                help_text="文档顶层 htmlBlock 的 attrs.blockId；分享链接始终解析该块当前 fileId",
                max_length=64,
                verbose_name="HTML 块 ID",
            ),
        ),
        migrations.AddIndex(
            model_name="htmlartifactshare",
            index=models.Index(
                fields=["document", "block_id", "is_active"],
                name="htmlashare_doc_blk_act_idx",
            ),
        ),
    ]
