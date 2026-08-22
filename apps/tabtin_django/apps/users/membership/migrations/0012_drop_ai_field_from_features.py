"""清理 MembershipTier.features JSON 中残留的 ai_field 键

产品决策（2026-05-01 扫尾轮）：
TabData AI 字段彻底下架后，所有等级的 features JSON 中残留的 ``ai_field`` 键
没有任何代码再读，仅作为数据噪音存在。本 migration 将其从所有现存等级中移除。

不可逆：JSON 字段更新无法可靠回滚，且产品方向已定（不会复活），
因此 reverse 设为 no-op。

依赖：上一个迁移 ``0011_alter_membershiptier_features``。
"""

from django.db import migrations


def _drop_ai_field_key(apps, schema_editor):
    """从所有 MembershipTier.features 中移除 'ai_field' 键。"""
    MembershipTier = apps.get_model('membership', 'MembershipTier')
    updated_count = 0
    for tier in MembershipTier.objects.all():
        features = tier.features or {}
        if 'ai_field' in features:
            features = {k: v for k, v in features.items() if k != 'ai_field'}
            tier.features = features
            tier.save(update_fields=['features'])
            updated_count += 1
    if updated_count:
        print(f"  [membership 0012] 从 {updated_count} 个等级 features 中移除 ai_field 键")


def _noop_reverse(apps, schema_editor):
    """无回滚——产品已下线。"""
    pass


class Migration(migrations.Migration):

    dependencies = [
        ('membership', '0011_alter_membershiptier_features'),
    ]

    operations = [
        migrations.RunPython(_drop_ai_field_key, _noop_reverse),
    ]
