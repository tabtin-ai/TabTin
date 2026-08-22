"""
API文档管理系统
"""

import os
import yaml
import json
from typing import Dict, List, Optional
from django.conf import settings
from django.http import JsonResponse, HttpResponse
from django.utils import timezone


class APIDocsManager:
    """API文档管理器"""

    def __init__(self):
        self.docs_dir = os.path.join(settings.BASE_DIR, 'docs', 'api')
        self.ensure_docs_dir()

    def ensure_docs_dir(self):
        """确保文档目录存在"""
        if not os.path.exists(self.docs_dir):
            os.makedirs(self.docs_dir, exist_ok=True)

    def get_available_docs(self) -> List[Dict]:
        """获取所有可用的API文档列表"""
        docs = []

        if not os.path.exists(self.docs_dir):
            return docs

        for filename in os.listdir(self.docs_dir):
            if filename.endswith('.yaml') or filename.endswith('.yml'):
                doc_name = filename.rsplit('.', 1)[0]
                doc_path = os.path.join(self.docs_dir, filename)

                try:
                    # 读取文档基本信息
                    with open(doc_path, 'r', encoding='utf-8') as f:
                        doc_content = yaml.safe_load(f)

                    info = doc_content.get('info', {})
                    doc_info = {
                        'name': doc_name,
                        'filename': filename,
                        'title': info.get('title', f'{doc_name.title()} API'),
                        'description': self._extract_description(info.get('description', '')),
                        'version': info.get('version', '1.0.0'),
                        'last_modified': self._get_file_modified_time(doc_path),
                        'endpoints_count': len(doc_content.get('paths', {})),
                        'access_urls': {
                            'json': f'/api/api-docs/{doc_name}.yaml',
                            'yaml_raw': f'/api/api-docs/{doc_name}.yaml/raw',
                            'info': f'/api/api-docs/{doc_name}.yaml/info'
                        }
                    }
                    docs.append(doc_info)

                except Exception as e:
                    # 如果文档解析失败，仍然添加基本信息
                    docs.append({
                        'name': doc_name,
                        'filename': filename,
                        'title': f'{doc_name.title()} API',
                        'description': '文档解析失败',
                        'version': 'unknown',
                        'last_modified': self._get_file_modified_time(doc_path),
                        'endpoints_count': 0,
                        'error': str(e),
                        'access_urls': {
                            'json': f'/api/api-docs/{doc_name}.yaml',
                            'yaml_raw': f'/api/api-docs/{doc_name}.yaml/raw',
                            'info': f'/api/api-docs/{doc_name}.yaml/info'
                        }
                    })

        # 按名称排序
        docs.sort(key=lambda x: x['name'])
        return docs

    def get_doc_content(self, doc_name: str, format_type: str = 'json', host: str = 'localhost') -> Optional[Dict]:
        """获取指定文档的内容"""
        doc_path = self._find_doc_file(doc_name)

        if not doc_path:
            return None

        try:
            with open(doc_path, 'r', encoding='utf-8') as f:
                if format_type == 'yaml':
                    content = f.read()
                    # 动态替换域名
                    content = content.replace('host: "api-preprod.example.com"', f'host: "{host}"')
                    return content
                else:
                    doc_content = yaml.safe_load(f)
                    # 动态更新主机地址
                    doc_content['host'] = host
                    return doc_content
        except Exception as e:
            return {'error': f'读取文档失败: {str(e)}'}

    def get_doc_info(self, doc_name: str, host: str = 'localhost') -> Optional[Dict]:
        """获取指定文档的详细信息"""
        doc_path = self._find_doc_file(doc_name)

        if not doc_path:
            return None

        try:
            with open(doc_path, 'r', encoding='utf-8') as f:
                doc_content = yaml.safe_load(f)

            info = doc_content.get('info', {})
            paths = doc_content.get('paths', {})

            # 统计接口信息
            methods_count = {}
            tags_count = {}

            for path, methods in paths.items():
                for method, details in methods.items():
                    if method in ['get', 'post', 'put', 'delete', 'patch']:
                        methods_count[method.upper()] = methods_count.get(method.upper(), 0) + 1

                        # 统计标签
                        tags = details.get('tags', [])
                        for tag in tags:
                            tags_count[tag] = tags_count.get(tag, 0) + 1

            is_local_host = host.startswith('localhost') or host.startswith('127.0.0.1')
            protocol = 'http' if is_local_host else 'https'
            base_url = f"{protocol}://{host}"

            return {
                'name': doc_name,
                'title': info.get('title', f'{doc_name.title()} API'),
                'description': info.get('description', ''),
                'version': info.get('version', '1.0.0'),
                'contact': info.get('contact', {}),
                'license': info.get('license', {}),
                'host': host,
                'base_path': doc_content.get('basePath', '/'),
                'schemes': doc_content.get('schemes', ['http', 'https']),
                'last_modified': self._get_file_modified_time(doc_path),
                'statistics': {
                    'total_endpoints': len(paths),
                    'methods': methods_count,
                    'tags': tags_count
                },
                'access_urls': {
                    'json': f"{base_url}/api/api-docs/{doc_name}.yaml",
                    'yaml_raw': f"{base_url}/api/api-docs/{doc_name}.yaml/raw",
                    'info': f"{base_url}/api/api-docs/{doc_name}.yaml/info",
                    'swagger_ui': f"{base_url}/api/docs#{doc_name}"
                },
                'usage_for_ai': {
                    'recommended_url': f"{base_url}/api/api-docs/{doc_name}.yaml",
                    'description': f"推荐将此URL发送给AI工具进行{info.get('title', doc_name)}API分析",
                    'format': 'JSON格式的Swagger 2.0文档',
                    'token_optimized': f"专门优化，只包含{doc_name}相关接口"
                }
            }

        except Exception as e:
            return {'error': f'读取文档信息失败: {str(e)}'}

    def _find_doc_file(self, doc_name: str) -> Optional[str]:
        """查找文档文件（带路径遍历防护）"""
        if '..' in doc_name or '/' in doc_name or '\\' in doc_name:
            return None

        possible_files = [
            f"{doc_name}.yaml",
            f"{doc_name}.yml"
        ]

        for filename in possible_files:
            doc_path = os.path.join(self.docs_dir, filename)
            resolved = os.path.realpath(doc_path)
            if not resolved.startswith(os.path.realpath(self.docs_dir)):
                return None
            if os.path.exists(resolved):
                return resolved

        return None

    def _extract_description(self, description: str) -> str:
        """提取描述的前几行作为简短描述"""
        if not description:
            return ''

        lines = description.split('\n')
        # 找到第一个非空的实际内容行
        for line in lines:
            line = line.strip()
            if line and not line.startswith('#') and not line.startswith('##'):
                return line[:100] + ('...' if len(line) > 100 else '')

        return description[:100] + ('...' if len(description) > 100 else '')

    def _get_file_modified_time(self, file_path: str) -> str:
        """获取文件修改时间"""
        try:
            import datetime
            timestamp = os.path.getmtime(file_path)
            dt = datetime.datetime.fromtimestamp(timestamp)
            return dt.strftime('%Y-%m-%d %H:%M:%S')
        except:
            return 'unknown'


# 全局实例
docs_manager = APIDocsManager()
