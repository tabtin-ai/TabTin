"""
上下文管理工具
"""

import logging
import threading
import time
from collections import OrderedDict
from typing import List, Dict, Any, Optional, Tuple
from datetime import datetime, timedelta
from abc import ABC, abstractmethod
import json

from .token_counter import get_token_counter

logger = logging.getLogger(__name__)

_CONTEXT_CACHE_MAX_SIZE = 500
_CONTEXT_CACHE_TTL_SECONDS = 3600  # 1 hour


class _TTLLRUCache:
    """线程安全的 TTL + LRU 缓存，用于替代无界全局 dict。"""

    def __init__(self, max_size: int = _CONTEXT_CACHE_MAX_SIZE,
                 ttl: float = _CONTEXT_CACHE_TTL_SECONDS):
        self._max_size = max_size
        self._ttl = ttl
        self._data: OrderedDict[str, Tuple[Any, float]] = OrderedDict()
        self._lock = threading.Lock()

    def get(self, key: str) -> Optional[Any]:
        with self._lock:
            entry = self._data.get(key)
            if entry is None:
                return None
            value, ts = entry
            if time.monotonic() - ts > self._ttl:
                self._data.pop(key, None)
                return None
            self._data.move_to_end(key)
            return value

    def set(self, key: str, value: Any) -> None:
        with self._lock:
            if key in self._data:
                self._data.move_to_end(key)
                self._data[key] = (value, time.monotonic())
            else:
                if len(self._data) >= self._max_size:
                    self._data.popitem(last=False)
                self._data[key] = (value, time.monotonic())

    def remove_prefix(self, prefix: str) -> int:
        """删除所有以 prefix 开头的 key，返回删除数量。"""
        with self._lock:
            keys = [k for k in self._data if k.startswith(prefix)]
            for k in keys:
                del self._data[k]
            return len(keys)

    def clear(self) -> None:
        with self._lock:
            self._data.clear()

    def __len__(self) -> int:
        with self._lock:
            return len(self._data)

    def __contains__(self, key: str) -> bool:
        return self.get(key) is not None


class BaseContextManager(ABC):
    """上下文管理器基类"""

    @abstractmethod
    def add_message(self, message: Dict[str, str]) -> None:
        """添加消息到上下文"""
        pass

    @abstractmethod
    def get_context(self, max_tokens: Optional[int] = None) -> List[Dict[str, str]]:
        """获取上下文消息"""
        pass

    @abstractmethod
    def clear_context(self) -> None:
        """清空上下文"""
        pass

    @abstractmethod
    def get_context_info(self) -> Dict[str, Any]:
        """获取上下文信息"""
        pass


