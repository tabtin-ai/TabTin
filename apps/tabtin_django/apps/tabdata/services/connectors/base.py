"""
连接器抽象基类

所有外部数据源连接器（PostgreSQL、MySQL、HTTP API）必须继承此基类。
"""
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class ExternalColumn:
    """外部数据源的列描述"""
    name: str
    data_type: str
    is_nullable: bool = True
    is_primary_key: bool = False
    default_value: Optional[str] = None


@dataclass
class ExternalTable:
    """外部数据源的表描述"""
    schema: str
    name: str
    columns: list[ExternalColumn] = field(default_factory=list)
    row_count: Optional[int] = None


class BaseConnector(ABC):
    """外部数据源连接器的抽象基类"""

    @abstractmethod
    def test_connection(self) -> tuple[bool, str]:
        """测试连接是否有效。返回 (成功, 消息)。"""
        ...

    @abstractmethod
    def discover_tables(self) -> list[ExternalTable]:
        """发现外部数据源中的所有表。"""
        ...

    @abstractmethod
    def discover_columns(self, schema: str, table: str) -> list[ExternalColumn]:
        """发现指定表的所有列。"""
        ...

    @abstractmethod
    def query(self, schema: str, table: str, columns: list[str] = None,
              filters: list = None, sorts: list = None,
              limit: int = 100, offset: int = 0) -> tuple[list[dict], int]:
        """查询数据。返回 (行列表, 总行数)。"""
        ...

    @abstractmethod
    def close(self):
        """释放资源。"""
        ...
