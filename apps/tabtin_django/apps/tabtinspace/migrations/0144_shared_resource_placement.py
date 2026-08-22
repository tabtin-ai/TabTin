import django.db.models.deletion
import uuid

from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('tabtinspace', '0143_workspace_dir_per_user')]

    operations = [
        migrations.CreateModel(
            name='SharedResourcePlacement',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('resource_type', models.CharField(max_length=16)),
                ('resource_id', models.CharField(max_length=100)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('collection', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='shared_resource_placements', to='tabtinspace.collection')),
                ('organization', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='shared_resource_placements', to='tabtinspace.organization')),
                ('user', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='shared_resource_placements', to=settings.AUTH_USER_MODEL)),
            ],
            options={'db_table': 'tabtinspace_shared_resource_placement'},
        ),
        migrations.AddConstraint(
            model_name='sharedresourceplacement',
            constraint=models.UniqueConstraint(fields=('organization', 'user', 'resource_type', 'resource_id'), name='ctx_shared_place_org_user_resource_uq'),
        ),
        migrations.AddIndex(
            model_name='sharedresourceplacement',
            index=models.Index(fields=['organization', 'user', 'collection'], name='ctx_shared_place_user_coll_idx'),
        ),
    ]
