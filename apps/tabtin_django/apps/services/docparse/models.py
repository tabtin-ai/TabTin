import uuid

from django.db import models


class ParsedDocument(models.Model):
    """文档解析结果（一个 FileRecord 对应一条记录，解析结果持久化缓存）"""

    class Status(models.TextChoices):
        PENDING = 'pending', '待解析'
        PARSING = 'parsing', '解析中'
        READY = 'ready', '已就绪'
        FAILED = 'failed', '解析失败'

    class ParseMethod(models.TextChoices):
        TEXT_LAYER = 'text_layer', '文本层提取'
        VISION = 'vision', 'Vision 模型'
        STRUCTURAL = 'structural', '结构化提取'
        TEXT_READ = 'text_read', '纯文本读取'

    class FailureCode(models.TextChoices):
        """
        失败原因结构化分类（W1 / L9：DocParseService.STATUS 失败原因结构化）。

        与 `@tabtin/file-pipeline-errors` 的 `FilePipelineErrorCode` SSoT 严格对齐。
        添加 / 改名前先改 TS 端，保证三端（客户端 / 后端 / 移动端）字面值不漂移。

        13 类对应关系：
          | TS FilePipelineErrorCode | Python FailureCode  | 触发场景 |
          |--------------------------|---------------------|--------|
          | FILE_NOT_FOUND           | FILE_NOT_FOUND      | 文件 / URL 不存在 |
          | FILE_TOO_LARGE           | FILE_TOO_LARGE      | 图 > 20MB / 文档 > 50MB |
          | PERMISSION_DENIED        | PERMISSION_DENIED   | 路径敏感 / 工作区外 |
          | ENCRYPTED                | ENCRYPTED           | PDF 密码保护 |
          | CORRUPTED                | CORRUPTED           | zip 解不开 / 非法结构 |
          | SCANNED_PDF              | SCANNED_PDF         | PDF 纯图无文本层 |
          | GARBLED_TEXT_LAYER       | GARBLED_TEXT_LAYER  | OCR 伪文本 |
          | UNSUPPORTED_FORMAT       | UNSUPPORTED_FORMAT  | 未知 mime / 真二进制 / PPTX |
          | PARSE_TIMEOUT            | PARSE_TIMEOUT       | 解析超时 |
          | USER_ABORTED             | USER_ABORTED        | 用户取消 |
          | NETWORK_ERROR            | NETWORK_ERROR       | OSS 下载失败 |
          | INVALID_PARAMETER        | INVALID_PARAMETER   | 参数缺失 / 类型错 |
          | UNKNOWN_ERROR            | UNKNOWN_ERROR       | 兜底 |

        旧 `error_message` TextField 保留（人类可读的原始消息 / 诊断细节），
        `failure_code` 是结构化分类供客户端 UI / catalog 路由用。
        """
        FILE_NOT_FOUND = 'file_not_found', '文件不存在'
        FILE_TOO_LARGE = 'file_too_large', '文件过大'
        PERMISSION_DENIED = 'permission_denied', '无权访问'
        ENCRYPTED = 'encrypted', '文件已加密'
        CORRUPTED = 'corrupted', '文件已损坏'
        SCANNED_PDF = 'scanned_pdf', '扫描件 PDF'
        GARBLED_TEXT_LAYER = 'garbled_text_layer', '文本层乱码'
        UNSUPPORTED_FORMAT = 'unsupported_format', '格式不支持'
        PARSE_TIMEOUT = 'parse_timeout', '解析超时'
        USER_ABORTED = 'aborted', '用户取消'
        NETWORK_ERROR = 'network_failed', '网络异常'
        INVALID_PARAMETER = 'invalid_param_format', '参数无效'
        UNKNOWN_ERROR = 'upstream_error', '未知错误'

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    file_record = models.OneToOneField(
        'oss.FileRecord',
        on_delete=models.CASCADE,
        related_name='parsed_doc',
        verbose_name='源文件',
    )
    status = models.CharField(
        max_length=20,
        choices=Status.choices,
        default=Status.PENDING,
    )
    parse_method = models.CharField(
        max_length=20,
        choices=ParseMethod.choices,
        blank=True,
    )
    total_pages = models.IntegerField(default=0, verbose_name='总页数')
    title = models.CharField(max_length=500, blank=True, verbose_name='文档标题')
    language = models.CharField(max_length=10, blank=True, verbose_name='语言')
    summary_text = models.TextField(blank=True, verbose_name='全文摘要')
    error_message = models.TextField(blank=True, verbose_name='错误信息')
    failure_code = models.CharField(
        max_length=32,
        choices=FailureCode.choices,
        blank=True,
        # W1.2 Review 收尾（2026-05-13）：可观测 / metric 需要按 failure_code
        # 聚合（"过去 7 天 top 5 失败原因"），加索引避免百万级表全扫描。
        db_index=True,
        verbose_name='失败结构化分类',
        help_text=(
            'W1 / L9：与 @tabtin/file-pipeline-errors SSoT 对齐的 13 类失败码。'
            'status=FAILED 时必填，客户端 UI 按此字段路由到 i18n 文案。'
        ),
    )
    parse_model = models.CharField(
        max_length=100, blank=True,
        verbose_name='使用的 VL 模型',
    )
    parsed_pages = models.IntegerField(
        default=0,
        verbose_name='已完成页数',
        help_text='断点续传：记录已成功写入 DB 的页数',
    )
    parsed_at = models.DateTimeField(null=True, blank=True, verbose_name='解析完成时间')
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True, verbose_name='最后更新时间')

    class Meta:
        db_table = 'services_docparse_document'
        verbose_name = '解析文档'
        verbose_name_plural = verbose_name
        indexes = [
            models.Index(fields=['status', 'created_at']),
        ]

    def __str__(self):
        return f"ParsedDoc({self.file_record.file_name}, {self.status})"


