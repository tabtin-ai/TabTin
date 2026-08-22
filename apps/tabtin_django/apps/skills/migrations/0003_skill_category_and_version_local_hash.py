from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("skills", "0002_rename_skills_skil_owner_u_3eba37_idx_skills_skil_owner_u_ae0170_idx_and_more"),
    ]

    operations = [
        migrations.AddField(
            model_name="skill",
            name="category",
            field=models.CharField(
                blank=True,
                default="",
                help_text="Marketplace 分类（productivity / ai_media / developer / lifestyle）。",
                max_length=32,
            ),
        ),
        migrations.AddField(
            model_name="skillpublishedversion",
            name="local_content_hash",
            field=models.CharField(
                blank=True,
                default="",
                help_text="Owner 本地 skill-root 内容 hash，用于 Mine dirty/去重判断。",
                max_length=64,
            ),
        ),
    ]
