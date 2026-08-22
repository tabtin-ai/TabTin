"""
LLM工具测试
"""

from unittest.mock import Mock, patch
from django.test import TestCase
from PIL import Image
import tempfile
import os

from ..utils.token_counter import (
    TikTokenCounter, QwenTokenCounter, ClaudeTokenCounter,
    get_token_counter, calculate_tokens, calculate_messages_tokens
)
from ..utils.context_manager import (
    SimpleContextManager, SlidingWindowContextManager, SummaryContextManager,
    get_context_manager, get_cached_context_manager, clear_context_cache,
    _context_cache, _TTLLRUCache,
)
from ..utils.content_pruner import (
    SimpleContentPruner, SmartContentPruner, get_content_pruner,
    prune_text, prune_conversation
)
from ..utils.image_processor import ImageProcessor, get_image_processor


class TokenCounterTestCase(TestCase):
    """Token计算器测试"""

    def test_tiktoken_counter_init(self):
        """测试TikToken计算器初始化"""
        counter = TikTokenCounter('gpt-4')
        self.assertEqual(counter.model_name, 'gpt-4')

    @patch('tiktoken.encoding_for_model')
    def test_tiktoken_count_tokens(self, mock_encoding):
        """测试TikToken计算"""
        # 模拟tiktoken编码器
        mock_encoder = Mock()
        mock_encoder.encode.return_value = [1, 2, 3, 4, 5]  # 5个token
        mock_encoding.return_value = mock_encoder

        counter = TikTokenCounter('gpt-4')
        counter._encoding = mock_encoder

        tokens = counter.count_tokens("Hello world")
        self.assertEqual(tokens, 5)

    def test_tiktoken_estimate_tokens(self):
        """测试Token估算"""
        counter = TikTokenCounter('gpt-4')
        counter._encoding = None  # 模拟tiktoken不可用

        # 测试英文文本
        english_tokens = counter.count_tokens("Hello world, this is a test.")
        self.assertGreater(english_tokens, 0)

        # 测试中文文本
        chinese_tokens = counter.count_tokens("你好世界，这是一个测试。")
        self.assertGreater(chinese_tokens, 0)

    def test_tiktoken_count_messages(self):
        """测试消息Token计算"""
        counter = TikTokenCounter('gpt-4')

        messages = [
            {'role': 'system', 'content': 'You are a helpful assistant.'},
            {'role': 'user', 'content': 'Hello!'},
            {'role': 'assistant', 'content': 'Hi there!'}
        ]

        tokens = counter.count_messages_tokens(messages)
        self.assertGreater(tokens, 0)

    def test_qwen_counter(self):
        """测试通义千问计算器"""
        counter = QwenTokenCounter('qwen3-coder-flash')

        # 测试中文文本
        chinese_tokens = counter.count_tokens("你好世界")
        self.assertEqual(chinese_tokens, 4)  # 4个中文字符

        # 测试英文文本
        english_tokens = counter.count_tokens("hello world")
        self.assertGreater(english_tokens, 0)

    def test_claude_counter(self):
        """测试Claude计算器"""
        counter = ClaudeTokenCounter('claude-3-sonnet')

        tokens = counter.count_tokens("Hello world")
        self.assertGreater(tokens, 0)

    def test_get_token_counter(self):
        """测试获取Token计算器"""
        # OpenAI
        openai_counter = get_token_counter('openai', 'gpt-4')
        self.assertIsInstance(openai_counter, TikTokenCounter)

        # 通义千问
        qwen_counter = get_token_counter('qwen', 'qwen3-coder-flash')
        self.assertIsInstance(qwen_counter, QwenTokenCounter)

        # Claude
        claude_counter = get_token_counter('claude', 'claude-3-sonnet')
        self.assertIsInstance(claude_counter, ClaudeTokenCounter)

        # 未知提供商（应该返回默认）
        unknown_counter = get_token_counter('unknown', 'unknown-model')
        self.assertIsInstance(unknown_counter, TikTokenCounter)

    def test_calculate_tokens_function(self):
        """测试快速计算函数"""
        tokens = calculate_tokens("Hello world")
        self.assertGreater(tokens, 0)

    def test_calculate_messages_tokens_function(self):
        """测试快速消息计算函数"""
        messages = [
            {'role': 'user', 'content': 'Hello'},
            {'role': 'assistant', 'content': 'Hi there!'}
        ]

        tokens = calculate_messages_tokens(messages)
        self.assertGreater(tokens, 0)


