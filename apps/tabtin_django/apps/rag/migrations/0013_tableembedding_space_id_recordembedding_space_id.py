# DS-034 fix: 为 TableEmbedding/RecordEmbedding 添加顶层 space_id 字段
# 用于数据库索引高效过滤，与 DocumentEmbedding 设计对齐
# 同时从 metadata JSON 回填已有记录的 space_id（产品未上线，数据量极少）

from django.db import migrations, models


def backfill_space_id(apps, schema_editor):
    """从 metadata.space_id 回填顶层 space_id 字段。"""
    import uuid as _uuid

    # 用当前迁移自身的连接 alias，而非硬编码 'postgresql'：single_pg 模式下迁移
    # 跑在 'default'(PG) 上，前面的 AddField/ALTER TABLE 在该连接的事务里持锁未提交；
    # 若此处再用 'postgresql' alias 开第二条连接读同一张表，会与未提交的 ALTER 锁
    # 自死锁（dual 下两 alias 是不同物理库才不冲突）。收敛到当前 alias 即同一连接。
    alias = schema_editor.connection.alias

    TableEmbedding = apps.get_model('rag', 'TableEmbedding')
    RecordEmbedding = apps.get_model('rag', 'RecordEmbedding')

    for Model in (TableEmbedding, RecordEmbedding):
        for row in Model.objects.using(alias).filter(space_id__isnull=True).iterator(chunk_size=500):
            raw = (row.metadata or {}).get('space_id', '')
            if not raw:
                continue
            try:
                parsed = _uuid.UUID(str(raw))
            except (ValueError, AttributeError):
                continue
            Model.objects.using(alias).filter(pk=row.pk).update(space_id=parsed)


class Migration(migrations.Migration):

    dependencies = [
        ('rag', '0012_add_status_to_code_chunk_embedding'),
    ]

    operations = [
        migrations.AddField(
            model_name='tableembedding',
            name='space_id',
            field=models.UUIDField(
                blank=True,
                db_index=True,
                help_text='冗余顶层字段，用于高效按 space 过滤；与 metadata.space_id 保持同步',
                null=True,
                verbose_name='所属空间',
            ),
        ),
        migrations.AddField(
            model_name='recordembedding',
            name='space_id',
            field=models.UUIDField(
                blank=True,
                db_index=True,
                help_text='冗余顶层字段，用于高效按 space 过滤；与 metadata.space_id 保持同步',
                null=True,
                verbose_name='所属空间',
            ),
        ),
        migrations.RunPython(backfill_space_id, migrations.RunPython.noop),
    ]
