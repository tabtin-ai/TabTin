"""
RAG 模块数据模型

包含六个核心模型：
1. TableEmbedding - 表格向量索引
2. RecordEmbedding - 记录向量索引
3. EmbeddingTask - 向量化任务队列
4. SearchLog - 检索日志
5. SkillEmbedding - 技能向量索引（用于语义检索可用技能）
6. DocumentEmbedding - 文档向量索引（TabDoc 文档语义检索）
"""

import uuid
from django.db import models
from django.contrib.auth import get_user_model
from django.utils import timezone
from pgvector.django import VectorField

User = get_user_model()


class TableEmbedding(models.Model):
    """
    表格向量索引

    存储表格级别的向量表示，用于快速检索相关表格
    """

    STATUS_CHOICES = [
        ('pending', '待处理'),
        ('processing', '处理中'),
        ('success', '成功'),
        ('failed', '失败'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    # 关联表格（跨数据库外键，不创建约束）
    table_id = models.UUIDField(verbose_name='表格ID', db_index=True)

    organization_id = models.UUIDField(
        db_index=True,
        verbose_name='组织ID',
        help_text='冗余顶层字段，用于高效按 organization 过滤；与 metadata.organization_id 保持同步',
    )
    space_id = models.UUIDField(
        null=True, blank=True, db_index=True,
        verbose_name='所属空间',
        help_text='冗余顶层字段，用于高效按 space 过滤；与 metadata.space_id 保持同步',
    )

    # 向量化内容
    content = models.TextField(verbose_name='向量化的原文本')
    content_hash = models.CharField(max_length=64, verbose_name='内容哈希', db_index=True)

    # 向量
    embedding = VectorField(dimensions=1024, verbose_name='向量')

    # 元数据
    metadata = models.JSONField(default=dict, verbose_name='元数据')

    # 状态管理
    version = models.IntegerField(default=1, verbose_name='版本号')
    status = models.CharField(
        max_length=20,
        choices=STATUS_CHOICES,
        default='pending',
        verbose_name='状态'
    )

    embedding_model_id = models.UUIDField(null=True, blank=True, db_index=True, verbose_name='LLMModel ID')
    embedding_model_version = models.CharField(max_length=50, blank=True, default='', verbose_name='模型版本号')

    # 时间戳
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'rag_table_embedding'
        verbose_name = '表格向量索引'
        verbose_name_plural = '表格向量索引'
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['table_id', 'version']),
            models.Index(fields=['content_hash']),
            models.Index(fields=['status']),
        ]
        # 同一表格的同一版本只有一条记录
        unique_together = [['table_id', 'version']]

    def __str__(self):
        return f"TableEmbedding({self.table_id}, v{self.version})"

    @staticmethod
    def calculate_content_hash(content: str) -> str:
        from apps.rag.utils import calculate_content_hash
        return calculate_content_hash(content)


class RecordEmbedding(models.Model):
    """
    记录向量索引

    存储记录级别的向量表示，用于语义检索
    """

    STATUS_CHOICES = [
        ('pending', '待处理'),
        ('processing', '处理中'),
        ('success', '成功'),
        ('failed', '失败'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    # 关联记录和表格（跨数据库外键，不创建约束）
    record_id = models.UUIDField(verbose_name='记录ID', db_index=True)
    table_id = models.UUIDField(verbose_name='表格ID', db_index=True)

    organization_id = models.UUIDField(
        db_index=True,
        verbose_name='组织ID',
        help_text='冗余顶层字段，用于高效按 organization 过滤；与 metadata.organization_id 保持同步',
    )
    space_id = models.UUIDField(
        null=True, blank=True, db_index=True,
        verbose_name='所属空间',
        help_text='冗余顶层字段，用于高效按 space 过滤；与 metadata.space_id 保持同步',
    )

    # 向量化内容
    content = models.TextField(verbose_name='向量化的原文本')
    content_hash = models.CharField(max_length=64, verbose_name='内容哈希', db_index=True)

    # 向量
    embedding = VectorField(dimensions=1024, verbose_name='向量')

    # 元数据
    metadata = models.JSONField(default=dict, verbose_name='元数据')

    # 权重与优先级
    priority = models.IntegerField(default=0, verbose_name='优先级')

    # 状态管理
    version = models.IntegerField(default=1, verbose_name='版本号')
    status = models.CharField(
        max_length=20,
        choices=STATUS_CHOICES,
        default='pending',
        verbose_name='状态'
    )

    embedding_model_id = models.UUIDField(null=True, blank=True, db_index=True, verbose_name='LLMModel ID')
    embedding_model_version = models.CharField(max_length=50, blank=True, default='', verbose_name='模型版本号')

    # 时间戳
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'rag_record_embedding'
        verbose_name = '记录向量索引'
        verbose_name_plural = '记录向量索引'
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['record_id', 'version']),
            models.Index(fields=['table_id', 'priority']),
            models.Index(fields=['content_hash']),
            models.Index(fields=['status']),
            models.Index(fields=['created_at']),  # 时间范围过滤
        ]
        # 同一记录的同一版本只有一条记录
        unique_together = [['record_id', 'version']]

    def __str__(self):
        return f"RecordEmbedding({self.record_id}, v{self.version})"

    @staticmethod
    def calculate_content_hash(content: str) -> str:
        from apps.rag.utils import calculate_content_hash
        return calculate_content_hash(content)