class ContextManagerTestCase(TestCase):
    """上下文管理器测试"""

    def test_simple_context_manager(self):
        """测试简单上下文管理器"""
        manager = SimpleContextManager(max_messages=5)

        # 添加消息
        manager.add_message({'role': 'user', 'content': 'Hello'})
        manager.add_message({'role': 'assistant', 'content': 'Hi there!'})

        context = manager.get_context()
        self.assertEqual(len(context), 2)
        self.assertEqual(context[0]['role'], 'user')
        self.assertEqual(context[1]['role'], 'assistant')

    def test_simple_context_manager_limit(self):
        """测试简单上下文管理器消息限制"""
        manager = SimpleContextManager(max_messages=3)

        # 添加系统消息
        manager.add_message({'role': 'system', 'content': 'You are helpful.'})

        # 添加超过限制的消息
        for i in range(5):
            manager.add_message({'role': 'user', 'content': f'Message {i}'})

        context = manager.get_context()

        # 应该保留系统消息和最新的用户消息
        self.assertLessEqual(len(context), 3)

        # 系统消息应该被保留
        system_messages = [msg for msg in context if msg['role'] == 'system']
        self.assertEqual(len(system_messages), 1)

    def test_context_manager_token_limit(self):
        """测试Token限制"""
        manager = SimpleContextManager()

        # 添加一些消息
        manager.add_message({'role': 'user', 'content': 'Short message'})
        manager.add_message({'role': 'assistant', 'content': 'Another short message'})

        # 获取有Token限制的上下文
        context = manager.get_context(max_tokens=50)

        # 应该返回部分消息
        self.assertGreaterEqual(len(context), 0)

    def test_sliding_window_context_manager(self):
        """测试滑动窗口上下文管理器"""
        manager = SlidingWindowContextManager(window_size=3, overlap_size=1)

        # 添加消息
        for i in range(5):
            manager.add_message({'role': 'user', 'content': f'Message {i}'})

        context = manager.get_context()

        # 应该只保留窗口大小的消息
        self.assertLessEqual(len(context), 3)

    def test_summary_context_manager(self):
        """测试摘要式上下文管理器"""
        manager = SummaryContextManager(max_messages=10, summary_threshold=5)

        # 添加消息直到触发摘要
        for i in range(8):
            manager.add_message({'role': 'user', 'content': f'Message {i}'})
            manager.add_message({'role': 'assistant', 'content': f'Response {i}'})

        # 检查是否生成了摘要
        info = manager.get_context_info()
        self.assertIsNotNone(manager.summary)

    def test_context_manager_clear(self):
        """测试清空上下文"""
        manager = SimpleContextManager()

        manager.add_message({'role': 'user', 'content': 'Hello'})
        self.assertEqual(len(manager.get_context()), 1)

        manager.clear_context()
        self.assertEqual(len(manager.get_context()), 0)

    def test_get_context_manager_factory(self):
        """测试上下文管理器工厂"""
        # 简单管理器
        simple_manager = get_context_manager('simple')
        self.assertIsInstance(simple_manager, SimpleContextManager)

        # 滑动窗口管理器
        sliding_manager = get_context_manager('sliding')
        self.assertIsInstance(sliding_manager, SlidingWindowContextManager)

        # 摘要管理器
        summary_manager = get_context_manager('summary')
        self.assertIsInstance(summary_manager, SummaryContextManager)


