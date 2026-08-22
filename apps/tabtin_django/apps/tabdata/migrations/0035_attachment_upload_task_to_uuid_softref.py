"""v0.1 宪法 §5.1（2026-05-07 收尾迭代）：``AttachmentUpload.upload_task`` FK
→ UUIDField 软引用。

== 背景 ==

0034 收尾时漏改的同款问题。``AttachmentUpload`` 在 PG / ``oss.UploadTask`` 在
MySQL，原 ``ForeignKey(db_constraint=False, on_delete=CASCADE)`` 反向 cascade
collector 跨库会爆 ProgrammingError——跟 ``file_record`` / ``file`` 的雷一模一样。

== 修复 ==

FK → UUIDField 软引用 + 描述符 accessor + cascade signal：

- 字段：``upload_task`` (FK) → ``upload_task_id`` (UUIDField, **NOT NULL**)
- 物理 column 名 ``upload_task_id`` 不变（Django FK 自动 ``_id`` 后缀），数据完全保留
- accessor：``upload.upload_task`` 仍可链式访问（描述符注册到 SoftRefRegistry）
- cascade：``apps/tabdata/signals.py`` 的 ``install_softref_cascade(action='cascade')``
  在 UploadTask post_delete 物理删 AttachmentUpload（原 CASCADE 语义；子项随父删）

== NOT NULL 决策 ==

dev 库扫描悬空 0 条；业务侧所有路径都假定 ``upload_task_id`` 存在
（``apps/tabdata/services/attachment_service.py`` 创建时必填）。**保留 NOT NULL**
+ migration 内悬空预检：发现就 raise，强制运维先用 ``reconcile_softrefs --fix`` 清完
再上线。

== Index 调整 ==

原 ``models.Index(fields=['upload_task', 'status'])`` 在 DB 上叫
``tabdata_att_upload__17ebf6_idx``（参照 ``0002_initial.py:520``）。State 里改
``fields=['upload_task_id', 'status']``——column 名不变，物理 index 不动。

== 跨库物理 FK 约束 ==

PG 上 ``tabdata_attachment_upload.upload_task_id`` 跨指 MySQL，``db_constraint=False``
+ 跨库 → 物理上根本没建过 FK 约束，不需要 DROP。``db_check_fk_alignment`` 体检
也确认 0 条相关物理 FK。
"""

from django.db import migrations, models


def _check_no_orphan_upload_task(apps, schema_editor):
    """悬空预检：``upload_task_id`` 指向已删除的 ``UploadTask`` → raise。

    NOT NULL 字段不能 SET NULL，悬空记录会让 cascade signal 永远找不到 target、
    数据沉底无法清理——必须在 migration 阶段就拦下。

    数据策略：
    - 0 悬空：直接 noop pass
    - >0 悬空：抛 RuntimeError，提示先用 ``reconcile_softrefs --fix`` 清理
      （直接物理删 holder 记录，因为 NOT NULL UUID 没法 SET NULL）

    SeparateDatabaseAndState 下本函数仍会被执行——RunPython 不属于
    database_operations，是独立的 state-aware 数据迁移钩子。
    """
    if schema_editor.connection.alias != "postgresql":
        return  # AttachmentUpload 在 PG 库，其他 alias noop

    AttachmentUpload = apps.get_model("tabdata", "AttachmentUpload")
    # oss.UploadTask 在 MySQL，跨库不能直接 JOIN——分两步查
    holder_qs = AttachmentUpload.objects.using("postgresql").exclude(upload_task_id=None)
    if not holder_qs.exists():
        return

    upload_task_ids = set(holder_qs.values_list("upload_task_id", flat=True).distinct())
    if not upload_task_ids:
        return

    from django.apps import apps as django_apps
    UploadTask = django_apps.get_model("oss", "UploadTask")
    existing = set(
        str(i)
        for i in UploadTask.objects.using("default")
        .filter(id__in=upload_task_ids).values_list("id", flat=True)
    )
    orphan_ids = [str(tid) for tid in upload_task_ids if str(tid) not in existing]

    if orphan_ids:
        sample = orphan_ids[:5]
        raise RuntimeError(
            f"AttachmentUpload.upload_task_id 发现 {len(orphan_ids)} 个悬空 ID："
            f"指向已删除的 oss.UploadTask（NOT NULL 字段不能 SET NULL）。\n"
            f"sample: {sample}\n"
            f"请先执行 `python manage.py reconcile_softrefs "
            f"--holder=tabdata.AttachmentUpload --id-attr=upload_task_id --fix` 清理后再迁移。"
        )


def _noop_reverse(apps, schema_editor):
    """反向迁移 noop——FK ↔ UUIDField 转换是单向的，回滚走 0034 逆向。"""
    pass


class Migration(migrations.Migration):

    dependencies = [
        ("tabdata", "0034_attachment_file_to_uuid_softref"),
    ]

    operations = [
        # 第一步：悬空预检（独立于 SeparateDatabaseAndState，不会被 fake/unfake 跳过）
        migrations.RunPython(
            _check_no_orphan_upload_task,
            reverse_code=_noop_reverse,
            hints={"target_db": "postgresql"},
        ),
        # 第二步：state 侧把 FK 改成 UUIDField，DB 物理列不动（column 名 ``upload_task_id`` 一致）
        migrations.SeparateDatabaseAndState(
            state_operations=[
                # 原 Index 引用 'upload_task'，先 RemoveIndex 再 RemoveField
                migrations.RemoveIndex(
                    model_name="attachmentupload",
                    name="tabdata_att_upload__17ebf6_idx",
                ),
                migrations.RemoveField(
                    model_name="attachmentupload",
                    name="upload_task",
                ),
                migrations.AddField(
                    model_name="attachmentupload",
                    name="upload_task_id",
                    field=models.UUIDField(
                        db_index=True,
                        verbose_name="OSS上传任务 ID",
                        help_text="软引用 oss.UploadTask.id（v0.1 §5.1）",
                    ),
                ),
                migrations.AddIndex(
                    model_name="attachmentupload",
                    index=models.Index(
                        fields=["upload_task_id", "status"],
                        name="tabdata_att_upload__17ebf6_idx",
                    ),
                ),
            ],
            database_operations=[],
        ),
    ]
