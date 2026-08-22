"""
LLM 服务数据模型（v0.1 AI 能力统一宪法）
"""

import logging
import uuid
from decimal import Decimal

from django.contrib.postgres.fields import ArrayField
from django.contrib.postgres.indexes import GinIndex
from django.core.exceptions import ValidationError
from django.core.validators import MinValueValidator, MaxValueValidator, RegexValidator
from django.db import models
from django.utils import timezone

logger = logging.getLogger(__name__)


class LLMCredentialDecryptionError(RuntimeError):
    """Raised when an encrypted LLM credential cannot be decrypted."""


class LLMCredentialEncryptionError(RuntimeError):
    """Raised when an LLM credential cannot be encrypted safely."""


def _looks_like_fernet_token(value: str) -> bool:
    """Fernet tokens start with a stable URL-safe base64 prefix."""
    return value.startswith("gAAAA")


def _decrypt_llm_api_key(encrypted_value: str, *, owner: str) -> str:
    if not encrypted_value:
        return ''
    try:
        f = LLMProvider._get_fernet()
        return f.decrypt(encrypted_value.encode()).decode()
    except Exception as exc:
        if _looks_like_fernet_token(encrypted_value):
            raise LLMCredentialDecryptionError(
                f"{owner} API Key 无法解密，请配置正确的 CREDENTIAL_ENCRYPTION_KEY 或重新录入密钥"
            ) from exc
        # 兼容历史明文存储：迁移早期 Fernet 不可用时可能直接写入明文。
        return encrypted_value


