"""
Phase 2.5 step 3/4 — 把 ``LLMModel.base_url`` 改成非空（业务上必填）。

应用前置：0028 已经把所有 Model 的 base_url 回填好；任何新代码创建 Model
必须带 base_url。

v0.1.x：URLField 默认 ``null=False``，空字符串 '' 不算 NULL，仅 0028 的批量 UPDATE
不能保证全部 model 都拿到 base_url（BYOK Provider 没下属 model 时跳过、Provider.base_url
本身为空时跳过）。本 migration 先用 RunPython 显式校验：如有 model.base_url='' 残留就 raise，
强制运营手动修；通过后再 AlterField 改严格类型。
"""

from django.db import migrations, models


def assert_no_empty_base_url(apps, schema_editor):
    """校验所有 LLMModel.base_url 非空，否则 raise 阻断 migrate。"""
    LLMModel = apps.get_model('llm', 'LLMModel')
    empty = list(
        LLMModel.objects.using(schema_editor.connection.alias)
        .filter(base_url='')
        .values_list('id', 'model_name', 'provider_id')[:20]
    )
    if empty:
        rows = "\n  ".join(
            f"  id={m_id} model_name={m_name!r} provider_id={p_id}"
            for m_id, m_name, p_id in empty
        )
        raise RuntimeError(
            f"[0029_llmmodel_base_url_required] {len(empty)}+ LLMModel.base_url 为空，"
            f"必须先手动补齐再继续 migrate：\n  {rows}\n"
            f"运营可在 AdminDash → /ai/models 编辑这些模型补 endpoint，或用 SQL：\n"
            f"  UPDATE services_llm_model SET base_url = '<your-endpoint>' "
            f"WHERE id IN ('<list>');"
        )


def noop_backwards(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ('llm', '0028_backfill_model_base_url'),
    ]

    operations = [
        migrations.RunPython(assert_no_empty_base_url, noop_backwards),
        migrations.AlterField(
            model_name='llmmodel',
            name='base_url',
            field=models.URLField(
                help_text=(
                    'HTTP/WS 调用拼装时使用的端点。每个 Model 必须有自己的 base_url'
                    '（v0.1.x 不再回退到 Provider.base_url——Provider.base_url 已删）。'
                ),
                verbose_name='端点 URL',
            ),
        ),
    ]
