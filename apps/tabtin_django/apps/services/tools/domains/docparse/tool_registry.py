"""
DocParse 工具注册 — 文档解析相关工具
"""

from typing import List

from apps.services.tools import BaseTool
from apps.services.tools.domains.docparse.document_read import DocumentReadTool


def get_all_tools() -> List[BaseTool]:
    return [
        DocumentReadTool(),
    ]


__all__ = ["get_all_tools"]