class EmbeddingTask(models.Model):
    """
    向量化任务队列

    记录向量化任务的执行状态，支持失败重试
    """

    TASK_TYPE_CHOICES = [
        ('table', '表格'),
        ('record', '记录'),
        ('batch', '批量'),
        ('document', '文档'),
        ('code', '代码'),
        ('skill', 'Skill'),
        ('mail', '邮件'),
    ]

    STATUS_CHOICES = [
        ('pending', '待处理'),
        ('processing', '处理中'),
        ('success', '成功'),
        ('failed', '失败'),
        ('cancelled', '已取消'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    # 任务信息
    task_type = models.CharField(
        max_length=20,
        choices=TASK_TYPE_CHOICES,
        verbose_name='任务类型'
    )
    target_id = models.UUIDField(verbose_name='目标ID')
    organization_id = models.UUIDField(
        db_index=True,
        verbose_name='组织ID',
        help_text='冗余字段，用于快速按 organization 过滤任务',
    )

    # 任务状态
    status = models.CharField(
        max_length=20,
        choices=STATUS_CHOICES,
        default='pending',
        verbose_name='状态'
    )
    retry_count = models.IntegerField(default=0, verbose_name='重试次数')
    error_message = models.TextField(blank=True, verbose_name='错误信息')

    # Celery 任务 ID（唯一，重试时复用同一条记录；NULL 表示非 Celery 触发）
    celery_task_id = models.CharField(
        max_length=255,
        null=True,
        blank=True,
        unique=True,
        verbose_name='Celery任务ID'
    )

    # 时间戳
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    started_at = models.DateTimeField(null=True, blank=True, verbose_name='开始时间')
    completed_at = models.DateTimeField(null=True, blank=True, verbose_name='完成时间')

    class Meta:
        db_table = 'rag_embedding_task'
        verbose_name = '向量化任务'
        verbose_name_plural = '向量化任务'
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['status', 'created_at']),
            models.Index(fields=['task_type', 'target_id']),
            models.Index(fields=['celery_task_id']),
        ]

    def __str__(self):
        return f"EmbeddingTask({self.task_type}, {self.target_id}, {self.status})"

    def mark_started(self):
        """标记任务开始"""
        self.status = 'processing'
        self.started_at = timezone.now()
        self.save(update_fields=['status', 'started_at'])

    def mark_success(self):
        """标记任务成功。

        SC-018 修复：改为 QuerySet.update() 原子行级更新，并加 status='processing' 条件
        防止并发 worker 互相覆盖状态（后来的 worker 不会把已成功的任务改回失败）。
        """
        updated = EmbeddingTask.objects.filter(
            pk=self.pk,
            status='processing',
        ).update(
            status='success',
            completed_at=timezone.now(),
        )
        if updated:
            self.status = 'success'

    def mark_failed(self, error_message: str):
        """标记任务失败（retry_count 由 Celery 任务在 update_or_create 时统一设置）。

        SC-018 修复：改为 QuerySet.update() 原子行级更新，并加 status='processing' 条件
        防止并发 worker 把已成功的任务状态回退为 failed。
        """
        updated = EmbeddingTask.objects.filter(
            pk=self.pk,
            status='processing',
        ).update(
            status='failed',
            error_message=error_message,
            completed_at=timezone.now(),
        )
        if updated:
            self.status = 'failed'
            self.error_message = error_message


