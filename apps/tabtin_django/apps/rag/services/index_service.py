"""
索引管理服务

负责管理向量索引的创建、更新、删除
"""

import logging
from typing import List, Dict, Any, Optional
from django.conf import settings
from django.db import transaction

from apps.services.llm.scenes.exceptions import SceneRoutingDisabled

logger = logging.getLogger(__name__)


MAX_RECORDS_PER_TASK = 5000


class IndexService:
    """
    索引管理服务

    职责：
    - 表格结构向量化
    - 记录内容向量化
    - 增量更新与删除
    - 批量索引管理
    """

    def __init__(self):
        """初始化索引服务"""
        from .embedding_service import get_embedding_service

        self.embedding_service = get_embedding_service()
        self.batch_size = settings.RAG_BATCH_SIZE

        logger.info("✅ 索引服务初始化成功")

    @staticmethod
    def _scene_embed(texts, *, scene_key, user_id="", organization_id=""):
        """通过统一 embedding 入口向量化，返回 list[list[float]]。"""
        from apps.services.llm.services.embedding import embed_text as _embed_text
        result = _embed_text(
            scene_key=scene_key,
            texts=texts,
            user_id=user_id,
            organization_id=organization_id,
        )
        return result.vectors

    # ===== 表格索引 =====

    def index_table(self, table_id: str, force: bool = False) -> Dict[str, Any]:
        """
        为单个表格创建向量索引

        Args:
            table_id: 表格 ID
            force: 是否强制重建（忽略已有索引）

        Returns:
            Dict: 索引结果
        """
        from apps.tabdata.models import Table
        from apps.rag.models import TableEmbedding

        logger.info(f"📇 开始为表格 {table_id} 创建索引")

        try:
            table = Table.objects.get(id=table_id)
        except Table.DoesNotExist:
            logger.warning(f"⚠️ 表格不存在，跳过索引: {table_id}")
            TableEmbedding.objects.filter(table_id=table_id).delete()
            return {
                'status': 'not_found',
                'table_id': str(table_id),
            }

        try:
            table_text = self._build_table_text(table)
            content_hash = self._calculate_hash(table_text)

            if not force:
                existing = TableEmbedding.objects.filter(
                    table_id=table_id,
                    content_hash=content_hash
                ).first()

                if existing:
                    logger.info(f"✅ 表格索引已存在，跳过: {table_id}")
                    return {
                        'status': 'skipped',
                        'reason': '内容未变化',
                        'table_id': str(table_id)
                    }

            _ws_id = str(table.organization_id) if hasattr(table, "organization_id") else ""
            _user_id = str(table.owner_id) if hasattr(table, "owner_id") and table.owner_id else ""
            embedding_vector = self._scene_embed(
                [table_text], scene_key="rag_index_table",
                user_id=_user_id, organization_id=_ws_id,
            )[0]

            # SC-002 修复：使用 bulk_create(update_conflicts=True) 原子 upsert，
            # 消除 update_or_create 的 SELECT+INSERT/UPDATE TOCTOU 竞态。
            _ws_uuid_parsed = None
            if _ws_id:
                try:
                    import uuid as _uuid_mod
                    _ws_uuid_parsed = _uuid_mod.UUID(_ws_id)
                except (ValueError, AttributeError):
                    pass
            _space_uuid_parsed = None
            if hasattr(table, 'space_id') and table.space_id:
                try:
                    import uuid as _uuid_mod
                    _space_uuid_parsed = _uuid_mod.UUID(str(table.space_id))
                except (ValueError, AttributeError):
                    pass
            obj = TableEmbedding(
                table_id=table_id,
                version=1,
                organization_id=_ws_uuid_parsed,
                space_id=_space_uuid_parsed,
                content=table_text,
                content_hash=content_hash,
                embedding=embedding_vector,
                metadata={
                    'table_name': table.name,
                    'description': table.description or '',
                    'organization_id': _ws_id,
                    'space_id': str(table.space_id),
                    'fields': [field.name for field in table.fields.all()],
                    'record_count': table.records.count(),
                    'embedding_provider': getattr(self.embedding_service, 'provider', ''),
                    'embedding_model': getattr(self.embedding_service, 'model', ''),
                    'embedding_dimensions': getattr(self.embedding_service, 'dimensions', 0),
                },
                status='success',
            )
            TableEmbedding.objects.bulk_create(
                [obj],
                update_conflicts=True,
                unique_fields=['table_id', 'version'],
                update_fields=['organization_id', 'space_id', 'content', 'content_hash', 'embedding', 'metadata', 'status', 'updated_at'],
            )

            logger.info(f"✅ 表格索引创建成功: {table.name}")

            return {
                'status': 'success',
                'table_id': str(table_id),
                'table_name': table.name,
            }

        except SceneRoutingDisabled:
            logger.info("⏭️ 表格索引跳过（场景路由已关闭）: table_id=%s", table_id)
            return {
                'status': 'skipped',
                'reason': 'scene_routing_disabled',
                'table_id': str(table_id),
            }
        except Exception as e:
            logger.error(f"❌ 表格索引创建失败: {e}")
            raise

    def index_tables_batch(
        self,
        table_ids: List[str],
        force: bool = False
    ) -> Dict[str, Any]:
        """
        批量为表格创建索引。

        SVC-15 修复：收集所有待 embed 文本后一次调用 embed_texts() 批量接口，
        减少网络往返从 N 次降为 ceil(N/batch_size) 次，性能提升 10-50 倍。

        Args:
            table_ids: 表格 ID 列表
            force: 是否强制重建

        Returns:
            Dict: 批量索引结果
        """
        from apps.tabdata.models import Table
        from apps.rag.models import TableEmbedding

        logger.info(f"📦 批量索引表格: count={len(table_ids)}")

        results: Dict[str, Any] = {
            'total': len(table_ids),
            'success': 0,
            'skipped': 0,
            'failed': 0,
            'errors': []
        }

        if not table_ids:
            return results

        # 1. 一次查询加载所有表格（含字段信息）
        tables_by_id: Dict[str, Any] = {
            str(t.id): t
            for t in Table.objects.filter(id__in=table_ids).prefetch_related('fields', 'records')
        }

        # 2. 找出不存在的 table_id
        for table_id in table_ids:
            if str(table_id) not in tables_by_id:
                TableEmbedding.objects.filter(table_id=table_id).delete()
                results['failed'] += 1
                results['errors'].append({'table_id': str(table_id), 'error': 'not_found'})

        # 3. 计算 hash，区分"需要 embed"与"可跳过"
        need_embed: List[Dict[str, Any]] = []  # [{table, text, hash, ws_id, user_id}]

        existing_hashes: Dict[str, str] = {}
        if not force:
            existing_hashes = {
                str(e.table_id): e.content_hash
                for e in TableEmbedding.objects.filter(
                    table_id__in=list(tables_by_id.keys()), version=1
                ).only('table_id', 'content_hash')
            }

        for table_id in table_ids:
            table = tables_by_id.get(str(table_id))
            if table is None:
                continue
            try:
                table_text = self._build_table_text(table)
                content_hash = self._calculate_hash(table_text)

                if not force and existing_hashes.get(str(table_id)) == content_hash:
                    results['skipped'] += 1
                    continue

                _ws_id = str(table.organization_id) if hasattr(table, "organization_id") else ""
                _user_id = str(table.owner_id) if hasattr(table, "owner_id") and table.owner_id else ""
                need_embed.append({
                    'table': table,
                    'text': table_text,
                    'hash': content_hash,
                    'ws_id': _ws_id,
                    'user_id': _user_id,
                })
            except Exception as e:
                results['failed'] += 1
                results['errors'].append({'table_id': str(table_id), 'error': str(e)})
                logger.error(f"❌ 表格 {table_id} 文本构建失败: {e}")

        if not need_embed:
            logger.info(
                f"✅ 批量索引完成: 成功={results['success']}, "
                f"跳过={results['skipped']}, 失败={results['failed']}"
            )
            return results

        # RAG-7: 按 ws_id 分组，每组使用对应的计费上下文
        ws_groups: Dict[str, List[Dict[str, Any]]] = {}
        for item in need_embed:
            ws_groups.setdefault(item['ws_id'], []).append(item)

        for group_ws_id, group_items in ws_groups.items():
            group_user_id = group_items[0]['user_id']
            texts = [item['text'] for item in group_items]
            try:
                vectors = self._scene_embed(
                    texts, scene_key="rag_index_table",
                    user_id=group_user_id, organization_id=group_ws_id,
                )
            except SceneRoutingDisabled:
                results['skipped'] += len(group_items)
                logger.info(
                    "⏭️ 批量表格索引跳过（场景路由已关闭）: ws=%s count=%d",
                    group_ws_id, len(group_items),
                )
                continue
            except Exception as e:
                logger.error(f"❌ 批量 embed 失败 (ws={group_ws_id})，将逐条降级: {e}")
                for item in group_items:
                    try:
                        vec = self._scene_embed(
                            [item['text']], scene_key="rag_index_table",
                            user_id=item['user_id'], organization_id=item['ws_id'],
                        )[0]
                        self._upsert_table_embedding(item, vec)
                        results['success'] += 1
                    except Exception as ie:
                        results['failed'] += 1
                        results['errors'].append({'table_id': str(item['table'].id), 'error': str(ie)})
                continue

            for item, vector in zip(group_items, vectors):
                try:
                    self._upsert_table_embedding(item, vector)
                    results['success'] += 1
                except Exception as e:
                    results['failed'] += 1
                    results['errors'].append({'table_id': str(item['table'].id), 'error': str(e)})
                    logger.error(f"❌ 表格 {item['table'].id} upsert 失败: {e}")

        logger.info(
            f"✅ 批量索引完成: 成功={results['success']}, "
            f"跳过={results['skipped']}, 失败={results['failed']}"
        )
        return results

    def _upsert_table_embedding(self, item: Dict[str, Any], vector: List[float]) -> None:
        """将单个表格 embedding 写入 DB。

        SC-002 修复：使用 bulk_create(update_conflicts=True) 替代 update_or_create，
        在 PostgreSQL 层通过单条 INSERT ... ON CONFLICT DO UPDATE 原子完成 upsert，
        消除 SELECT + INSERT/UPDATE 两步操作之间的 TOCTOU 竞态。
        """
        from apps.rag.models import TableEmbedding

        table = item['table']
        metadata = {
            'table_name': table.name,
            'description': table.description or '',
            'organization_id': item['ws_id'],
            'space_id': str(table.space_id) if hasattr(table, 'space_id') else '',
            'fields': [field.name for field in table.fields.all()],
            'record_count': table.records.count(),
            'embedding_provider': getattr(self.embedding_service, 'provider', ''),
            'embedding_model': getattr(self.embedding_service, 'model', ''),
            'embedding_dimensions': getattr(self.embedding_service, 'dimensions', 0),
        }
        _ws_uuid = None
        if item['ws_id']:
            try:
                import uuid as _uuid_mod
                _ws_uuid = _uuid_mod.UUID(item['ws_id'])
            except (ValueError, AttributeError):
                pass
        _space_uuid = None
        if hasattr(table, 'space_id') and table.space_id:
            try:
                import uuid as _uuid_mod
                _space_uuid = _uuid_mod.UUID(str(table.space_id))
            except (ValueError, AttributeError):
                pass
        obj = TableEmbedding(
            table_id=table.id,
            version=1,
            organization_id=_ws_uuid,
            space_id=_space_uuid,
            content=item['text'],
            content_hash=item['hash'],
            embedding=vector,
            metadata=metadata,
            status='success',
        )
        TableEmbedding.objects.bulk_create(
            [obj],
            update_conflicts=True,
            unique_fields=['table_id', 'version'],
            update_fields=['organization_id', 'space_id', 'content', 'content_hash', 'embedding', 'metadata', 'status', 'updated_at'],
        )

    # ===== 记录索引 =====

    def index_record(
        self,
        record_id: str,
        force: bool = False
    ) -> Dict[str, Any]:
        """
        为单条记录创建向量索引

        Args:
            record_id: 记录 ID
            force: 是否强制重建

        Returns:
            Dict: 索引结果
        """
        from apps.tabdata.models import TableRecord
        from apps.rag.models import RecordEmbedding

        logger.info(f"📝 开始为记录 {record_id} 创建索引")

        try:
            # 获取记录信息
            record = TableRecord.objects.select_related('table').get(id=record_id)

            # 构建记录文本
            record_text = self._build_record_text(record)

            if not record_text.strip():
                logger.warning(f"⚠️ 记录内容为空，跳过: {record_id}")
                return {
                    'status': 'skipped',
                    'reason': '内容为空',
                    'record_id': str(record_id)
                }

            content_hash = self._calculate_hash(record_text)

            # 检查是否已存在相同内容的索引
            if not force:
                existing = RecordEmbedding.objects.filter(
                    record_id=record_id,
                    content_hash=content_hash
                ).first()

                if existing:
                    logger.debug(f"✅ 记录索引已存在，跳过: {record_id}")
                    return {
                        'status': 'skipped',
                        'reason': '内容未变化',
                        'record_id': str(record_id)
                    }

            _ws_id = str(record.table.organization_id) if hasattr(record.table, "organization_id") else ""
            _user_id = str(record.table.owner_id) if hasattr(record.table, "owner_id") and record.table.owner_id else ""
            embedding_vector = self._scene_embed(
                [record_text], scene_key="rag_index_record",
                user_id=_user_id, organization_id=_ws_id,
            )[0]

            # SC-002 修复：使用 bulk_create(update_conflicts=True) 原子 upsert，
            # 消除 update_or_create 的 SELECT+INSERT/UPDATE TOCTOU 竞态。
            _ws_uuid_parsed = None
            if _ws_id:
                try:
                    import uuid as _uuid_mod
                    _ws_uuid_parsed = _uuid_mod.UUID(_ws_id)
                except (ValueError, AttributeError):
                    pass
            _space_uuid_parsed = None
            if hasattr(record.table, "space_id") and record.table.space_id:
                try:
                    import uuid as _uuid_mod
                    _space_uuid_parsed = _uuid_mod.UUID(str(record.table.space_id))
                except (ValueError, AttributeError):
                    pass
            obj = RecordEmbedding(
                record_id=record_id,
                table_id=record.table_id,
                version=1,
                organization_id=_ws_uuid_parsed,
                space_id=_space_uuid_parsed,
                content=record_text,
                content_hash=content_hash,
                embedding=embedding_vector,
                metadata={
                    'table_name': record.table.name,
                    'table_id': str(record.table_id),
                    'organization_id': _ws_id,
                    'space_id': str(record.table.space_id) if hasattr(record.table, "space_id") else "",
                    'created_at': record.created_at.isoformat(),
                    'embedding_provider': getattr(self.embedding_service, 'provider', ''),
                    'embedding_model': getattr(self.embedding_service, 'model', ''),
                    'embedding_dimensions': getattr(self.embedding_service, 'dimensions', 0),
                },
                status='success',
            )
            RecordEmbedding.objects.bulk_create(
                [obj],
                update_conflicts=True,
                unique_fields=['record_id', 'version'],
                update_fields=['table_id', 'organization_id', 'space_id', 'content', 'content_hash', 'embedding', 'metadata', 'status', 'updated_at'],
            )

            logger.debug(f"✅ 记录索引创建成功: {record_id}")

            return {
                'status': 'success',
                'record_id': str(record_id),
            }

        except SceneRoutingDisabled:
            logger.info("⏭️ 记录索引跳过（场景路由已关闭）: record_id=%s", record_id)
            return {
                'status': 'skipped',
                'reason': 'scene_routing_disabled',
                'record_id': str(record_id),
            }
        except Exception as e:
            logger.error(f"❌ 记录索引创建失败: {e}")
            raise

    def index_records_batch(
        self,
        record_ids: List[str],
        force: bool = False
    ) -> Dict[str, Any]:
        """
        批量为记录创建索引。

        SVC-15 修复：按 batch_size 分批调用 embed_texts() 批量接口，
        减少网络往返从 N 次降为 ceil(N/batch_size) 次。

        Args:
            record_ids: 记录 ID 列表
            force: 是否强制重建

        Returns:
            Dict: 批量索引结果
        """
        from apps.tabdata.models import TableRecord
        from apps.rag.models import RecordEmbedding

        logger.info(f"📦 批量索引记录: count={len(record_ids)}")

        results: Dict[str, Any] = {
            'total': len(record_ids),
            'success': 0,
            'skipped': 0,
            'failed': 0,
            'errors': []
        }

        if not record_ids:
            return results

        # 1. 分批处理（保留 batch_size 控制，避免一次加载过多记录）
        for batch_start in range(0, len(record_ids), self.batch_size):
            batch_ids = record_ids[batch_start:batch_start + self.batch_size]
            self._index_records_batch_chunk(batch_ids, force, results)

        logger.info(
            f"✅ 批量索引完成: 成功={results['success']}, "
            f"跳过={results['skipped']}, 失败={results['failed']}"
        )
        return results

    def _index_records_batch_chunk(
        self,
        record_ids: List[str],
        force: bool,
        results: Dict[str, Any],
    ) -> None:
        """处理单个 batch 的记录索引（供 index_records_batch 调用）。"""
        from apps.tabdata.models import TableRecord
        from apps.rag.models import RecordEmbedding

        # 加载这批记录
        records_by_id: Dict[str, Any] = {
            str(r.id): r
            for r in TableRecord.objects.select_related('table').filter(id__in=record_ids)
        }

        # 标记缺失记录
        for rid in record_ids:
            if str(rid) not in records_by_id:
                results['failed'] += 1
                results['errors'].append({'record_id': str(rid), 'error': 'not_found'})

        # 加载已有 hash
        existing_hashes: Dict[str, str] = {}
        if not force:
            existing_hashes = {
                str(e.record_id): e.content_hash
                for e in RecordEmbedding.objects.filter(
                    record_id__in=list(records_by_id.keys()), version=1
                ).only('record_id', 'content_hash')
            }

        # SI-04: 批量预取本 chunk 涉及的所有表格字段，避免 N×M 次重复字段查询。
        from apps.tabdata.models import TableField as _TableField
        _table_ids_in_chunk = {r.table_id for r in records_by_id.values()}
        _fields_by_table: Dict[str, List[Any]] = {
            str(tid): list(
                _TableField.objects.filter(table_id=tid).order_by('order')
            )
            for tid in _table_ids_in_chunk
        }

        need_embed: List[Dict[str, Any]] = []
        for rid in record_ids:
            record = records_by_id.get(str(rid))
            if record is None:
                continue
            try:
                record_text = self._build_record_text(
                    record, fields=_fields_by_table.get(str(record.table_id))
                )
                if not record_text.strip():
                    results['skipped'] += 1
                    continue
                content_hash = self._calculate_hash(record_text)
                if not force and existing_hashes.get(str(rid)) == content_hash:
                    results['skipped'] += 1
                    continue
                _ws_id = str(record.table.organization_id) if hasattr(record.table, "organization_id") else ""
                _user_id = str(record.table.owner_id) if hasattr(record.table, "owner_id") and record.table.owner_id else ""
                need_embed.append({
                    'record': record,
                    'text': record_text,
                    'hash': content_hash,
                    'ws_id': _ws_id,
                    'user_id': _user_id,
                })
            except Exception as e:
                results['failed'] += 1
                results['errors'].append({'record_id': str(rid), 'error': str(e)})
                logger.error(f"❌ 记录 {rid} 文本构建失败: {e}")

        if not need_embed:
            return

        # RAG-7: 按 ws_id 分组，每组使用对应的计费上下文
        ws_groups: Dict[str, List[Dict[str, Any]]] = {}
        for item in need_embed:
            ws_groups.setdefault(item['ws_id'], []).append(item)

        for group_ws_id, group_items in ws_groups.items():
            group_user_id = group_items[0]['user_id']
            texts = [item['text'] for item in group_items]
            try:
                vectors = self._scene_embed(
                    texts, scene_key="rag_index_record",
                    user_id=group_user_id, organization_id=group_ws_id,
                )
            except SceneRoutingDisabled:
                results['skipped'] += len(group_items)
                logger.info(
                    "⏭️ 批量记录索引跳过（场景路由已关闭）: ws=%s count=%d",
                    group_ws_id, len(group_items),
                )
                continue
            except Exception as e:
                logger.error(f"❌ 批量 embed 失败 (ws={group_ws_id})，将逐条降级: {e}")
                for item in group_items:
                    try:
                        vec = self._scene_embed(
                            [item['text']], scene_key="rag_index_record",
                            user_id=item['user_id'], organization_id=item['ws_id'],
                        )[0]
                        self._upsert_record_embedding(item, vec)
                        results['success'] += 1
                    except Exception as ie:
                        results['failed'] += 1
                        results['errors'].append({'record_id': str(item['record'].id), 'error': str(ie)})
                continue

            for item, vector in zip(group_items, vectors):
                try:
                    self._upsert_record_embedding(item, vector)
                    results['success'] += 1
                except Exception as e:
                    results['failed'] += 1
                    results['errors'].append({'record_id': str(item['record'].id), 'error': str(e)})
                    logger.error(f"❌ 记录 {item['record'].id} upsert 失败: {e}")

    def _upsert_record_embedding(self, item: Dict[str, Any], vector: List[float]) -> None:
        """将单条记录 embedding 写入 DB。

        SC-002 修复：使用 bulk_create(update_conflicts=True) 替代 update_or_create，
        在 PostgreSQL 层通过单条 INSERT ... ON CONFLICT DO UPDATE 原子完成 upsert，
        消除 SELECT + INSERT/UPDATE 两步操作之间的 TOCTOU 竞态。
        """
        from apps.rag.models import RecordEmbedding

        record = item['record']
        metadata = {
            'table_name': record.table.name,
            'table_id': str(record.table_id),
            'organization_id': item['ws_id'],
            'space_id': str(record.table.space_id) if hasattr(record.table, "space_id") else "",
            'created_at': record.created_at.isoformat(),
            'embedding_provider': getattr(self.embedding_service, 'provider', ''),
            'embedding_model': getattr(self.embedding_service, 'model', ''),
            'embedding_dimensions': getattr(self.embedding_service, 'dimensions', 0),
        }
        _ws_uuid = None
        if item['ws_id']:
            try:
                import uuid as _uuid_mod
                _ws_uuid = _uuid_mod.UUID(item['ws_id'])
            except (ValueError, AttributeError):
                pass
        _space_uuid = None
        if hasattr(record.table, "space_id") and record.table.space_id:
            try:
                import uuid as _uuid_mod
                _space_uuid = _uuid_mod.UUID(str(record.table.space_id))
            except (ValueError, AttributeError):
                pass
        obj = RecordEmbedding(
            record_id=record.id,
            table_id=record.table_id,
            version=1,
            organization_id=_ws_uuid,
            space_id=_space_uuid,
            content=item['text'],
            content_hash=item['hash'],
            embedding=vector,
            metadata=metadata,
            status='success',
        )
        RecordEmbedding.objects.bulk_create(
            [obj],
            update_conflicts=True,
            unique_fields=['record_id', 'version'],
            update_fields=['table_id', 'organization_id', 'space_id', 'content', 'content_hash', 'embedding', 'metadata', 'status', 'updated_at'],
        )

    def index_table_records(
        self,
        table_id: str,
        force: bool = False
    ) -> Dict[str, Any]:
        """
        为表格下的所有记录创建索引

        P1-9 修复：大表（>MAX_RECORDS_PER_TASK）拆分为多个子任务交错 dispatch，
        避免单任务超时；小表使用 .iterator(chunk_size=500) 替代 list() 一次性加载。

        Args:
            table_id: 表格 ID
            force: 是否强制重建

        Returns:
            Dict: 索引结果（大表返回 status='split'）
        """
        from apps.tabdata.models import TableRecord

        logger.info(f"📊 为表格 {table_id} 的所有记录创建索引")

        base_qs = TableRecord.objects.filter(
            table_id=table_id, is_deleted=False
        )
        total = base_qs.count()

        if total == 0:
            logger.warning(f"⚠️ 表格无记录: {table_id}")
            return {
                'total': 0, 'success': 0, 'skipped': 0, 'failed': 0, 'errors': [],
            }

        if total > MAX_RECORDS_PER_TASK:
            from apps.rag.tasks import index_records_batch_task
            id_qs = base_qs.order_by('id').values_list('id', flat=True)
            batch_idx = 0
            for offset in range(0, total, MAX_RECORDS_PER_TASK):
                batch_ids = list(
                    id_qs[offset:offset + MAX_RECORDS_PER_TASK]
                )
                if batch_ids:
                    index_records_batch_task.apply_async(
                        args=[[str(rid) for rid in batch_ids]],
                        kwargs={'force': force},
                        countdown=batch_idx * 10,
                    )
                    batch_idx += 1
            logger.info(
                "📊 大表拆分为 %d 个子任务: table_id=%s, total=%d",
                batch_idx, table_id, total,
            )
            return {
                'status': 'split',
                'total': total,
                'batches': batch_idx,
                'table_id': str(table_id),
            }

        record_ids = [
            str(rid) for rid in
            base_qs.values_list('id', flat=True).iterator(chunk_size=500)
        ]
        return self.index_records_batch(record_ids, force=force)

    # ===== 删除索引 =====

    def delete_table_index(self, table_id: str):
        """删除表格索引"""
        from apps.rag.models import TableEmbedding

        deleted_count = TableEmbedding.objects.filter(table_id=table_id).delete()[0]
        logger.info(f"🗑️ 删除表格索引: {table_id}, count={deleted_count}")

        return {'deleted': deleted_count}

    def delete_record_index(self, record_id: str):
        """删除记录索引"""
        from apps.rag.models import RecordEmbedding

        deleted_count = RecordEmbedding.objects.filter(record_id=record_id).delete()[0]
        logger.debug(f"🗑️ 删除记录索引: {record_id}, count={deleted_count}")

        return {'deleted': deleted_count}

    def delete_table_records_index(self, table_id: str):
        """删除表格下的所有记录索引"""
        from apps.rag.models import RecordEmbedding

        deleted_count = RecordEmbedding.objects.filter(table_id=table_id).delete()[0]
        logger.info(f"🗑️ 删除表格所有记录索引: {table_id}, count={deleted_count}")

        return {'deleted': deleted_count}

    # ===== 工具方法 =====

    def _build_table_text(self, table) -> str:
        """
        构建表格描述文本

        格式：
        表格名称: xxx
        描述: xxx
        字段: field1 (type), field2 (type), ...
        记录数: xxx

        SI-03 修复：使用 table.fields.all() 并在 Python 层排序，
        避免绕过 prefetch_related 缓存触发额外字段查询。
        """
        lines = [f"表格名称: {table.name}"]

        if table.description:
            lines.append(f"描述: {table.description}")

        # SI-03: 通过关联管理器访问，批量场景命中 prefetch 缓存（0 次额外 DB 查询），
        # 单条场景退回到单次关联查询，在 Python 层排序避免修改 queryset 导致缓存失效。
        fields = sorted(table.fields.all(), key=lambda f: f.order)
        field_texts = [
            f"{field.name} ({field.field_type})"
            for field in fields
        ]

        if field_texts:
            lines.append(f"字段: {', '.join(field_texts)}")

        # 记录数：COUNT 查询开销低，保持不变
        record_count = table.records.count()
        lines.append(f"记录数: {record_count}")

        return "\n".join(lines)

    def _build_record_text(self, record, fields=None) -> str:
        """
        构建记录文本

        格式：
        表格: xxx
        field1: value1
        field2: value2
        ...

        Args:
            record: TableRecord 实例
            fields: 可选，预加载的 TableField 列表（SI-04 修复）。
                    为 None 时退回到单次 DB 查询（保持向后兼容）。
        """
        from apps.tabdata.models import TableField

        lines = [f"表格: {record.table.name}"]

        # SI-04: 优先使用调用方预加载的 fields，避免 N×M 次重复字段查询。
        if fields is None:
            fields = TableField.objects.filter(table_id=record.table_id).order_by('order')

        record_data = record.get_record_data()
        for field in fields:
            field_name = field.name
            field_id = str(field.id)
            value = record_data.get(field_id)
            if value is None:
                value = record_data.get(field_name)

            if value is not None and str(value).strip():
                formatted_value = self._format_field_value(value, field.field_type)
                lines.append(f"{field_name}: {formatted_value}")

        return "\n".join(lines)

    def _format_field_value(self, value: Any, field_type: str) -> str:
        """格式化字段值"""
        if isinstance(value, (list, dict)):
            import json
            return json.dumps(value, ensure_ascii=False)

        return str(value)

    @staticmethod
    def _calculate_hash(text: str) -> str:
        from apps.rag.utils import calculate_content_hash
        return calculate_content_hash(text)

    # ===== 统计信息 =====

    def get_index_stats(self) -> Dict[str, Any]:
        """获取索引统计信息"""
        from apps.rag.models import (
            TableEmbedding, RecordEmbedding, DocumentEmbedding, SkillEmbedding,
        )

        table_count = TableEmbedding.objects.count()
        record_count = RecordEmbedding.objects.count()
        document_count = DocumentEmbedding.objects.count()
        skill_count = SkillEmbedding.objects.count()

        stats = {
            'table_embeddings': table_count,
            'record_embeddings': record_count,
            'document_embeddings': document_count,
            'skill_embeddings': skill_count,
            'total_embeddings': table_count + record_count + document_count + skill_count,
        }

        logger.info(f"📊 索引统计: {stats}")
        return stats
