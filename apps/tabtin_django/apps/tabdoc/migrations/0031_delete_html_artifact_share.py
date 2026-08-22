# ：删除独立 HtmlArtifactShare 表。
# HTML 块浏览改走文档级 DocumentShare + documentId/blockId，不再维护块级外链表。

from django.db import migrations
from django.db.migrations.exceptions import IrreversibleError


def discard_html_artifact_shares(apps, schema_editor):
    """有意丢弃块级分享行后再删表。

    产品已撤销 HtmlArtifactShare；旧块级外链不迁到别处，浏览改走
    DocumentShare + documentId/blockId。本步满足
    ``destructive_without_data_move``：DeleteModel 前先显式清空数据。
    """
    HtmlArtifactShare = apps.get_model("tabdoc", "HtmlArtifactShare")
    db_alias = schema_editor.connection.alias
    HtmlArtifactShare.objects.using(db_alias).all().delete()


def reverse_discard_html_artifact_shares(apps, schema_editor):
    raise IrreversibleError(
        "HtmlArtifactShare was retired in ; restore from DB backup if needed."
    )


class Migration(migrations.Migration):

    dependencies = [
        ("tabdoc", "0030_html_artifact_share_active_stable_block_constraint"),
    ]

    operations = [
        migrations.RunPython(
            discard_html_artifact_shares,
            reverse_discard_html_artifact_shares,
        ),
        migrations.DeleteModel(name="HtmlArtifactShare"),
    ]