class SearchLog(models.Model):
    """
    检索日志

    记录向量检索请求，用于分析和优化
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    # 用户信息（跨数据库外键，不创建约束）
    user_id = models.UUIDField(verbose_name='用户ID', db_index=True)
    session_id = models.UUIDField(null=True, blank=True, verbose_name='会话ID')

    # 查询信息
    query = models.TextField(verbose_name='查询文本')
    query_embedding = VectorField(dimensions=1024, null=True, blank=True, verbose_name='查询向量')

    # 检索结果
    results_count = models.IntegerField(verbose_name='结果数量')
    top_similarity_score = models.FloatField(verbose_name='最高相似度')
    response_time_ms = models.IntegerField(verbose_name='响应时间(毫秒)')

    # 过滤条件
    filters = models.JSONField(default=dict, verbose_name='过滤条件')

    # 用户反馈
    user_feedback = models.CharField(
        max_length=20,
        blank=True,
        choices=[
            ('helpful', '有帮助'),
            ('not_helpful', '无帮助'),
        ],
        verbose_name='用户反馈'
    )

    # 时间戳
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')

    class Meta:
        db_table = 'rag_search_log'
        verbose_name = '检索日志'
        verbose_name_plural = '检索日志'
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['user_id', 'created_at']),
            models.Index(fields=['session_id']),
            models.Index(fields=['created_at']),
        ]

    def __str__(self):
        return f"SearchLog({self.user_id}, {self.query[:50]})"


class SkillEmbedding(models.Model):
    """
    技能向量索引

    存储 Skill 描述的向量表示，用于语义检索可用技能。
    三层来源：platform（内置）、app（应用随附）、user（用户自定义/安装）。
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    skill_key = models.CharField(
        max_length=255, unique=True, db_index=True,
        verbose_name='Skill 唯一标识',
    )
    source = models.CharField(
        max_length=20, db_index=True,
        verbose_name='来源',
        help_text='platform / app / user（旧值 system/market/managed 经兼容层自动映射）',
    )

    organization_id = models.UUIDField(
        null=True, blank=True,
        db_index=True,
        verbose_name='组织ID',
        help_text='冗余顶层字段，用于高效按 organization 过滤；系统/平台级 Skill 无 organization 时为 NULL',
    )
    space_id = models.UUIDField(
        null=True, blank=True, db_index=True,
        verbose_name='所属空间',
        help_text='冗余顶层字段，用于高效按 space 过滤；与 metadata.space_id 保持同步',
    )

    content = models.TextField(verbose_name='向量化的原文本')
    content_hash = models.CharField(max_length=64, verbose_name='内容哈希', db_index=True)

    embedding = VectorField(dimensions=1024, verbose_name='向量')

    metadata = models.JSONField(
        default=dict, verbose_name='元数据',
        help_text='name, description, location, tags, auto_activate_for',
    )

    embedding_model_id = models.UUIDField(null=True, blank=True, db_index=True, verbose_name='LLMModel ID')
    embedding_model_version = models.CharField(max_length=50, blank=True, default='', verbose_name='模型版本号')

    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'rag_skill_embedding'
        verbose_name = 'Skill 向量索引'
        verbose_name_plural = 'Skill 向量索引'
        ordering = ['-updated_at']
        indexes = [
            models.Index(fields=['source']),
            models.Index(fields=['content_hash']),
            models.Index(fields=['organization_id']),
            models.Index(fields=['space_id']),
        ]

    def __str__(self):
        return f"SkillEmbedding({self.skill_key})"

    @staticmethod
    def calculate_content_hash(content: str) -> str:
        from apps.rag.utils import calculate_content_hash
        return calculate_content_hash(content)


