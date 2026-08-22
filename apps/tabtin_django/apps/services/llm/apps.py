import importlib
import logging
import pkgutil

from django.apps import AppConfig

logger = logging.getLogger(__name__)


def _auto_discover_providers() -> None:
    """扫描 providers/ 子包，自动执行每个子包的 register 模块。

    约定：providers/<name>/register.py 在模块级调用
    ``ProviderRegistry.register(ProviderMetadata(...))``，
    import 即完成注册。
    """
    try:
        providers_package = importlib.import_module("apps.services.llm.providers")
    except ImportError:
        # providers/ 目录尚未创建——阶段 2 其他 Agent 负责，此处静默跳过
        return

    for _, name, is_pkg in pkgutil.iter_modules(providers_package.__path__):
        if not is_pkg:
            continue
        try:
            importlib.import_module(f"apps.services.llm.providers.{name}.register")
        except ImportError:
            logger.debug("Provider '%s' 没有 register 模块，跳过", name)
        except Exception:
            logger.exception("Provider '%s' 注册失败", name)


class LlmConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'apps.services.llm'
    verbose_name = 'LLM服务'

    def ready(self):
        # 避免 Ninja 动态参数模型因 model_id 触发 pydantic 受保护命名空间警告
        try:
            from pydantic import ConfigDict
            from ninja.params import models as ninja_params

            config = ConfigDict(protected_namespaces=())
            param_models = [
                ninja_params.ParamModel,
                ninja_params.QueryModel,
                ninja_params.PathModel,
                ninja_params.HeaderModel,
                ninja_params.CookieModel,
                ninja_params.BodyModel,
                ninja_params.FormModel,
                ninja_params.FileModel,
            ]
            for model_cls in param_models:
                model_cls.model_config = config
                rebuild = getattr(model_cls, "model_rebuild", None)
                if callable(rebuild):
                    rebuild(force=True)
        except Exception:
            pass

        _auto_discover_providers()

        try:
            from apps.services.llm.litellm_config import connect_cache_invalidation_signals
            connect_cache_invalidation_signals()
        except Exception as e:
            logger.warning("[LLM] LiteLLM cache signal registration failed: %s", e)

        try:
            from django.conf import settings
            from apps.services.startup_jobs import should_skip_startup_background_jobs

            if getattr(settings, 'RUNNING_TESTS', False) or should_skip_startup_background_jobs():
                logger.debug("[LLM] litellm preload skipped for management command/tests")
            else:
                from apps.services.llm.litellm_config import preload_litellm_in_background
                preload_litellm_in_background()
        except Exception as e:
            logger.warning("[LLM] litellm preload scheduling failed: %s", e)

        try:
            from apps.services.llm.scenes.registry import validate_registry_at_startup
            validate_registry_at_startup()
        except Exception as e:
            logger.error("[LLM] SceneRegistry 启动校验失败: %s", e)
            raise

        try:
            from apps.services.llm.prompts.registry import PromptRegistry
            PromptRegistry.validate_at_startup()
        except Exception as e:
            logger.error("[LLM] PromptRegistry 启动校验失败: %s", e)
            raise
