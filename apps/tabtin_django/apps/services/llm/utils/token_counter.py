"""
Token计算工具
"""

import base64
import hashlib
import logging
import math
import threading
from collections import OrderedDict
from typing import List, Dict, Any, Optional, Tuple
from urllib.parse import urlparse, parse_qs
from abc import ABC, abstractmethod

logger = logging.getLogger(__name__)

# Claude 图片 token 常量（基于 Anthropic 文档）
# tokens = (width * height) / 750，典型尺寸下约 1,334 tokens
CLAUDE_IMAGE_TOKENS_DEFAULT = 1_334
NORMALIZED_IMAGE_TOKENS = 1_000
# 每字节 base64 编码后约 1.37 字符；解码后按 10 bytes/pixel 粗估分辨率
_BASE64_BYTES_PER_PIXEL_ESTIMATE = 10


def _parse_jpeg_sof_dimensions(data: bytes) -> Tuple[Optional[int], Optional[int]]:
    """在 JPEG 数据中查找 SOF marker 提取宽高。"""
    i = 2
    while i < len(data) - 9:
        if data[i] != 0xFF:
            return (None, None)
        marker = data[i + 1]
        if marker in (0xC0, 0xC1, 0xC2):
            h = int.from_bytes(data[i + 5 : i + 7], "big")
            w = int.from_bytes(data[i + 7 : i + 9], "big")
            if w > 0 and h > 0:
                return (w, h)
            return (None, None)
        if marker in (0xD8, 0xD9):
            return (None, None)
        if i + 3 < len(data):
            seg_len = int.from_bytes(data[i + 2 : i + 4], "big")
            i += 2 + seg_len
        else:
            break
    return (None, None)


def _parse_image_header_dimensions(data: bytes) -> Tuple[Optional[int], Optional[int]]:
    """从图片文件头部字节解析宽高（支持 PNG/GIF/JPEG/WEBP）。"""
    if not data or len(data) < 10:
        return (None, None)

    # PNG
    if data[:8] == b"\x89PNG\r\n\x1a\n" and len(data) >= 24:
        w = int.from_bytes(data[16:20], "big")
        h = int.from_bytes(data[20:24], "big")
        if w > 0 and h > 0:
            return (w, h)

    # GIF
    if data[:3] == b"GIF" and len(data) >= 10:
        w = int.from_bytes(data[6:8], "little")
        h = int.from_bytes(data[8:10], "little")
        if w > 0 and h > 0:
            return (w, h)

    # JPEG
    if data[:2] == b"\xff\xd8":
        return _parse_jpeg_sof_dimensions(data)

    # WEBP
    if len(data) >= 16 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        if data[12:16] == b"VP8 " and len(data) >= 30:
            w = int.from_bytes(data[26:28], "little") & 0x3FFF
            h = int.from_bytes(data[28:30], "little") & 0x3FFF
            if w > 0 and h > 0:
                return (w, h)
        if data[12:16] == b"VP8L" and len(data) >= 25:
            bits = int.from_bytes(data[21:25], "little")
            w = (bits & 0x3FFF) + 1
            h = ((bits >> 14) & 0x3FFF) + 1
            if w > 0 and h > 0:
                return (w, h)

    return (None, None)


