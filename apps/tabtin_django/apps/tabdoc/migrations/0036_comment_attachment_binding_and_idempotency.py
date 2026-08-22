from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("tabdoc", "0035_comment_thread_indexes"),
    ]

    operations = [
        migrations.AddField(
            model_name="commentmessage",
            name="client_request_id",
            field=models.CharField(blank=True, max_length=100, null=True),
        ),
        migrations.AddConstraint(
            model_name="commentmessage",
            constraint=models.UniqueConstraint(
                condition=models.Q(
                    author__isnull=False,
                    client_request_id__isnull=False,
                ),
                fields=("author", "client_request_id"),
                name="doccm_author_request_uniq",
            ),
        ),
        migrations.AddConstraint(
            model_name="commentattachment",
            constraint=models.UniqueConstraint(
                fields=("file_record",),
                name="docca_file_record_uniq",
            ),
        ),
    ]
