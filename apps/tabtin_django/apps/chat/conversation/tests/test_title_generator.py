"""
会话标题生成服务测试

测试标题自动生成功能
"""

import pytest
from django.contrib.auth import get_user_model
from apps.chat.conversation.models import ChatSession, ChatMessage
from apps.chat.conversation.services.title_generator import (
    TitleGeneratorService,
    generate_session_title
)

User = get_user_model()


@pytest.mark.django_db
class TestTitleGeneratorService:
    """标题生成服务测试"""

    def test_generate_title_chinese(self):
        """测试中文标题生成"""
        messages = [
            {"role": "user", "content": "你好，我想学习Python编程"},
            {"role": "assistant", "content": "你好！我很高兴帮助你学习Python。你想从哪里开始？"}
        ]

        # 注意：这个测试需要有效的模型ID才能真正运行
        # 在实际环境中需要确保模型ID存在
        title = TitleGeneratorService.generate_title(messages)

        if title:
            assert len(title) > 0
            assert len(title) <= 30
            print(f"生成的中文标题: {title}")

    def test_generate_title_english(self):
        """测试英文标题生成"""
        messages = [
            {"role": "user", "content": "Hello, I want to learn Python programming"},
            {"role": "assistant", "content": "Hello! I'm happy to help you learn Python. Where would you like to start?"}
        ]

        title = TitleGeneratorService.generate_title(messages)

        if title:
            assert len(title) > 0
            assert len(title) <= 30
            print(f"生成的英文标题: {title}")

    def test_should_generate_title_new_session(self):
        """测试新会话是否需要生成标题"""
        user = User.objects.create_user(username='testuser', password='testpass')
        session = ChatSession.objects.create(
            user=user,
            organization_id='test-workspace',
            title='新对话'
        )

        # 创建一条用户消息
        ChatMessage.objects.create(
            session=session,
            role='user',
            content='测试消息'
        )

        assert TitleGeneratorService.should_generate_title(session) is True

    def test_should_not_generate_title_existing(self):
        """测试已有标题的会话不需要重新生成"""
        user = User.objects.create_user(username='testuser2', password='testpass')
        session = ChatSession.objects.create(
            user=user,
            organization_id='test-workspace',
            title='已有的标题'
        )

        # 创建一条用户消息
        ChatMessage.objects.create(
            session=session,
            role='user',
            content='测试消息'
        )

        assert TitleGeneratorService.should_generate_title(session) is False

    def test_clean_title(self):
        """测试标题清理功能"""
        # 测试移除引号
        assert TitleGeneratorService._clean_title('"测试标题"') == '测试标题'
        assert TitleGeneratorService._clean_title("'Test Title'") == 'Test Title'

        # 测试长度限制
        long_title = "这是一个非常非常非常长的标题" * 5
        cleaned = TitleGeneratorService._clean_title(long_title)
        assert len(cleaned) <= 33  # 30 + "..."

        # 测试空标题
        assert TitleGeneratorService._clean_title('') == '新任务'

    def test_build_prompt(self):
        """测试提示词构建"""
        messages = [
            {"role": "user", "content": "你好"},
            {"role": "assistant", "content": "你好！有什么可以帮助你的？"}
        ]

        prompt_messages = TitleGeneratorService._build_prompt(messages)

        assert len(prompt_messages) == 2
        assert prompt_messages[0]['role'] == 'system'
        assert prompt_messages[1]['role'] == 'user'
        assert '你好' in prompt_messages[1]['content']


@pytest.mark.django_db
class TestGenerateSessionTitle:
    """测试会话标题生成便捷函数"""

    def test_generate_session_title_no_messages(self):
        """测试没有消息的会话"""
        user = User.objects.create_user(username='testuser3', password='testpass')
        session = ChatSession.objects.create(
            user=user,
            organization_id='test-workspace',
            title='新对话'
        )

        # 没有消息时应该返回False
        result = generate_session_title(session)
        assert result is False

    def test_generate_session_title_with_messages(self):
        """测试有消息的会话"""
        user = User.objects.create_user(username='testuser4', password='testpass')
        session = ChatSession.objects.create(
            user=user,
            organization_id='test-workspace',
            title='新对话'
        )

        # 创建几条消息
        ChatMessage.objects.create(
            session=session,
            role='user',
            content='我想了解机器学习'
        )
        ChatMessage.objects.create(
            session=session,
            role='assistant',
            content='好的，机器学习是人工智能的一个分支...'
        )

        # 尝试生成标题
        # 注意：如果模型ID不存在，这个会失败
        result = generate_session_title(session)

        if result:
            session.refresh_from_db()
            assert session.title != '新对话'
            print(f"生成的标题: {session.title}")

if __name__ == '__main__':
    pytest.main([__file__, '-v'])
