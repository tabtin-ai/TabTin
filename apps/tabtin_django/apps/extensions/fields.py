"""可复用的加密 JSON 字段

基于 Fernet 对称加密，在数据库层面以密文 TextField 存储。
Python 层读取时自动解密为 dict / list；保存时自动加密。

对尚未加密的旧数据（纯 JSON 字符串或 dict）做平滑兼容。
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
from typing import Any

from django.conf import settings
from django.core.exceptions import ImproperlyConfigured
from django.db import models

logger = logging.getLogger(__name__)


def _build_fernet_from_settings(*, allow_secret_key_fallback: bool = True):
    """统一构建 Fernet，并对非法配置给出明确异常。"""
    from cryptography.fernet import Fernet

    key = (
        getattr(settings, "CREDENTIAL_ENCRYPTION_KEY", None)
        or getattr(settings, "SSH_CREDENTIAL_ENCRYPTION_KEY", None)
    )
    if key:
        key_bytes = key if isinstance(key, bytes) else key.encode()
        try:
            return Fernet(key_bytes)
        except Exception as exc:
            raise ImproperlyConfigured(
                "CREDENTIAL_ENCRYPTION_KEY is invalid "
                "(must be 32 url-safe base64-encoded bytes)"
            ) from exc

    if not allow_secret_key_fallback:
        raise ImproperlyConfigured(
            "CREDENTIAL_ENCRYPTION_KEY is required outside DEBUG mode."
        )

    derived = hashlib.sha256(settings.SECRET_KEY.encode()).digest()
    return Fernet(base64.urlsafe_b64encode(derived))


def _get_fernet():
    """获取 Fernet 实例，复用项目已有的密钥体系。"""
    return _build_fernet_from_settings(allow_secret_key_fallback=True)


def encrypt_str(value: str) -> str:
    """加密纯字符串，返回 base64 密文。"""
    f = _get_fernet()
    return f.encrypt(value.encode("utf-8")).decode("ascii")


def decrypt_str(cipher_text: str) -> str:
    """解密 base64 密文，返回原始字符串。"""
    f = _get_fernet()
    return f.decrypt(cipher_text.encode("ascii")).decode("utf-8")


def encrypt_json(value: Any) -> str:
    """将 Python 对象序列化为 JSON 并加密为 base64 字符串。"""
    plain = json.dumps(value, ensure_ascii=False)
    f = _get_fernet()
    return f.encrypt(plain.encode("utf-8")).decode("ascii")


def decrypt_json(cipher_text: str) -> Any:
    """解密 base64 字符串并反序列化为 Python 对象。"""
    f = _get_fernet()
    plain = f.decrypt(cipher_text.encode("ascii")).decode("utf-8")
    return json.loads(plain)


class EncryptedJSONField(models.TextField):
    """字段级 JSON 加密存储。

    - DB 层存储为 Fernet 加密的 base64 字符串
    - Python 层自动解密为 dict/list
    - 对未加密的旧数据（纯 JSON 或空字符串）做平滑迁移
    """

    description = "Encrypted JSON field using Fernet"

    def __init__(self, *args: Any, default: Any = dict, **kwargs: Any) -> None:
        kwargs.setdefault("blank", True)
        super().__init__(*args, default=default, **kwargs)

    def get_prep_value(self, value: Any) -> str | None:
        """Python → DB: 加密 JSON。加密失败直接抛异常，禁止明文回退。"""
        if value is None:
            return None
        return encrypt_json(value)

    def from_db_value(self, value: str | None, expression: Any, connection: Any) -> Any:
        """DB → Python: 解密 JSON。"""
        if value is None:
            return self.get_default()
        return self._safe_decrypt(value)

    def to_python(self, value: Any) -> Any:
        """反序列化（也用于 form 等场景）。"""
        if value is None:
            return self.get_default()
        if isinstance(value, (dict, list)):
            return value
        if isinstance(value, str):
            return self._safe_decrypt(value)
        return value

    def _safe_decrypt(self, value: str) -> Any:
        """尝试解密，失败则按纯 JSON 解析（兼容未加密旧数据）。"""
        if not value:
            return self.get_default()

        # 尝试 Fernet 解密
        try:
            return decrypt_json(value)
        except Exception:
            pass

        # 降级：尝试按纯 JSON 解析（迁移前的明文数据）
        try:
            return json.loads(value)
        except (json.JSONDecodeError, TypeError):
            pass

        logger.warning("[EncryptedJSONField] cannot decrypt or parse value, returning default")
        return self.get_default()

    def get_default(self) -> Any:
        default = self.default
        if callable(default):
            return default()
        return default

    def deconstruct(self):
        name, path, args, kwargs = super().deconstruct()
        if kwargs.get("blank") is True:
            del kwargs["blank"]
        return name, path, args, kwargs


class EncryptedCharField(models.TextField):
    """字段级字符串加密存储。

    Python 层为普通 str，DB 层为 Fernet 密文。
    对未加密的旧明文数据做平滑兼容。
    """

    description = "Encrypted char field using Fernet"

    def __init__(self, *args: Any, max_length: int = 128, **kwargs: Any) -> None:
        kwargs.setdefault("blank", True)
        kwargs.setdefault("default", "")
        self._logical_max_length = max_length
        super().__init__(*args, **kwargs)

    def get_prep_value(self, value: Any) -> str | None:
        if value is None or value == "":
            return value
        return encrypt_str(str(value))

    def from_db_value(self, value: str | None, expression: Any, connection: Any) -> str:
        if not value:
            return ""
        try:
            return decrypt_str(value)
        except Exception:
            return value

    def to_python(self, value: Any) -> str:
        if value is None:
            return ""
        if not isinstance(value, str):
            return str(value)
        if not value:
            return ""
        try:
            return decrypt_str(value)
        except Exception:
            return value

    def deconstruct(self):
        name, path, args, kwargs = super().deconstruct()
        if kwargs.get("blank") is True:
            del kwargs["blank"]
        if kwargs.get("default") == "":
            del kwargs["default"]
        return name, path, args, kwargs
