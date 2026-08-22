#!/usr/bin/env python3
"""
LLM服务使用示例
"""

import os
import sys
import django

# 设置Django环境
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'tabtin.settings')
django.setup()

from apps.services.llm.utils import (
    get_token_counter, get_context_manager, get_content_pruner, get_image_processor
)


def example_token_counting():
    """Token计算示例"""
    print("=== Token计算示例 ===")

    # 获取Token计算器
    counter = get_token_counter('openai', 'gpt-4')

    # 计算文本Token
    text = "Hello, how are you today?"
    tokens = counter.count_tokens(text)
    print(f"文本: '{text}'")
    print(f"Token数量: {tokens}")

    # 计算消息Token
    messages = [
        {'role': 'system', 'content': 'You are a helpful assistant.'},
        {'role': 'user', 'content': 'What is the weather like?'},
        {'role': 'assistant', 'content': 'I cannot access real-time weather data.'}
    ]

    message_tokens = counter.count_messages_tokens(messages)
    print(f"消息Token数量: {message_tokens}")
    print()


def example_context_management():
    """上下文管理示例"""
    print("=== 上下文管理示例 ===")

    # 创建上下文管理器
    manager = get_context_manager('simple', max_messages=10)

    # 添加系统消息
    manager.add_message({
        'role': 'system',
        'content': 'You are a helpful AI assistant.'
    })

    # 模拟对话
    conversations = [
        ('user', 'Hello, what can you help me with?'),
        ('assistant', 'I can help you with various tasks like answering questions, writing, and problem-solving.'),
        ('user', 'Can you explain quantum computing?'),
        ('assistant', 'Quantum computing uses quantum mechanical phenomena to process information...'),
        ('user', 'That\'s interesting. What about AI?'),
        ('assistant', 'Artificial Intelligence involves creating systems that can perform tasks requiring human intelligence...')
    ]

    for role, content in conversations:
        manager.add_message({'role': role, 'content': content})

    # 获取上下文
    context = manager.get_context()
    print(f"当前上下文消息数量: {len(context)}")

    # 获取上下文信息
    info = manager.get_context_info()
    print(f"上下文统计: {info}")

    # 获取Token限制的上下文
    limited_context = manager.get_context(max_tokens=100)
    print(f"Token限制后消息数量: {len(limited_context)}")
    print()


def example_content_pruning():
    """内容剪枝示例"""
    print("=== 内容剪枝示例 ===")

    # 获取内容剪枝器
    pruner = get_content_pruner('smart')

    # 长文本剪枝
    long_text = """
    This is a very important document about artificial intelligence and machine learning.
    It contains key information about neural networks, deep learning, and natural language processing.
    The document also discusses various algorithms and their applications in real-world scenarios.
    There are many technical details that might not be as important for a general overview.
    However, the core concepts and main ideas should be preserved during any summarization process.
    """

    print("原始文本长度:", len(long_text))
    pruned_text = pruner.prune_content(long_text.strip(), max_tokens=50)
    print("剪枝后文本长度:", len(pruned_text))
    print("剪枝后内容:", pruned_text)

    # 消息剪枝
    messages = [
        {'role': 'system', 'content': 'You are an AI assistant specialized in technology.'},
        {'role': 'user', 'content': 'What is machine learning?'},
        {'role': 'assistant', 'content': 'Machine learning is a subset of AI that enables computers to learn without explicit programming.'},
        {'role': 'user', 'content': 'Can you give me some examples?'},
        {'role': 'assistant', 'content': 'Sure! Examples include image recognition, natural language processing, recommendation systems, and autonomous vehicles.'},
        {'role': 'user', 'content': 'How does neural network work?'},
        {'role': 'assistant', 'content': 'Neural networks are inspired by biological neurons and consist of interconnected nodes that process information.'}
    ]

    print(f"\n原始消息数量: {len(messages)}")
    pruned_messages = pruner.prune_messages(messages, max_tokens=80)
    print(f"剪枝后消息数量: {len(pruned_messages)}")

    for i, msg in enumerate(pruned_messages):
        print(f"{i+1}. {msg['role']}: {msg['content'][:50]}...")
    print()


def example_image_processing():
    """图片处理示例"""
    print("=== 图片处理示例 ===")

    # 获取图片处理器
    processor = get_image_processor()

    # 模拟图片信息
    image_info_large = {
        'width': 1920,
        'height': 1080,
        'size': 2 * 1024 * 1024  # 2MB
    }

    image_info_small = {
        'width': 256,
        'height': 256,
        'size': 64 * 1024  # 64KB
    }

    # 计算Token
    large_tokens = processor.calculate_image_tokens(image_info_large)
    small_tokens = processor.calculate_image_tokens(image_info_small)

    print(f"大图片 (1920x1080): {large_tokens} tokens")
    print(f"小图片 (256x256): {small_tokens} tokens")

    print("图片处理器功能验证完成")
    print()


def example_integrated_workflow():
    """集成工作流示例"""
    print("=== 集成工作流示例 ===")

    # 1. 初始化组件
    token_counter = get_token_counter('openai', 'gpt-4')
    context_manager = get_context_manager('simple', max_messages=20)
    content_pruner = get_content_pruner('smart')

    # 2. 设置系统提示
    system_prompt = "You are a helpful AI assistant that provides concise and accurate information."
    context_manager.add_message({'role': 'system', 'content': system_prompt})

    # 3. 模拟用户交互
    user_queries = [
        "What is artificial intelligence?",
        "How does machine learning differ from traditional programming?",
        "Can you explain neural networks in simple terms?",
        "What are the applications of AI in healthcare?",
        "How do we ensure AI safety and ethics?"
    ]

    for query in user_queries:
        # 添加用户消息
        context_manager.add_message({'role': 'user', 'content': query})

        # 模拟AI响应
        response = f"This is a detailed response to: {query}. " * 5  # 模拟长响应
        context_manager.add_message({'role': 'assistant', 'content': response})

    # 4. 获取当前上下文
    full_context = context_manager.get_context()
    print(f"完整对话消息数: {len(full_context)}")

    # 5. 计算Token使用
    total_tokens = token_counter.count_messages_tokens(full_context)
    print(f"总Token数: {total_tokens}")

    # 6. 如果Token过多，进行剪枝
    if total_tokens > 200:
        print("Token数量过多，进行剪枝...")
        pruned_context = content_pruner.prune_messages(full_context, max_tokens=200)
        pruned_tokens = token_counter.count_messages_tokens(pruned_context)
        print(f"剪枝后消息数: {len(pruned_context)}")
        print(f"剪枝后Token数: {pruned_tokens}")

    # 7. 获取上下文统计
    context_info = context_manager.get_context_info()
    print(f"上下文统计: {context_info}")

    print("集成工作流演示完成")


def main():
    """主函数"""
    print("🚀 LLM服务使用示例\n")

    try:
        example_token_counting()
        example_context_management()
        example_content_pruning()
        example_image_processing()
        example_integrated_workflow()

        print("\n✅ 所有示例运行完成！")

    except Exception as e:
        print(f"❌ 示例运行出错: {e}")
        import traceback
        traceback.print_exc()


if __name__ == '__main__':
    main()