class DocumentPage(models.Model):
    """文档页面（PDF 按页，Word 按逻辑段落组）"""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    document = models.ForeignKey(
        ParsedDocument, on_delete=models.CASCADE, related_name='pages',
    )
    page_number = models.IntegerField(verbose_name='页码')
    width = models.FloatField(default=0, verbose_name='页面宽度(pt)')
    height = models.FloatField(default=0, verbose_name='页面高度(pt)')
    thumbnail_url = models.URLField(blank=True, verbose_name='缩略图 URL')
    text_content = models.TextField(blank=True, verbose_name='整页纯文本')

    class Meta:
        db_table = 'services_docparse_page'
        ordering = ['document', 'page_number']
        verbose_name = '文档页面'
        verbose_name_plural = verbose_name
        constraints = [
            models.UniqueConstraint(
                fields=['document', 'page_number'],
                name='docparse_page_document_page_uniq',
            ),
        ]
        indexes = [
            models.Index(fields=['document', 'page_number']),
        ]

    def __str__(self):
        return f"Page({self.document_id}, p{self.page_number})"


class DocumentChunk(models.Model):
    """文档内容块（带 bbox 位置信息）"""

    class ChunkType(models.TextChoices):
        HEADING = 'heading', '标题'
        PARAGRAPH = 'paragraph', '段落'
        TABLE = 'table', '表格'
        IMAGE = 'image', '图片'
        LIST = 'list', '列表'
        FIELD = 'field', '表单字段'
        NOTE = 'note', '备注'

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    page = models.ForeignKey(
        DocumentPage, on_delete=models.CASCADE, related_name='chunks',
    )
    chunk_type = models.CharField(max_length=30, choices=ChunkType.choices)
    content = models.TextField(verbose_name='文本内容')
    sequence = models.IntegerField(verbose_name='页内排序')

    bbox_x0 = models.FloatField(null=True, blank=True, verbose_name='左上 x')
    bbox_y0 = models.FloatField(null=True, blank=True, verbose_name='左上 y')
    bbox_x1 = models.FloatField(null=True, blank=True, verbose_name='右下 x')
    bbox_y1 = models.FloatField(null=True, blank=True, verbose_name='右下 y')

    heading_level = models.IntegerField(null=True, blank=True, verbose_name='标题级别')
    metadata = models.JSONField(default=dict, blank=True, verbose_name='元数据')

    class Meta:
        db_table = 'services_docparse_chunk'
        ordering = ['page', 'sequence']
        verbose_name = '文档内容块'
        verbose_name_plural = verbose_name
        constraints = [
            models.UniqueConstraint(
                fields=['page', 'sequence'],
                name='docparse_chunk_page_sequence_uniq',
            ),
        ]
        indexes = [
            models.Index(fields=['page', 'sequence']),
            models.Index(fields=['page', 'chunk_type']),
        ]

    def __str__(self):
        preview = self.content[:40] if self.content else ''
        return f"Chunk({self.chunk_type}, {preview})"