class LLMProvider(models.Model):
    """LLM 服务提供商配置（v0.1 schema）"""

    SCOPE_CHOICES = [
        ('global', 'Global'),
        ('organization', 'Organization'),
        ('user', 'User'),
    ]

    RUNTIME_STATUS_CHOICES = [
        ('unknown', 'Unknown'),
        ('healthy', 'Healthy'),
        ('degraded', 'Degraded'),
        ('unhealthy', 'Unhealthy'),
    ]

    CAPABILITY_DOMAIN_CHOICES = [
        ('chat', 'Chat'),
        ('embedding', 'Embedding'),
        ('vision', 'Vision'),
        ('asr', 'ASR'),
        ('tts', 'TTS'),
        ('image_gen', 'Image Generation'),
        ('video_gen', 'Video Generation'),
        ('audio_gen', 'Audio Generation'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=50, verbose_name='提供商名称')
    provider_key = models.CharField(
        max_length=100, blank=True, default='', db_index=True,
        verbose_name='渠道标识',
    )
    display_name = models.CharField(max_length=100, verbose_name='显示名称')
    # 渠道只保存“新模型默认端点”；运行时仍只读取 LLMModel.base_url。
    # 这样创建渠道时可以先录入常用 endpoint，同时允许同渠道各模型独立覆盖。
    default_base_url = models.URLField(
        blank=True,
        default='',
        verbose_name='默认端点 URL',
        help_text='仅用于创建模型时预填；模型运行时以自身 base_url 为准。',
    )
    encrypted_api_key = models.TextField(blank=True, default='', verbose_name='加密 API 密钥')

    capability_domains = ArrayField(
        base_field=models.CharField(max_length=20, choices=CAPABILITY_DOMAIN_CHOICES),
        default=list,
        blank=False,
        verbose_name='能力域集合',
        help_text='该 Provider 同时支持的能力域。一个阿里云账号可同时提供 chat/embedding/vision 等。',
    )

    scope = models.CharField(
        max_length=20, choices=SCOPE_CHOICES, default='global', db_index=True,
        verbose_name='配置范围',
    )
    organization_id = models.CharField(max_length=100, blank=True, null=True, db_index=True, verbose_name='组织 ID')
    user_id = models.CharField(max_length=36, blank=True, null=True, db_index=True, verbose_name='用户 ID')

    priority = models.IntegerField(default=0, verbose_name='优先级')
    rate_limit = models.IntegerField(default=60, verbose_name='每分钟请求限制')
    routing_enabled = models.BooleanField(default=True, verbose_name='是否参与路由')
    routing_weight = models.IntegerField(
        default=100,
        validators=[MinValueValidator(1), MaxValueValidator(1000)],
        verbose_name='轮询权重',
    )

    runtime_status = models.CharField(
        max_length=20, choices=RUNTIME_STATUS_CHOICES, default='unknown', db_index=True,
        verbose_name='运行状态',
    )
    runtime_cooldown_until = models.DateTimeField(null=True, blank=True, verbose_name='熔断冷却截止时间')
    runtime_cooldown_multiplier = models.IntegerField(default=1, verbose_name='冷却期倍数')

    health_check_enabled = models.BooleanField(default=True, verbose_name='启用健康检查')
    health_check_interval_sec = models.IntegerField(default=60, verbose_name='健康检查间隔(秒)')
    health_consecutive_failures = models.IntegerField(default=0, verbose_name='连续失败次数')
    health_total_checks = models.BigIntegerField(default=0, verbose_name='健康检查总次数')
    health_success_checks = models.BigIntegerField(default=0, verbose_name='健康检查成功次数')
    health_last_checked_at = models.DateTimeField(null=True, blank=True, verbose_name='最近检查时间')
    health_last_success_at = models.DateTimeField(null=True, blank=True, verbose_name='最近成功时间')
    health_last_failure_at = models.DateTimeField(null=True, blank=True, verbose_name='最近失败时间')
    health_last_latency_ms = models.IntegerField(null=True, blank=True, verbose_name='最近延迟(ms)')
    health_avg_latency_ms = models.FloatField(default=0, verbose_name='平均延迟(ms)')
    health_last_error = models.TextField(blank=True, verbose_name='最近错误信息')

    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'services_llm_provider'
        verbose_name = 'LLM 服务提供商'
        verbose_name_plural = 'LLM 服务提供商'
        ordering = ['-priority', '-created_at']
        constraints = [
            models.UniqueConstraint(
                fields=['scope', 'provider_key'],
                condition=models.Q(organization_id__isnull=True, user_id__isnull=True),
                name='uniq_provider_global',
            ),
            models.UniqueConstraint(
                fields=['scope', 'organization_id', 'provider_key'],
                condition=models.Q(organization_id__isnull=False, user_id__isnull=True),
                name='uniq_provider_organization',
            ),
            models.UniqueConstraint(
                fields=['scope', 'organization_id', 'user_id', 'provider_key'],
                condition=models.Q(user_id__isnull=False),
                name='uniq_provider_user',
            ),
        ]
        indexes = [
            GinIndex(fields=['capability_domains'], name='llm_prov_caps_gin'),
            models.Index(fields=['scope', 'routing_enabled'], name='llm_prov_scope_route'),
            models.Index(fields=['organization_id', 'routing_enabled'], name='llm_prov_wt_route'),
            models.Index(fields=['user_id', 'organization_id', 'routing_enabled'], name='llm_prov_user_wt_route'),
            models.Index(fields=['runtime_status', 'routing_enabled'], name='llm_prov_runtime_route'),
        ]

    def __str__(self):
        if self.scope == 'user' and self.user_id:
            return f"{self.display_name} (用户: {self.user_id[:8]}...)"
        if self.scope == 'organization' and self.organization_id:
            return f"{self.display_name} (组织: {self.organization_id[:8]}...)"
        return f"{self.display_name} (全局)"

    # v0.1.x Phase 2.5：__init__ 兼容已删字段，避免 v0.1.0 测试/老调用方 TypeError。
    # 已删字段（0022 / 0030）：is_active / is_global / base_url
    # 这些字段会被静默吃掉并打 DEBUG 日志，下游写 DB 时不会出现 unexpected keyword。
    _DEPRECATED_KWARGS = frozenset({'is_active', 'is_global', 'base_url'})

    def __init__(self, *args, **kwargs):
        # ORM 从 DB load 实例时走 positional args，此时 kwargs 是空的，不能动；
        # 只对 kwargs-only 路径做兼容处理。
        plain_key = None
        if not args:
            plain_key = kwargs.pop('api_key', None)
            for _deprecated in list(kwargs.keys()):
                if _deprecated in self._DEPRECATED_KWARGS:
                    kwargs.pop(_deprecated)
                    logger.debug(
                        "[LLMProvider] 忽略已删字段 kwarg: %s（v0.1.x 兼容层）", _deprecated,
                    )
        super().__init__(*args, **kwargs)
        if plain_key is not None:
            self.api_key = plain_key

    def save(self, *args, **kwargs):
        if not self.provider_key:
            self.provider_key = self.name
        if self.user_id:
            self.scope = 'user'
        elif self.organization_id:
            self.scope = 'organization'
        else:
            self.scope = 'global'
        super().save(*args, **kwargs)

    def clean(self) -> None:
        super().clean()
        domains = list(self.capability_domains or [])
        if not domains:
            raise ValidationError({
                'capability_domains': 'capability_domains 至少需要 1 个能力域',
            })
        valid = {c for c, _ in self.CAPABILITY_DOMAIN_CHOICES}
        invalid = [d for d in domains if d not in valid]
        if invalid:
            raise ValidationError({
                'capability_domains': f'非法能力域: {invalid}，可选值: {sorted(valid)}',
            })
        if len(set(domains)) != len(domains):
            raise ValidationError({
                'capability_domains': 'capability_domains 不允许重复',
            })

    def has_capability(self, domain: str) -> bool:
        """判断本 Provider 是否提供指定能力域。"""
        return domain in (self.capability_domains or [])

    @property
    def primary_capability_domain(self) -> str:
        """兼容字段：返回首个能力域。

        历史代码大量直接读 ``provider.capability_domain``（单值）。完成迁移前，
        ``primary_capability_domain`` 提供单值视图；新代码应使用 ``has_capability``
        / ``capability_domains`` 集合语义。
        """
        domains = self.capability_domains or []
        return domains[0] if domains else ''

    @staticmethod
    def _get_fernet():
        from apps.tabtinspace.models import SecureCredential
        return SecureCredential._get_fernet()

    @property
    def api_key(self) -> str:
        return _decrypt_llm_api_key(
            self.encrypted_api_key,
            owner=f"LLMProvider(provider_key={self.provider_key or self.name}, id={self.id})",
        )

    @api_key.setter
    def api_key(self, plain_value: str) -> None:
        if plain_value is None:
            plain_value = ''
        if not plain_value:
            self.encrypted_api_key = ''
            return
        try:
            f = self._get_fernet()
            encrypted_value = f.encrypt(plain_value.encode()).decode()
        except Exception as exc:
            logger.error("[LLMProvider] Fernet 加密失败，拒绝写入 credential")
            raise LLMCredentialEncryptionError(
                "LLMProvider API Key 加密失败，credential 未写入"
            ) from exc
        self.encrypted_api_key = encrypted_value

    @property
    def health_success_rate(self) -> float:
        if self.health_total_checks <= 0:
            return 0.0
        return round((self.health_success_checks / self.health_total_checks) * 100, 2)


class LLMModel(models.Model):
    """LLM 模型配置（v0.1 schema）"""

    BILLING_TYPE_CHOICES = [
        ('token', 'Token'),
        ('request', 'Request'),
        ('image_count', 'Image Count'),
        ('time', 'Time'),
        ('custom', 'Custom'),
    ]

    WAVE_STATUS_CHOICES = [
        ('ready', 'Ready'),
        ('w2_pending', 'W2 Pending'),
        ('w3_pending', 'W3 Pending'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    provider = models.ForeignKey(LLMProvider, on_delete=models.PROTECT, related_name='models', verbose_name='服务提供商')
    model_name = models.CharField(max_length=100, verbose_name='模型名称')
    display_name = models.CharField(max_length=100, verbose_name='显示名称')
    description = models.TextField(blank=True, verbose_name='模型描述')

    # v0.1.x Phase 2.5：base_url 从 Provider 下沉到 Model。
    # 背景：dashscope 同账号 chat/embedding/vision 走 /compatible-mode/v1，
    # image_gen/video_gen/audio_gen 走 /api/v1，1 Provider 1 base_url 撑不住；
    # 把 endpoint 跟 Model 走，反而是更自然的"账号 vs 端点"分层。
    # blank=True 是为了让 0027 add field 不爆 not-null；0028 backfill 完后由 0029
    # 改成强制非空。
    base_url = models.URLField(
        blank=True, default='',
        verbose_name='端点 URL',
        help_text=(
            'HTTP/WS 调用拼装时使用的端点。每个 Model 必须有自己的 base_url'
            '（v0.1.x 不再回退到 Provider.base_url——Provider.base_url 已删）。'
        ),
    )

    capability_domain = models.CharField(
        max_length=20, choices=LLMProvider.CAPABILITY_DOMAIN_CHOICES, db_index=True,
        verbose_name='能力域',
    )

    context_window_tokens = models.IntegerField(
        validators=[MinValueValidator(1)],
        verbose_name='上下文窗口(Token)',
    )
    max_input_tokens = models.IntegerField(null=True, blank=True, verbose_name='最大输入 Token 数')
    max_output_tokens = models.IntegerField(null=True, blank=True, verbose_name='最大输出 Token 数')

    billing_type = models.CharField(max_length=20, choices=BILLING_TYPE_CHOICES, default='token', verbose_name='计费类型')
    input_price_per_1k = models.DecimalField(max_digits=10, decimal_places=6, default=0, verbose_name='输入价格(每1K)')
    output_price_per_1k = models.DecimalField(max_digits=10, decimal_places=6, default=0, verbose_name='输出价格(每1K)')
    price_per_request = models.DecimalField(max_digits=10, decimal_places=6, default=0, verbose_name='每次请求价格')
    price_per_second = models.DecimalField(max_digits=10, decimal_places=6, default=0, verbose_name='每秒价格')

    custom_billing_config = models.JSONField(default=dict, blank=True, verbose_name='自定义计费配置')
    capabilities_config = models.JSONField(default=dict, blank=True, verbose_name='能力配置')

    wave_status = models.CharField(
        max_length=16, choices=WAVE_STATUS_CHOICES, default='ready', db_index=True,
        verbose_name='Wave 状态',
    )

    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'services_llm_model'
        verbose_name = 'LLM 模型'
        verbose_name_plural = 'LLM 模型'
        ordering = ['-created_at']
        unique_together = [['provider', 'model_name']]
        indexes = [
            models.Index(fields=['provider', 'capability_domain'], name='llm_model_prov_domain'),
            models.Index(fields=['capability_domain'], name='llm_model_domain'),
            models.Index(fields=['wave_status'], name='llm_model_wave'),
        ]

    # v0.1.x：__init__ 兼容已删字段，避免老调用方/老测试 TypeError。
    # 已删字段（0022）：is_active / mode / supports_streaming / supports_function_calling /
    # supports_vision / max_image_size / max_images_per_request / supported_image_formats
    # 字段重命名：max_tokens → context_window_tokens
    _DEPRECATED_KWARGS = frozenset({
        'is_active', 'mode', 'supports_streaming', 'supports_function_calling',
        'supports_vision', 'max_image_size', 'max_images_per_request',
        'supported_image_formats',
    })

    def __init__(self, *args, **kwargs):
        # ORM 从 DB load 实例时走 positional args（按字段顺序），此时 kwargs 是空的，
        # 不能塞 setdefault；只对 kwargs-only 路径（如 .objects.create / 显式 LLMModel(field=...)）
        # 做兼容处理。
        if not args:
            # 字段重命名兼容：max_tokens → context_window_tokens
            if 'max_tokens' in kwargs and 'context_window_tokens' not in kwargs:
                kwargs['context_window_tokens'] = kwargs.pop('max_tokens')
            for _deprecated in list(kwargs.keys()):
                if _deprecated in self._DEPRECATED_KWARGS:
                    kwargs.pop(_deprecated)
                    logger.debug(
                        "[LLMModel] 忽略已删字段 kwarg: %s（v0.1.x 兼容层）", _deprecated,
                    )
            # base_url 是 Phase 2.5 新加的必填字段；老调用方/老测试没传时给个默认值（兜底）
            kwargs.setdefault('base_url', 'https://api.example.com/v1')
            kwargs.setdefault('capability_domain', 'chat')
        super().__init__(*args, **kwargs)

    def __str__(self):
        return f"{self.display_name} ({self.provider.display_name})"

    @property
    def max_input_tokens_resolved(self) -> int:
        return self.max_input_tokens or self.context_window_tokens

    _DEFAULT_MAX_OUTPUT_FALLBACK = 4096

    @property
    def max_output_tokens_resolved(self) -> int:
        if self.max_output_tokens:
            return self.max_output_tokens
        return min(self.context_window_tokens, self._DEFAULT_MAX_OUTPUT_FALLBACK)

    @property
    def cost_per_1k_tokens(self):
        if self.billing_type == 'token':
            return (self.input_price_per_1k + self.output_price_per_1k) / 2
        return Decimal('0')


class LLMProviderKey(models.Model):
    """LLM 渠道密钥"""

    KEY_TYPE_CHOICES = [
        ('api_key', 'API Key'),
        ('oauth', 'OAuth'),
        ('token', 'Token'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    provider = models.ForeignKey(LLMProvider, on_delete=models.CASCADE, related_name='keys', verbose_name='所属渠道')
    label = models.CharField(max_length=100, verbose_name='密钥标签')
    encrypted_api_key = models.TextField(blank=True, default='', verbose_name='加密 API 密钥')

    key_type = models.CharField(max_length=20, choices=KEY_TYPE_CHOICES, default='api_key', verbose_name='密钥类型')
    priority = models.IntegerField(default=0, verbose_name='优先级')
    last_used_at = models.DateTimeField(null=True, blank=True, verbose_name='最近使用时间')
    error_count = models.IntegerField(default=0, verbose_name='连续错误次数')
    cooldown_until = models.DateTimeField(null=True, blank=True, db_index=True, verbose_name='冷却截止时间')
    disabled_until = models.DateTimeField(null=True, blank=True, db_index=True, verbose_name='禁用截止时间')
    disabled_reason = models.CharField(max_length=50, blank=True, default='', verbose_name='禁用原因')
    last_error_reason = models.CharField(max_length=50, blank=True, default='', verbose_name='最近错误分类')

    total_requests = models.BigIntegerField(default=0, verbose_name='总请求数')
    total_tokens = models.BigIntegerField(default=0, verbose_name='总 Token 数')

    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'services_llm_provider_key'
        verbose_name = 'LLM 渠道密钥'
        verbose_name_plural = 'LLM 渠道密钥'
        ordering = ['-priority', 'last_used_at', 'created_at']
        unique_together = [['provider', 'label']]
        indexes = [
            models.Index(fields=['cooldown_until']),
            models.Index(fields=['disabled_until']),
        ]

    def __str__(self):
        return f"{self.label} ({self.provider.display_name})"

    @staticmethod
    def _get_fernet():
        from apps.tabtinspace.models import SecureCredential
        return SecureCredential._get_fernet()

    @property
    def api_key(self) -> str:
        return _decrypt_llm_api_key(
            self.encrypted_api_key,
            owner=f"LLMProviderKey(label={self.label}, id={self.id})",
        )

    @api_key.setter
    def api_key(self, plain_value: str) -> None:
        if not plain_value:
            self.encrypted_api_key = ''
            return
        try:
            f = self._get_fernet()
            encrypted_value = f.encrypt(plain_value.encode()).decode()
        except Exception as exc:
            logger.error("[LLMProviderKey] Fernet 加密失败，拒绝写入 credential")
            raise LLMCredentialEncryptionError(
                "LLMProviderKey API Key 加密失败，credential 未写入"
            ) from exc
        self.encrypted_api_key = encrypted_value

    @property
    def is_usable(self) -> bool:
        now = timezone.now()
        if self.cooldown_until and now < self.cooldown_until:
            return False
        if self.disabled_until and now < self.disabled_until:
            return False
        return True


class LLMSceneBinding(models.Model):
    """LLM 场景-模型绑定配置（v0.1 schema）"""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    scene_key = models.CharField(max_length=100, unique=True, db_index=True, verbose_name='场景标识')
    display_name = models.CharField(max_length=100, verbose_name='场景名称')
    description = models.TextField(blank=True, verbose_name='场景描述')

    capability_domain = models.CharField(
        max_length=20, choices=LLMProvider.CAPABILITY_DOMAIN_CHOICES, db_index=True,
        verbose_name='能力域',
    )

    primary_model = models.ForeignKey(
        LLMModel, on_delete=models.PROTECT, null=True, blank=True, related_name='+',
        verbose_name='首选模型',
    )
    fallback_models = models.JSONField(default=list, blank=True, verbose_name='回退模型列表')
    default_params = models.JSONField(default=dict, blank=True, verbose_name='默认参数')
    capability_requirements = models.JSONField(default=dict, blank=True, verbose_name='能力要求')
    timeout_sec = models.IntegerField(null=True, blank=True, verbose_name='超时(秒)')

    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'services_llm_scene_binding'
        verbose_name = 'LLM 场景绑定'
        verbose_name_plural = 'LLM 场景绑定'
        ordering = ['scene_key']

    def __str__(self):
        model_info = self.primary_model.display_name if self.primary_model else '未配置'
        return f"{self.display_name} ({self.scene_key}) → {model_info}"

    def clean(self):
        """LLMSceneBinding 强校验（按宪法 v0.1 §5.5 + 04 §3.1）。

        校验项（合并 §5.5 4 项 + 04 §3.1 双向 SSoT 3 项）：
          A. SSoT 双向校验（防 AdminDash 单点编辑漂移；启动期同时跑兜底）
            1. scene_key 必须在 SCENES 注册（→ E19_SCENE_NOT_REGISTERED）
            2. system scene 不进 binding 表
            3. capability_domain 必须等于 SCENES[scene_key].capability_domain
            4. capability_requirements 必须等于 SCENES[scene_key].capability_requirements
          B. Model 端校验
            5. primary_model.capability_domain 必须等于 self.capability_domain
            6. fallback_models 中每个 model 的 capability_domain 也要一致
            7. primary_model.provider.scope 必须 == 'global'（路线 B → E14）
            8. primary_model.capabilities_config 必须满足 capability_requirements（→ E16）
        """
        from django.core.exceptions import ValidationError

        super().clean()
        # 用 list[str] 累积，避免不同检查项写同一 key 互相覆盖
        errors: dict[str, list[str]] = {}

        def _add_err(field: str, message: str) -> None:
            errors.setdefault(field, []).append(message)

        # ── A. SSoT 双向校验 ────────────────────────────────────────
        # AdminDash 单点编辑保存只走 clean()，不触发启动期校验；这条路径必须硬拦
        # 避免 binding 跟 SCENES 漂移（不变量 6 + 04 §3.1 line 392-413）
        spec = None
        if self.scene_key:
            try:
                from apps.services.llm.scenes.registry import SCENES
                spec = SCENES.get(self.scene_key)
            except Exception:
                # SCENES 加载异常时不阻塞 clean；启动校验路径会兜底
                spec = None
            if spec is None:
                _add_err(
                    'scene_key',
                    f'E19_SCENE_NOT_REGISTERED: scene_key={self.scene_key} 未在 SCENES 注册',
                )
            elif getattr(spec, 'is_system', False):
                _add_err(
                    'scene_key',
                    f'system scene 不进 binding 表: scene_key={self.scene_key}',
                )
            else:
                if self.capability_domain != spec.capability_domain:
                    _add_err(
                        'capability_domain',
                        f'capability_domain drift: binding={self.capability_domain} '
                        f'vs SCENES[{self.scene_key}]={spec.capability_domain}',
                    )
                # capability_requirements 跟 SCENES 双向 SSoT
                # JSONField 把 tuple 序列化成 list；SCENES 内是 tuple。归一化避免假漂移
                from apps.services.llm.scenes.registry import _canonicalize_requirements
                binding_reqs = _canonicalize_requirements(self.capability_requirements or {})
                scene_reqs = _canonicalize_requirements(spec.capability_requirements or {})
                if binding_reqs != scene_reqs:
                    _add_err(
                        'capability_requirements',
                        f'capability_requirements drift vs SCENES[{self.scene_key}]',
                    )

        # ── B. Model 端校验 ─────────────────────────────────────────
        # 5. primary_model.capability_domain 一致
        if self.primary_model and self.primary_model.capability_domain != self.capability_domain:
            _add_err(
                'primary_model',
                f'capability_domain mismatch: model={self.primary_model.capability_domain} '
                f'vs binding={self.capability_domain}',
            )

        # 6. fallback_models 中每个 model_id 也要 capability_domain 一致
        for idx, fb in enumerate(self.fallback_models or []):
            key = f'fallback_models[{idx}]'
            if not isinstance(fb, dict):
                _add_err(key, 'must be a dict with model_id')
                continue
            model_id = fb.get('model_id')
            if not model_id:
                # 允许 {"model_name": "..."} / {"provider_name": "..."} 形式作为软引用
                continue
            try:
                m = LLMModel.objects.get(id=model_id)
            except (LLMModel.DoesNotExist, ValueError, TypeError):
                _add_err(key, f'model_id={model_id} not found')
                continue
            if m.capability_domain != self.capability_domain:
                _add_err(
                    key,
                    f'capability_domain mismatch: model={m.capability_domain} '
                    f'vs binding={self.capability_domain}',
                )
            if m.provider.scope != 'global':
                _add_err(
                    key,
                    f'E14_SCENE_BINDING_VIOLATES_BYOK_BOUNDARY: '
                    f'fallback model provider scope={m.provider.scope}',
                )

        # 7. primary_model.provider.scope 必须 == 'global'（路线 B）
        if self.primary_model and self.primary_model.provider.scope != 'global':
            _add_err(
                'primary_model',
                f'E14_SCENE_BINDING_VIOLATES_BYOK_BOUNDARY: '
                f'provider scope={self.primary_model.provider.scope}',
            )

        # 8. capability_requirements 满足（实际 capability_check 跑一遍）
        if self.primary_model and self.capability_requirements:
            from apps.services.llm.scenes.capability_check import check_capability_match

            mismatch = check_capability_match(
                capabilities_config=self.primary_model.capabilities_config or {},
                requirements=self.capability_requirements,
                capability_domain=self.capability_domain,
                context_window_tokens=self.primary_model.context_window_tokens or 0,
                max_output_tokens=(
                    self.primary_model.max_output_tokens
                    or self.primary_model.context_window_tokens
                    or 0
                ),
            )
            if mismatch:
                # 跟 SSoT drift 错误（A.4 用了 capability_requirements key）区分语义：
                # drift 是「binding != SCENES」，satisfaction 是「model != binding」
                _add_err(
                    'capability_requirements_satisfaction',
                    f'E16_CAPABILITY_MISMATCH: {mismatch}',
                )

        if errors:
            raise ValidationError(errors)


class LLMUsageFact(models.Model):
    """LLM 用量事实表（v0.1 schema）"""

    STATUS_CHOICES = [
        ('pending', 'Pending'),
        ('processing', 'Processing'),
        ('completed', 'Completed'),
        ('failed', 'Failed'),
        ('cancelled', 'Cancelled'),
    ]

    COST_STATUS_CHOICES = [
        ('platform_paid', 'Platform Paid'),
        ('byok_self_paid', 'BYOK Self Paid'),
        ('n_a', 'N/A'),
    ]

    RESULT_STATUS_CHOICES = [
        ('valid', 'Valid'),
        ('invalid', 'Invalid'),
        ('unknown', 'Unknown'),
    ]

    SETTLEMENT_STATUS_CHOICES = [
        ('not_required', 'Not Required'),
        ('pending', 'Pending'),
        ('settled', 'Settled'),
        ('failed', 'Failed'),
        ('skipped', 'Skipped'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    request_id = models.CharField(max_length=255, unique=True, db_index=True, verbose_name='请求 ID')
    invocation_id = models.CharField(
        max_length=255, blank=True, null=True, verbose_name='业务调用 ID',
    )
    attempt_id = models.CharField(
        max_length=255, blank=True, null=True, verbose_name='Provider 尝试 ID',
    )
    stable_invocation = models.BooleanField(
        blank=True, null=True, verbose_name='是否稳定业务调用身份',
    )
    execution_key = models.CharField(
        max_length=100, blank=True, null=True, verbose_name='执行结算键',
    )
    business_object_type = models.CharField(
        max_length=64, blank=True, null=True, verbose_name='业务对象类型',
    )
    business_object_id = models.CharField(
        max_length=255, blank=True, null=True, verbose_name='业务对象 ID',
    )
    run_id = models.CharField(max_length=255, blank=True, null=True, verbose_name='运行 ID')
    task_id = models.CharField(max_length=255, blank=True, null=True, verbose_name='任务 ID')
    parent_invocation_id = models.CharField(
        max_length=255, blank=True, null=True, verbose_name='父业务调用 ID',
    )

    scene_key = models.CharField(max_length=100, db_index=True, verbose_name='场景标识')
    capability_domain = models.CharField(
        max_length=20, choices=LLMProvider.CAPABILITY_DOMAIN_CHOICES, db_index=True,
        verbose_name='能力域',
    )

    effective_provider_scope = models.CharField(
        max_length=20,
        choices=LLMProvider.SCOPE_CHOICES,
        db_index=True,
        verbose_name='实际渠道范围',
    )
    cost_status = models.CharField(
        max_length=20, choices=COST_STATUS_CHOICES, default='platform_paid', db_index=True,
        verbose_name='计费状态',
    )
    prompt_bundle_version = models.CharField(max_length=64, blank=True, default='', verbose_name='Prompt Bundle 版本')

    provider = models.ForeignKey(LLMProvider, on_delete=models.SET_NULL, null=True, related_name='usage_facts', verbose_name='渠道')
    provider_key = models.CharField(max_length=100, blank=True, default='', verbose_name='渠道标识')
    model = models.ForeignKey(LLMModel, on_delete=models.SET_NULL, null=True, related_name='usage_facts', verbose_name='模型')
    model_name = models.CharField(max_length=100, blank=True, default='', verbose_name='模型名称')

    organization_id = models.CharField(max_length=100, blank=True, null=True, db_index=True, verbose_name='组织 ID')
    user_id = models.CharField(max_length=36, blank=True, null=True, db_index=True, verbose_name='用户 ID')

    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default='pending', db_index=True, verbose_name='状态')
    result_status = models.CharField(
        max_length=20,
        choices=RESULT_STATUS_CHOICES,
        blank=True,
        null=True,
        verbose_name='结果状态',
    )
    settlement_status = models.CharField(
        max_length=20,
        choices=SETTLEMENT_STATUS_CHOICES,
        blank=True,
        null=True,
        verbose_name='结算状态',
    )
    settlement_key_version = models.CharField(
        max_length=32, blank=True, null=True, verbose_name='结算键版本',
    )
    retry_source = models.CharField(
        max_length=64, blank=True, null=True, verbose_name='重试来源',
    )
    error_code = models.CharField(max_length=100, blank=True, default='', verbose_name='错误码')
    error_category = models.CharField(max_length=32, blank=True, default='', db_index=True, verbose_name='错误分类')
    attempt_count = models.IntegerField(default=1, verbose_name='尝试次数')

    latency_ms = models.IntegerField(null=True, blank=True, verbose_name='时延(ms)')

    input_tokens = models.BigIntegerField(default=0, verbose_name='输入 Token')
    output_tokens = models.BigIntegerField(default=0, verbose_name='输出 Token')
    total_tokens = models.BigIntegerField(default=0, verbose_name='总 Token')
    cache_read_input_tokens = models.BigIntegerField(default=0, verbose_name='缓存命中输入 Token')
    cache_creation_input_tokens = models.BigIntegerField(default=0, verbose_name='缓存写入输入 Token')
    duration_sec = models.FloatField(default=0, verbose_name='时长(秒)')
    asset_count = models.IntegerField(default=0, verbose_name='资产数量')
    usage_estimated = models.BooleanField(default=False, verbose_name='用量是否为估算值')

    input_cost = models.DecimalField(max_digits=16, decimal_places=6, default=0, verbose_name='输入成本')
    output_cost = models.DecimalField(max_digits=16, decimal_places=6, default=0, verbose_name='输出成本')
    total_cost = models.DecimalField(max_digits=16, decimal_places=6, default=0, verbose_name='总成本')

    has_override_params = models.BooleanField(default=False, verbose_name='是否使用了覆盖参数')
    payer = models.CharField(max_length=20, blank=True, null=True, verbose_name='实际付款方')
    model_source = models.CharField(max_length=20, blank=True, null=True, verbose_name='实际模型来源')

    occurred_at = models.DateTimeField(db_index=True, verbose_name='发生时间')
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')

    class Meta:
        db_table = 'services_llm_usage_fact'
        verbose_name = 'LLM 用量事实'
        verbose_name_plural = 'LLM 用量事实'
        ordering = ['-occurred_at']
        indexes = [
            models.Index(fields=['occurred_at', 'status'], name='llm_uf_occur_status'),
            models.Index(fields=['organization_id', 'occurred_at'], name='llm_uf_wt_occur'),
            models.Index(fields=['scene_key', 'occurred_at'], name='llm_uf_scene_occur'),
            models.Index(fields=['capability_domain', 'occurred_at'], name='llm_uf_domain_occur'),
            models.Index(fields=['provider', 'occurred_at'], name='llm_uf_prov_occur'),
            models.Index(fields=['model', 'occurred_at'], name='llm_uf_model_occur'),
            models.Index(fields=['cost_status', 'occurred_at'], name='llm_uf_cost_occur'),
            models.Index(fields=['effective_provider_scope', 'occurred_at'], name='llm_uf_scope_occur'),
        ]

    def __str__(self):
        return f"{self.request_id} ({self.status})"


class LLMAdminAuditLog(models.Model):
    """LLM 管理员配置变更审计日志"""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    operator_id = models.CharField(max_length=36, db_index=True, verbose_name='操作人 ID')
    operator_username = models.CharField(max_length=150, blank=True, verbose_name='操作人用户名')

    action = models.CharField(max_length=64, db_index=True, verbose_name='操作动作')
    target_type = models.CharField(max_length=32, db_index=True, verbose_name='目标类型')
    target_id = models.CharField(max_length=64, blank=True, db_index=True, verbose_name='目标 ID')
    organization_id = models.CharField(max_length=100, blank=True, null=True, db_index=True, verbose_name='组织 ID')
    provider_id = models.CharField(max_length=36, blank=True, null=True, db_index=True, verbose_name='渠道 ID')
    model_id = models.CharField(max_length=36, blank=True, null=True, db_index=True, verbose_name='模型 ID')

    changed_fields = models.JSONField(default=dict, blank=True, verbose_name='字段变更')
    before_data = models.JSONField(default=dict, blank=True, verbose_name='变更前快照')
    after_data = models.JSONField(default=dict, blank=True, verbose_name='变更后快照')
    extra_data = models.JSONField(default=dict, blank=True, verbose_name='附加信息')

    created_at = models.DateTimeField(auto_now_add=True, db_index=True, verbose_name='创建时间')

    class Meta:
        db_table = 'services_llm_admin_audit_log'
        verbose_name = 'LLM 管理员审计日志'
        verbose_name_plural = 'LLM 管理员审计日志'
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['action', 'created_at']),
            models.Index(fields=['target_type', 'target_id']),
            models.Index(fields=['organization_id', 'created_at']),
            models.Index(fields=['operator_id', 'created_at']),
        ]

    def __str__(self):
        return f"{self.action} ({self.target_type}:{self.target_id})"


_MODEL_GATEWAY_STABLE_KEY = RegexValidator(
    regex=r"^[a-z0-9]+(?:-[a-z0-9]+)*$",
    message="必须是小写、连字符分隔的稳定标识",
)
_MODEL_GATEWAY_SHA256 = RegexValidator(
    regex=r"^sha256:[0-9a-f]{64}$",
    message="必须是带 sha256: 前缀的 64 位小写十六进制哈希",
)


class ModelGatewayProjectionBinding(models.Model):
    """环境本地 reviewed Binding identity 与可变 current pointer。"""

    class Lifecycle(models.TextChoices):
        UNBOUND = 'unbound', 'Unbound'
        DRAFT = 'draft', 'Draft'
        ACTIVE = 'active', 'Active'
        RETIRED = 'retired', 'Retired'

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    database_alias = models.CharField(max_length=64)
    package_key = models.CharField(max_length=128, validators=[_MODEL_GATEWAY_STABLE_KEY])
    deployment_key = models.CharField(max_length=128, validators=[_MODEL_GATEWAY_STABLE_KEY])
    binding_key = models.CharField(max_length=128, validators=[_MODEL_GATEWAY_STABLE_KEY])

    # 环境本地 soft identity；刻意不耦合 LLMProvider/LLMModel 的删除语义。
    existing_provider_uuid = models.UUIDField(null=True, blank=True)
    provider_create_candidate_key = models.CharField(
        max_length=128, null=True, blank=True, validators=[_MODEL_GATEWAY_STABLE_KEY],
    )
    existing_model_uuid = models.UUIDField(null=True, blank=True)
    model_create_candidate_key = models.CharField(
        max_length=128, null=True, blank=True, validators=[_MODEL_GATEWAY_STABLE_KEY],
    )

    current_projection_revision = models.ForeignKey(
        'ModelGatewayProjectionRevision',
        null=True,
        blank=True,
        on_delete=models.PROTECT,
        related_name='+',
    )
    lifecycle = models.CharField(max_length=16, choices=Lifecycle.choices, default=Lifecycle.UNBOUND)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'services_llm_gateway_projection_binding'
        constraints = [
            models.UniqueConstraint(
                fields=['database_alias', 'package_key', 'deployment_key', 'binding_key'],
                name='uniq_llm_gw_binding_identity',
            ),
            models.CheckConstraint(
                check=(
                    models.Q(existing_provider_uuid__isnull=False, provider_create_candidate_key__isnull=True)
                    | models.Q(existing_provider_uuid__isnull=True, provider_create_candidate_key__isnull=False)
                ),
                name='ck_llm_gw_provider_target_xor',
            ),
            models.CheckConstraint(
                check=(
                    models.Q(existing_model_uuid__isnull=False, model_create_candidate_key__isnull=True)
                    | models.Q(existing_model_uuid__isnull=True, model_create_candidate_key__isnull=False)
                ),
                name='ck_llm_gw_model_target_xor',
            ),
            models.CheckConstraint(
                check=(
                    ~models.Q(database_alias='') & ~models.Q(package_key='')
                    & ~models.Q(deployment_key='') & ~models.Q(binding_key='')
                ),
                name='ck_llm_gw_binding_keys_nonempty',
            ),
            models.CheckConstraint(
                check=(
                    models.Q(provider_create_candidate_key__isnull=True)
                    | models.Q(provider_create_candidate_key__regex=r'^[a-z0-9]+(?:-[a-z0-9]+)*$')
                ),
                name='ck_llm_gw_provider_candidate_key',
            ),
            models.CheckConstraint(
                check=(
                    models.Q(model_create_candidate_key__isnull=True)
                    | models.Q(model_create_candidate_key__regex=r'^[a-z0-9]+(?:-[a-z0-9]+)*$')
                ),
                name='ck_llm_gw_model_candidate_key',
            ),
        ]

    def clean(self):
        super().clean()
        if self.current_projection_revision_id:
            from .model_gateway.persistence import (
                ProjectionPersistenceValidationError,
                validate_current_pointer,
            )

            try:
                validate_current_pointer(self.id, self.current_projection_revision.binding_id)
            except ProjectionPersistenceValidationError as exc:
                raise ValidationError({'current_projection_revision': str(exc)}) from exc


class ModelGatewayProjectionRevision(models.Model):
    """Immutable ProjectionPlan revision；PR7 不提供更新路径。"""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    binding = models.ForeignKey(
        ModelGatewayProjectionBinding,
        on_delete=models.PROTECT,
        related_name='projection_revisions',
    )
    projection_revision = models.PositiveIntegerField()
    projection_hash = models.CharField(max_length=71, validators=[_MODEL_GATEWAY_SHA256])
    previous_revision = models.ForeignKey(
        'self', null=True, blank=True, on_delete=models.PROTECT, related_name='+',
    )

    package_identity = models.JSONField()
    deployment_ref = models.JSONField()
    binding_ref = models.JSONField()
    artifact_closure = models.JSONField(default=list)

    generated_factual_fields = models.JSONField(default=list)
    commercial_fields = models.JSONField(default=list)
    preserved_operational_field_names = models.JSONField(default=list)
    secret_field_classifications = models.JSONField(default=list)
    unmanaged_fields = models.JSONField(default=list)
    validation_summary = models.JSONField(default=dict)
    behavior_blockers = models.JSONField(default=list)
    readiness_blockers = models.JSONField(default=list)
    projection_metadata = models.JSONField(default=dict)

    prepared_at = models.DateTimeField()
    prepared_by_actor_id = models.CharField(max_length=128)
    review_ticket = models.CharField(max_length=128, null=True, blank=True)
    source_environment = models.CharField(max_length=64)

    class Meta:
        db_table = 'services_llm_gateway_projection_revision'
        constraints = [
            models.UniqueConstraint(
                fields=['binding', 'projection_revision'],
                name='uniq_llm_gw_revision_number',
            ),
            models.UniqueConstraint(
                fields=['binding', 'projection_hash'],
                name='uniq_llm_gw_revision_hash',
            ),
            models.CheckConstraint(
                check=models.Q(projection_revision__gt=0),
                name='ck_llm_gw_revision_positive',
            ),
            models.CheckConstraint(
                check=(~models.Q(prepared_by_actor_id='') & ~models.Q(source_environment='')),
                name='ck_llm_gw_revision_audit_nonempty',
            ),
        ]
        indexes = [
            models.Index(fields=['binding', 'projection_revision'], name='llm_gw_rev_binding_rev'),
            models.Index(fields=['projection_hash'], name='llm_gw_rev_hash'),
            models.Index(fields=['prepared_at'], name='llm_gw_rev_prepared'),
        ]

    def clean(self):
        super().clean()
        from .model_gateway.persistence import (
            ProjectionPersistenceValidationError,
            validate_exact_closure,
            validate_projection_revision_payload,
        )

        try:
            validate_exact_closure(self.artifact_closure)
            validate_projection_revision_payload({
                'package_identity': self.package_identity,
                'deployment_ref': self.deployment_ref,
                'binding_ref': self.binding_ref,
                'artifact_closure': self.artifact_closure,
                'generated_factual_fields': self.generated_factual_fields,
                'commercial_fields': self.commercial_fields,
                'preserved_operational_field_names': self.preserved_operational_field_names,
                'secret_field_classifications': self.secret_field_classifications,
                'unmanaged_fields': self.unmanaged_fields,
                'validation_summary': self.validation_summary,
                'behavior_blockers': self.behavior_blockers,
                'readiness_blockers': self.readiness_blockers,
                'projection_metadata': self.projection_metadata,
            })
        except ProjectionPersistenceValidationError as exc:
            raise ValidationError(str(exc)) from exc
        if self.previous_revision_id and self.previous_revision.binding_id != self.binding_id:
            raise ValidationError({'previous_revision': 'previous revision must belong to the same Binding'})


class ModelGatewayProjectionEvent(models.Model):
    """Future Apply/Rollback/Retire append-only audit event schema。"""

    class Action(models.TextChoices):
        PREPARED = 'prepared', 'Prepared'
        APPLY = 'apply', 'Apply'
        ROLLBACK = 'rollback', 'Rollback'
        RETIRE = 'retire', 'Retire'
        FAILED = 'failed', 'Failed'

    class Result(models.TextChoices):
        SUCCEEDED = 'succeeded', 'Succeeded'
        FAILED = 'failed', 'Failed'
        REJECTED = 'rejected', 'Rejected'

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    binding = models.ForeignKey(
        ModelGatewayProjectionBinding, on_delete=models.PROTECT, related_name='projection_events',
    )
    projection_revision = models.ForeignKey(
        ModelGatewayProjectionRevision, on_delete=models.PROTECT, related_name='projection_events',
    )
    previous_projection_revision = models.ForeignKey(
        ModelGatewayProjectionRevision,
        null=True,
        blank=True,
        on_delete=models.PROTECT,
        related_name='+',
    )
    action = models.CharField(max_length=16, choices=Action.choices)
    result = models.CharField(max_length=16, choices=Result.choices)
    actor_id = models.CharField(max_length=128)
    ticket_reference = models.CharField(max_length=128, null=True, blank=True)
    safe_reason = models.CharField(max_length=512)
    safe_error_code = models.CharField(max_length=128, null=True, blank=True)
    safe_metadata = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = 'services_llm_gateway_projection_event'
        indexes = [
            models.Index(fields=['binding', 'created_at'], name='llm_gw_evt_binding_time'),
            models.Index(fields=['projection_revision', 'action'], name='llm_gw_evt_revision_action'),
            models.Index(fields=['action', 'result'], name='llm_gw_evt_action_result'),
        ]
        constraints = [
            models.CheckConstraint(
                check=(~models.Q(actor_id='') & ~models.Q(safe_reason='')),
                name='ck_llm_gw_event_audit_nonempty',
            ),
        ]

    def clean(self):
        super().clean()
        from .model_gateway.persistence import (
            ProjectionPersistenceValidationError,
            validate_projection_event_payload,
        )

        try:
            validate_projection_event_payload({
                'actor_id': self.actor_id,
                'ticket_reference': self.ticket_reference,
                'safe_reason': self.safe_reason,
                'safe_error_code': self.safe_error_code,
                'safe_metadata': self.safe_metadata,
            })
        except ProjectionPersistenceValidationError as exc:
            raise ValidationError(str(exc)) from exc
        if self.projection_revision.binding_id != self.binding_id:
            raise ValidationError({'projection_revision': 'projection revision must belong to the same Binding'})
        if (
            self.previous_projection_revision_id
            and self.previous_projection_revision.binding_id != self.binding_id
        ):
            raise ValidationError({
                'previous_projection_revision': 'previous projection revision must belong to the same Binding',
            })