class SimpleContextManager(BaseContextManager):
    """简单上下文管理器"""

    def __init__(self, max_messages: int = 20, provider: str = 'openai', model_name: str = 'gpt-4'):
        self.max_messages = max_messages
        self.provider = provider
        self.model_name = model_name
        self.messages: List[Dict[str, str]] = []
        self.token_counter = get_token_counter(provider, model_name)

        logger.info("初始化简单上下文管理器: max_messages=%d", max_messages)

    def add_message(self, message: Dict[str, str]) -> None:
        """添加消息到上下文"""
        if not isinstance(message, dict) or 'role' not in message or 'content' not in message:
            raise ValueError("消息格式无效")

        # 添加时间戳
        message_with_time = message.copy()
        message_with_time['timestamp'] = datetime.now().isoformat()

        self.messages.append(message_with_time)

        # 限制消息数量
        if len(self.messages) > self.max_messages:
            # 保留系统消息，删除最旧的用户/助手消息
            system_messages = [msg for msg in self.messages if msg['role'] == 'system']
            other_messages = [msg for msg in self.messages if msg['role'] != 'system']

            # 保留最新的消息
            keep_count = self.max_messages - len(system_messages)
            if keep_count > 0:
                other_messages = other_messages[-keep_count:]

            self.messages = system_messages + other_messages

        logger.debug("添加消息到上下文: role=%s, 当前消息数=%d", message['role'], len(self.messages))

    def get_context(self, max_tokens: Optional[int] = None) -> List[Dict[str, str]]:
        """获取上下文消息"""
        if not max_tokens:
            # 返回所有消息（去除时间戳）
            return [self._clean_message(msg) for msg in self.messages]

        # 根据Token限制裁剪上下文
        return self._trim_by_tokens(max_tokens)

    def clear_context(self) -> None:
        """清空上下文"""
        self.messages.clear()
        logger.info("上下文已清空")

    def get_context_info(self) -> Dict[str, Any]:
        """获取上下文信息"""
        if not self.messages:
            return {
                'message_count': 0,
                'total_tokens': 0,
                'system_messages': 0,
                'user_messages': 0,
                'assistant_messages': 0
            }

        # 统计消息类型
        role_counts = {}
        for msg in self.messages:
            role = msg['role']
            role_counts[role] = role_counts.get(role, 0) + 1

        # 计算总Token数
        clean_messages = [self._clean_message(msg) for msg in self.messages]
        total_tokens = self.token_counter.count_messages_tokens(clean_messages)

        return {
            'message_count': len(self.messages),
            'total_tokens': total_tokens,
            'system_messages': role_counts.get('system', 0),
            'user_messages': role_counts.get('user', 0),
            'assistant_messages': role_counts.get('assistant', 0),
            'oldest_message': self.messages[0]['timestamp'] if self.messages else None,
            'newest_message': self.messages[-1]['timestamp'] if self.messages else None
        }

    def _clean_message(self, message: Dict[str, str]) -> Dict[str, str]:
        """清理消息，移除内部字段"""
        return {
            'role': message['role'],
            'content': message['content']
        }

    def _trim_by_tokens(self, max_tokens: int) -> List[Dict[str, str]]:
        """根据Token数量裁剪上下文"""
        if not self.messages:
            return []

        # 保留系统消息
        system_messages = [msg for msg in self.messages if msg['role'] == 'system']
        other_messages = [msg for msg in self.messages if msg['role'] != 'system']

        # 计算系统消息的Token数
        system_tokens = 0
        if system_messages:
            clean_system = [self._clean_message(msg) for msg in system_messages]
            system_tokens = self.token_counter.count_messages_tokens(clean_system)

        # 剩余Token预算
        remaining_tokens = max_tokens - system_tokens
        if remaining_tokens <= 0:
            return [self._clean_message(msg) for msg in system_messages]

        # 从最新消息开始，逐步添加直到达到Token限制
        selected_messages = []
        current_tokens = 0

        for msg in reversed(other_messages):
            clean_msg = self._clean_message(msg)
            msg_tokens = self.token_counter.count_messages_tokens([clean_msg])

            if current_tokens + msg_tokens <= remaining_tokens:
                selected_messages.insert(0, msg)
                current_tokens += msg_tokens
            else:
                continue

        result = system_messages + selected_messages
        return [self._clean_message(msg) for msg in result]


