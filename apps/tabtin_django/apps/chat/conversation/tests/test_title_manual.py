#!/usr/bin/env python3
"""
标题生成功能测试脚本

直接测试标题生成服务的各项功能
"""

import os
import sys
import django

# 设置Django环境
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'tabtin.settings')
sys.path.insert(0, '/www/wwwroot/tabtin')

try:
    django.setup()
except Exception as e:
    print(f"Django初始化失败: {e}")
    sys.exit(1)

from apps.chat.conversation.services.title_generator import TitleGeneratorService


def test_clean_title():
    """测试标题清理功能"""
    print("\n=== 测试标题清理功能 ===")

    tests = [
        ('\"测试标题\"', '测试标题'),
        ("'Test Title'", 'Test Title'),
        ('"Python编程"', 'Python编程'),
        ('', '新任务'),
        ('  带空格的标题  ', '带空格的标题'),
        ('《机器学习》', '机器学习'),
        ('【深度学习】', '深度学习'),
    ]

    passed = 0
    failed = 0

    for input_title, expected in tests:
        result = TitleGeneratorService._clean_title(input_title)
        if result == expected:
            print(f"✅ PASS: '{input_title}' -> '{result}'")
            passed += 1
        else:
            print(f"❌ FAIL: '{input_title}' -> 期望: '{expected}', 实际: '{result}'")
            failed += 1

    # 测试长度限制
    long_title = "这是一个非常非常非常长的标题" * 5
    result = TitleGeneratorService._clean_title(long_title)
    if len(result) <= 33:  # 30 + "..."
        print(f"✅ PASS: 长度限制测试通过，长度: {len(result)}")
        passed += 1
    else:
        print(f"❌ FAIL: 长度限制测试失败，长度: {len(result)}")
        failed += 1

    print(f"\n测试结果: {passed} 通过, {failed} 失败")
    return failed == 0


def test_build_prompt():
    """测试提示词构建"""
    print("\n=== 测试提示词构建 ===")

    messages = [
        {"role": "user", "content": "你好，我想学习Python编程"},
        {"role": "assistant", "content": "你好！我很高兴帮助你学习Python。你想从哪里开始？"},
        {"role": "user", "content": "从基础语法开始"},
    ]

    prompt_messages = TitleGeneratorService._build_prompt(messages)

    print(f"生成的提示词消息数: {len(prompt_messages)}")
    print(f"系统提示词: {prompt_messages[0]['content'][:50]}...")
    print(f"用户提示词包含原对话: {'你好' in prompt_messages[1]['content']}")

    if len(prompt_messages) == 2 and prompt_messages[0]['role'] == 'system':
        print("✅ PASS: 提示词构建正确")
        return True
    else:
        print("❌ FAIL: 提示词构建失败")
        return False


def test_should_generate_title():
    """测试是否需要生成标题的逻辑"""
    print("\n=== 测试标题生成条件判断 ===")

    from apps.chat.conversation.models import ChatSession, ChatMessage
    from django.contrib.auth import get_user_model

    User = get_user_model()

    try:
        # 创建测试用户（使用唯一的email）
        import uuid
        unique_email = f'test_{uuid.uuid4().hex[:8]}@example.com'
        user, _ = User.objects.get_or_create(
            username=f'test_title_user_{uuid.uuid4().hex[:8]}',
            defaults={'email': unique_email}
        )

        # 测试1：新会话，有消息
        session1 = ChatSession.objects.create(
            user=user,
            organization_id='test-workspace-1',
            title='新对话'
        )
        ChatMessage.objects.create(
            session=session1,
            role='user',
            content='测试消息'
        )

        should_gen1 = TitleGeneratorService.should_generate_title(session1)
        print(f"新会话有消息: {should_gen1} (预期: True)")

        # 测试2：已有标题的会话
        session2 = ChatSession.objects.create(
            user=user,
            organization_id='test-workspace-2',
            title='已有的标题'
        )
        ChatMessage.objects.create(
            session=session2,
            role='user',
            content='测试消息'
        )

        should_gen2 = TitleGeneratorService.should_generate_title(session2)
        print(f"已有标题的会话: {should_gen2} (预期: False)")

        # 清理测试数据
        session1.delete()
        session2.delete()

        if should_gen1 and not should_gen2:
            print("✅ PASS: 标题生成条件判断正确")
            return True
        else:
            print("❌ FAIL: 标题生成条件判断失败")
            return False

    except Exception as e:
        print(f"❌ FAIL: 测试失败 - {e}")
        return False


def test_generate_title_with_model():
    """测试使用实际模型生成标题（可选）"""
    print("\n=== 测试实际标题生成（需要有效的模型） ===")

    try:
        messages = [
            {"role": "user", "content": "你好，我想学习Python编程"},
            {"role": "assistant", "content": "你好！我很高兴帮助你学习Python。你想从哪里开始？"}
        ]

        print("正在调用LLM生成标题...")
        title = TitleGeneratorService.generate_title(messages)

        if title:
            print(f"✅ 成功生成标题: {title}")
            print(f"   标题长度: {len(title)}")
            return True
        else:
            print("⚠️  标题生成返回None（可能模型ID不存在或服务不可用）")
            return None  # 返回None表示跳过此测试

    except Exception as e:
        print(f"⚠️  标题生成异常: {e}")
        print("   这可能是因为模型ID不存在或LLM服务不可用")
        return None


def main():
    """运行所有测试"""
    print("=" * 60)
    print("标题生成服务测试")
    print("=" * 60)

    results = []

    # 运行基础功能测试
    results.append(("标题清理", test_clean_title()))
    results.append(("提示词构建", test_build_prompt()))
    results.append(("生成条件判断", test_should_generate_title()))

    # 运行LLM测试（可选）
    llm_result = test_generate_title_with_model()
    if llm_result is not None:
        results.append(("LLM标题生成", llm_result))

    # 输出总结
    print("\n" + "=" * 60)
    print("测试总结")
    print("=" * 60)

    passed = sum(1 for _, result in results if result)
    total = len(results)

    for name, result in results:
        status = "✅ PASS" if result else "❌ FAIL"
        print(f"{status}: {name}")

    print(f"\n总计: {passed}/{total} 通过")

    if passed == total:
        print("\n🎉 所有测试通过！")
        return 0
    else:
        print(f"\n⚠️  有 {total - passed} 个测试失败")
        return 1


if __name__ == '__main__':
    sys.exit(main())
