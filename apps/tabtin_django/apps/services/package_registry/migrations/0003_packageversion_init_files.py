# Generated for W1 / 任务 A3 — _init_files 脱离 manifest JSONField。
"""把发布期临时数据 ``_init_files`` 从 ``PackageVersion.manifest`` 中分离到
独立的 ``init_files`` JSONField。

操作顺序:
1. ``AddField`` ``init_files`` (default=list)
2. 数据迁移:把现有所有 PackageVersion 的 ``manifest._init_files`` 复制到
   ``init_files``,并从 ``manifest`` 中删除 ``_init_files`` key。
"""
from django.db import migrations, models


def _move_init_files(apps, schema_editor):
    """把 manifest['_init_files'] 迁移到 init_files 字段,并清理 manifest。

    幂等:对每行只读一次 manifest,如有 ``_init_files`` 就移走。
    """
    PackageVersion = apps.get_model("package_registry", "PackageVersion")
    using = schema_editor.connection.alias

    qs = PackageVersion.objects.using(using).all()
    moved = 0
    for v in qs.iterator(chunk_size=200):
        manifest = v.manifest or {}
        if "_init_files" not in manifest:
            continue
        legacy = manifest.pop("_init_files")
        v.manifest = manifest
        # 老数据若 _init_files 不是 list(理论上不会),记录为空列表更安全
        v.init_files = legacy if isinstance(legacy, list) else []
        v.save(update_fields=["manifest", "init_files"])
        moved += 1
    # 不打 print/log 避免污染 migrate 输出;失败会以 exception 形式上抛


def _restore_init_files(apps, schema_editor):
    """反向迁移:把 init_files 写回 manifest._init_files,以便回滚后老代码能读。"""
    PackageVersion = apps.get_model("package_registry", "PackageVersion")
    using = schema_editor.connection.alias

    qs = PackageVersion.objects.using(using).all()
    for v in qs.iterator(chunk_size=200):
        if not v.init_files:
            continue
        manifest = dict(v.manifest or {})
        manifest["_init_files"] = list(v.init_files)
        v.manifest = manifest
        v.save(update_fields=["manifest"])


class Migration(migrations.Migration):

    dependencies = [
        ("package_registry", "0002_packagefile_content_type"),
    ]

    operations = [
        migrations.AddField(
            model_name="packageversion",
            name="init_files",
            field=models.JSONField(blank=True, default=list),
        ),
        migrations.RunPython(
            _move_init_files,
            reverse_code=_restore_init_files,
        ),
    ]
