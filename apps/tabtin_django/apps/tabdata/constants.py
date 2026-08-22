"""
TabData 常量定义

统一分页、批量操作、导入分片等边界参数，避免多处硬编码导致行为漂移。
"""

from django.conf import settings

# ── 数据库别名 ──
TABDATA_DB_ALIAS = (
    'default'
    if getattr(settings, 'TABTIN_SINGLE_DATABASE_MODE', False)
    else getattr(settings, 'TABDATA_DB', 'postgresql')
)
AITABLE_DB_ALIAS = TABDATA_DB_ALIAS  # 兼容旧引用

DEFAULT_PAGE = 1
DEFAULT_PAGE_SIZE = 100
MAX_PAGE_SIZE = 1000

# 批量记录操作上限（API 输入级）
MAX_BULK_RECORDS = 1000

# 批量字段创建上限（API 输入级）
MAX_BULK_FIELDS = 50

# 导入单次最大行数（请求级安全阀）。
# -1 = 不按请求截断；产品上限由套餐 max_records_per_table 在写入前执行（QTA-01）。
# 另有请求体体积上限（CSV/JSON 10MB）与大文件异步导入门槛作进程保护。
# >0 时仍会截断并写入 truncation_warning（兼容旧行为 / 紧急回滚）。
MAX_IMPORT_ROWS_PER_REQUEST = -1

# 导入时自动建字段分片大小（执行级）
IMPORT_FIELD_CHUNK_SIZE = 50

# 批量写入分批提交大小（执行级）
BULK_WRITE_CHUNK_SIZE = 200

# 导出单次最大行数（防 OOM 保护，CSV 流式不受此限制）
MAX_EXPORT_ROWS = 100_000

# PDF 导出单次最大行数（PDF 表格构建全量加载内存，需更保守）
MAX_EXPORT_ROWS_PDF = 5_000

# 协同快照全量加载行数上限（Y.Doc 初始化）
# 可通过 Django settings.COLLAB_SNAPSHOT_MAX_ROWS 覆盖
COLLAB_SNAPSHOT_MAX_ROWS: int = getattr(settings, 'COLLAB_SNAPSHOT_MAX_ROWS', 5_000)

# DDL 操作超时保护（毫秒），防止大表 ALTER TABLE 长时间阻塞
DDL_STATEMENT_TIMEOUT_MS: int = getattr(settings, 'DDL_STATEMENT_TIMEOUT_MS', 30_000)

# ── Record 写入路径（维护提示） ──
# 以下模块都有独立的 record 创建/更新逻辑，新增系统字段行为时需逐一处理：
#   1. record_service.py — create_record / update_record / bulk_create_records
#   2. import_service.py — _import_data (CSV/Excel 导入)
#   3. collab_service.py — persist_changes (协同编辑 Y.js 变更持久化)
#   4. connector_tasks.py — _full_sync / _incremental_sync (外部数据连接器镜像同步)
# TODO: 未来考虑统一写入钩子，避免每条路径逐一打补丁。

# ── 字段类型分类 ──
FILE_BASED_FIELD_TYPES = frozenset({'attachment'})
# 系统自动管理的只读字段，用户输入一律跳过
SYSTEM_MANAGED_FIELD_TYPES = frozenset({
    'created_by', 'last_modified_by',
    'created_time', 'last_modified_time',
})
# ── Link 关系常量（单一定义源）──
MULTI_VALUE_RELATIONSHIPS = frozenset({'ManyMany', 'OneMany'})
DEFAULT_LINK_RELATIONSHIP = 'ManyOne'
SYMMETRIC_RELATIONSHIP_MAP = {
    'OneOne': 'OneOne',
    'OneMany': 'ManyOne',
    'ManyOne': 'OneMany',
    'ManyMany': 'ManyMany',
}

# 关联记录（包括子记录的父记录）没有可读展示字段时，统一使用此占位符；
# 不得向用户暴露内部 UUID。
UNNAMED_RECORD_DISPLAY_NAME = '未命名记录'

# 天然多值的字段类型
INHERENTLY_MULTI_VALUE_TYPES = frozenset({'multi_select', 'attachment'})
