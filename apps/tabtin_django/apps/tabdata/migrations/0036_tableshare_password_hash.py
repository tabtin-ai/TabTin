"""Wave 5 §8：TableShare.password → password_hash 不可逆迁移。

== 背景 ==

Wave 5 之前 ``TableShare.password`` 同名字段存的是明文密码（个别历史记录
可能因前向兼容代码而已经是 hash）。本次迁移把这一字段重命名为
``password_hash`` 并把所有非空值统一 ``make_password`` 化，与
``DocumentShare.password_hash`` 对称。

== 步骤 ==

1. 新增 ``password_hash`` 字段（CharField max_length=255 blank）。
2. RunPython forward：遍历 ``TableShare``，把 ``password`` 非空值
   ``make_password`` 写入 ``password_hash``。已经是 hash（前缀 pbkdf2_/argon2$
   等）的值原样保留。
3. 删除旧 ``password`` 字段。

== 单向 ==

按 PRD §五块 8.2，迁移是单向不可逆的：reverse 抛 ``RuntimeError``。
明文密码已经 hash 化，无法还原原始字符串。
"""
from __future__ import annotations

from django.contrib.auth.hashers import identify_hasher, make_password
from django.db import migrations, models


def _forward_hash_passwords(apps, schema_editor):
    """把 ``TableShare.password`` 明文 hash 化写入 ``password_hash``。

    已经是合法 hash 的值（``identify_hasher`` 能识别）原样复制。
    空字符串 / None 保持空。

    走 ``schema_editor.connection.alias`` 而不是 ``TABDATA_DB_ALIAS``，
    确保 makemigrations 与 staging/prod 在不同 alias 下都能跑。
    """
    TableShare = apps.get_model("tabdata", "TableShare")
    db_alias = schema_editor.connection.alias

    qs = TableShare.objects.using(db_alias).all().only("id", "password", "password_hash")
    updates: list = []
    for share in qs.iterator():
        raw = getattr(share, "password", "") or ""
        if not raw:
            continue
        try:
            identify_hasher(raw)
            # 已经是 hash —— 直接搬到 password_hash
            share.password_hash = raw
        except ValueError:
            share.password_hash = make_password(raw)
        updates.append(share)
        if len(updates) >= 200:
            TableShare.objects.using(db_alias).bulk_update(updates, ["password_hash"])
            updates = []
    if updates:
        TableShare.objects.using(db_alias).bulk_update(updates, ["password_hash"])


def _reverse_non_reversible(apps, schema_editor):
    """不可逆。"""
    raise RuntimeError(
        "0036_tableshare_password_hash is non-reversible: "
        "plaintext password cannot be reconstructed from a hash."
    )


class Migration(migrations.Migration):

    dependencies = [
        ("tabdata", "0035_attachment_upload_task_to_uuid_softref"),
    ]

    operations = [
        # 1. 新增 password_hash 字段
        migrations.AddField(
            model_name="tableshare",
            name="password_hash",
            field=models.CharField(
                blank=True, max_length=255, verbose_name="访问密码 hash",
            ),
        ),
        # 2. 数据迁移：把现有 password 明文 hash 化写入 password_hash
        migrations.RunPython(
            _forward_hash_passwords,
            reverse_code=_reverse_non_reversible,
            hints={"target_db": "postgresql"},
        ),
        # 3. 删除旧字段
        migrations.RemoveField(
            model_name="tableshare",
            name="password",
        ),
    ]
