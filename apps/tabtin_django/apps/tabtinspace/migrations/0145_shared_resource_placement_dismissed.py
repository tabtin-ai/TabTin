from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ('tabtinspace', '0144_shared_resource_placement'),
    ]

    operations = [
        migrations.AddField(
            model_name='sharedresourceplacement',
            name='dismissed',
            field=models.BooleanField(default=False),
        ),
    ]
