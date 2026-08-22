"""RAG 模块工具函数。"""

import hashlib


def calculate_content_hash(text: str) -> str:
    """计算文本内容的 SHA-256 哈希值。"""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()
