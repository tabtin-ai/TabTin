import uuid
from decimal import Decimal

import django.core.validators
from django.db import migrations, models
import django.db.models.deletion
import django.utils.timezone


class Migration(migrations.Migration):

    dependencies = [
        ("billing", "0030_billingusageevent_scene_key"),
    ]

    operations = [
        migrations.CreateModel(
            name="AddonPackage",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("addon_code", models.CharField(db_index=True, max_length=80, unique=True, verbose_name="增值包编码")),
                ("addon_name", models.CharField(max_length=120, verbose_name="增值包名称")),
                ("description", models.TextField(blank=True, default="", verbose_name="增值包描述")),
                ("price", models.DecimalField(decimal_places=2, max_digits=20, validators=[django.core.validators.MinValueValidator(Decimal("0.01"))], verbose_name="售价（元）")),
                ("quota_key", models.CharField(choices=[("max_tables", "表格数量"), ("max_documents", "文档数量"), ("max_groups", "群组数量"), ("storage_quota_bytes", "存储容量"), ("max_members", "成员席位")], db_index=True, max_length=64, verbose_name="权益键")),
                ("quota_value", models.BigIntegerField(validators=[django.core.validators.MinValueValidator(1)], verbose_name="增加额度")),
                ("period_months", models.PositiveIntegerField(default=1, validators=[django.core.validators.MinValueValidator(1)], verbose_name="有效期（月）")),
                ("sort_order", models.IntegerField(default=0, verbose_name="排序")),
                ("is_active", models.BooleanField(db_index=True, default=True, verbose_name="是否启用")),
                ("metadata", models.JSONField(default=dict, verbose_name="扩展元数据")),
                ("created_at", models.DateTimeField(auto_now_add=True, verbose_name="创建时间")),
                ("updated_at", models.DateTimeField(auto_now=True, verbose_name="更新时间")),
            ],
            options={
                "verbose_name": "权益增值包",
                "verbose_name_plural": "权益增值包",
                "db_table": "services_billing_addon_package",
                "ordering": ["sort_order", "-created_at"],
            },
        ),
        migrations.CreateModel(
            name="WorkteamAddonEntitlement",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("workteam_id", models.CharField(db_index=True, max_length=100, verbose_name="工作团队ID")),
                ("order_id", models.CharField(blank=True, db_index=True, max_length=36, null=True, unique=True, verbose_name="关联支付订单ID")),
                ("quota_key", models.CharField(db_index=True, max_length=64, verbose_name="权益键")),
                ("quota_value", models.BigIntegerField(validators=[django.core.validators.MinValueValidator(1)], verbose_name="生效额度")),
                ("starts_at", models.DateTimeField(db_index=True, default=django.utils.timezone.now, verbose_name="开始时间")),
                ("expires_at", models.DateTimeField(db_index=True, verbose_name="结束时间")),
                ("status", models.CharField(choices=[("active", "生效中"), ("expired", "已过期"), ("cancelled", "已取消")], db_index=True, default="active", max_length=20, verbose_name="状态")),
                ("purchased_by", models.CharField(blank=True, default="", max_length=36, verbose_name="购买用户ID")),
                ("metadata", models.JSONField(default=dict, verbose_name="扩展元数据")),
                ("created_at", models.DateTimeField(auto_now_add=True, verbose_name="创建时间")),
                ("updated_at", models.DateTimeField(auto_now=True, verbose_name="更新时间")),
                ("addon_package", models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="entitlements", to="billing.addonpackage", verbose_name="增值包")),
            ],
            options={
                "verbose_name": "工作团队增值包权益",
                "verbose_name_plural": "工作团队增值包权益",
                "db_table": "services_billing_workteam_addon_entitlement",
                "ordering": ["-expires_at", "-created_at"],
            },
        ),
        migrations.AddIndex(
            model_name="addonpackage",
            index=models.Index(fields=["is_active", "sort_order"], name="services_bi_is_acti_4a2337_idx"),
        ),
        migrations.AddIndex(
            model_name="addonpackage",
            index=models.Index(fields=["quota_key", "is_active"], name="services_bi_quota_k_143d6f_idx"),
        ),
        migrations.AddIndex(
            model_name="workteamaddonentitlement",
            index=models.Index(fields=["workteam_id", "status", "expires_at"], name="services_bi_worktea_051f46_idx"),
        ),
        migrations.AddIndex(
            model_name="workteamaddonentitlement",
            index=models.Index(fields=["workteam_id", "quota_key", "status"], name="services_bi_worktea_fa528e_idx"),
        ),
        migrations.AddIndex(
            model_name="workteamaddonentitlement",
            index=models.Index(fields=["starts_at", "expires_at"], name="services_bi_starts__00e5eb_idx"),
        ),
    ]
