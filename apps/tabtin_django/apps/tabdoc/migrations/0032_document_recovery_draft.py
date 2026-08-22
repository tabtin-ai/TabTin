import uuid

from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("tabdoc", "0031_delete_html_artifact_share"),
    ]

    operations = [
        migrations.CreateModel(
            name="DocumentRecoveryDraft",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("organization_id", models.UUIDField(db_index=True)),
                ("base_version", models.PositiveIntegerField(blank=True, null=True)),
                ("content_pm_json", models.JSONField(blank=True, default=dict)),
                ("content_markdown", models.TextField(blank=True, default="")),
                ("content_plaintext", models.TextField(blank=True, default="")),
                ("status", models.CharField(choices=[("active", "Active"), ("restored", "Restored"), ("expired", "Expired")], default="active", max_length=16)),
                ("expires_at", models.DateTimeField(db_index=True)),
                ("restored_at", models.DateTimeField(blank=True, null=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("creator", models.ForeignKey(blank=True, null=True, on_delete=models.deletion.SET_NULL, related_name="tabdoc_recovery_drafts_created", to=settings.AUTH_USER_MODEL)),
                ("document", models.ForeignKey(on_delete=models.deletion.CASCADE, related_name="recovery_drafts", to="tabdoc.document")),
            ],
            options={"db_table": "tabdoc_document_recovery_draft", "ordering": ["-created_at"]},
        ),
        migrations.AddIndex(
            model_name="documentrecoverydraft",
            index=models.Index(fields=["document", "status", "-created_at"], name="doc_recovery_doc_state_idx"),
        ),
        migrations.AddIndex(
            model_name="documentrecoverydraft",
            index=models.Index(fields=["creator", "status"], name="doc_recovery_creator_state_idx"),
        ),
    ]
