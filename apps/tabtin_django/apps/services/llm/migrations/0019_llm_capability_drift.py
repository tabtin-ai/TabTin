"""W1c · 新增 LLMCapabilityDrift 表用于 capability drift 检测记录。

总控 § 4 W1 S1.4 + § 6.1 W1c CI gate 要求:
- ``validate_wire_capabilities`` / ``llm_capability_test`` 发现的 drift 持久化
- admin 列表展示 + 标记 acknowledged
- nightly task 检测 + 写入

DB:LLMModel 在 default DB(MySQL),LLMCapabilityDrift 与之 FK,同 DB。
不需要 ``--database=postgresql``。
"""

from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ("llm", "0018_llm_wire_adapter_system_style_canonicalize"),
    ]

    operations = [
        migrations.CreateModel(
            name="LLMCapabilityDrift",
            fields=[
                ("id", models.BigAutoField(primary_key=True, serialize=False)),
                (
                    "probe_name",
                    models.CharField(
                        blank=True,
                        default="",
                        help_text=(
                            "若 drift 来自 self-test probe,记录 probe 名;来自 "
                            "static validator 时为空。"
                        ),
                        max_length=64,
                        verbose_name="Probe 名",
                    ),
                ),
                (
                    "field_name",
                    models.CharField(
                        help_text="如 wire.system_message_style / image.input_via 等。",
                        max_length=128,
                        verbose_name="字段路径",
                    ),
                ),
                (
                    "drift_type",
                    models.CharField(
                        choices=[
                            ("regression", "Regression(declared 但 fail)"),
                            ("under_claim", "Under-claim(可升级 declared)"),
                            ("enum_invalid", "Enum 值非法"),
                            ("helper_not_recognized", "Helper 不显式识别"),
                            ("required_missing", "必填字段缺失"),
                            ("invariant_violation", "逻辑约束违反"),
                            ("discrete_drift", "离散字段与 wire_adapter 不一致"),
                            ("unknown", "未知"),
                        ],
                        default="unknown",
                        max_length=32,
                        verbose_name="Drift 类型",
                    ),
                ),
                (
                    "severity",
                    models.CharField(
                        choices=[
                            ("error", "Error(阻断)"),
                            ("warning", "Warning(提示)"),
                            ("info", "Info"),
                        ],
                        default="warning",
                        max_length=16,
                        verbose_name="严重度",
                    ),
                ),
                (
                    "declared",
                    models.JSONField(
                        blank=True,
                        help_text="基于 caps 推断的预期值。",
                        null=True,
                        verbose_name="Declared 值",
                    ),
                ),
                (
                    "observed",
                    models.JSONField(
                        blank=True,
                        help_text="dry-run / 校验实际看到的值。",
                        null=True,
                        verbose_name="Observed 值",
                    ),
                ),
                (
                    "rule",
                    models.CharField(
                        blank=True,
                        default="",
                        help_text="如 W1c.enum.invalid_value,便于过滤。",
                        max_length=128,
                        verbose_name="规则代号",
                    ),
                ),
                ("message", models.TextField(blank=True, default="", verbose_name="描述")),
                ("hint", models.TextField(blank=True, default="", verbose_name="修复建议")),
                (
                    "detected_at",
                    models.DateTimeField(auto_now_add=True, db_index=True, verbose_name="发现时间"),
                ),
                (
                    "acknowledged",
                    models.BooleanField(
                        default=False,
                        help_text="管理员排查后勾选,nightly task 不再重复 alert。",
                        verbose_name="已确认",
                    ),
                ),
                (
                    "acknowledged_at",
                    models.DateTimeField(blank=True, null=True, verbose_name="确认时间"),
                ),
                (
                    "acknowledged_by",
                    models.CharField(
                        blank=True, default="", max_length=64, verbose_name="确认人"
                    ),
                ),
                (
                    "model",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="capability_drifts",
                        to="llm.llmmodel",
                        verbose_name="LLM 模型",
                    ),
                ),
            ],
            options={
                "verbose_name": "LLM Capability Drift",
                "verbose_name_plural": "LLM Capability Drifts",
                "db_table": "services_llm_capability_drift",
                "ordering": ["-detected_at"],
                "indexes": [
                    models.Index(
                        fields=["model", "probe_name", "field_name", "drift_type"],
                        name="llm_drift_dedup_idx",
                    ),
                    models.Index(
                        fields=["acknowledged", "-detected_at"],
                        name="llm_drift_pending_idx",
                    ),
                ],
            },
        ),
    ]
