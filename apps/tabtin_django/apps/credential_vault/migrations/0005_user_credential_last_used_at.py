# Wave 4 PD-10：UserCredential 加 last_used_at 字段。
#
# 用途：autofill-reveal 成功时回写当前时间；/website/match 端点按 last_used_at
# 倒序排列，让 Agent 后台 view 在多匹配场景下自动选最近使用的一条。
# 同时 Wave 5 设置页可基于此字段展示"最近使用时间"，让用户感知"Agent 选了哪
# 个账号"并修改默认。
from __future__ import annotations

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("credential_vault", "0004_save_blacklist_entry"),
    ]

    operations = [
        migrations.AddField(
            model_name="usercredential",
            name="last_used_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
    ]
