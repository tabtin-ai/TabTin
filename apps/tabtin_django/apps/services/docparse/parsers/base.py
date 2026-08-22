"""
解析器抽象基类与通用数据结构

所有具体解析器（PDF、Word、Vision）均继承 BaseDocumentParser。
ParseResult / PageResult / ChunkResult 为跨解析器通用的中间表示。
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field


@dataclass
class ChunkResult:
    """单个内容块（段落 / 标题 / 表格 / 图片 …）

    metadata 约定字段：
      - source: "text_layer" | "vision" | "skipped_scan"
      - quality: "high" (文本层提取且质量校验通过)
                 | "medium" (Vision 模型解析)
                 | "low" (Vision 失败降级 / 占位)
                 | "skipped" (扫描件且未配置 Vision)
    """
    chunk_type: str
    content: str
    sequence: int
    bbox: tuple[float, float, float, float] | None = None
    heading_level: int | None = None
    metadata: dict = field(default_factory=dict)


@dataclass
class PageResult:
    """一页（PDF 物理页 / Word 逻辑页）"""
    page_number: int
    width: float
    height: float
    chunks: list[ChunkResult]
    text_content: str = ""


@dataclass
class ParseResult:
    """完整文档解析结果"""
    pages: list[PageResult]
    title: str = ""
    language: str = ""
    parse_method: str = ""


class BaseDocumentParser(ABC):
    """解析器抽象基类"""

    @abstractmethod
    def parse(self, file_path: str, **kwargs) -> ParseResult:
        """解析文件并返回结构化结果"""
        ...

    @abstractmethod
    def supported_mimes(self) -> list[str]:
        """返回该解析器支持的 MIME 类型列表"""
        ...
