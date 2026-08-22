"""
DocParse 解析器包

导入所有解析器模块以触发 @register_parser 自注册。
新增解析器只需在此目录新建文件并使用 @register_parser 装饰器。

每个 parser 的导入用 try/except 包裹，单个 parser 的第三方依赖缺失
只会导致该 parser 不可用，不会阻塞整个进程（如 Celery Worker）启动。
"""

import importlib
import logging

logger = logging.getLogger(__name__)

_PARSER_MODULES = [
    "docx_parser",
    "image_parser",
    "pdf_parser",
    "plaintext_parser",
    "pptx_parser",
    "xlsx_parser",
]

for _mod_name in _PARSER_MODULES:
    try:
        importlib.import_module(f".{_mod_name}", __name__)
    except ImportError as exc:
        logger.warning(
            "[DocParse] 解析器 %s 加载失败（依赖缺失: %s），该格式将不可用",
            _mod_name, exc,
        )