class SlidingWindowContextManager(BaseContextManager):
    """滑动窗口上下文管理器

    注意：overlap_size 参数已弃用，当前实现不使用此参数。
    保留仅为向后兼容，未来版本将移除。
    """

    def __init__(self, window_size: int = 10, overlap_size: int = 2,
                 provider: str = 'openai', model_name: str = 'gpt-4'):
        self.window_size = window_size
        if overlap_size != 2:
            logger.warning(
                "SlidingWindowContextManager.overlap_size 已弃用且不生效，"
                "传入的值 %d 将被忽略", overlap_size
            )
        self.overlap_size = overlap_size
        self.provider = provider
        self.model_name = model_name
        self.messages: List[Dict[str, str]] = []
        self.token_counter = get_token_counter(provider, model_name)

        logger.info("初始化滑动窗口上下文管理器: window_size=%d", window_size)

    def add_message(self, message: Dict[str, str]) -> None:
        """添加消息到上下文"""
        message_with_time = message.copy()
        message_with_time['timestamp'] = datetime.now().isoformat()

        self.messages.append(message_with_time)

        # 应用滑动窗口策略
        if len(self.messages) > self.window_size:
            # 保留系统消息和最近的消息
            system_messages = [msg for msg in self.messages if msg['role'] == 'system']
            other_messages = [msg for msg in self.messages if msg['role'] != 'system']

            if len(other_messages) > self.window_size - len(system_messages):
                # 保留重叠部分和最新消息
                keep_count = self.window_size - len(system_messages)
                other_messages = other_messages[-keep_count:]

            self.messages = system_messages + other_messages

        logger.debug("滑动窗口添加消息: 当前消息数=%d", len(self.messages))

    def get_context(self, max_tokens: Optional[int] = None) -> List[Dict[str, str]]:
        """获取上下文消息"""
        if not max_tokens:
            return [self._clean_message(msg) for msg in self.messages]

        return self._trim_by_tokens(max_tokens)

    def clear_context(self) -> None:
        """清空上下文"""
        self.messages.clear()
        logger.info("滑动窗口上下文已清空")

    def get_context_info(self) -> Dict[str, Any]:
        """获取上下文信息"""
        if not self.messages:
            return {
                'message_count': 0,
                'total_tokens': 0,
                'window_size': self.window_size,
                'overlap_size': self.overlap_size
            }

        clean_messages = [self._clean_message(msg) for msg in self.messages]
        total_tokens = self.token_counter.count_messages_tokens(clean_messages)

        return {
            'message_count': len(self.messages),
            'total_tokens': total_tokens,
            'window_size': self.window_size,
            'overlap_size': self.overlap_size,
            'window_utilization': len(self.messages) / self.window_size
        }

    def _clean_message(self, message: Dict[str, str]) -> Dict[str, str]:
        """清理消息"""
        return {
            'role': message['role'],
            'content': message['content']
        }

    def _trim_by_tokens(self, max_tokens: int) -> List[Dict[str, str]]:
        """根据Token数量裁剪上下文"""
        # 与SimpleContextManager类似的实现
        if not self.messages:
            return []

        system_messages = [msg for msg in self.messages if msg['role'] == 'system']
        other_messages = [msg for msg in self.messages if msg['role'] != 'system']

        system_tokens = 0
        if system_messages:
            clean_system = [self._clean_message(msg) for msg in system_messages]
            system_tokens = self.token_counter.count_messages_tokens(clean_system)

        remaining_tokens = max_tokens - system_tokens
        if remaining_tokens <= 0:
            return [self._clean_message(msg) for msg in system_messages]

        selected_messages = []
        current_tokens = 0

        for msg in reversed(other_messages):
            clean_msg = self._clean_message(msg)
            msg_tokens = self.token_counter.count_messages_tokens([clean_msg])

            if current_tokens + msg_tokens <= remaining_tokens:
                selected_messages.insert(0, msg)
                current_tokens += msg_tokens
            else:
                continue

        result = system_messages + selected_messages
        return [self._clean_message(msg) for msg in result]