class ClaudeImageTokenRegressionTestCase(TestCase):
    """FAC-5 回归测试：ClaudeTokenCounter 不应对 base64 图片 str() 后按字符估 token"""

    def setUp(self):
        self.counter = ClaudeTokenCounter('claude-3-sonnet')
        self.fake_b64 = 'A' * 133_000  # ~100KB base64

    def test_base64_image_not_counted_as_text(self):
        """100KB base64 图片不应计为 ~34,000 tokens"""
        messages = [{
            'role': 'user',
            'content': [
                {'type': 'text', 'text': 'Describe this image'},
                {
                    'type': 'image',
                    'source': {
                        'type': 'base64',
                        'media_type': 'image/jpeg',
                        'data': self.fake_b64,
                    }
                }
            ]
        }]
        tokens = self.counter.count_messages_tokens(messages)
        self.assertLess(tokens, 6_000,
                        "100KB base64 图片 token 应远小于旧实现的 ~34,000")

    def test_openai_compat_image_url_format(self):
        """OpenAI 兼容的 data:base64 URL 格式应正确估算"""
        messages = [{
            'role': 'user',
            'content': [
                {'type': 'text', 'text': 'What is this?'},
                {
                    'type': 'image_url',
                    'image_url': {
                        'url': f'data:image/png;base64,{self.fake_b64}'
                    }
                }
            ]
        }]
        tokens = self.counter.count_messages_tokens(messages)
        self.assertLess(tokens, 6_000)
        self.assertGreater(tokens, 50)

    def test_image_tokens_bounded(self):
        """图片 token 应在合理范围 [85, 5000] 内"""
        item = {
            'type': 'image',
            'source': {'type': 'base64', 'media_type': 'image/jpeg',
                       'data': self.fake_b64}
        }
        tokens = ClaudeTokenCounter._calculate_image_tokens(item)
        self.assertGreaterEqual(tokens, 85)
        self.assertLessEqual(tokens, 5_000)

    def test_no_base64_data_returns_default(self):
        """无 base64 数据时应返回默认值"""
        from ..utils.token_counter import CLAUDE_IMAGE_TOKENS_DEFAULT
        item = {'type': 'image_url', 'image_url': {'url': 'https://example.com/img.jpg'}}
        tokens = ClaudeTokenCounter._calculate_image_tokens(item)
        self.assertEqual(tokens, CLAUDE_IMAGE_TOKENS_DEFAULT)

    def test_non_image_dict_items_not_inflated(self):
        """非图片类型 dict 条目不应被 str() 膨胀"""
        messages = [{
            'role': 'user',
            'content': [
                {'type': 'text', 'text': 'hello'},
                {'type': 'unknown_type', 'text': 'some data'},
            ]
        }]
        tokens = self.counter.count_messages_tokens(messages)
        self.assertLess(tokens, 100)


