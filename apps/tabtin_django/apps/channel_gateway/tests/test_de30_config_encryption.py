"""DE-30: ChannelAccount.config 加密存储回归测试。

验证：
1. ChannelAccount.config 字段类型为 EncryptedJSONField
2. 写入 config 后读取数据不变（round-trip）
3. 数据库存储的是密文而非明文
"""

from __future__ import annotations

import json
import unittest

from django.test import SimpleTestCase, override_settings

from apps.extensions.fields import EncryptedJSONField, encrypt_json, decrypt_json
from apps.channel_gateway.models import ChannelAccount

# 测试用有效 Fernet 密钥（不依赖真实配置，Django 测试环境可能无有效密钥）
_FERNET_KEY = "9BDfvkgfAHpozigBmgMDVo3iNR1v68h8hZqDkoqHrZQ="


class TestDE30_ChannelAccountConfigFieldType(SimpleTestCase):
    """DE-30: 验证 ChannelAccount.config 使用 EncryptedJSONField。"""

    def test_config_field_is_encrypted_json_field(self):
        """config 字段类型必须为 EncryptedJSONField。"""
        field = ChannelAccount._meta.get_field("config")
        self.assertIsInstance(
            field,
            EncryptedJSONField,
            "ChannelAccount.config 必须使用 EncryptedJSONField，禁止明文 JSONField",
        )


@override_settings(CREDENTIAL_ENCRYPTION_KEY=_FERNET_KEY)
class TestDE30_EncryptedJSONFieldRoundTrip(SimpleTestCase):
    """DE-30: 验证 EncryptedJSONField 写入后读取数据不变。"""

    def test_dict_round_trip(self):
        """dict 写入后读取数据一致。"""
        field = EncryptedJSONField(default=dict)
        original = {"bot_token": "secret_123", "api_key": "key_456"}
        prep = field.get_prep_value(original)
        self.assertIsNotNone(prep)
        # 模拟 from_db_value 读取
        restored = field.from_db_value(prep, None, None)
        self.assertEqual(restored, original)

    def test_nested_dict_round_trip(self):
        """嵌套 dict 写入后读取数据一致。"""
        field = EncryptedJSONField(default=dict)
        original = {"nested": {"a": 1, "b": [2, 3]}, "list": [{"x": "y"}]}
        prep = field.get_prep_value(original)
        restored = field.from_db_value(prep, None, None)
        self.assertEqual(restored, original)

    def test_empty_dict_round_trip(self):
        """空 dict 写入后读取一致。"""
        field = EncryptedJSONField(default=dict)
        original = {}
        prep = field.get_prep_value(original)
        restored = field.from_db_value(prep, None, None)
        self.assertEqual(restored, original)

    def test_list_round_trip(self):
        """list 类型也支持 round-trip。"""
        field = EncryptedJSONField(default=dict)
        original = [1, 2, {"key": "value"}]
        prep = field.get_prep_value(original)
        restored = field.from_db_value(prep, None, None)
        self.assertEqual(restored, original)


@override_settings(CREDENTIAL_ENCRYPTION_KEY=_FERNET_KEY)
class TestDE30_DatabaseStoresCiphertext(SimpleTestCase):
    """DE-30: 验证数据库存储的是密文而非明文。"""

    def test_prep_value_is_not_plain_json(self):
        """get_prep_value 返回值不是明文 JSON 字符串。"""
        field = EncryptedJSONField(default=dict)
        original = {"secret": "sensitive_data"}
        plain_json = json.dumps(original, ensure_ascii=False)
        prep = field.get_prep_value(original)
        self.assertNotEqual(
            prep,
            plain_json,
            "数据库存储值不得为明文 JSON，必须加密",
        )

    def test_prep_value_not_parseable_as_json(self):
        """密文无法被 json.loads 解析为原始数据（证明是加密后的 base64）。"""
        field = EncryptedJSONField(default=dict)
        original = {"key": "value"}
        prep = field.get_prep_value(original)
        # Fernet 密文为 base64，json.loads 会失败或解析出非预期结构
        with self.assertRaises(json.JSONDecodeError):
            json.loads(prep)

    def test_encrypt_json_returns_ciphertext(self):
        """encrypt_json 返回密文，与明文 JSON 不同。"""
        original = {"token": "secret"}
        plain = json.dumps(original, ensure_ascii=False)
        cipher = encrypt_json(original)
        self.assertNotEqual(cipher, plain)
        # 密文可被 decrypt_json 正确还原
        restored = decrypt_json(cipher)
        self.assertEqual(restored, original)
