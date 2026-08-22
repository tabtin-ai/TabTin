# SK-002 fix: 为 SkillEmbedding 添加顶层 workspace_id/space_id 字段
# 用于数据库索引高效过滤，与 TableEmbedding/RecordEmbedding 设计对齐
# 同时从 metadata JSON 回填已有记录（零停机 5 步策略：数据量极少，直接回填）
# SK-003 fix: 补充回填 TableEmbedding/RecordEmbedding 的 workspace_id
# migration 0011 添加了 workspace_id 字段但没有回填逻辑

from django.db import migrations, models


def backfill_skillembedding_space_ids(apps, schema_editor):
    """从 metadata.space_id 回填顶层 space_id 字段。"""
    import uuid as _uuid

    # 用当前迁移自身的连接 alias（而非硬编码 'postgresql'）：single_pg 下迁移跑在
    # 'default'(PG)，前面 AddField 的 ALTER 在该连接事务里持锁未提交，再用 'postgresql'
    # 开第二条连接读同表会自死锁。收敛到当前 alias = 同一连接。
    alias = schema_editor.connection.alias

    SkillEmbedding = apps.get_model('rag', 'SkillEmbedding')

    for row in SkillEmbedding.objects.using(alias).filter(space_id__isnull=True).iterator(chunk_size=500):
        raw_space = (row.metadata or {}).get('space_id', '')
        if not raw_space:
            continue
        try:
            parsed_space = _uuid.UUID(str(raw_space))
        except (ValueError, AttributeError):
            continue
        SkillEmbedding.objects.using(alias).filter(pk=row.pk).update(space_id=parsed_space)


def backfill_table_record_workspace_id(apps, schema_editor):
    """SK-003: 回填 TableEmbedding/RecordEmbedding 缺失的顶层 workspace_id 字段。

    migration 0011 只添加了字段，没有回填逻辑；
    migration 0013 只回填了 space_id，未回填 workspace_id。
    此函数从 metadata.workspace_id 回填顶层字段。
    """
    import uuid as _uuid

    alias = schema_editor.connection.alias

    TableEmbedding = apps.get_model('rag', 'TableEmbedding')
    RecordEmbedding = apps.get_model('rag', 'RecordEmbedding')

    for Model in (TableEmbedding, RecordEmbedding):
        for row in Model.objects.using(alias).filter(workspace_id__isnull=True).iterator(chunk_size=500):
            raw_ws = (row.metadata or {}).get('workspace_id', '')
            if not raw_ws:
                continue
            try:
                parsed_ws = _uuid.UUID(str(raw_ws))
            except (ValueError, AttributeError):
                continue
            Model.objects.using(alias).filter(pk=row.pk).update(workspace_id=parsed_ws)


class Migration(migrations.Migration):

    dependencies = [
        ('rag', '0013_tableembedding_space_id_recordembedding_space_id'),
    ]

    operations = [
        migrations.AddField(
            model_name='skillembedding',
            name='workspace_id',
            field=models.UUIDField(
                blank=True,
                db_index=True,
                help_text='冗余顶层字段，用于高效按 workspace 过滤；与 metadata.workspace_id 保持同步',
                null=True,
                verbose_name='工作空间ID',
            ),
        ),
        migrations.AddField(
            model_name='skillembedding',
            name='space_id',
            field=models.UUIDField(
                blank=True,
                db_index=True,
                help_text='冗余顶层字段，用于高效按 space 过滤；与 metadata.space_id 保持同步',
                null=True,
                verbose_name='所属空间',
            ),
        ),
        migrations.RunPython(backfill_skillembedding_space_ids, migrations.RunPython.noop),
        migrations.RunPython(backfill_table_record_workspace_id, migrations.RunPython.noop),
        migrations.AddIndex(
            model_name='skillembedding',
            index=models.Index(fields=['workspace_id'], name='rag_skill_emb_workspace_idx'),
        ),
        migrations.AddIndex(
            model_name='skillembedding',
            index=models.Index(fields=['space_id'], name='rag_skill_emb_space_idx'),
        ),
    ]