class DocumentEmbedding(models.Model):
    """
    文档向量索引

    存储 TabDoc 文档的向量表示，用于语义检索。
    """

    STATUS_CHOICES = [
        ('pending', '待处理'),
        ('processing', '处理中'),
        ('success', '成功'),
        ('failed', '失败'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    document_id = models.UUIDField(verbose_name='文档ID', db_index=True)
    organization_id = models.UUIDField(verbose_name='组织ID', db_index=True)
    # ：org-only 文档无 Space 宿主，允许 space_id 为空
    space_id = models.UUIDField(
        null=True, blank=True, db_index=True, verbose_name='所属空间',
    )

    content = models.TextField(verbose_name='向量化的原文本')
    content_hash = models.CharField(max_length=64, verbose_name='内容哈希', db_index=True)

    embedding = VectorField(dimensions=1024, verbose_name='向量')

    metadata = models.JSONField(default=dict, verbose_name='元数据')

    version = models.IntegerField(default=1, verbose_name='版本号')
    status = models.CharField(
        max_length=20,
        choices=STATUS_CHOICES,
        default='pending',
        verbose_name='状态',
    )

    embedding_model_id = models.UUIDField(null=True, blank=True, db_index=True, verbose_name='LLMModel ID')
    embedding_model_version = models.CharField(max_length=50, blank=True, default='', verbose_name='模型版本号')

    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'rag_document_embedding'
        verbose_name = '文档向量索引'
        verbose_name_plural = '文档向量索引'
        ordering = ['-created_at']
        unique_together = [['document_id', 'version']]
        indexes = [
            models.Index(fields=['status']),
            models.Index(fields=['organization_id', 'status']),
        ]

    def __str__(self):
        return f"DocumentEmbedding({self.document_id}, v{self.version})"

    @staticmethod
    def calculate_content_hash(content: str) -> str:
        from apps.rag.utils import calculate_content_hash
        return calculate_content_hash(content)


class CodeChunkEmbedding(models.Model):
    """
    代码块向量索引

    存储前端 tree-sitter chunking 产出的代码块向量，用于代码语义搜索。
    前端负责 chunking，后端负责 embedding + 存储 + 检索。
    """

    KIND_CHOICES = [
        ('function', '函数'),
        ('class', '类'),
        ('method', '方法'),
        ('interface', '接口'),
        ('module', '模块'),
        ('block', '代码块'),
    ]

    STATUS_CHOICES = [
        ('pending', '待处理'),
        ('processing', '处理中'),
        ('success', '成功'),
        ('failed', '失败'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    project_id = models.CharField(
        max_length=255,
        db_index=True,
        verbose_name='项目标识',
        help_text='{organization_id}:{sha256(project_root)[:16]}',
    )
    organization_id = models.UUIDField(verbose_name='组织ID', db_index=True)

    file_path = models.CharField(max_length=1024, verbose_name='文件路径')
    start_line = models.IntegerField(verbose_name='起始行')
    end_line = models.IntegerField(verbose_name='结束行')
    signature = models.CharField(max_length=255, blank=True, default='', verbose_name='签名')
    kind = models.CharField(
        max_length=20,
        choices=KIND_CHOICES,
        default='block',
        verbose_name='代码块类型',
    )
    language = models.CharField(max_length=30, verbose_name='编程语言')

    content = models.TextField(verbose_name='代码内容')
    content_hash = models.CharField(max_length=64, verbose_name='内容哈希', db_index=True)

    embedding = VectorField(dimensions=1024, verbose_name='向量', null=True, blank=True)

    metadata = models.JSONField(default=dict, verbose_name='元数据')

    status = models.CharField(
        max_length=20,
        choices=STATUS_CHOICES,
        default='pending',
        db_index=True,
        verbose_name='状态',
        help_text='pending=等待向量化, processing=向量化中, success=已完成, failed=向量化失败',
    )
    error_message = models.TextField(blank=True, default='', verbose_name='错误信息')

    embedding_model_id = models.UUIDField(null=True, blank=True, db_index=True, verbose_name='LLMModel ID')
    embedding_model_version = models.CharField(max_length=50, blank=True, default='', verbose_name='模型版本号')

    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'rag_code_chunk_embedding'
        verbose_name = '代码块向量索引'
        verbose_name_plural = '代码块向量索引'
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['project_id', 'file_path']),
            models.Index(fields=['organization_id']),
            models.Index(fields=['content_hash']),
            models.Index(fields=['language']),
            models.Index(fields=['status']),
            models.Index(fields=['project_id', 'status']),
        ]
        unique_together = [['project_id', 'file_path', 'start_line', 'end_line']]

    def __str__(self):
        return f"CodeChunkEmbedding({self.project_id}, {self.file_path}:{self.start_line}-{self.end_line})"

    @staticmethod
    def calculate_content_hash(content: str) -> str:
        from apps.rag.utils import calculate_content_hash
        return calculate_content_hash(content)