class BaseTokenCounter(ABC):
    """Token计算器基类 — 三级递降计数策略

    L1: _count_tokens_native  — 原生 tokenizer（子类覆盖以接入离线 SDK 或在线 API）
    L2: _count_tokens_tiktoken — tiktoken cl100k_base 通用 fallback
    L3: _count_tokens_estimate — 改进的字符估算兜底
    """

    _tiktoken_fallback_encoding = None
    _tiktoken_fallback_loaded = False
    _tiktoken_lock = threading.Lock()

    @abstractmethod
    def count_tokens(self, text: str) -> int:
        pass

    @abstractmethod
    def count_messages_tokens(self, messages: List[Dict[str, str]]) -> int:
        pass

    def _count_tokens_native(self, text: str) -> Optional[int]:  # noqa: ARG002
        """L1 扩展点：原生 tokenizer。
        子类覆盖以接入离线 SDK（如 anthropic tokenizer）或在线 API。
        在线 API 实现应设置 200ms 硬超时（concurrent.futures.Future.result(timeout=0.2)）。
        返回 None 降级到 L2。"""
        return None

    @staticmethod
    def _get_tiktoken_fallback():
        if BaseTokenCounter._tiktoken_fallback_loaded:
            return BaseTokenCounter._tiktoken_fallback_encoding
        with BaseTokenCounter._tiktoken_lock:
            if not BaseTokenCounter._tiktoken_fallback_loaded:
                try:
                    import tiktoken
                    BaseTokenCounter._tiktoken_fallback_encoding = tiktoken.get_encoding("cl100k_base")
                except Exception:
                    pass
                BaseTokenCounter._tiktoken_fallback_loaded = True
        return BaseTokenCounter._tiktoken_fallback_encoding

    def _count_tokens_tiktoken(self, text: str) -> Optional[int]:
        """L2: tiktoken cl100k_base fallback，精度远高于字符估算。"""
        enc = self._get_tiktoken_fallback()
        if enc is None:
            return None
        try:
            return len(enc.encode(text))
        except Exception:
            return None

    @staticmethod
    def _count_tokens_estimate(text: str) -> int:
        """L3: 改进的字符估算。
        CJK ~1.4 tokens/char（BPE 可能拆分为多 token），non-CJK ~1 token/3.5 chars。
        覆盖 CJK Extension A / 日文假名 / 韩文音节。"""
        if not text:
            return 0
        cjk = 0
        for ch in text:
            cp = ord(ch)
            if (0x4E00 <= cp <= 0x9FFF
                    or 0x3400 <= cp <= 0x4DBF
                    or 0xF900 <= cp <= 0xFAFF
                    or 0x3040 <= cp <= 0x30FF
                    or 0xAC00 <= cp <= 0xD7AF):
                cjk += 1
        non_cjk = len(text) - cjk
        return max(1, round(cjk * 1.4 + non_cjk / 3.5))


