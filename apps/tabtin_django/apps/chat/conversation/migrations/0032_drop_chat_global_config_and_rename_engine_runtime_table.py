"""
AI 能力统一宪法 v0.1 § Phase B Wave B1：
- 表 `conversation_engine_runtime_config` → `chat_engine_runtime_config`
- `ChatGlobalConfig` 50 字段全部下线（27 已迁 EngineRuntimeConfig；
  10 已迁 prompt bundle / LLMSceneBinding；13 直接弃用）

设计依据：
- 99_设计决策.md：prompt 资源化 + LLMSceneBinding 取代旧业务级 model_id 字段

注：本 migration 对已跑过 0030 的 dev DB 做就地表名重命名；
对一新环境则等价于先 CreateTable（0030）再 AlterTable（本 migration）；
两条路径在 SQL 层都收敛到 `chat_engine_runtime_config`。
"""

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ('conversation', '0031_alter_chatmessage_model_and_more'),
    ]

    operations = [
        migrations.AlterModelTable(
            name='engineruntimeconfig',
            table='chat_engine_runtime_config',
        ),
        migrations.DeleteModel(
            name='ChatGlobalConfig',
        ),
    ]
