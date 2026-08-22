"""
Wave 1-B Data migration: 为所有存量 bot Space 幂等补齐「规划」Collection。

Plan 模式产出的文档将归属于此 Collection（W1-C / W2-A 实现）。
本迁移仅处理 type='bot' 的 Space，不影响 user/team Space。

幂等策略：使用 get_or_create 按 (space, parent=None, name='规划') 查询，
存在即跳过；不存在则补齐。重复执行不会报错也不会产生重复 Collection。

i18n：当前硬编码中文，与 agent_service.py::create_bot_space 中的常量保持一致。
多语言版本待后续 Wave 统一接入。
"""
import logging

from django.db import migrations


PLANNING_NAME = "规划"
PLANNING_ICON = "📋"
PLANNING_ORDER = 0
BOT_SPACE_TYPE = "bot"

logger = logging.getLogger(__name__)


def forward(apps, schema_editor):
    """为所有 type='bot' 的 Space 幂等补齐「规划」Collection。"""
    Space = apps.get_model('tabtinspace', 'Space')
    Collection = apps.get_model('tabtinspace', 'Collection')

    bot_space_ids = list(
        Space.objects
        .filter(type=BOT_SPACE_TYPE)
        .values_list('id', flat=True)
    )

    if not bot_space_ids:
        logger.info("[Migration:0041] 无存量 bot Space，跳过补齐")
        return

    existing_space_ids = set(
        Collection.objects
        .filter(
            space_id__in=bot_space_ids,
            parent__isnull=True,
            name=PLANNING_NAME,
        )
        .values_list('space_id', flat=True)
    )

    created = 0
    for space_id in bot_space_ids:
        if space_id in existing_space_ids:
            continue
        Collection.objects.create(
            space_id=space_id,
            parent=None,
            name=PLANNING_NAME,
            icon=PLANNING_ICON,
            color='',
            order=PLANNING_ORDER,
            is_expanded=True,
            created_by=None,
        )
        created += 1

    logger.info(
        "[Migration:0041] bot Space 总数=%d，新建 Collection=%d，已存在=%d",
        len(bot_space_ids), created, len(existing_space_ids),
    )


def backward(apps, schema_editor):
    """回滚：删除所有 bot Space 根级 name='规划' 的 Collection。

    ⚠️ 警告 — 该回滚有破坏性副作用，生产环境严禁使用：

    1. Collection.parent 是 on_delete=CASCADE：删除根级「规划」时，
       用户在「规划」下建的所有子 Collection 会被一并物理删除。
    2. ContextItem.collection 是 on_delete=SET_NULL：被删除 Collection
       关联的所有上下文条目（含 Plan 文档对应的 ContextItem）的
       collection_id 字段会被置 NULL，丢失文件夹归属信息。
    3. 仅按精确 name='规划' 匹配；用户已重命名为「计划」「Planning」
       等同义文件夹不会被回滚清理。

    仅在开发期为重置 schema 时使用，且需确认目标 Space 内未存放任何
    实际业务数据。
    """
    Space = apps.get_model('tabtinspace', 'Space')
    Collection = apps.get_model('tabtinspace', 'Collection')

    bot_space_ids = list(
        Space.objects
        .filter(type=BOT_SPACE_TYPE)
        .values_list('id', flat=True)
    )

    deleted, _ = Collection.objects.filter(
        space_id__in=bot_space_ids,
        parent__isnull=True,
        name=PLANNING_NAME,
    ).delete()
    logger.warning(
        "[Migration:0041:reverse] 删除根级「规划」Collection=%d "
        "（包含 CASCADE 删除的子 Collection 和 SET_NULL 的关联条目）",
        deleted,
    )


class Migration(migrations.Migration):

    dependencies = [
        ('tabtinspace', '0040_agent_preferred_model_id'),
    ]

    operations = [
        migrations.RunPython(
            forward,
            backward,
            hints={'target_db': 'postgresql'},
        ),
    ]
