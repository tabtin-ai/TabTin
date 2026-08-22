"""
AI 能力统一宪法 v0.1 — 数据模型全面改造

LLMProvider: 删 is_global/is_active/PROVIDER_CHOICES, capability_domain 改 8 域
LLMModel: 删 mode/supports_streaming/supports_function_calling/supports_vision 等, 加 capability_domain, max_tokens → context_window_tokens
LLMSceneBinding: 删 is_active, 加 capability_domain/capability_requirements/timeout_sec, primary_model on_delete 改 PROTECT
LLMUsageFact: 删 llm_request/use_case/source_app/caller_module/is_byok, 加 capability_domain/effective_provider_scope/cost_status 等
删除 7 张废弃表
"""

from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ('llm', '0021_llmusagefact_is_byok'),
    ]

    operations = [
        # ═══════════════════════════════════════════════════════════
        # LLMProvider 改造
        # ═══════════════════════════════════════════════════════════

        # 删除字段
        migrations.RemoveField(model_name='llmprovider', name='is_global'),
        migrations.RemoveField(model_name='llmprovider', name='is_active'),

        # 改造 name：去掉 choices
        migrations.AlterField(
            model_name='llmprovider',
            name='name',
            field=models.CharField(max_length=50, verbose_name='提供商名称'),
        ),

        # 改造 capability_domain：8 个选项
        migrations.AlterField(
            model_name='llmprovider',
            name='capability_domain',
            field=models.CharField(
                max_length=20,
                choices=[
                    ('chat', 'Chat'), ('embedding', 'Embedding'), ('vision', 'Vision'),
                    ('asr', 'ASR'), ('tts', 'TTS'),
                    ('image_gen', 'Image Generation'), ('video_gen', 'Video Generation'),
                    ('audio_gen', 'Audio Generation'),
                ],
                db_index=True, verbose_name='能力域',
            ),
        ),

        # provider_key 加 db_index
        migrations.AlterField(
            model_name='llmprovider',
            name='provider_key',
            field=models.CharField(max_length=100, blank=True, default='', db_index=True, verbose_name='渠道标识'),
        ),

        # user_id 加 db_index
        migrations.AlterField(
            model_name='llmprovider',
            name='user_id',
            field=models.CharField(max_length=36, blank=True, null=True, db_index=True, verbose_name='用户 ID'),
        ),

        # 重建索引（替换旧的 is_active 索引）
        migrations.RemoveIndex(model_name='llmprovider', name='services_ll_name_e4a2a1_idx'),
        migrations.RemoveIndex(model_name='llmprovider', name='ll_scope_active_idx'),
        migrations.RemoveIndex(model_name='llmprovider', name='ll_ws_active_idx'),
        migrations.RemoveIndex(model_name='llmprovider', name='ll_user_ws_active_idx'),
        migrations.RemoveIndex(model_name='llmprovider', name='ll_runtime_route_idx'),

        migrations.AddIndex(
            model_name='llmprovider',
            index=models.Index(fields=['capability_domain', 'scope', 'routing_enabled'], name='llm_prov_domain_scope_route'),
        ),
        migrations.AddIndex(
            model_name='llmprovider',
            index=models.Index(fields=['workteam_id', 'routing_enabled'], name='llm_prov_wt_route'),
        ),
        migrations.AddIndex(
            model_name='llmprovider',
            index=models.Index(fields=['user_id', 'workteam_id', 'routing_enabled'], name='llm_prov_user_wt_route'),
        ),
        migrations.AddIndex(
            model_name='llmprovider',
            index=models.Index(fields=['runtime_status', 'routing_enabled'], name='llm_prov_runtime_route'),
        ),

        # ═══════════════════════════════════════════════════════════
        # LLMModel 改造
        # ═══════════════════════════════════════════════════════════

        # 删除字段
        migrations.RemoveField(model_name='llmmodel', name='mode'),
        migrations.RemoveField(model_name='llmmodel', name='supports_streaming'),
        migrations.RemoveField(model_name='llmmodel', name='supports_function_calling'),
        migrations.RemoveField(model_name='llmmodel', name='supports_vision'),
        migrations.RemoveField(model_name='llmmodel', name='max_image_size'),
        migrations.RemoveField(model_name='llmmodel', name='max_images_per_request'),
        migrations.RemoveField(model_name='llmmodel', name='supported_image_formats'),
        migrations.RemoveField(model_name='llmmodel', name='multimodal_limits'),
        migrations.RemoveField(model_name='llmmodel', name='wire_adapter_disabled'),
        migrations.RemoveField(model_name='llmmodel', name='is_active'),

        # max_tokens → context_window_tokens
        migrations.RenameField(
            model_name='llmmodel',
            old_name='max_tokens',
            new_name='context_window_tokens',
        ),

        # 加 capability_domain
        migrations.AddField(
            model_name='llmmodel',
            name='capability_domain',
            field=models.CharField(
                max_length=20,
                choices=[
                    ('chat', 'Chat'), ('embedding', 'Embedding'), ('vision', 'Vision'),
                    ('asr', 'ASR'), ('tts', 'TTS'),
                    ('image_gen', 'Image Generation'), ('video_gen', 'Video Generation'),
                    ('audio_gen', 'Audio Generation'),
                ],
                db_index=True, verbose_name='能力域',
                default='chat',
            ),
            preserve_default=False,
        ),

        # 重建索引
        migrations.RemoveIndex(model_name='llmmodel', name='services_ll_provide_8e43de_idx'),
        migrations.RemoveIndex(model_name='llmmodel', name='services_ll_model_n_b038ff_idx'),
        migrations.RemoveIndex(model_name='llmmodel', name='services_ll_support_004a98_idx'),
        migrations.RemoveIndex(model_name='llmmodel', name='ll_model_wave_active_idx'),

        migrations.AddIndex(
            model_name='llmmodel',
            index=models.Index(fields=['provider', 'capability_domain'], name='llm_model_prov_domain'),
        ),
        migrations.AddIndex(
            model_name='llmmodel',
            index=models.Index(fields=['capability_domain'], name='llm_model_domain'),
        ),
        migrations.AddIndex(
            model_name='llmmodel',
            index=models.Index(fields=['wave_status'], name='llm_model_wave'),
        ),

        # ═══════════════════════════════════════════════════════════
        # LLMProviderKey: 删 is_active, 重建索引
        # ═══════════════════════════════════════════════════════════
        migrations.RemoveField(model_name='llmproviderkey', name='is_active'),
        migrations.RemoveIndex(model_name='llmproviderkey', name='ll_pkey_provider_active_idx'),

        # ═══════════════════════════════════════════════════════════
        # LLMSceneBinding 改造
        # ═══════════════════════════════════════════════════════════

        migrations.RemoveField(model_name='llmscenebinding', name='is_active'),

        # primary_model: SET_NULL → PROTECT（保留 null=True 兼容旧数据）
        migrations.AlterField(
            model_name='llmscenebinding',
            name='primary_model',
            field=models.ForeignKey(
                on_delete=django.db.models.deletion.PROTECT,
                null=True, blank=True,
                related_name='+',
                to='llm.llmmodel',
                verbose_name='首选模型',
            ),
        ),

        migrations.AddField(
            model_name='llmscenebinding',
            name='capability_domain',
            field=models.CharField(
                max_length=20,
                choices=[
                    ('chat', 'Chat'), ('embedding', 'Embedding'), ('vision', 'Vision'),
                    ('asr', 'ASR'), ('tts', 'TTS'),
                    ('image_gen', 'Image Generation'), ('video_gen', 'Video Generation'),
                    ('audio_gen', 'Audio Generation'),
                ],
                db_index=True, verbose_name='能力域',
                default='chat',
            ),
            preserve_default=False,
        ),

        migrations.AddField(
            model_name='llmscenebinding',
            name='capability_requirements',
            field=models.JSONField(default=dict, blank=True, verbose_name='能力要求'),
        ),

        migrations.AddField(
            model_name='llmscenebinding',
            name='timeout_sec',
            field=models.IntegerField(null=True, blank=True, verbose_name='超时(秒)'),
        ),

        # ═══════════════════════════════════════════════════════════
        # LLMUsageFact 改造
        # ═══════════════════════════════════════════════════════════

        # 删除字段
        migrations.RemoveField(model_name='llmusagefact', name='llm_request'),
        migrations.RemoveField(model_name='llmusagefact', name='use_case'),
        migrations.RemoveField(model_name='llmusagefact', name='source_app'),
        migrations.RemoveField(model_name='llmusagefact', name='caller_module'),
        migrations.RemoveField(model_name='llmusagefact', name='is_byok'),
        migrations.RemoveField(model_name='llmusagefact', name='updated_at'),

        # 新增字段
        migrations.AddField(
            model_name='llmusagefact',
            name='capability_domain',
            field=models.CharField(
                max_length=20,
                choices=[
                    ('chat', 'Chat'), ('embedding', 'Embedding'), ('vision', 'Vision'),
                    ('asr', 'ASR'), ('tts', 'TTS'),
                    ('image_gen', 'Image Generation'), ('video_gen', 'Video Generation'),
                    ('audio_gen', 'Audio Generation'),
                ],
                db_index=True, verbose_name='能力域',
                default='chat',
            ),
            preserve_default=False,
        ),

        migrations.AddField(
            model_name='llmusagefact',
            name='effective_provider_scope',
            field=models.CharField(
                max_length=20,
                choices=[('global', 'Global'), ('workteam', 'Workteam'), ('user', 'User')],
                db_index=True, verbose_name='实际渠道范围',
                default='global',
            ),
            preserve_default=False,
        ),

        migrations.AddField(
            model_name='llmusagefact',
            name='cost_status',
            field=models.CharField(
                max_length=20,
                choices=[('platform_paid', 'Platform Paid'), ('byok_self_paid', 'BYOK Self Paid'), ('n_a', 'N/A')],
                default='platform_paid', db_index=True, verbose_name='计费状态',
            ),
        ),

        migrations.AddField(
            model_name='llmusagefact',
            name='prompt_bundle_version',
            field=models.CharField(max_length=64, blank=True, default='', verbose_name='Prompt Bundle 版本'),
        ),

        migrations.AddField(
            model_name='llmusagefact',
            name='duration_sec',
            field=models.FloatField(default=0, verbose_name='时长(秒)'),
        ),

        migrations.AddField(
            model_name='llmusagefact',
            name='asset_count',
            field=models.IntegerField(default=0, verbose_name='资产数量'),
        ),

        migrations.AddField(
            model_name='llmusagefact',
            name='has_override_params',
            field=models.BooleanField(default=False, verbose_name='是否使用了覆盖参数'),
        ),

        # 改 status default: 'unknown' → 'pending', 去掉 'unknown' choice
        migrations.AlterField(
            model_name='llmusagefact',
            name='status',
            field=models.CharField(
                max_length=20,
                choices=[
                    ('pending', 'Pending'), ('processing', 'Processing'),
                    ('completed', 'Completed'), ('failed', 'Failed'),
                    ('cancelled', 'Cancelled'),
                ],
                default='pending', db_index=True, verbose_name='状态',
            ),
        ),

        # 改 input_cost/output_cost/total_cost: 去 null
        migrations.AlterField(
            model_name='llmusagefact',
            name='input_cost',
            field=models.DecimalField(max_digits=16, decimal_places=6, default=0, verbose_name='输入成本'),
        ),
        migrations.AlterField(
            model_name='llmusagefact',
            name='output_cost',
            field=models.DecimalField(max_digits=16, decimal_places=6, default=0, verbose_name='输出成本'),
        ),
        migrations.AlterField(
            model_name='llmusagefact',
            name='total_cost',
            field=models.DecimalField(max_digits=16, decimal_places=6, default=0, verbose_name='总成本'),
        ),

        # scene_key: 去掉 blank/default
        migrations.AlterField(
            model_name='llmusagefact',
            name='scene_key',
            field=models.CharField(max_length=100, db_index=True, verbose_name='场景标识'),
        ),

        # 重建索引
        migrations.RemoveIndex(model_name='llmusagefact', name='ll_usage_occur_status_idx'),
        migrations.RemoveIndex(model_name='llmusagefact', name='ll_usage_ws_time_idx'),
        migrations.RemoveIndex(model_name='llmusagefact', name='ll_usage_provider_time_idx'),
        migrations.RemoveIndex(model_name='llmusagefact', name='ll_usage_model_time_idx'),
        migrations.RemoveIndex(model_name='llmusagefact', name='ll_usage_case_source_idx'),

        migrations.AddIndex(
            model_name='llmusagefact',
            index=models.Index(fields=['occurred_at', 'status'], name='llm_uf_occur_status'),
        ),
        migrations.AddIndex(
            model_name='llmusagefact',
            index=models.Index(fields=['workteam_id', 'occurred_at'], name='llm_uf_wt_occur'),
        ),
        migrations.AddIndex(
            model_name='llmusagefact',
            index=models.Index(fields=['scene_key', 'occurred_at'], name='llm_uf_scene_occur'),
        ),
        migrations.AddIndex(
            model_name='llmusagefact',
            index=models.Index(fields=['capability_domain', 'occurred_at'], name='llm_uf_domain_occur'),
        ),
        migrations.AddIndex(
            model_name='llmusagefact',
            index=models.Index(fields=['provider', 'occurred_at'], name='llm_uf_prov_occur'),
        ),
        migrations.AddIndex(
            model_name='llmusagefact',
            index=models.Index(fields=['model', 'occurred_at'], name='llm_uf_model_occur'),
        ),
        migrations.AddIndex(
            model_name='llmusagefact',
            index=models.Index(fields=['cost_status', 'occurred_at'], name='llm_uf_cost_occur'),
        ),
        migrations.AddIndex(
            model_name='llmusagefact',
            index=models.Index(fields=['effective_provider_scope', 'occurred_at'], name='llm_uf_scope_occur'),
        ),

        # ═══════════════════════════════════════════════════════════
        # 删除 7 张废弃表
        # ═══════════════════════════════════════════════════════════

        migrations.DeleteModel(name='LLMVisionRequest'),
        migrations.DeleteModel(name='LLMRequest'),
        migrations.DeleteModel(name='LLMUsageStatistics'),
        migrations.DeleteModel(name='LLMUsageBudgetPolicy'),
        migrations.DeleteModel(name='LLMCapabilityDrift'),
        migrations.DeleteModel(name='LLMModelCache'),
        migrations.DeleteModel(name='LLMProviderProbeLog'),
    ]
