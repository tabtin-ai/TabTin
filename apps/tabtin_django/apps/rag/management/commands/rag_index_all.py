"""
Django 管理命令：为所有表格（及文档）创建索引
"""

from django.core.management.base import BaseCommand
from django.conf import settings


class Command(BaseCommand):
    help = '为所有表格（及文档）创建向量索引'

    def add_arguments(self, parser):
        parser.add_argument(
            '--force',
            action='store_true',
            help='强制重建所有索引',
        )
        parser.add_argument(
            '--async',
            action='store_true',
            dest='use_async',
            help='使用异步任务',
        )
        parser.add_argument(
            '--backfill-metadata',
            action='store_true',
            help='回填 RecordEmbedding 中缺失的 organization_id',
        )
        parser.add_argument(
            '--include-documents',
            action='store_true',
            help='同时为所有活跃文档创建向量索引',
        )
        parser.add_argument(
            '--backfill-task-organization',
            action='store_true',
            help='回填 EmbeddingTask 中缺失的 organization_id',
        )

    def handle(self, *args, **options):
        if options['backfill_task_organization']:
            self._handle_backfill_task_organization()
            return

        if options['backfill_metadata']:
            self._handle_backfill()
            if not options['include_documents']:
                return

        if not options['backfill_metadata']:
            self._handle_tables(options)

        if options['include_documents']:
            self._handle_documents(force=options['force'], use_async=options['use_async'])

    def _handle_tables(self, options):
        from apps.tabdata.models import Table
        from apps.rag.services import IndexService
        from apps.rag.tasks import index_batch_tables_task

        force = options['force']
        use_async = options['use_async']

        self.stdout.write("=" * 60)
        self.stdout.write("RAG 索引创建工具")
        self.stdout.write("=" * 60)

        # EQ-009: 使用 values_list + iterator 只取 ID，避免全量加载 Table 对象
        table_id_qs = Table.objects.values_list('id', flat=True)
        total = table_id_qs.count()

        if total == 0:
            self.stdout.write(self.style.WARNING("没有找到任何表格"))
            return

        self.stdout.write(f"\n找到 {total} 个表格")

        table_ids = [str(tid) for tid in table_id_qs.iterator()]

        if use_async:
            # 异步方式
            self.stdout.write("\n提交异步任务...")
            task = index_batch_tables_task.delay(table_ids, force)
            self.stdout.write(self.style.SUCCESS(f"✅ 任务已提交: {task.id}"))
            self.stdout.write(f"查询状态: python manage.py rag_task_status {task.id}")
        else:
            # 同步方式
            self.stdout.write(f"\n开始索引 (force={force})...")

            service = IndexService()
            result = service.index_tables_batch(table_ids, force=force)

            self.stdout.write("\n" + "=" * 60)
            self.stdout.write("索引结果")
            self.stdout.write("=" * 60)
            self.stdout.write(f"总数: {result['total']}")
            self.stdout.write(self.style.SUCCESS(f"成功: {result['success']}"))
            self.stdout.write(self.style.WARNING(f"跳过: {result['skipped']}"))

            if result['failed'] > 0:
                self.stdout.write(self.style.ERROR(f"失败: {result['failed']}"))

                if result.get('errors'):
                    self.stdout.write("\n错误详情:")
                    for error in result['errors'][:5]:  # 只显示前5个
                        self.stdout.write(f"  - {error['table_id']}: {error['error']}")

            self.stdout.write("\n" + "=" * 60)

            if result['failed'] == 0:
                self.stdout.write(self.style.SUCCESS("✅ 所有索引创建成功！"))
            else:
                self.stdout.write(self.style.WARNING("⚠️ 部分索引创建失败"))

    def _handle_documents(self, force: bool = False, use_async: bool = False):
        """为所有活跃文档创建向量索引。"""
        from apps.tabdoc.models import Document

        self.stdout.write("\n" + "=" * 60)
        self.stdout.write("文档向量索引")
        self.stdout.write("=" * 60)

        docs = Document.objects.filter(
            trashed_at__isnull=True,
        ).exclude(status="archived")
        total = docs.count()

        if total == 0:
            self.stdout.write(self.style.WARNING("没有找到活跃文档"))
            return

        self.stdout.write(f"找到 {total} 个活跃文档")
        # EQ-009: 使用 values_list + iterator 只取 ID，避免全量加载 Document 对象
        doc_ids = [str(did) for did in docs.values_list('id', flat=True).iterator()]

        if use_async:
            from apps.rag.tasks import index_documents_batch_task
            task = index_documents_batch_task.delay(doc_ids, force)
            self.stdout.write(self.style.SUCCESS(f"✅ 文档索引任务已提交: {task.id}"))
        else:
            from apps.tabdoc.services.document_embedding_service import DocumentEmbeddingService
            result = DocumentEmbeddingService.index_documents_batch(doc_ids, force=force)
            self.stdout.write(self.style.SUCCESS(f"成功: {result['success']}"))
            self.stdout.write(self.style.WARNING(f"跳过: {result['skipped']}"))
            if result['failed']:
                self.stdout.write(self.style.ERROR(f"失败: {result['failed']}"))
            else:
                self.stdout.write(self.style.SUCCESS("✅ 文档索引完成"))

    def _handle_backfill(self):
        from apps.rag.tasks import backfill_record_metadata_task

        self.stdout.write("=" * 60)
        self.stdout.write("RecordEmbedding metadata 回填")
        self.stdout.write("=" * 60)

        result = backfill_record_metadata_task()
        self.stdout.write(f"更新: {result['updated']}")
        self.stdout.write(f"跳过: {result['skipped']}")
        if result['failed']:
            self.stdout.write(self.style.ERROR(f"失败: {result['failed']}"))
        else:
            self.stdout.write(self.style.SUCCESS("✅ 回填完成"))

    def _handle_backfill_task_organization(self):
        """回填 EmbeddingTask 中缺失的 organization_id。"""
        from apps.rag.models import EmbeddingTask
        from apps.tabdata.models import Table, TableRecord

        self.stdout.write("=" * 60)
        self.stdout.write("EmbeddingTask organization_id 回填")
        self.stdout.write("=" * 60)

        tasks_to_fill = EmbeddingTask.objects.filter(organization_id__isnull=True)
        total = tasks_to_fill.count()
        if total == 0:
            self.stdout.write(self.style.SUCCESS("✅ 无需回填"))
            return

        self.stdout.write(f"待回填: {total} 条")

        updated = 0
        failed = 0
        batch_size = 500

        table_cache: dict = {}
        record_cache: dict = {}
        doc_cache: dict = {}

        pending_objs: list = []

        for task in tasks_to_fill.only("id", "task_type", "target_id").iterator(chunk_size=batch_size):
            tid = str(task.target_id)
            ws_id = None

            if task.task_type in ("table", "batch"):
                if tid not in table_cache:
                    t = Table.objects.filter(id=tid).only("organization_id").first()
                    table_cache[tid] = str(t.organization_id) if t else None
                ws_id = table_cache[tid]

            elif task.task_type == "record":
                if tid not in record_cache:
                    rec = TableRecord.objects.filter(id=tid).only("table_id").first()
                    if rec:
                        t_id = str(rec.table_id)
                        if t_id not in table_cache:
                            t = Table.objects.filter(id=t_id).only("organization_id").first()
                            table_cache[t_id] = str(t.organization_id) if t else None
                        record_cache[tid] = table_cache[t_id]
                    else:
                        record_cache[tid] = None
                ws_id = record_cache[tid]

            elif task.task_type == "document":
                if tid not in doc_cache:
                    try:
                        from apps.tabdoc.models import Document
                        doc = Document.objects.filter(id=tid).only("organization_id").first()
                        doc_cache[tid] = str(doc.organization_id) if doc else None
                    except Exception:
                        doc_cache[tid] = None
                ws_id = doc_cache[tid]

            if ws_id:
                task.organization_id = ws_id
                pending_objs.append(task)
            else:
                failed += 1

            if len(pending_objs) >= batch_size:
                EmbeddingTask.objects.bulk_update(pending_objs, ['organization_id'], batch_size=batch_size)
                updated += len(pending_objs)
                pending_objs = []

        if pending_objs:
            EmbeddingTask.objects.bulk_update(pending_objs, ['organization_id'], batch_size=batch_size)
            updated += len(pending_objs)

        self.stdout.write(f"更新: {updated}")
        if failed:
            self.stdout.write(self.style.WARNING(f"无法解析: {failed}（目标资源可能已删除）"))
        else:
            self.stdout.write(self.style.SUCCESS("✅ 回填完成"))