class ContextCacheTTLLRUTestCase(TestCase):
    """FAC-6 回归测试：_context_cache 必须有界、有 TTL、有 LRU"""

    def test_cache_has_max_size(self):
        """缓存应有上限，超出后自动驱逐最老条目"""
        cache = _TTLLRUCache(max_size=3, ttl=3600)
        cache.set('a', 1)
        cache.set('b', 2)
        cache.set('c', 3)
        cache.set('d', 4)  # 应驱逐 'a'
        self.assertIsNone(cache.get('a'))
        self.assertEqual(cache.get('d'), 4)
        self.assertEqual(len(cache), 3)

    def test_cache_ttl_expiry(self):
        """条目超过 TTL 后应被视为失效"""
        cache = _TTLLRUCache(max_size=100, ttl=0.01)
        cache.set('key', 'value')
        import time
        time.sleep(0.02)
        self.assertIsNone(cache.get('key'))

    def test_cache_lru_promotion(self):
        """访问条目应将其提升为最新，防止被误驱逐"""
        cache = _TTLLRUCache(max_size=3, ttl=3600)
        cache.set('a', 1)
        cache.set('b', 2)
        cache.set('c', 3)
        cache.get('a')  # 提升 'a'
        cache.set('d', 4)  # 应驱逐 'b'（最老）
        self.assertEqual(cache.get('a'), 1)
        self.assertIsNone(cache.get('b'))

    def test_remove_prefix(self):
        """按前缀删除应正确工作"""
        cache = _TTLLRUCache(max_size=100, ttl=3600)
        cache.set('session1:simple:openai:gpt-4', 'mgr1')
        cache.set('session1:sliding:openai:gpt-4', 'mgr2')
        cache.set('session2:simple:openai:gpt-4', 'mgr3')
        removed = cache.remove_prefix('session1:')
        self.assertEqual(removed, 2)
        self.assertIsNone(cache.get('session1:simple:openai:gpt-4'))
        self.assertEqual(cache.get('session2:simple:openai:gpt-4'), 'mgr3')

    def test_clear(self):
        """clear 应清空所有条目"""
        cache = _TTLLRUCache(max_size=100, ttl=3600)
        cache.set('a', 1)
        cache.set('b', 2)
        cache.clear()
        self.assertEqual(len(cache), 0)

    def test_global_cache_is_bounded(self):
        """全局 _context_cache 应是 _TTLLRUCache 实例"""
        self.assertIsInstance(_context_cache, _TTLLRUCache)

    def test_get_cached_context_manager_returns_same_instance(self):
        """同一 session 多次调用应返回同一个 manager"""
        clear_context_cache()
        mgr1 = get_cached_context_manager('test-session-dedup')
        mgr2 = get_cached_context_manager('test-session-dedup')
        self.assertIs(mgr1, mgr2)
        clear_context_cache()

    def test_clear_context_cache_by_session(self):
        """clear_context_cache(session_id) 应只清除该 session"""
        clear_context_cache()
        get_cached_context_manager('sess-a')
        get_cached_context_manager('sess-b')
        clear_context_cache('sess-a')
        mgr_b = _context_cache.get('sess-b:simple:openai:gpt-4')
        self.assertIsNotNone(mgr_b)
        mgr_a = _context_cache.get('sess-a:simple:openai:gpt-4')
        self.assertIsNone(mgr_a)
        clear_context_cache()

    def test_cache_does_not_grow_unbounded(self):
        """压力测试：插入远超上限的条目，缓存大小不应超过 max_size"""
        cache = _TTLLRUCache(max_size=50, ttl=3600)
        for i in range(200):
            cache.set(f'key-{i}', i)
        self.assertLessEqual(len(cache), 50)


class ContentPrunerTestCase(TestCase):
    """内容剪枝器测试"""

    def test_simple_content_pruner(self):
        """测试简单内容剪枝器"""
        pruner = SimpleContentPruner()

        # 测试短文本（不需要剪枝）
        short_text = "Hello world"
        result = pruner.prune_content(short_text, 100)
        self.assertEqual(result, short_text)

        # 测试长文本（需要剪枝）
        long_text = "This is a very long text that needs to be pruned. " * 20
        result = pruner.prune_content(long_text, 50)
        self.assertLess(len(result), len(long_text))

    def test_simple_pruner_messages(self):
        """测试简单剪枝器消息处理"""
        pruner = SimpleContentPruner()

        messages = [
            {'role': 'system', 'content': 'You are helpful.'},
            {'role': 'user', 'content': 'Hello'},
            {'role': 'assistant', 'content': 'Hi there!'},
            {'role': 'user', 'content': 'How are you?'},
            {'role': 'assistant', 'content': 'I am fine, thank you!'}
        ]

        # 剪枝到较小的Token数
        result = pruner.prune_messages(messages, 30)

        # 应该保留系统消息
        system_messages = [msg for msg in result if msg['role'] == 'system']
        self.assertEqual(len(system_messages), 1)

        # 总消息数应该减少
        self.assertLessEqual(len(result), len(messages))

    def test_smart_content_pruner(self):
        """测试智能内容剪枝器"""
        pruner = SmartContentPruner()

        # 包含重要关键词的文本
        important_text = "This is very important information. This is less important. Key point here."
        result = pruner.prune_content(important_text, 30)

        # 应该保留重要信息
        self.assertIn("important", result.lower())

    def test_smart_pruner_sentence_scoring(self):
        """测试智能剪枝器句子评分"""
        pruner = SmartContentPruner()

        sentences = [
            "This is important information.",
            "Random text here.",
            "Key details: 123 items.",
            "Another sentence."
        ]

        scores = pruner._score_sentences(sentences)

        # 包含"important"的句子应该有更高分数
        important_score = scores[0]
        random_score = scores[1]
        self.assertGreater(important_score, random_score)

    def test_get_content_pruner_factory(self):
        """测试内容剪枝器工厂"""
        # 简单剪枝器
        simple_pruner = get_content_pruner('simple')
        self.assertIsInstance(simple_pruner, SimpleContentPruner)

        # 智能剪枝器
        smart_pruner = get_content_pruner('smart')
        self.assertIsInstance(smart_pruner, SmartContentPruner)

    def test_prune_text_function(self):
        """测试快速剪枝函数"""
        text = "This is a test text that might be too long."
        result = prune_text(text, 20)
        self.assertLessEqual(len(result), len(text))

    def test_prune_conversation_function(self):
        """测试快速对话剪枝函数"""
        messages = [
            {'role': 'user', 'content': 'Hello'},
            {'role': 'assistant', 'content': 'Hi there!'},
            {'role': 'user', 'content': 'How are you?'}
        ]

        result = prune_conversation(messages, 20)
        self.assertLessEqual(len(result), len(messages))


