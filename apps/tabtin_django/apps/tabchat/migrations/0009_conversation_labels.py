"""TC-37：会话 label 库 + ConversationMember.labels M2M。"""

from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion
import django.utils.timezone
import uuid


class Migration(migrations.Migration):

    dependencies = [
        ("tabchat", "0008_message_edited_at"),
    ]

    operations = [
        migrations.CreateModel(
            name="ConversationLabel",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True)),
                ("user_id", models.CharField(db_index=True, max_length=100)),
                ("workteam_id", models.CharField(db_index=True, max_length=100)),
                ("name", models.CharField(max_length=32)),
                ("color", models.CharField(
                    default="#6b7280",
                    help_text="hex 颜色字符串如 #FF5733，用户自由选色",
                    max_length=7,
                )),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
            ],
            options={
                "db_table": "tabchat_conversation_label",
                "indexes": [
                    models.Index(
                        fields=["user_id", "workteam_id"],
                        name="tabchat_label_user_wt_idx",
                    ),
                ],
            },
        ),
        migrations.AddConstraint(
            model_name="conversationlabel",
            constraint=models.UniqueConstraint(
                fields=["user_id", "workteam_id", "name"],
                name="tabchat_label_user_wt_name_uniq",
            ),
        ),
        migrations.AddField(
            model_name="conversationmember",
            name="labels",
            field=models.ManyToManyField(
                blank=True,
                related_name="conversation_members",
                to="tabchat.conversationlabel",
            ),
        ),
    ]
