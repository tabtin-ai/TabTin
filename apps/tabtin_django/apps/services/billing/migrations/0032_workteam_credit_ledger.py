import uuid

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("billing", "0031_addon_entitlements"),
    ]

    operations = [
        migrations.CreateModel(
            name="WorkteamCreditLedger",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("workteam_id", models.CharField(db_index=True, max_length=100, verbose_name="工作团队ID")),
                ("user_id", models.CharField(blank=True, db_index=True, default="", max_length=36, verbose_name="用户ID")),
                ("ledger_type", models.CharField(choices=[("plan_included_grant", "套餐内赠"), ("resource_pack_purchase", "资源包购买"), ("system_gift", "系统赠送"), ("compensation", "补偿"), ("usage_consume", "用量扣减"), ("expire", "过期"), ("refund_reverse", "退款冲正"), ("manual_adjust", "人工调整"), ("legacy_derived", "历史兼容派生")], db_index=True, max_length=40, verbose_name="流水类型")),
                ("amount_points", models.DecimalField(decimal_places=4, help_text="正数=增加，负数=扣减", max_digits=20, verbose_name="变动点券")),
                ("balance_after_points", models.DecimalField(blank=True, decimal_places=4, max_digits=20, null=True, verbose_name="变更后余额（点券）")),
                ("related_usage_event_id", models.CharField(blank=True, db_index=True, default="", max_length=64, verbose_name="关联用量事件ID")),
                ("related_billing_event_id", models.CharField(blank=True, db_index=True, default="", max_length=64, verbose_name="关联计费事件ID")),
                ("related_wallet_transaction_id", models.CharField(blank=True, default="", max_length=64, verbose_name="关联钱包流水ID")),
                ("related_order_id", models.CharField(blank=True, default="", max_length=64, verbose_name="关联订单ID")),
                ("related_invoice_id", models.CharField(blank=True, default="", max_length=64, verbose_name="关联账单ID")),
                ("operator_admin_account_id", models.CharField(blank=True, default="", max_length=36, verbose_name="操作后台账号ID")),
                ("operator_user_id", models.CharField(blank=True, db_index=True, default="", max_length=36, verbose_name="操作用户ID")),
                ("reason", models.CharField(blank=True, default="", max_length=500, verbose_name="原因")),
                ("ticket_id", models.CharField(blank=True, default="", max_length=128, verbose_name="工单ID")),
                ("metadata_json", models.JSONField(blank=True, default=dict, verbose_name="扩展元数据")),
                ("created_at", models.DateTimeField(auto_now_add=True, db_index=True, verbose_name="创建时间")),
            ],
            options={
                "verbose_name": "工作团队点券流水",
                "verbose_name_plural": "工作团队点券流水",
                "db_table": "services_billing_workteam_credit_ledger",
                "ordering": ["-created_at"],
            },
        ),
        migrations.AddIndex(
            model_name="workteamcreditledger",
            index=models.Index(fields=["workteam_id", "created_at"], name="services_bi_worktea_5df6e4_idx"),
        ),
        migrations.AddIndex(
            model_name="workteamcreditledger",
            index=models.Index(fields=["user_id", "created_at"], name="services_bi_user_id_13cb56_idx"),
        ),
        migrations.AddIndex(
            model_name="workteamcreditledger",
            index=models.Index(fields=["ledger_type", "created_at"], name="services_bi_ledger__f21e21_idx"),
        ),
        migrations.AddIndex(
            model_name="workteamcreditledger",
            index=models.Index(fields=["related_usage_event_id"], name="services_bi_related_7ea87e_idx"),
        ),
        migrations.AddIndex(
            model_name="workteamcreditledger",
            index=models.Index(fields=["related_billing_event_id"], name="services_bi_related_8a50e4_idx"),
        ),
    ]