class ImageProcessorTestCase(TestCase):
    """图片处理器测试"""

    def setUp(self):
        """设置测试数据"""
        self.processor = ImageProcessor()

        # 创建临时测试图片
        self.temp_dir = tempfile.mkdtemp()
        self.test_image_path = os.path.join(self.temp_dir, 'test.jpg')

        # 创建一个简单的测试图片
        image = Image.new('RGB', (100, 100), color='red')
        image.save(self.test_image_path, 'JPEG')

    def tearDown(self):
        """清理测试数据"""
        if os.path.exists(self.test_image_path):
            os.remove(self.test_image_path)
        os.rmdir(self.temp_dir)

    def test_validate_image_success(self):
        """测试图片验证成功"""
        result = self.processor.validate_image(self.test_image_path)

        self.assertTrue(result['valid'])
        self.assertIsNone(result['error'])
        self.assertIn('size', result['file_info'])
        self.assertIn('mime_type', result['file_info'])
        self.assertIn('width', result['file_info'])
        self.assertIn('height', result['file_info'])

    def test_validate_image_not_found(self):
        """测试图片文件不存在"""
        result = self.processor.validate_image('/nonexistent/path.jpg')

        self.assertFalse(result['valid'])
        self.assertIn('文件不存在', result['error'])

    def test_validate_image_too_large(self):
        """测试图片文件过大"""
        # 临时设置较小的文件大小限制
        original_limit = self.processor.max_file_size
        self.processor.max_file_size = 100  # 100字节

        try:
            result = self.processor.validate_image(self.test_image_path)
            self.assertFalse(result['valid'])
            self.assertIn('文件大小超过限制', result['error'])
        finally:
            self.processor.max_file_size = original_limit

    def test_calculate_image_tokens(self):
        """测试图片Token计算"""
        file_info = {
            'width': 512,
            'height': 512,
            'size': 1024 * 1024
        }

        tokens = self.processor.calculate_image_tokens(file_info)

        # 应该返回合理的Token数量
        self.assertGreater(tokens, 0)
        self.assertIsInstance(tokens, int)

    def test_calculate_image_tokens_small_image(self):
        """测试小图片Token计算"""
        file_info = {
            'width': 50,
            'height': 50,
            'size': 1024
        }

        tokens = self.processor.calculate_image_tokens(file_info)

        # 小图片应该返回基础Token数
        self.assertEqual(tokens, 85)

    @patch('PIL.Image.open')
    def test_compress_image(self, mock_open):
        """测试图片压缩"""
        # 模拟PIL图片对象
        mock_image = Mock()
        mock_image.mode = 'RGB'
        mock_image.size = (2048, 2048)
        mock_image.resize.return_value = mock_image

        mock_open.return_value.__enter__.return_value = mock_image

        # 测试压缩
        compressed_path = self.processor.compress_image(
            self.test_image_path,
            max_size=1024*1024,
            max_width=1024,
            max_height=1024
        )

        # 应该返回压缩后的路径
        self.assertIsInstance(compressed_path, str)

    def test_get_image_processor(self):
        """测试获取图片处理器"""
        processor = get_image_processor()
        self.assertIsInstance(processor, ImageProcessor)