class DocumentImportJob(models.Model):
    """后台文档导入任务，承载 TabDoc 文件导入的可恢复状态。"""

    class Status(models.TextChoices):
        QUEUED = 'queued', 'Queued'
        RUNNING = 'running', 'Running'
        RETRYING = 'retrying', 'Retrying'
        READY = 'ready', 'Ready'
        PARTIAL_READY = 'partial_ready', 'Partial ready'
        FAILED = 'failed', 'Failed'
        INTERRUPTED = 'interrupted', 'Interrupted'
        CANCELLED = 'cancelled', 'Cancelled'

    class Stage(models.TextChoices):
        VALIDATING = 'validating', 'Validating'
        DOWNLOADING = 'downloading', 'Downloading'
        INSPECTING = 'inspecting', 'Inspecting'
        EXTRACTING = 'extracting', 'Extracting'
        PERSISTING = 'persisting', 'Persisting'
        BUILDING_DRAFT = 'building_draft', 'Building draft'
        INDEXING = 'indexing', 'Indexing'
        COMPLETED = 'completed', 'Completed'

    ACTIVE_STATUSES = (
        Status.QUEUED,
        Status.RUNNING,
        Status.RETRYING,
    )

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    file_record = models.ForeignKey(
        'oss.FileRecord',
        on_delete=models.CASCADE,
        related_name='document_import_jobs',
        verbose_name='源文件',
    )
    organization_id = models.CharField(max_length=100, blank=True, default='', db_index=True)
    space_id = models.CharField(max_length=100, blank=True, default='', db_index=True)
    requested_by_id = models.CharField(max_length=100, blank=True, default='', db_index=True)
    parsed_document = models.ForeignKey(
        ParsedDocument,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='import_jobs',
        verbose_name='解析文档',
    )
    status = models.CharField(
        max_length=32,
        choices=Status.choices,
        default=Status.QUEUED,
        db_index=True,
    )
    stage = models.CharField(
        max_length=32,
        choices=Stage.choices,
        default=Stage.VALIDATING,
        db_index=True,
    )
    total_pages = models.IntegerField(default=0)
    processed_pages = models.IntegerField(default=0)
    failed_pages = models.IntegerField(default=0)
    celery_task_id = models.CharField(max_length=255, blank=True, db_index=True)
    worker_id = models.CharField(max_length=255, blank=True, db_index=True)
    retry_count = models.IntegerField(default=0)
    heartbeat_at = models.DateTimeField(null=True, blank=True, db_index=True)
    lease_expires_at = models.DateTimeField(null=True, blank=True, db_index=True)
    error_code = models.CharField(max_length=64, blank=True, db_index=True)
    error_message = models.TextField(blank=True)
    request_payload = models.JSONField(default=dict, blank=True)
    result_payload = models.JSONField(default=dict, blank=True)
    result_storage_key = models.CharField(max_length=1024, blank=True)
    parser_version = models.CharField(max_length=64, default='docparse-job-v1')
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)
    updated_at = models.DateTimeField(auto_now=True)
    started_at = models.DateTimeField(null=True, blank=True)
    completed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = 'services_docparse_import_job'
        ordering = ['-created_at']
        constraints = [
            models.UniqueConstraint(
                fields=['file_record', 'organization_id', 'space_id'],
                condition=models.Q(status__in=('queued', 'running', 'retrying')),
                name='docparse_import_job_one_active_per_context',
            ),
        ]
        indexes = [
            models.Index(fields=['file_record', 'status']),
            models.Index(fields=['organization_id', 'space_id', 'status'], name='services_do_organiz_0e0faa_idx'),
            models.Index(fields=['status', 'stage', 'created_at']),
            models.Index(fields=['lease_expires_at', 'status']),
        ]

    def __str__(self):
        return f"DocumentImportJob({self.file_record_id}, {self.status}, {self.stage})"
