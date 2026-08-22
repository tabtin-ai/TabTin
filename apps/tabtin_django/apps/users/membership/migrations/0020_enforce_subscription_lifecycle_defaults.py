from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('membership', '0019_backfill_subscription_lifecycle_defaults'),
    ]

    operations = [
        migrations.AlterField(
            model_name='organizationmembership',
            name='billing_cycle',
            field=models.CharField(
                choices=[('monthly', '月付'), ('yearly', '年付')],
                default='monthly',
                max_length=20,
                verbose_name='计费周期',
            ),
        ),
        migrations.AlterField(
            model_name='organizationmembership',
            name='lifecycle_version',
            field=models.PositiveBigIntegerField(
                default=1,
                help_text='用于报价和套餐变更的乐观并发控制。',
                verbose_name='生命周期版本',
            ),
        ),
    ]
