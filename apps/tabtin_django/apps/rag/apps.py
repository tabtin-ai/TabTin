"""
RAG 模块配置
"""

from django.apps import AppConfig


class RagConfig(AppConfig):
    """RAG 应用配置"""

    default_auto_field = 'django.db.models.BigAutoField'
    name = 'apps.rag'
    verbose_name = 'RAG 向量检索'

    def ready(self):
        """应用就绪时执行"""
        # 导入信号处理器
        try:
            import apps.rag.signals  # noqa
        except ImportError:
            pass

        # 让 EmbeddingService client 缓存随 LLMProvider/LLMModel 变更自动失效
        # 与 services.llm.litellm_config 的 chat 缓存失效并列，确保 v0.1 宪法
        # "provider/model/credentials 单源、改了立刻生效"在 embedding 路径上也成立
        try:
            from apps.rag.services.embedding_service import (
                connect_embedding_cache_invalidation_signals,
            )
            connect_embedding_cache_invalidation_signals()
        except Exception:
            import logging
            logging.getLogger(__name__).warning(
                "[RAG] EmbeddingService cache invalidation signals 注册失败",
                exc_info=True,
            )
