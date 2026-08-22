"""
Services模块常量定义
"""

# ── 权限角色（单一事实来源，所有模块必须从此导入） ──

ROLE_LEVELS = {'owner': 4, 'admin': 3, 'editor': 2, 'viewer': 1, 'participant': 1}
ASSIGNABLE_ROLES = frozenset({'viewer', 'editor', 'admin'})
# Organization 成员两级模型（2026-06-10 产品调整）：管理动作 owner-only，成员只剩 editor。
# 新写入（邀请/加成员/改角色）只允许 editor；存量 admin/viewer 成员保留展示与既有层级语义。
# 仅约束 OrganizationMember/OrganizationInvitation 写路径；Space 成员与资源级权限仍用 ASSIGNABLE_ROLES。
ORGANIZATION_ASSIGNABLE_ROLES = frozenset({'editor'})
VALID_SPACE_STATUSES = frozenset({'active', 'paused', 'completed', 'archived'})

RESOURCE_PERMISSION_CHOICES = [
    ("viewer", "Viewer"),
    ("editor", "Editor"),
    ("admin", "Admin"),
    ("owner", "Owner"),
]

# 服务类型
SERVICE_TYPES = {
    'SMS': 'sms',
    'EMAIL': 'email',
    'OSS': 'oss',
}

# 错误代码
ERROR_CODES = {
    # 通用错误
    'SUCCESS': '0000',
    'UNKNOWN_ERROR': '9999',
    'INVALID_PARAMS': '1001',
    'MISSING_PARAMS': '1002',
    'VALIDATION_ERROR': '1003',
    'CONFIG_ERROR': '1004',
    'NETWORK_ERROR': '1005',
    'AUTH_ERROR': '1006',
    'RATE_LIMIT_ERROR': '1007',

    # SMS错误
    'SMS_ERROR': '2001',
    'SMS_SEND_FAILED': '2002',
    'SMS_TEMPLATE_ERROR': '2003',
    'SMS_QUOTA_EXCEEDED': '2004',

    # Email错误
    'EMAIL_ERROR': '3001',
    'EMAIL_SEND_FAILED': '3002',
    'EMAIL_TEMPLATE_ERROR': '3003',
    'EMAIL_QUOTA_EXCEEDED': '3004',

    # OSS错误
    'OSS_ERROR': '4001',
    'OSS_UPLOAD_FAILED': '4002',
    'OSS_DOWNLOAD_FAILED': '4003',
    'OSS_DELETE_FAILED': '4004',
    'OSS_FILE_NOT_FOUND': '4005',
    'OSS_BUCKET_ERROR': '4006',
}

# 正则表达式模式
REGEX_PATTERNS = {
    'PHONE': r'^\+?[1-9]\d{6,14}$',  # E.164 简化版：可选+前缀，1-9开头，总长7-15位
    'EMAIL': r'^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$',
    'VERIFICATION_CODE': r'^\d{4,8}$',
    'UUID': r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
}

# 文件类型映射
FILE_TYPE_MAPPING = {
    # 图片类型
    'image': ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'ico', 'tiff'],
    # 文档类型
    'document': ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'rtf', 'odt', 'ods', 'odp'],
    # 视频类型
    'video': ['mp4', 'avi', 'mov', 'wmv', 'flv', 'webm', 'mkv', '3gp', 'rm', 'rmvb'],
    # 音频类型
    'audio': ['mp3', 'wav', 'flac', 'aac', 'ogg', 'wma', 'm4a', 'opus'],
    # 压缩包类型
    'archive': ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'z'],
}

