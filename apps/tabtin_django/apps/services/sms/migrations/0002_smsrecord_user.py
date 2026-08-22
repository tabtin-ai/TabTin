from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ('sms', '0001_initial'),
    ]

    operations = [
        migrations.AddField(
            model_name='smsrecord',
            name='user',
            field=models.ForeignKey(
                blank=True,
                db_constraint=False,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name='sms_records',
                to=settings.AUTH_USER_MODEL,
                verbose_name='发送用户',
            ),
        ),
    ]
