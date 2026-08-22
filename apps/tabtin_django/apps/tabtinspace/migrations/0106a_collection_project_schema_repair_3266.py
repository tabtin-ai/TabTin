#  修复：旧版 0105 已 applied、但当时尚未包含 Collection.project /
# space nullable 时，库里缺列而 migration state 已有字段，导致 0107
# ``project_id__isnull`` 查询 ProgrammingError。
#
# 本迁移只补 DB schema（state 无变更——0105 现行文件已声明这些字段）。
# 新环境若 0105 已建好列，本步为 no-op。

from django.db import migrations, models


def _collection_columns(connection) -> set[str]:
    with connection.cursor() as cursor:
        description = connection.introspection.get_table_description(
            cursor, 'tabtinspace_collection',
        )
    return {getattr(col, 'name', None) or col[0] for col in description}


def _space_id_nullable(connection) -> bool | None:
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT is_nullable
            FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = %s
              AND column_name = %s
            """,
            ['tabtinspace_collection', 'space_id'],
        )
        row = cursor.fetchone()
    if row is None:
        return None
    return str(row[0]).upper() == 'YES'


def forwards_repair_collection_project_schema(apps, schema_editor):
    connection = schema_editor.connection
    if connection.vendor != 'postgresql':
        return

    cols = _collection_columns(connection)
    if 'project_id' not in cols:
        schema_editor.execute(
            """
            ALTER TABLE tabtinspace_collection
            ADD COLUMN project_id uuid NULL
            REFERENCES tabtinspace_project(id)
            """
        )
        schema_editor.execute(
            """
            CREATE INDEX IF NOT EXISTS tabtinspace_collection_project_id_idx
            ON tabtinspace_collection (project_id)
            """
        )

    if _space_id_nullable(connection) is False:
        schema_editor.execute(
            """
            ALTER TABLE tabtinspace_collection
            ALTER COLUMN space_id DROP NOT NULL
            """
        )

    # 若仍有 space_id == Project.id 的团队文件夹（旧 0105 未回填），补挂 project。
    Collection = apps.get_model('tabtinspace', 'Collection')
    Project = apps.get_model('tabtinspace', 'Project')
    project_ids = list(Project.objects.values_list('id', flat=True))
    if not project_ids:
        return
    Collection.objects.filter(
        space_id__in=project_ids,
        project_id__isnull=True,
    ).update(project_id=models.F('space_id'))
    Collection.objects.filter(
        space_id__in=project_ids,
        project_id=models.F('space_id'),
    ).update(space_id=None)


def backwards_noop(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ('tabtinspace', '0106_contextitem_project_backfill_xor_3266'),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            state_operations=[],
            database_operations=[
                migrations.RunPython(
                    forwards_repair_collection_project_schema,
                    backwards_noop,
                ),
            ],
        ),
    ]