class TikTokenCounter(BaseTokenCounter):
    """基于tiktoken的Token计算器"""

    def __init__(self, model_name: str = "gpt-4"):
        self.model_name = model_name
        self._encoding = None
        self._init_encoding()

    def _init_encoding(self):
        """初始化编码器"""
        try:
            import tiktoken

            model_lower = self.model_name.lower()

            # GPT-4o / GPT-4o-mini 使用 o200k_base（必须在 gpt-4 通配之前判断）
            if "gpt-4o" in model_lower:
                self._encoding = tiktoken.get_encoding("o200k_base")
            elif "gpt-4" in model_lower:
                self._encoding = tiktoken.encoding_for_model("gpt-4")
            elif "gpt-3.5" in model_lower:
                self._encoding = tiktoken.encoding_for_model("gpt-3.5-turbo")
            elif "text-davinci" in model_lower:
                self._encoding = tiktoken.encoding_for_model("text-davinci-003")
            else:
                self._encoding = tiktoken.get_encoding("cl100k_base")

            logger.info("初始化Token计算器: %s", self.model_name)

        except ImportError:
            logger.warning("tiktoken未安装，使用估算方法")
            self._encoding = None
        except Exception as e:
            logger.error("初始化Token计算器失败: %s", e)
            self._encoding = None

    def count_tokens(self, text: str) -> int:
        """计算文本的Token数量"""
        if not text:
            return 0

        if self._encoding:
            try:
                return len(self._encoding.encode(text))
            except Exception as e:
                logger.error("Token计算异常: %s", e)
                return self._estimate_tokens(text)
        else:
            return self._estimate_tokens(text)

    def count_messages_tokens(self, messages: List[Dict[str, str]]) -> int:
        """计算消息列表的Token数量"""
        if not messages:
            return 0

        total_tokens = 0

        # 消息格式的额外Token开销
        tokens_per_message = 3  # 每条消息的格式开销
        tokens_per_name = 1     # 如果有name字段的额外开销

        for message in messages:
            total_tokens += tokens_per_message

            # 计算角色Token
            role = message.get('role', '')
            total_tokens += self.count_tokens(role)

            # 计算内容Token
            content = message.get('content', '')
            if isinstance(content, str):
                total_tokens += self.count_tokens(content)
            elif isinstance(content, list):
                # 处理多模态内容
                for item in content:
                    if isinstance(item, dict):
                        if item.get('type') == 'text':
                            total_tokens += self.count_tokens(item.get('text', ''))
                        elif item.get('type') == 'image_url':
                            # 图片Token计算
                            total_tokens += self._calculate_image_tokens(item)

            # 如果有name字段
            if 'name' in message:
                total_tokens += tokens_per_name
                total_tokens += self.count_tokens(message['name'])

        # 对话的额外开销
        total_tokens += 3  # 每次对话的额外开销

        return total_tokens

    def _estimate_tokens(self, text: str) -> int:
        """估算Token数量（当tiktoken不可用时）"""
        # 简单估算：平均每个Token约4个字符
        # 对于中文，每个字符约1个Token
        # 对于英文，每4个字符约1个Token

        chinese_chars = sum(1 for char in text if '\u4e00' <= char <= '\u9fff')
        other_chars = len(text) - chinese_chars

        estimated_tokens = chinese_chars + (other_chars // 4)
        return max(1, estimated_tokens)

    def _calculate_image_tokens(self, image_item: Dict[str, Any]) -> int:
        """按 OpenAI 官方公式计算图片 token。

        low:  固定 85
        high/auto: 85 + tiles × 170（按分辨率切 512×512 瓦片）
        无法获取尺寸时 fallback = 765（4 tiles 中位数估计）
        """
        image_url_obj = image_item.get("image_url", {})
        detail = (
            image_url_obj.get("detail", "auto")
            if isinstance(image_url_obj, dict)
            else "auto"
        )

        if detail == "low":
            return 85

        if detail in ("high", "auto"):
            width, height = self._extract_image_dimensions(image_item)
            if width and height:
                scale = min(2048 / max(width, height), 1)
                w = max(1, int(width * scale))
                h = max(1, int(height * scale))
                short_side = min(w, h)
                scale2 = min(768 / short_side, 1)
                w = max(1, int(w * scale2))
                h = max(1, int(h * scale2))
                tiles = math.ceil(w / 512) * math.ceil(h / 512)
                return 85 + tiles * 170
            return 765

        return 765

    @staticmethod
    def _extract_image_dimensions(
        image_item: Dict[str, Any],
    ) -> Tuple[Optional[int], Optional[int]]:
        """纯内存解析图片尺寸（绝不发 HTTP 请求）。

        尝试路径：
        1. image_url 对象中的 width/height 元数据
        2. URL 查询参数（?w=&h= / ?width=&height=）
        3. base64 data URI 文件头（仅解码前 768 字节）
        """
        image_url_obj = image_item.get("image_url", {})
        if not isinstance(image_url_obj, dict):
            return (None, None)

        for w_key, h_key in (("width", "height"), ("w", "h")):
            w = image_url_obj.get(w_key)
            h = image_url_obj.get(h_key)
            if w is not None and h is not None:
                try:
                    iw, ih = int(w), int(h)
                    if iw > 0 and ih > 0:
                        return (iw, ih)
                except (ValueError, TypeError):
                    pass

        url = image_url_obj.get("url", "")
        if not isinstance(url, str) or not url:
            return (None, None)

        try:
            parsed = urlparse(url)
            if parsed.query:
                params = parse_qs(parsed.query)
                for w_key, h_key in (("w", "h"), ("width", "height")):
                    w_vals = params.get(w_key)
                    h_vals = params.get(h_key)
                    if w_vals and h_vals:
                        iw, ih = int(w_vals[0]), int(h_vals[0])
                        if iw > 0 and ih > 0:
                            return (iw, ih)
        except (ValueError, TypeError):
            pass

        if url.startswith("data:") and ";base64," in url:
            try:
                b64_chunk = url.split(";base64,", 1)[1][:1024]
                remainder = len(b64_chunk) % 4
                if remainder:
                    b64_chunk = b64_chunk[: len(b64_chunk) - remainder]
                if b64_chunk:
                    header_bytes = base64.b64decode(b64_chunk)
                    return _parse_image_header_dimensions(header_bytes)
            except Exception:
                pass

        return (None, None)


class QwenTokenCounter(BaseTokenCounter):
    """通义千问Token计算器 — L1(预留原生) → L2(tiktoken) → L3(字符估算)"""

    def __init__(self, model_name: str = "qwen3-coder-flash"):
        self.model_name = model_name
        logger.info("初始化通义千问Token计算器: %s", model_name)

    def count_tokens(self, text: str) -> int:
        if not text:
            return 0
        native = self._count_tokens_native(text)
        if native is not None:
            return native
        tiktoken_result = self._count_tokens_tiktoken(text)
        if tiktoken_result is not None:
            return tiktoken_result
        return self._count_tokens_estimate(text)

    def count_messages_tokens(self, messages: List[Dict[str, str]]) -> int:
        """计算消息列表的Token数量"""
        if not messages:
            return 0

        total_tokens = 0

        for message in messages:
            role = message.get('role', '')
            total_tokens += self.count_tokens(role)

            content = message.get('content', '')
            if isinstance(content, str):
                total_tokens += self.count_tokens(content)
            elif isinstance(content, list):
                for item in content:
                    if isinstance(item, dict):
                        item_type = item.get('type', '')
                        if item_type == 'text':
                            total_tokens += self.count_tokens(item.get('text', ''))
                        elif item_type in ('image_url', 'image'):
                            total_tokens += _estimate_multimodal_image_tokens(item)

            total_tokens += 2

        return total_tokens


class ClaudeTokenCounter(BaseTokenCounter):
    """Claude Token计算器 — L1(预留原生) → L2(tiktoken) → L3(字符估算)"""

    def __init__(self, model_name: str = "claude-3-sonnet"):
        self.model_name = model_name
        logger.info("初始化Claude Token计算器: %s", model_name)

    def count_tokens(self, text: str) -> int:
        if not text:
            return 0
        native = self._count_tokens_native(text)
        if native is not None:
            return native
        tiktoken_result = self._count_tokens_tiktoken(text)
        if tiktoken_result is not None:
            return tiktoken_result
        return self._count_tokens_estimate(text)

    def count_messages_tokens(self, messages: List[Dict[str, str]]) -> int:
        """计算消息列表的Token数量"""
        if not messages:
            return 0

        total_tokens = 0

        for message in messages:
            role = message.get('role', '')
            content = message.get('content', '')

            total_tokens += self.count_tokens(role)
            if isinstance(content, str):
                total_tokens += self.count_tokens(content)
            elif isinstance(content, list):
                for item in content:
                    if isinstance(item, dict):
                        if item.get('type') == 'text':
                            total_tokens += self.count_tokens(item.get('text', ''))
                        elif item.get('type') in ('image_url', 'image'):
                            total_tokens += self._calculate_image_tokens(item)
                        else:
                            total_tokens += self.count_tokens(item.get('text', ''))
                    elif isinstance(item, str):
                        total_tokens += self.count_tokens(item)
            else:
                total_tokens += self.count_tokens(str(content))
            total_tokens += 3  # 消息格式开销

        return total_tokens

    @staticmethod
    def _calculate_image_tokens(image_item: Dict[str, Any]) -> int:
        """按 Anthropic 文档估算图片 token：tokens = ceil(width * height / 750)。
        无法获取尺寸时，从 base64 数据长度粗估像素数。"""
        # Claude 原生格式: {"type": "image", "source": {"type": "base64", "data": "..."}}
        source = image_item.get('source', {})
        b64_data = source.get('data', '') if isinstance(source, dict) else ''

        # OpenAI 兼容格式: {"type": "image_url", "image_url": {"url": "data:...;base64,..."}}
        if not b64_data:
            image_url_obj = image_item.get('image_url', {})
            url = image_url_obj.get('url', '') if isinstance(image_url_obj, dict) else ''
            if url.startswith('data:') and ';base64,' in url:
                b64_data = url.split(';base64,', 1)[1]

        if b64_data:
            try:
                raw_bytes = len(b64_data) * 3 // 4
                estimated_pixels = raw_bytes // _BASE64_BYTES_PER_PIXEL_ESTIMATE
                tokens = math.ceil(estimated_pixels / 750)
                return max(85, min(tokens, 5_000))
            except Exception:
                pass

        return CLAUDE_IMAGE_TOKENS_DEFAULT


def _estimate_multimodal_image_tokens(image_item: Dict[str, Any], default: int = NORMALIZED_IMAGE_TOKENS) -> int:  # noqa: ARG001
    """通用图片 token 估算（用于缺少专属估算逻辑的 Counter）。"""
    return default


class _ThreadSafeLRUCache:
    """线程安全的 LRU 缓存（用于 token 计算结果缓存）。"""

    def __init__(self, max_size: int = 1000):
        self._max_size = max_size
        self._data: OrderedDict[str, int] = OrderedDict()
        self._lock = threading.Lock()

    def get(self, key: str) -> Optional[int]:
        with self._lock:
            if key in self._data:
                self._data.move_to_end(key)
                return self._data[key]
            return None

    def set(self, key: str, value: int) -> None:
        with self._lock:
            if key in self._data:
                self._data.move_to_end(key)
                self._data[key] = value
            else:
                if len(self._data) >= self._max_size:
                    self._data.popitem(last=False)
                self._data[key] = value

    def __len__(self) -> int:
        with self._lock:
            return len(self._data)


class TokenCounterFactory:
    """Token计算器工厂

    COMP-P1-04: 扩展 provider 别名注册表，支持数据库中常见的大小写变体
    （如 "Anthropic"、"Google"、"Gemini"），统一通过 `provider.lower()` 匹配。
    """

    _counters = {
        'openai': TikTokenCounter,
        'moonshot': TikTokenCounter,
        'minimax': TikTokenCounter,
        'qwen': QwenTokenCounter,
        'claude': ClaudeTokenCounter,
        'anthropic': ClaudeTokenCounter,
        'google': TikTokenCounter,
        'gemini': TikTokenCounter,
        'deepseek': TikTokenCounter,
        'zhipu': TikTokenCounter,
        'baichuan': TikTokenCounter,
        'yi': TikTokenCounter,
        'mistral': TikTokenCounter,
        'groq': TikTokenCounter,
        'cohere': TikTokenCounter,
        'together': TikTokenCounter,
        # 火山方舟 / 豆包：OpenAI 兼容协议，复用 TikToken 估算（无专用 tokenizer）。
        'volcengine': TikTokenCounter,
        'ark': TikTokenCounter,
        'doubao': TikTokenCounter,
    }

    # openrouter / zenmux 等代理按模型名前缀二次分发
    _MODEL_PREFIX_MAP = {
        'claude': ClaudeTokenCounter,
        'anthropic': ClaudeTokenCounter,
        'qwen': QwenTokenCounter,
    }

    _PROXY_PROVIDERS = frozenset({'openrouter', 'zenmux'})

    @classmethod
    def create_counter(cls, provider: str, model_name: str) -> BaseTokenCounter:
        """创建Token计算器"""
        provider_lower = provider.lower().strip()

        if provider_lower in cls._PROXY_PROVIDERS:
            return cls._resolve_by_model_prefix(model_name)

        if provider_lower in cls._counters:
            return cls._counters[provider_lower](model_name)

        logger.warning(
            "[TokenCounterFactory] 未注册的提供商 '%s'（原始值），回退到 TikTokenCounter；"
            "请在 _counters 中补充注册以获得更准确的 token 估算",
            provider,
        )
        return TikTokenCounter(model_name)

    @classmethod
    def _resolve_by_model_prefix(cls, model_name: str) -> BaseTokenCounter:
        """代理型 provider（openrouter/zenmux 等）按模型名前缀二次分发到对应 Counter。"""
        model_lower = (model_name or "").lower()
        for prefix, counter_cls in cls._MODEL_PREFIX_MAP.items():
            if model_lower.startswith(prefix) or f"/{prefix}" in model_lower:
                return counter_cls(model_name)
        return TikTokenCounter(model_name)

    @classmethod
    def register_counter(cls, provider: str, counter_class: type):
        """注册新的Token计算器"""
        cls._counters[provider.lower()] = counter_class


def get_token_counter(provider: str, model_name: str) -> BaseTokenCounter:
    """获取Token计算器实例"""
    return TokenCounterFactory.create_counter(provider, model_name)


def calculate_tokens(text: str, provider: str = 'openai', model_name: str = 'gpt-4') -> int:
    """快速计算文本Token数量"""
    counter = get_token_counter(provider, model_name)
    return counter.count_tokens(text)


def calculate_messages_tokens(messages: List[Dict[str, str]],
                            provider: str = 'openai',
                            model_name: str = 'gpt-4') -> int:
    """快速计算消息Token数量"""
    counter = get_token_counter(provider, model_name)
    return counter.count_messages_tokens(messages)


def estimate_cost(tokens: int,
                 input_price_per_1k: float,
                 output_price_per_1k: float,
                 input_ratio: float = 0.7) -> Dict[str, float]:
    """
    估算成本

    Args:
        tokens: Token数量
        input_price_per_1k: 输入Token价格（每1K）
        output_price_per_1k: 输出Token价格（每1K）
        input_ratio: 输入Token比例（默认70%）

    Returns:
        Dict: 成本估算
    """
    input_tokens = int(tokens * input_ratio)
    output_tokens = tokens - input_tokens

    input_cost = (input_tokens / 1000) * input_price_per_1k
    output_cost = (output_tokens / 1000) * output_price_per_1k
    total_cost = input_cost + output_cost

    return {
        'input_tokens': input_tokens,
        'output_tokens': output_tokens,
        'input_cost': input_cost,
        'output_cost': output_cost,
        'total_cost': total_cost
    }


_token_cache = _ThreadSafeLRUCache(max_size=1000)


def cached_calculate_tokens(text: str, provider: str = 'openai', model_name: str = 'gpt-4') -> int:
    """带缓存的Token计算（线程安全 LRU，上限 1000 条）"""
    text_hash = hashlib.sha256(text.encode()).hexdigest()[:16]
    cache_key = f"{provider}:{model_name}:{text_hash}:{len(text)}"

    cached = _token_cache.get(cache_key)
    if cached is not None:
        return cached

    tokens = calculate_tokens(text, provider, model_name)
    _token_cache.set(cache_key, tokens)
    return tokens