class TruncatingContextManager(BaseContextManager):
    """截断式上下文管理器。

    当消息数超过 summary_threshold 时，将旧消息截断为简短摘要文本
    （每条取前 100 字符拼接），**不调用 LLM 生成真正的语义摘要**。
    适用于对上下文精度要求不高、但需要保留历史线索的场景。
    """

    def __init__(self, max_messages: int = 20, summary_threshold: int = 15,
                 provider: str = 'openai', model_name: str = 'gpt-4'):
        self.max_messages = max_messages
        self.summary_threshold = summary_threshold
        self.provider = provider
        self.model_name = model_name
        self.messages: List[Dict[str, str]] = []
        self.summary: Optional[str] = None
        self.token_counter = get_token_counter(provider, model_name)

        logger.info("初始化截断式上下文管理器: max_messages=%d, summary_threshold=%d", max_messages, summary_threshold)

    def add_message(self, message: Dict[str, str]) -> None:
        """添加消息到上下文"""
        message_with_time = message.copy()
        message_with_time['timestamp'] = datetime.now().isoformat()

        self.messages.append(message_with_time)

        if len(self.messages) > self.summary_threshold:
            self._truncate_old_messages()

        logger.debug("截断式上下文添加消息: 当前消息数=%d", len(self.messages))

    def get_context(self, max_tokens: Optional[int] = None) -> List[Dict[str, str]]:
        """获取上下文消息"""
        context = []

        if self.summary:
            context.append({
                'role': 'system',
                'content': f"对话历史摘要（截断，非 LLM 生成）: {self.summary}"
            })

        recent_messages = [self._clean_message(msg) for msg in self.messages]
        context.extend(recent_messages)

        if max_tokens:
            return self._trim_by_tokens(context, max_tokens)

        return context

    def clear_context(self) -> None:
        """清空上下文"""
        self.messages.clear()
        self.summary = None
        logger.info("截断式上下文已清空")

    def get_context_info(self) -> Dict[str, Any]:
        """获取上下文信息"""
        context = self.get_context()
        total_tokens = self.token_counter.count_messages_tokens(context)

        return {
            'message_count': len(self.messages),
            'total_tokens': total_tokens,
            'has_summary': self.summary is not None,
            'summary_length': len(self.summary) if self.summary else 0,
            'summary_threshold': self.summary_threshold
        }

    def _clean_message(self, message: Dict[str, str]) -> Dict[str, str]:
        """清理消息"""
        return {
            'role': message['role'],
            'content': message['content']
        }

    def _truncate_old_messages(self) -> None:
        """将旧消息截断为简短文本摘要（每条取前 100 字符拼接）。"""
        try:
            old_messages = self.messages[:-self.max_messages // 2]

            key_points = []
            for msg in old_messages:
                role = msg.get('role', '')
                if role in ('user', 'assistant'):
                    content = msg.get('content', '')
                    if isinstance(content, str):
                        content = content[:100]
                    elif isinstance(content, list):
                        content = str(content)[:100]
                    else:
                        content = str(content)[:100]
                    label = "用户" if role == 'user' else "助手"
                    key_points.append(f"{label}: {content}")

            self.summary = " | ".join(key_points[-5:])
            self.messages = self.messages[-self.max_messages // 2:]

            logger.info("截断旧消息为摘要: 长度=%d", len(self.summary))

        except Exception as e:
            logger.error("截断旧消息失败: %s", e)

    def _trim_by_tokens(self, messages: List[Dict[str, str]], max_tokens: int) -> List[Dict[str, str]]:
        """根据Token数量裁剪上下文"""
        if not messages:
            return []

        selected_messages = []
        current_tokens = 0

        for msg in reversed(messages):
            msg_tokens = self.token_counter.count_messages_tokens([msg])

            if current_tokens + msg_tokens <= max_tokens:
                selected_messages.insert(0, msg)
                current_tokens += msg_tokens
            else:
                continue

        return selected_messages


SummaryContextManager = TruncatingContextManager


class ContextManagerFactory:
    """上下文管理器工厂"""

    _managers = {
        'simple': SimpleContextManager,
        'sliding': SlidingWindowContextManager,
        'truncating': TruncatingContextManager,
        'summary': TruncatingContextManager,  # 向后兼容别名
    }

    @classmethod
    def create_manager(cls, manager_type: str = 'simple', **kwargs) -> BaseContextManager:
        """创建上下文管理器"""
        manager_type = manager_type.lower()

        if manager_type in cls._managers:
            return cls._managers[manager_type](**kwargs)
        else:
            logger.warning("未知管理器类型 %s，使用默认管理器", manager_type)
            return SimpleContextManager(**kwargs)

    @classmethod
    def register_manager(cls, manager_type: str, manager_class: type):
        """注册新的上下文管理器"""
        cls._managers[manager_type.lower()] = manager_class


def get_context_manager(manager_type: str = 'simple',
                       provider: str = 'openai',
                       model_name: str = 'gpt-4',
                       **kwargs) -> BaseContextManager:
    """获取上下文管理器实例"""
    return ContextManagerFactory.create_manager(
        manager_type=manager_type,
        provider=provider,
        model_name=model_name,
        **kwargs
    )


# 全局上下文管理器缓存（有界 TTL+LRU，防止 OOM）
_context_cache = _TTLLRUCache(
    max_size=_CONTEXT_CACHE_MAX_SIZE,
    ttl=_CONTEXT_CACHE_TTL_SECONDS,
)


def get_cached_context_manager(session_id: str,
                              manager_type: str = 'simple',
                              provider: str = 'openai',
                              model_name: str = 'gpt-4',
                              **kwargs) -> BaseContextManager:
    """获取缓存的上下文管理器（TTL=1h，LRU 上限 500 条）"""
    cache_key = f"{session_id}:{manager_type}:{provider}:{model_name}"

    cached = _context_cache.get(cache_key)
    if cached is not None:
        return cached

    manager = get_context_manager(
        manager_type=manager_type,
        provider=provider,
        model_name=model_name,
        **kwargs
    )
    _context_cache.set(cache_key, manager)
    return manager


def clear_context_cache(session_id: Optional[str] = None):
    """清理上下文缓存"""
    if session_id:
        count = _context_cache.remove_prefix(f"{session_id}:")
        logger.info("清理会话 %s 的上下文缓存，共 %d 条", session_id, count)
    else:
        _context_cache.clear()
        logger.info("清理所有上下文缓存")