# 默认配置值
DEFAULT_CONFIG = {
    # 验证码配置
    'VERIFICATION_CODE_LENGTH': 6,
    'VERIFICATION_CODE_EXPIRE': 600,  # 10分钟

    # 重试配置
    'MAX_RETRY_ATTEMPTS': 3,
    'RETRY_BASE_DELAY': 1,  # 秒
    'RETRY_MAX_DELAY': 60,  # 秒

    # 限流配置
    'RATE_LIMIT_WINDOW': 60,  # 秒
    'RATE_LIMIT_MAX_REQUESTS': 100,

    # 批量操作限制
    'BATCH_MAX_SIZE': 100,
    'BATCH_TIMEOUT': 300,  # 5分钟

    # 文件上传限制（权威来源：settings.OSS_MAX_FILE_SIZE / OSS_ALLOWED_EXTENSIONS）
    'MAX_FILE_SIZE': 104857600,  # 100MB — 仅作 fallback，应使用 settings.OSS_MAX_FILE_SIZE
    'ALLOWED_FILE_EXTENSIONS': ['jpg', 'jpeg', 'png', 'gif', 'pdf', 'doc', 'docx', 'txt'],  # 仅作 fallback

    # 缓存配置
    'CACHE_DEFAULT_TIMEOUT': 3600,  # 1小时
    'CACHE_KEY_PREFIX': 'tabtin:services:',
}

# 敏感词列表（可配置）
SENSITIVE_WORDS = [
    '测试敏感词',
    '违法',
    '广告',
    '垃圾信息',
]

# HTTP状态码映射
HTTP_STATUS_MAPPING = {
    'SUCCESS': 200,
    'CREATED': 201,
    'BAD_REQUEST': 400,
    'UNAUTHORIZED': 401,
    'FORBIDDEN': 403,
    'NOT_FOUND': 404,
    'METHOD_NOT_ALLOWED': 405,
    'CONFLICT': 409,
    'UNPROCESSABLE_ENTITY': 422,
    'TOO_MANY_REQUESTS': 429,
    'INTERNAL_SERVER_ERROR': 500,
    'BAD_GATEWAY': 502,
    'SERVICE_UNAVAILABLE': 503,
}

# 日志级别
LOG_LEVELS = {
    'DEBUG': 10,
    'INFO': 20,
    'WARNING': 30,
    'ERROR': 40,
    'CRITICAL': 50,
}

# 时间格式
TIME_FORMATS = {
    'DATETIME': '%Y-%m-%d %H:%M:%S',
    'DATE': '%Y-%m-%d',
    'TIME': '%H:%M:%S',
    'ISO': '%Y-%m-%dT%H:%M:%S.%fZ',
    'TIMESTAMP': '%Y%m%d%H%M%S',
}

# 服务状态
SERVICE_STATUS = {
    'HEALTHY': 'healthy',
    'DEGRADED': 'degraded',
    'UNHEALTHY': 'unhealthy',
    'MAINTENANCE': 'maintenance',
}

# 任务状态
TASK_STATUS = {
    'PENDING': 'pending',
    'PROCESSING': 'processing',
    'COMPLETED': 'completed',
    'FAILED': 'failed',
    'CANCELLED': 'cancelled',
}

# 优先级
PRIORITY_LEVELS = {
    'LOW': 1,
    'NORMAL': 2,
    'HIGH': 3,
    'URGENT': 4,
    'CRITICAL': 5,
}

# 缓存键模板
CACHE_KEY_TEMPLATES = {
    'SMS_CODE': 'sms:code:{phone}',
    'EMAIL_CODE': 'email:code:{email}',
    'RATE_LIMIT': 'rate_limit:{service}:{key}',
    'USER_SESSION': 'session:{user_id}',
    'FILE_INFO': 'file:info:{file_id}',
    'CONFIG': 'config:{service}:{key}',
}

# API版本
API_VERSIONS = {
    'V1': 'v1',
    'V2': 'v2',
    'CURRENT': 'v1',
}

# 环境类型
ENVIRONMENTS = {
    'DEVELOPMENT': 'development',
    'TESTING': 'testing',
    'STAGING': 'staging',
    'PRODUCTION': 'production',
}

# 编码格式
ENCODINGS = {
    'UTF8': 'utf-8',
    'GBK': 'gbk',
    'ASCII': 'ascii',
}

# 哈希算法
HASH_ALGORITHMS = {
    'MD5': 'md5',
    'SHA1': 'sha1',
    'SHA256': 'sha256',
    'SHA512': 'sha512',
}
