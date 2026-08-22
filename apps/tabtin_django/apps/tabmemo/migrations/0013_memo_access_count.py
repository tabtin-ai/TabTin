from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('tabmemo', '0012_alter_memocollectionmembership_unique_together_and_more'),
    ]

    operations = [
        migrations.AddField(
            model_name='memo',
            name='access_count',
            field=models.PositiveIntegerField(
                default=0,
                help_text='Agent 记忆召回命中次数，用于 importance 动态调整和过期归档判断',
                verbose_name='访问计数',
            ),
        ),
    ]
