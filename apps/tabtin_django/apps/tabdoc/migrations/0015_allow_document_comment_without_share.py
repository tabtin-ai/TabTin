from __future__ import annotations

from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ("tabdoc", "0014_add_document_share_comment"),
    ]

    operations = [
        migrations.AlterField(
            model_name="documentsharecomment",
            name="share",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.CASCADE,
                related_name="comments",
                to="tabdoc.documentshare",
                verbose_name="来源分享",
            ),
        ),
    ]
