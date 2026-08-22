"""
统一API文档访问端点
"""

from django.http import HttpRequest, JsonResponse, HttpResponse, Http404
from ninja import Router
from .docs_manager import docs_manager


router = Router()


@router.get("/api-docs", auth=None, tags=["文档"])
def list_api_docs(request: HttpRequest):
    """
    获取所有API文档列表

    ## 功能说明
    返回系统中所有可用的API文档列表，包括文档基本信息和访问链接。

    ## 使用场景
    - AI工具获取可用API文档列表
    - 开发者查看系统API概览
    - 自动化工具发现API文档

    ## 返回信息
    - 文档名称和标题
    - 文档描述和版本
    - 接口数量统计
    - 各种格式的访问链接
    """
    try:
        current_host = request.get_host()
        protocol = 'https' if request.is_secure() else 'http'
        base_url = f"{protocol}://{current_host}"

        docs = docs_manager.get_available_docs()

        # 更新访问链接为完整URL并添加标题信息
        for doc in docs:
            for format_type, path in doc['access_urls'].items():
                doc['access_urls'][format_type] = f"{base_url}{path}"

            # 为AI工具添加带标题的URL信息
            doc['ai_friendly_url'] = {
                'url': f"{base_url}/api/api-docs/{doc['name']}.yaml",
                'title': doc['title'],
                'description': f"获取 {doc['title']} 的完整API文档"
            }

        # 简化的文档信息
        simplified_docs = []
        for doc in docs:
            simplified_docs.append({
                'title': doc['title'],
                'description': doc['description']
            })

        return JsonResponse({
            'message': 'API文档列表获取成功',
            'api_base_url': 'api-preprod.example.com',
            'ai_integration': {
                'description': "AI工具可以通过以下方式获取API文档",
                'steps': [
                    "1. 访问 https://api-preprod.example.com/api/api-docs 获取文档列表",
                    "2. 选择需要的文档，如 https://api-preprod.example.com/api/api-docs/auth.yaml",
                    "3. 获得完整的Swagger 2.0格式API文档",
                    "4. 进行API分析和代码生成"
                ],
                'quick_access': [
                    {
                        'url': f"https://api-preprod.example.com/api/api-docs/{doc['name']}.yaml",
                        'title': doc['title']
                    } for doc in docs
                ]
            }
        }, json_dumps_params={'ensure_ascii': False, 'indent': 2})

    except Exception as e:
        return JsonResponse({
            'success': False,
            'message': f'获取文档列表失败: {str(e)}',
            'code': 500
        }, status=500)


@router.get("/api-docs/{doc_name}.yaml", auth=None, tags=["文档"])
def get_api_doc_json(request: HttpRequest, doc_name: str):
    """
    获取指定API文档的JSON格式内容

    ## 功能说明
    返回指定文档的完整Swagger 2.0格式JSON内容，专门用于AI工具分析。

    ## 路径参数
    - doc_name: 文档名称（如：auth、parse、sms等）

    ## 使用场景
    - 发送给AI工具进行API分析
    - 生成客户端SDK
    - API文档集成

    ## 注意事项
    - 自动适配当前访问域名
    - 返回完整的接口定义
    - 包含所有请求/响应示例
    """
    try:
        current_host = request.get_host()
        doc_content = docs_manager.get_doc_content(doc_name, 'json', current_host)

        if doc_content is None:
            return JsonResponse({
                'success': False,
                'message': f'文档 "{doc_name}" 不存在',
                'available_docs': [doc['name'] for doc in docs_manager.get_available_docs()],
                'code': 404
            }, status=404)

        if isinstance(doc_content, dict) and 'error' in doc_content:
            return JsonResponse({
                'success': False,
                'message': doc_content['error'],
                'code': 500
            }, status=500)

        return JsonResponse(doc_content, json_dumps_params={'ensure_ascii': False, 'indent': 2})

    except Exception as e:
        return JsonResponse({
            'success': False,
            'message': f'获取文档失败: {str(e)}',
            'code': 500
        }, status=500)


@router.get("/api-docs/{doc_name}.yaml/raw", auth=None, tags=["文档"])
def get_api_doc_yaml(request: HttpRequest, doc_name: str):
    """
    获取指定API文档的YAML格式内容

    ## 功能说明
    返回指定文档的原始YAML格式内容。

    ## 路径参数
    - doc_name: 文档名称（如：auth、parse、sms等）

    ## 使用场景
    - 直接下载YAML文件
    - 导入到API文档工具
    - 版本控制和备份
    """
    try:
        current_host = request.get_host()
        doc_content = docs_manager.get_doc_content(doc_name, 'yaml', current_host)

        if doc_content is None:
            return HttpResponse(f'文档 "{doc_name}" 不存在', status=404)

        if isinstance(doc_content, dict) and 'error' in doc_content:
            return HttpResponse(doc_content['error'], status=500)

        response = HttpResponse(doc_content, content_type='text/yaml; charset=utf-8')
        response['Content-Disposition'] = f'attachment; filename="{doc_name}_api.yaml"'
        return response

    except Exception as e:
        return HttpResponse(f'获取文档失败: {str(e)}', status=500)


@router.get("/api-docs/{doc_name}.yaml/info", auth=None, tags=["文档"])
def get_api_doc_info(request: HttpRequest, doc_name: str):
    """
    获取指定API文档的详细信息

    ## 功能说明
    返回指定文档的元信息，包括统计数据和访问链接。

    ## 路径参数
    - doc_name: 文档名称（如：auth、parse、sms等）

    ## 返回信息
    - 文档基本信息
    - 接口统计数据
    - 访问链接
    - AI使用建议
    """
    try:
        current_host = request.get_host()
        doc_info = docs_manager.get_doc_info(doc_name, current_host)

        if doc_info is None:
            return JsonResponse({
                'success': False,
                'message': f'文档 "{doc_name}" 不存在',
                'available_docs': [doc['name'] for doc in docs_manager.get_available_docs()],
                'code': 404
            }, status=404)

        if 'error' in doc_info:
            return JsonResponse({
                'success': False,
                'message': doc_info['error'],
                'code': 500
            }, status=500)

        return JsonResponse({
            'success': True,
            'message': f'{doc_name} API文档信息',
            'data': doc_info,
            'code': 200
        }, json_dumps_params={'ensure_ascii': False, 'indent': 2})

    except Exception as e:
        return JsonResponse({
            'success': False,
            'message': f'获取文档信息失败: {str(e)}',
            'code': 500
        }, status=500)
