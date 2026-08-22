#!/usr/bin/env python
"""
模型配置验证脚本
验证GPT-4o和qwen3-coder-flash模型的配置和连接
"""

import os
import sys
import django
from pathlib import Path

# 添加项目根目录到Python路径
BASE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE_DIR))

# 设置Django环境
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'tabtin.settings')
django.setup()

from apps.services.llm.services import get_llm_service, get_available_models
from django.conf import settings
import logging

# 设置日志级别
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

def test_openai_gpt4o():
    """测试GPT-4o模型"""
    print("🔍 测试GPT-4o模型配置...")

    try:
        # 临时切换到OpenAI服务
        original_service = getattr(settings, 'LLM_SERVICE', 'qwen')
        settings.LLM_SERVICE = 'openai'

        # 检查配置
        api_key = getattr(settings, 'OPENAI_API_KEY', None)
        base_url = getattr(settings, 'OPENAI_BASE_URL', None)
        model = getattr(settings, 'OPENAI_MODEL', None)

        print(f"   - API Key: {'已配置' if api_key else '未配置'}")
        print(f"   - Base URL: {base_url}")
        print(f"   - Model: {model}")

        if not api_key:
            print("❌ OpenAI API Key未配置")
            return False

        # 尝试创建服务实例
        service = get_llm_service()
        print("✅ GPT-4o服务实例创建成功")

        # 测试简单调用
        test_prompt = "请返回一个简单的JSON对象，包含message字段，内容为'Hello from GPT-4o'"

        print("   正在测试API调用...")
        response = service.call_llm_for_json(test_prompt)

        if isinstance(response, dict) and 'message' in response:
            print("✅ GPT-4o API调用成功")
            print(f"   响应: {response.get('message', 'N/A')}")
            return True
        else:
            print(f"❌ GPT-4o API响应格式异常: {response}")
            return False

    except Exception as e:
        print(f"❌ GPT-4o测试失败: {str(e)}")
        return False
    finally:
        # 恢复原始配置
        settings.LLM_SERVICE = original_service

def test_qwen_coder_flash():
    """测试qwen3-coder-flash模型"""
    print("🔍 测试qwen3-coder-flash模型配置...")

    try:
        # 临时切换到Qwen服务
        original_service = getattr(settings, 'LLM_SERVICE', 'qwen')
        settings.LLM_SERVICE = 'qwen'

        # 检查配置
        api_key = getattr(settings, 'QWEN_API_KEY', None)
        base_url = getattr(settings, 'QWEN_BASE_URL', None)
        model = getattr(settings, 'QWEN_MODEL', None)

        print(f"   - API Key: {'已配置' if api_key else '未配置'}")
        print(f"   - Base URL: {base_url}")
        print(f"   - Model: {model}")
        print(f"   - 兼容模式: {'是' if 'compatible-mode' in base_url else '否'}")

        if not api_key:
            print("❌ Qwen API Key未配置")
            return False

        # 尝试创建服务实例
        service = get_llm_service()
        print("✅ qwen3-coder-flash服务实例创建成功")

        # 测试简单调用
        test_prompt = "请返回一个简单的JSON对象，包含message字段，内容为'Hello from qwen3-coder-flash'"

        print("   正在测试API调用...")
        response = service.call_llm_for_json(test_prompt)

        if isinstance(response, dict) and 'message' in response:
            print("✅ qwen3-coder-flash API调用成功")
            print(f"   响应: {response.get('message', 'N/A')}")
            return True
        else:
            print(f"❌ qwen3-coder-flash API响应格式异常: {response}")
            return False

    except Exception as e:
        print(f"❌ qwen3-coder-flash测试失败: {str(e)}")
        return False
    finally:
        # 恢复原始配置
        settings.LLM_SERVICE = original_service

def test_schema_generation():
    """测试Schema生成功能"""
    print("🔍 测试Schema生成功能...")

    try:
        from apps.parse.schema_services.generators import SchemaGenerationService

        service = SchemaGenerationService()

        test_html = """
        <div class="product-list">
            <div class="product-item">
                <h2 class="product-title">iPhone 15 Pro</h2>
                <span class="price">￥8999</span>
                <div class="rating">4.8分</div>
            </div>
        </div>
        """

        result = service.execute(
            skeleton_html=test_html,
            user_instruction="提取商品信息，包括名称、价格和评分",
            core_content_selector=".product-list"
        )

        print("✅ Schema生成测试成功")
        print(f"   - 列表选择器: {result.get('list_selector', 'N/A')}")
        print(f"   - 字段数量: {len(result.get('fields', []))}")
        print(f"   - 置信度: {result.get('confidence', 0):.2f}")
        print(f"   - 生成时间: {result.get('generation_time', 0)}ms")

        return True

    except Exception as e:
        print(f"❌ Schema生成测试失败: {str(e)}")
        return False

def main():
    """主验证函数"""
    print("🚀 开始验证模型配置")
    print("=" * 60)

    # 显示当前配置
    print("📋 当前配置:")
    print(f"   - 默认LLM服务: {getattr(settings, 'LLM_SERVICE', 'N/A')}")

    # 显示可用服务
    print("\n📋 可用服务列表:")
    services = get_available_models()
    for service in services:
        status = "✅" if service.get('available') else "❌"
        model = service.get('model', 'N/A')
        service_type = service.get('type', 'unknown')
        reason = service.get('reason', '')
        print(f"   {status} {service_type}: {model} {reason}")

    print("\n" + "=" * 60)

    tests = [
        ("GPT-4o模型", test_openai_gpt4o),
        ("qwen3-coder-flash模型", test_qwen_coder_flash),
        ("Schema生成功能", test_schema_generation),
    ]

    passed = 0
    total = len(tests)

    for test_name, test_func in tests:
        print(f"\n📋 {test_name}")
        print("-" * 40)

        if test_func():
            passed += 1

        print()

    print("=" * 60)
    print(f"🎯 验证结果: {passed}/{total} 通过")

    if passed == total:
        print("🎉 所有模型配置验证通过！")
        sys.exit(0)
    else:
        print("⚠️  部分验证失败，请检查配置")
        sys.exit(1)

if __name__ == "__main__":
    main()
