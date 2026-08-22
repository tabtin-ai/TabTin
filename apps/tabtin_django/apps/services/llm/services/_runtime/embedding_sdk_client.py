"""
Embedding capability 入口的底层 SDK 工厂（_runtime 共享层）

按宪法 09 §A.4.4 — provider 适配层 / _runtime 共享层可使用 openai SDK 等底层 client，
不算违反 A.4 反例（lint 自动豁免 /_runtime/ 路径）。

将 openai.OpenAI() 创建集中到此工厂：
  - rag/services/embedding_service.py 过渡期通过此工厂获取客户端
  - 未来 embed_text capability 入口（apps/services/llm/services/embedding/__init__.py）
    也通过此工厂复用相同的底层 SDK
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


def create_embedding_client(api_key: str, base_url: str):
    """创建 OpenAI 兼容的 Embedding 客户端（openai / qwen 均走此接口）。"""
    import openai
    import httpx

    http_client = httpx.Client(
        timeout=60.0,
        transport=httpx.HTTPTransport(proxy=None),
    )
    return openai.OpenAI(
        api_key=api_key,
        base_url=base_url,
        http_client=http_client,
    )
