"""
内容剪枝工具
"""

import logging
import re
from typing import List, Dict, Any, Optional, Tuple
from abc import ABC, abstractmethod

from .token_counter import get_token_counter

logger = logging.getLogger(__name__)


class BaseContentPruner(ABC):
    """内容剪枝器基类"""

    @abstractmethod
    def prune_content(self, content: str, max_tokens: int) -> str:
        """剪枝内容"""
        pass

    @abstractmethod
    def prune_messages(self, messages: List[Dict[str, str]], max_tokens: int) -> List[Dict[str, str]]:
        """剪枝消息列表"""
        pass


class SimpleContentPruner(BaseContentPruner):
    """简单内容剪枝器"""

    def __init__(self, provider: str = 'openai', model_name: str = 'gpt-4'):
        self.provider = provider
        self.model_name = model_name
        self.token_counter = get_token_counter(provider, model_name)

        logger.info("初始化简单内容剪枝器: %s/%s", provider, model_name)

    def prune_content(self, content, max_tokens: int):
        """剪枝内容（支持 str 和 list 类型的多模态 content）"""
        if not content:
            return content

        if isinstance(content, list):
            return self._prune_list_content(content, max_tokens)

        if not isinstance(content, str):
            return content

        current_tokens = self.token_counter.count_tokens(content)

        if current_tokens <= max_tokens:
            return content

        # 简单截断策略：按比例截取
        ratio = max_tokens / current_tokens
        target_length = int(len(content) * ratio * 0.9)  # 留一些余量

        # 尝试在句子边界截断
        truncated = self._truncate_at_sentence(content, target_length)

        # 验证Token数量
        if self.token_counter.count_tokens(truncated) <= max_tokens:
            return truncated
        else:
            # 如果还是超出，进一步截断
            return self._force_truncate(truncated, max_tokens)

    def _prune_list_content(self, content_parts: list, max_tokens: int) -> list:
        """剪枝多模态 content（list of parts），仅裁剪 text 类型部分。"""
        text_segments = []
        for part in content_parts:
            if isinstance(part, dict) and part.get('type') == 'text':
                text_segments.append(part.get('text', ''))

        if not text_segments:
            return content_parts

        combined_text = '\n'.join(text_segments)
        current_tokens = self.token_counter.count_tokens(combined_text)

        if current_tokens <= max_tokens:
            return content_parts

        pruned_text = self.prune_content(combined_text, max_tokens)

        result = []
        text_replaced = False
        for part in content_parts:
            if isinstance(part, dict) and part.get('type') == 'text':
                if not text_replaced and pruned_text:
                    result.append({'type': 'text', 'text': pruned_text})
                    text_replaced = True
            else:
                result.append(part)

        return result if result else content_parts

    def prune_messages(self, messages: List[Dict[str, str]], max_tokens: int) -> List[Dict[str, str]]:
        """剪枝消息列表，保留 system/user/assistant/tool 所有角色。"""
        if not messages:
            return messages

        current_tokens = self.token_counter.count_messages_tokens(messages)

        if current_tokens <= max_tokens:
            return messages

        system_messages = [msg for msg in messages if msg.get('role') == 'system']
        other_messages = [msg for msg in messages if msg.get('role') != 'system']

        system_tokens = 0
        if system_messages:
            system_tokens = self.token_counter.count_messages_tokens(system_messages)

        if max_tokens - system_tokens <= 0:
            return system_messages

        result_messages = system_messages.copy()
        current_tokens = system_tokens

        for msg in reversed(other_messages):
            msg_tokens = self.token_counter.count_messages_tokens([msg])

            if current_tokens + msg_tokens <= max_tokens:
                result_messages.append(msg)
                current_tokens += msg_tokens
            else:
                content = msg.get('content', '')
                if isinstance(content, list):
                    budget = max_tokens - current_tokens
                    if budget > 0:
                        pruned_content = self._prune_list_content(content, budget)
                        pruned_msg = msg.copy()
                        pruned_msg['content'] = pruned_content
                    else:
                        pruned_msg = msg.copy()
                    result_messages.append(pruned_msg)
                    current_tokens += self.token_counter.count_messages_tokens([pruned_msg])
                    continue

                budget = max_tokens - current_tokens
                if budget <= 0:
                    continue

                pruned_content = self.prune_content(content, budget)
                if pruned_content:
                    pruned_msg = msg.copy()
                    pruned_msg['content'] = pruned_content
                    result_messages.append(pruned_msg)
                    current_tokens += self.token_counter.count_messages_tokens([pruned_msg])

        result_messages = self._fix_tool_call_pairing(result_messages, messages)
        return self._sort_messages_by_original_order(result_messages, messages)

    @staticmethod
    def _extract_tool_call_ids(msg: Dict[str, Any]) -> set:
        """从 assistant 消息中提取所有 tool_call id。"""
        ids = set()
        for tc in (msg.get('tool_calls') or []):
            tc_id = tc.get('id') if isinstance(tc, dict) else getattr(tc, 'id', None)
            if tc_id:
                ids.add(tc_id)
        return ids

    def _fix_tool_call_pairing(
        self,
        result_messages: List[Dict[str, Any]],
        original_messages: List[Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        """确保 result 中 assistant.tool_calls 与 tool 消息的 tool_call_id 配对完整。

        Provider API 要求每个 tool_call_id 都有对应的 tool result 消息，
        缺失任一方会导致 400 错误。
        """
        result_tool_call_ids: set = set()
        result_assistant_tc_ids: set = set()
        for msg in result_messages:
            if msg.get('role') == 'assistant':
                ids = self._extract_tool_call_ids(msg)
                result_tool_call_ids.update(ids)
                result_assistant_tc_ids.update(ids)

        result_tool_response_ids: set = set()
        for msg in result_messages:
            if msg.get('role') == 'tool':
                tcid = msg.get('tool_call_id')
                if tcid:
                    result_tool_response_ids.add(tcid)

        missing_tool_responses = result_tool_call_ids - result_tool_response_ids
        missing_assistant_calls = result_tool_response_ids - result_tool_call_ids

        if not missing_tool_responses and not missing_assistant_calls:
            return result_messages

        for msg in original_messages:
            if msg.get('role') == 'tool':
                tcid = msg.get('tool_call_id')
                if tcid and tcid in missing_tool_responses and tcid not in result_tool_response_ids:
                    result_messages.append(msg)
                    result_tool_response_ids.add(tcid)

        for msg in original_messages:
            if msg.get('role') == 'assistant':
                ids = self._extract_tool_call_ids(msg)
                overlap = ids & missing_assistant_calls
                if overlap and not (ids & result_assistant_tc_ids):
                    result_messages.append(msg)
                    result_assistant_tc_ids.update(ids)

        return result_messages

    def _truncate_at_sentence(self, content: str, target_length: int) -> str:
        """在句子边界截断"""
        if len(content) <= target_length:
            return content

        # 查找句子结束符
        sentence_endings = ['.', '!', '?', '。', '！', '？', '\n']

        # 在目标长度附近查找句子边界
        search_start = max(0, target_length - 100)
        search_end = min(len(content), target_length + 50)

        best_pos = target_length

        for i in range(search_end - 1, search_start - 1, -1):
            if content[i] in sentence_endings:
                best_pos = i + 1
                break

        return content[:best_pos].strip()

    def _force_truncate(self, content: str, max_tokens: int) -> str:
        """强制截断到指定Token数"""
        if not content:
            return content

        # 二分查找合适的长度
        left, right = 0, len(content)

        while left < right:
            mid = (left + right + 1) // 2
            test_content = content[:mid]

            if self.token_counter.count_tokens(test_content) <= max_tokens:
                left = mid
            else:
                right = mid - 1

        return content[:left].strip()

    @staticmethod
    def _content_sort_key(content) -> str:
        """生成 content 的排序摘要键，兼容 str / list / None。"""
        if content is None:
            return ''
        if isinstance(content, str):
            return content[:50]
        return str(content)[:50]

    def _sort_messages_by_original_order(self, result_messages: List[Dict[str, str]],
                                       original_messages: List[Dict[str, str]]) -> List[Dict[str, str]]:
        """按原始顺序排序消息"""
        original_index = {}
        for i, msg in enumerate(original_messages):
            key = f"{msg.get('role', '')}:{self._content_sort_key(msg.get('content', ''))}"
            if key not in original_index:
                original_index[key] = i

        def get_order(msg):
            key = f"{msg.get('role', '')}:{self._content_sort_key(msg.get('content', ''))}"
            return original_index.get(key, len(original_messages))

        return sorted(result_messages, key=get_order)


class SmartContentPruner(BaseContentPruner):
    """智能内容剪枝器"""

    def __init__(self, provider: str = 'openai', model_name: str = 'gpt-4'):
        self.provider = provider
        self.model_name = model_name
        self.token_counter = get_token_counter(provider, model_name)

        # 重要性关键词
        self.important_keywords = [
            '重要', '关键', '核心', '主要', '必须', '需要', '要求',
            'important', 'key', 'core', 'main', 'must', 'need', 'require'
        ]

        logger.info("初始化智能内容剪枝器: %s/%s", provider, model_name)

    def prune_content(self, content: str, max_tokens: int) -> str:
        """智能剪枝内容"""
        if not content:
            return content

        current_tokens = self.token_counter.count_tokens(content)

        if current_tokens <= max_tokens:
            return content

        # 分析内容结构
        sentences = self._split_sentences(content)
        sentence_scores = self._score_sentences(sentences)

        # 按重要性排序
        scored_sentences = list(zip(sentences, sentence_scores))
        scored_sentences.sort(key=lambda x: x[1], reverse=True)

        # 选择最重要的句子
        selected_sentences = []
        current_tokens = 0

        for sentence, score in scored_sentences:
            sentence_tokens = self.token_counter.count_tokens(sentence)

            if current_tokens + sentence_tokens <= max_tokens:
                selected_sentences.append(sentence)
                current_tokens += sentence_tokens
            else:
                # 尝试截断这个句子
                remaining_tokens = max_tokens - current_tokens
                if remaining_tokens > 10:  # 至少保留10个Token
                    truncated = self._force_truncate(sentence, remaining_tokens)
                    if truncated:
                        selected_sentences.append(truncated)
                break

        # 按原始顺序重新排列
        return self._reorder_sentences(selected_sentences, sentences)

    def prune_messages(self, messages: List[Dict[str, str]], max_tokens: int) -> List[Dict[str, str]]:
        """智能剪枝消息列表"""
        if not messages:
            return messages

        current_tokens = self.token_counter.count_messages_tokens(messages)

        if current_tokens <= max_tokens:
            return messages

        # 计算消息重要性分数
        message_scores = self._score_messages(messages)

        # 保留系统消息（最高优先级）
        system_messages = [(msg, i) for i, msg in enumerate(messages) if msg['role'] == 'system']
        other_messages = [(msg, i, score) for i, (msg, score) in enumerate(zip(messages, message_scores))
                         if msg['role'] != 'system']

        # 计算系统消息Token
        system_tokens = 0
        if system_messages:
            system_only = [msg for msg, _ in system_messages]
            system_tokens = self.token_counter.count_messages_tokens(system_only)

        remaining_tokens = max_tokens - system_tokens

        if remaining_tokens <= 0:
            return [msg for msg, _ in system_messages]

        # 按重要性排序其他消息
        other_messages.sort(key=lambda x: x[2], reverse=True)

        # 选择最重要的消息
        selected_messages = [(msg, idx) for msg, idx in system_messages]
        current_tokens = system_tokens

        for msg, original_idx, score in other_messages:
            msg_tokens = self.token_counter.count_messages_tokens([msg])

            if current_tokens + msg_tokens <= remaining_tokens:
                selected_messages.append((msg, original_idx))
                current_tokens += msg_tokens
            else:
                # 尝试剪枝消息内容
                available_tokens = remaining_tokens - current_tokens
                if available_tokens > 20:  # 至少20个Token才值得保留
                    pruned_content = self.prune_content(msg['content'], available_tokens - 10)  # 留10个Token给格式
                    if pruned_content:
                        pruned_msg = msg.copy()
                        pruned_msg['content'] = pruned_content
                        selected_messages.append((pruned_msg, original_idx))
                break

        # 按原始顺序排序
        selected_messages.sort(key=lambda x: x[1])
        return [msg for msg, _ in selected_messages]

    def _split_sentences(self, content: str) -> List[str]:
        """分割句子"""
        # 使用正则表达式分割句子
        sentence_pattern = r'[.!?。！？\n]+'
        sentences = re.split(sentence_pattern, content)

        # 过滤空句子并保留标点
        result = []
        for sentence in sentences:
            sentence = sentence.strip()
            if sentence:
                result.append(sentence)

        return result

    def _score_sentences(self, sentences: List[str]) -> List[float]:
        """计算句子重要性分数"""
        scores = []

        for sentence in sentences:
            score = 1.0  # 基础分数

            # 长度因子（适中长度的句子更重要）
            length = len(sentence)
            if 20 <= length <= 200:
                score += 0.5
            elif length < 10:
                score -= 0.3

            # 关键词因子
            sentence_lower = sentence.lower()
            for keyword in self.important_keywords:
                if keyword in sentence_lower:
                    score += 0.3

            # 数字和特殊符号因子（可能包含重要信息）
            if re.search(r'\d+', sentence):
                score += 0.2

            if re.search(r'[：:""''「」【】]', sentence):
                score += 0.1

            # 问号句子（可能是重要问题）
            if '?' in sentence or '？' in sentence:
                score += 0.2

            scores.append(score)

        return scores

    def _score_messages(self, messages: List[Dict[str, str]]) -> List[float]:
        """计算消息重要性分数"""
        scores = []

        for i, msg in enumerate(messages):
            score = 1.0

            # 角色因子
            if msg['role'] == 'system':
                score += 2.0  # 系统消息最重要
            elif msg['role'] == 'user':
                score += 1.0  # 用户消息比较重要
            else:  # assistant
                score += 0.5

            # 位置因子（最新的消息更重要）
            position_factor = i / len(messages)
            score += position_factor * 0.5

            # 内容长度因子
            content_length = len(msg['content'])
            if 50 <= content_length <= 500:
                score += 0.3
            elif content_length < 20:
                score -= 0.2

            # 关键词因子
            content_lower = msg['content'].lower()
            for keyword in self.important_keywords:
                if keyword in content_lower:
                    score += 0.2

            scores.append(score)

        return scores

    def _reorder_sentences(self, selected_sentences: List[str], original_sentences: List[str]) -> str:
        """按原始顺序重新排列句子"""
        # 创建原始句子的位置映射
        original_positions = {sentence: i for i, sentence in enumerate(original_sentences)}

        # 为选中的句子分配位置
        sentence_positions = []
        for sentence in selected_sentences:
            # 查找最匹配的原始句子
            best_match = sentence
            best_pos = len(original_sentences)

            for orig_sentence in original_sentences:
                if sentence in orig_sentence or orig_sentence in sentence:
                    pos = original_positions[orig_sentence]
                    if pos < best_pos:
                        best_pos = pos
                        best_match = orig_sentence

            sentence_positions.append((sentence, best_pos))

        # 按位置排序
        sentence_positions.sort(key=lambda x: x[1])

        # 重新组合
        return ' '.join([sentence for sentence, _ in sentence_positions])

    def _force_truncate(self, content: str, max_tokens: int) -> str:
        """强制截断到指定Token数"""
        if not content:
            return content

        left, right = 0, len(content)

        while left < right:
            mid = (left + right + 1) // 2
            test_content = content[:mid]

            if self.token_counter.count_tokens(test_content) <= max_tokens:
                left = mid
            else:
                right = mid - 1

        return content[:left].strip()


class ContentPrunerFactory:
    """内容剪枝器工厂"""

    _pruners = {
        'simple': SimpleContentPruner,
        'smart': SmartContentPruner,
    }

    @classmethod
    def create_pruner(cls, pruner_type: str = 'simple', **kwargs) -> BaseContentPruner:
        """创建内容剪枝器"""
        pruner_type = pruner_type.lower()

        if pruner_type in cls._pruners:
            return cls._pruners[pruner_type](**kwargs)
        else:
            logger.warning("未知剪枝器类型 %s，使用默认剪枝器", pruner_type)
            return SimpleContentPruner(**kwargs)


def get_content_pruner(pruner_type: str = 'simple',
                      provider: str = 'openai',
                      model_name: str = 'gpt-4') -> BaseContentPruner:
    """获取内容剪枝器实例"""
    return ContentPrunerFactory.create_pruner(
        pruner_type=pruner_type,
        provider=provider,
        model_name=model_name
    )


def prune_text(text: str, max_tokens: int,
               pruner_type: str = 'simple',
               provider: str = 'openai',
               model_name: str = 'gpt-4') -> str:
    """快速剪枝文本"""
    pruner = get_content_pruner(pruner_type, provider, model_name)
    return pruner.prune_content(text, max_tokens)


def prune_conversation(messages: List[Dict[str, str]], max_tokens: int,
                      pruner_type: str = 'simple',
                      provider: str = 'openai',
                      model_name: str = 'gpt-4') -> List[Dict[str, str]]:
    """快速剪枝对话"""
    pruner = get_content_pruner(pruner_type, provider, model_name)
    return pruner.prune_messages(messages, max_tokens)
