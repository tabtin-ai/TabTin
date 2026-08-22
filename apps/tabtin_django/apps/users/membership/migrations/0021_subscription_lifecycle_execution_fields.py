from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ('membership', '0020_enforce_subscription_lifecycle_defaults'),
    ]

    operations = [
        migrations.AlterField(
            model_name='organizationmembership',
            name='status',
            field=models.CharField(
                choices=[
                    ('active', '有效'),
                    ('grace', '宽限期'),
                    ('expired', '已过期'),
                    ('suspended', '已暂停'),
                    ('cancelled', '已取消'),
                ],
                db_index=True,
                default='active',
                max_length=20,
                verbose_name='状态',
            ),
        ),
        migrations.AddField(
            model_name='organizationmembership',
            name='scheduled_tier',
            field=models.ForeignKey(
                blank=True,
                help_text='当前有效的下周期套餐计划；历史记录见 OrganizationMembershipChangeLog。',
                null=True,
                on_delete=django.db.models.deletion.PROTECT,
                related_name='+',
                to='membership.membershiptier',
                verbose_name='已预约目标套餐',
            ),
        ),
        migrations.AddField(
            model_name='organizationmembership',
            name='scheduled_billing_cycle',
            field=models.CharField(
                blank=True,
                choices=[('monthly', '月付'), ('yearly', '年付')],
                max_length=20,
                null=True,
                verbose_name='已预约目标计费周期',
            ),
        ),
        migrations.AddField(
            model_name='organizationmembership',
            name='scheduled_change_type',
            field=models.CharField(
                blank=True,
                choices=[('downgrade', '降级'), ('switch', '同级切换')],
                max_length=32,
                null=True,
                verbose_name='已预约变更类型',
            ),
        ),
        migrations.AddField(
            model_name='organizationmembership',
            name='scheduled_change_effective_at',
            field=models.DateTimeField(
                blank=True,
                db_index=True,
                null=True,
                verbose_name='已预约变更生效时间',
            ),
        ),
        migrations.AddField(
            model_name='organizationmembership',
            name='scheduled_change_log_id',
            field=models.UUIDField(
                blank=True,
                help_text='指向 OrganizationMembershipChangeLog.id；避免强 FK 循环，执行时会锁 ChangeLog 校验。',
                null=True,
                verbose_name='已预约变更记录ID',
            ),
        ),
        migrations.AlterField(
            model_name='organizationmembershipchangelog',
            name='change_type',
            field=models.CharField(
                choices=[
                    ('new', '新购'),
                    ('renew', '续费'),
                    ('renewal', '手动续费'),
                    ('upgrade', '升级'),
                    ('downgrade', '降级'),
                    ('switch', '同级或周期切换'),
                    ('grace_enter', '进入宽限期'),
                    ('grace_exit', '退出宽限期'),
                    ('expire', '到期'),
                    ('free_downgrade', '降为免费版'),
                    ('cancel_change', '取消变更'),
                    ('admin_adjust', '管理员调整'),
                    ('refund_revoke', '退款撤销'),
                    ('suspend', '暂停'),
                    ('resume', '恢复'),
                ],
                max_length=32,
                verbose_name='变更类型',
            ),
        ),
        migrations.AlterField(
            model_name='organizationmembershipchangelog',
            name='status',
            field=models.CharField(
                choices=[
                    ('requested', '已请求'),
                    ('scheduled', '已预约'),
                    ('payment_pending', '待支付'),
                    ('paid', '已支付'),
                    ('pending', '待生效'),
                    ('applying', '应用中'),
                    ('applied', '已应用'),
                    ('failed', '失败'),
                    ('cancelled', '已取消'),
                    ('expired', '已过期'),
                ],
                max_length=32,
                verbose_name='处理状态',
            ),
        ),
        migrations.RemoveConstraint(
            model_name='organizationmembershipchangelog',
            name='uniq_pending_membership_plan_per_org',
        ),
        migrations.AddConstraint(
            model_name='organizationmembershipchangelog',
            constraint=models.UniqueConstraint(
                condition=models.Q(change_type__in=['downgrade', 'switch'], status__in=['pending', 'scheduled']),
                fields=('organization',),
                name='uniq_active_membership_plan_per_org',
            ),
        ),
    ]
