from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('tabtinspace', '0127_collection_organization_host_exclusive_7140'),
    ]

    operations = [
        migrations.AddIndex(
            model_name='projecttask',
            index=models.Index(
                fields=['selected_agent', 'updated_at', 'created_at'],
                name='ctx_pt_agent_time_idx',
            ),
        ),
    ]
