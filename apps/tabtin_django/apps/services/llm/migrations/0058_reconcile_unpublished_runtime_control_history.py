"""记录已由正式 Model Gateway 迁移覆盖的临时运行控件迁移。"""

from django.db import migrations


class Migration(migrations.Migration):
    reconciles = [("llm", "0051_runtime_control_descriptions")]

    dependencies = [("llm", "0057_model_gateway_projection_metadata")]

    operations = []
