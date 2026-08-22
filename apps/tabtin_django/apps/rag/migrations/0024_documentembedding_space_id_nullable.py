"""#6603: DocumentEmbedding.space_id 允许为空（org-only TabDoc）。"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        (
            "rag",
            "0023_rename_rag_code_ch_worktea_fd670a_idx_rag_code_ch_organiz_ec5657_idx_and_more",
        ),
    ]

    operations = [
        migrations.AlterField(
            model_name="documentembedding",
            name="space_id",
            field=models.UUIDField(
                blank=True,
                db_index=True,
                null=True,
                verbose_name="所属空间",
            ),
        ),
    ]
