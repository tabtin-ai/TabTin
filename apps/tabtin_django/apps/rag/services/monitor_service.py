"""
RAG 监控服务

提供索引质量统计、性能监控、检索质量分析
"""

import hashlib
import logging
from typing import Dict, Any, List, Optional
from datetime import datetime, timedelta
from django.utils import timezone
from django.db.models import Avg, Count, Q, F
from django.conf import settings

logger = logging.getLogger(__name__)


class MonitorService:
    """
    监控服务

    职责：
    - 索引质量统计
    - 性能指标监控
    - 检索效果分析
    - 异常检测
    """

    def __init__(self):
        """初始化监控服务"""
        logger.info("✅ 监控服务初始化成功")

    @staticmethod
    def _mask_query(query: str, max_chars: int = 20) -> str:
        """SEC-07: 脱敏查询文本，只返回前 N 字符 + MD5 短哈希，保护用户隐私。"""
        if not query:
            return ""
        if len(query) <= max_chars:
            return query
        suffix = hashlib.md5(query.encode('utf-8', errors='replace')).hexdigest()[:6]
        return f"{query[:max_chars]}...({suffix})"

    # ===== 索引质量统计 =====

    def get_index_quality_stats(self) -> Dict[str, Any]:
        """获取索引质量统计（含 Document / Skill）。"""
        from apps.rag.models import (
            TableEmbedding, RecordEmbedding, EmbeddingTask,
            DocumentEmbedding, SkillEmbedding,
        )

        try:
            total_tables = TableEmbedding.objects.count()
            total_records = RecordEmbedding.objects.count()
            total_documents = DocumentEmbedding.objects.count()
            total_skills = SkillEmbedding.objects.count()

            table_status = TableEmbedding.objects.values('status').annotate(count=Count('id'))
            record_status = RecordEmbedding.objects.values('status').annotate(count=Count('id'))
            document_status = DocumentEmbedding.objects.values('status').annotate(count=Count('id'))
            task_stats = EmbeddingTask.objects.values('status').annotate(count=Count('id'))

            # SS-004: 补充 skill_status 分布（基于 EmbeddingTask.task_type='skill'）
            skill_task_status = (
                EmbeddingTask.objects
                .filter(task_type='skill')
                .values('status')
                .annotate(count=Count('id'))
            )
            yesterday = timezone.now() - timedelta(hours=24)
            recent_tables = TableEmbedding.objects.filter(created_at__gte=yesterday).count()
            recent_records = RecordEmbedding.objects.filter(created_at__gte=yesterday).count()
            recent_documents = DocumentEmbedding.objects.filter(created_at__gte=yesterday).count()

            # SS-004: 补充近 24h Skills 新增数
            recent_skills = SkillEmbedding.objects.filter(created_at__gte=yesterday).count()

            # EQ-010: failure_rate 与 recent_24h 保持同一统计口径（近 24h）
            recent_total_tasks = EmbeddingTask.objects.filter(created_at__gte=yesterday).count()
            recent_failed_tasks = EmbeddingTask.objects.filter(
                created_at__gte=yesterday, status='failed'
            ).count()
            failure_rate = (
                (recent_failed_tasks / recent_total_tasks * 100)
                if recent_total_tasks > 0 else 0
            )

            return {
                'total_tables': total_tables,
                'total_records': total_records,
                'total_documents': total_documents,
                'total_skills': total_skills,
                'table_status': {item['status']: item['count'] for item in table_status},
                'record_status': {item['status']: item['count'] for item in record_status},
                'document_status': {item['status']: item['count'] for item in document_status},
                'skill_task_status': {item['status']: item['count'] for item in skill_task_status},
                'task_stats': {item['status']: item['count'] for item in task_stats},
                'recent_24h': {
                    'tables': recent_tables,
                    'records': recent_records,
                    'documents': recent_documents,
                    'skills': recent_skills,
                },
                'failure_rate': round(failure_rate, 2),
                'failure_rate_period': '24h',
                'failure_rate_scope': 'EmbeddingTask (all task types)',
                'timestamp': timezone.now().isoformat(),
            }

        except Exception as e:
            logger.error(f"❌ 获取索引质量统计失败: {e}")
            raise

    def get_index_coverage(self) -> Dict[str, Any]:
        """获取索引覆盖率（含 Document / Skill）。"""
        from apps.tabdata.models import Table, TableRecord
        from apps.rag.models import TableEmbedding, RecordEmbedding, DocumentEmbedding, SkillEmbedding

        try:
            total_tables = Table.objects.count()
            total_records = TableRecord.objects.count()
            indexed_tables = TableEmbedding.objects.values('table_id').distinct().count()
            indexed_records = RecordEmbedding.objects.values('record_id').distinct().count()
            table_coverage = (indexed_tables / total_tables * 100) if total_tables > 0 else 0
            record_coverage = (indexed_records / total_records * 100) if total_records > 0 else 0
            indexed_table_ids = TableEmbedding.objects.values('table_id')
            unindexed_tables = Table.objects.exclude(id__in=indexed_table_ids).count()

            total_documents = 0
            indexed_documents = 0
            try:
                from apps.tabdoc.models import Document
                active_docs = Document.objects.filter(
                    trashed_at__isnull=True
                ).exclude(status='archived').values('id')
                total_documents = active_docs.count()
                # EQ-002: 只统计关联文档仍存在且活跃的 embedding，防止分子 > 分母
                indexed_documents = DocumentEmbedding.objects.filter(
                    document_id__in=active_docs
                ).values('document_id').distinct().count()
            except Exception:
                pass

            doc_coverage = (indexed_documents / total_documents * 100) if total_documents > 0 else 0

            # SS-005: 补充 Skill 覆盖率统计
            # SkillEmbedding 直接即为已索引，total = 所有注册 skill（系统+市场+本地）
            # 由于 Skill 没有单独的"全量"表，用 EmbeddingTask 追踪失败数来表示漏洞
            total_skill_embeddings = SkillEmbedding.objects.count()
            skill_failed_tasks = 0
            try:
                from apps.rag.models import EmbeddingTask
                skill_failed_tasks = EmbeddingTask.objects.filter(
                    task_type='skill', status='failed'
                ).count()
            except Exception:
                pass

            return {
                'table_coverage': {
                    'total': total_tables,
                    'indexed': indexed_tables,
                    'unindexed': unindexed_tables,
                    'coverage_rate': round(table_coverage, 2),
                },
                'record_coverage': {
                    'total': total_records,
                    'indexed': indexed_records,
                    'unindexed': total_records - indexed_records,
                    'coverage_rate': round(record_coverage, 2),
                },
                'document_coverage': {
                    'total': total_documents,
                    'indexed': indexed_documents,
                    'unindexed': total_documents - indexed_documents,
                    'coverage_rate': round(doc_coverage, 2),
                },
                # SS-005: 新增 skill_coverage（基于 SkillEmbedding 总数 + EmbeddingTask 失败数）
                'skill_coverage': {
                    'indexed': total_skill_embeddings,
                    'failed_tasks': skill_failed_tasks,
                    'note': 'Skills have no canonical "total" table; failed_tasks tracks indexing failures',
                },
                'timestamp': timezone.now().isoformat(),
            }

        except Exception as e:
            logger.error(f"❌ 获取索引覆盖率失败: {e}")
            raise

    # ===== 性能监控 =====

    def get_performance_metrics(self, hours: int = 24) -> Dict[str, Any]:
        """
        获取性能指标

        Args:
            hours: 统计时间范围（小时）

        Returns:
            Dict: 性能指标
        """
        from apps.rag.models import SearchLog

        try:
            cutoff_time = timezone.now() - timedelta(hours=hours)

            # 查询日志
            logs = SearchLog.objects.filter(created_at__gte=cutoff_time)

            if not logs.exists():
                return {
                    'total_searches': 0,
                    'avg_response_time': 0,
                    'message': '暂无数据'
                }

            # 统计
            total_searches = logs.count()
            avg_response_time = logs.aggregate(Avg('response_time_ms'))['response_time_ms__avg']

            # 响应时间分布
            fast_count = logs.filter(response_time_ms__lt=100).count()
            medium_count = logs.filter(
                response_time_ms__gte=100,
                response_time_ms__lt=500
            ).count()
            slow_count = logs.filter(response_time_ms__gte=500).count()

            # 最慢的查询（SEC-07: query 字段脱敏，避免泄露全平台原始搜索文本）
            raw_slowest = logs.order_by('-response_time_ms')[:5].values(
                'query', 'response_time_ms', 'results_count', 'created_at'
            )
            slowest_queries = [
                {**item, 'query': self._mask_query(item['query'])}
                for item in raw_slowest
            ]

            return {
                'time_range_hours': hours,
                'total_searches': total_searches,
                'avg_response_time_ms': round(avg_response_time, 2) if avg_response_time else 0,
                'response_time_distribution': {
                    'fast_lt_100ms': fast_count,
                    'medium_100_500ms': medium_count,
                    'slow_gt_500ms': slow_count
                },
                'slowest_queries': slowest_queries,
                'timestamp': timezone.now().isoformat()
            }

        except Exception as e:
            logger.error(f"❌ 获取性能指标失败: {e}")
            raise

    # ===== 检索质量分析 =====

    def get_search_quality_metrics(self, hours: int = 24) -> Dict[str, Any]:
        """
        获取检索质量指标

        Args:
            hours: 统计时间范围（小时）

        Returns:
            Dict: 检索质量指标
        """
        from apps.rag.models import SearchLog

        try:
            cutoff_time = timezone.now() - timedelta(hours=hours)

            # 查询日志
            logs = SearchLog.objects.filter(created_at__gte=cutoff_time)

            if not logs.exists():
                return {
                    'total_searches': 0,
                    'message': '暂无数据'
                }

            total_searches = logs.count()

            # 平均相似度
            avg_similarity = logs.aggregate(
                Avg('top_similarity_score')
            )['top_similarity_score__avg']

            # 相似度分布
            high_quality = logs.filter(top_similarity_score__gte=0.8).count()
            medium_quality = logs.filter(
                top_similarity_score__gte=0.6,
                top_similarity_score__lt=0.8
            ).count()
            low_quality = logs.filter(top_similarity_score__lt=0.6).count()

            # 零结果查询
            zero_results = logs.filter(results_count=0).count()
            zero_results_rate = (zero_results / total_searches * 100) if total_searches > 0 else 0

            # 平均结果数
            avg_results = logs.aggregate(Avg('results_count'))['results_count__avg']

            # 热门查询（SEC-07: query 字段脱敏，避免泄露全平台原始搜索文本）
            raw_hot = logs.values('query').annotate(
                count=Count('id')
            ).order_by('-count')[:10]
            hot_queries = [
                {**item, 'query': self._mask_query(item['query'])}
                for item in raw_hot
            ]

            return {
                'time_range_hours': hours,
                'total_searches': total_searches,
                'avg_similarity_score': round(avg_similarity, 3) if avg_similarity else 0,
                'similarity_distribution': {
                    'high_ge_0.8': high_quality,
                    'medium_0.6_0.8': medium_quality,
                    'low_lt_0.6': low_quality
                },
                'zero_results': {
                    'count': zero_results,
                    'rate': round(zero_results_rate, 2)
                },
                'avg_results_count': round(avg_results, 2) if avg_results else 0,
                'hot_queries': hot_queries,
                'timestamp': timezone.now().isoformat()
            }

        except Exception as e:
            logger.error(f"❌ 获取检索质量指标失败: {e}")
            raise

    # ===== 异常检测 =====

    def detect_anomalies(self, coverage: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """
        检测异常情况

        阈值均从 settings 读取，可通过环境变量配置（SS-007）：
          RAG_MONITOR_FAILURE_RATE_THRESHOLD        任务失败率告警阈值，默认 20%
          RAG_MONITOR_SLOW_QUERY_MS_THRESHOLD       慢查询响应时间阈值，默认 1000ms
          RAG_MONITOR_SLOW_QUERY_COUNT_THRESHOLD    1h 内慢查询次数阈值，默认 10 次
          RAG_MONITOR_ZERO_RESULTS_RATE_THRESHOLD   零结果率告警阈值，默认 50%
          RAG_MONITOR_COVERAGE_RATE_THRESHOLD       覆盖率最低阈值，默认 50%

        Returns:
            Dict: 异常检测结果
        """
        from apps.rag.models import EmbeddingTask, SearchLog

        failure_rate_threshold = getattr(settings, 'RAG_MONITOR_FAILURE_RATE_THRESHOLD', 20)
        slow_query_ms_threshold = getattr(settings, 'RAG_MONITOR_SLOW_QUERY_MS_THRESHOLD', 1000)
        slow_query_count_threshold = getattr(settings, 'RAG_MONITOR_SLOW_QUERY_COUNT_THRESHOLD', 10)
        zero_results_rate_threshold = getattr(settings, 'RAG_MONITOR_ZERO_RESULTS_RATE_THRESHOLD', 50)
        coverage_rate_threshold = getattr(settings, 'RAG_MONITOR_COVERAGE_RATE_THRESHOLD', 50)

        anomalies = []

        try:
            # 1. 高失败率检测
            recent_tasks = EmbeddingTask.objects.filter(
                created_at__gte=timezone.now() - timedelta(hours=24)
            )

            if recent_tasks.exists():
                total = recent_tasks.count()
                failed = recent_tasks.filter(status='failed').count()
                failure_rate = (failed / total * 100) if total > 0 else 0

                if failure_rate > failure_rate_threshold:
                    anomalies.append({
                        'type': 'high_failure_rate',
                        'severity': 'high',
                        'message': f'任务失败率过高: {failure_rate:.2f}% (阈值: {failure_rate_threshold}%)',
                        'details': {
                            'total_tasks': total,
                            'failed_tasks': failed,
                            'failure_rate': failure_rate,
                            'threshold': failure_rate_threshold,
                        }
                    })

            # 2. 慢查询检测
            slow_queries = SearchLog.objects.filter(
                created_at__gte=timezone.now() - timedelta(hours=1),
                response_time_ms__gt=slow_query_ms_threshold,
            ).count()

            if slow_queries > slow_query_count_threshold:
                anomalies.append({
                    'type': 'slow_queries',
                    'severity': 'medium',
                    'message': f'慢查询频繁: {slow_queries} 次/小时 (阈值: {slow_query_count_threshold} 次, >{slow_query_ms_threshold}ms)',
                    'details': {
                        'slow_query_count': slow_queries,
                        'threshold_ms': slow_query_ms_threshold,
                        'count_threshold': slow_query_count_threshold,
                    }
                })

            # 3. 零结果率检测
            recent_searches = SearchLog.objects.filter(
                created_at__gte=timezone.now() - timedelta(hours=24)
            )

            if recent_searches.exists():
                total_searches = recent_searches.count()
                zero_results = recent_searches.filter(results_count=0).count()
                zero_rate = (zero_results / total_searches * 100) if total_searches > 0 else 0

                if zero_rate > zero_results_rate_threshold:
                    anomalies.append({
                        'type': 'high_zero_results',
                        'severity': 'medium',
                        'message': f'零结果率过高: {zero_rate:.2f}% (阈值: {zero_results_rate_threshold}%)',
                        'details': {
                            'total_searches': total_searches,
                            'zero_results': zero_results,
                            'zero_rate': zero_rate,
                            'threshold': zero_results_rate_threshold,
                        }
                    })

            # 4. 低覆盖率检测（EQ-007: 接受外部传入的 coverage，避免重复查询）
            if coverage is None:
                coverage = self.get_index_coverage()
            table_coverage = coverage['table_coverage']['coverage_rate']

            if table_coverage < coverage_rate_threshold:
                anomalies.append({
                    'type': 'low_coverage',
                    'severity': 'high',  # EQ-011: 覆盖率不足是严重问题
                    'message': f'索引覆盖率严重不足: {table_coverage:.2f}% (阈值: {coverage_rate_threshold}%)',
                    'details': {**coverage['table_coverage'], 'threshold': coverage_rate_threshold},
                })

            # SS-005: 检测 Skill embedding 失败任务
            skill_coverage_data = coverage.get('skill_coverage', {})
            skill_failed_tasks = skill_coverage_data.get('failed_tasks', 0)
            if skill_failed_tasks > 0:
                anomalies.append({
                    'type': 'skill_embedding_failures',
                    'severity': 'medium',
                    'message': f'技能 Embedding 累计失败任务: {skill_failed_tasks} 条',
                    'details': {'failed_tasks': skill_failed_tasks},
                })

            # SS-008: severity=high 的异常主动输出 critical 日志，便于日志系统告警
            high_severity = [a for a in anomalies if a.get('severity') == 'high']
            if high_severity:
                logger.critical(
                    "[RAG Monitor] %d high-severity anomalies detected: %s",
                    len(high_severity),
                    "; ".join(a['message'] for a in high_severity),
                )

            return {
                'has_anomalies': len(anomalies) > 0,
                'anomaly_count': len(anomalies),
                'anomalies': anomalies,
                'checked_at': timezone.now().isoformat()
            }

        except Exception as e:
            logger.error(f"❌ 异常检测失败: {e}")
            raise

    # ===== 系统健康评分 =====

    def get_system_health(self) -> Dict[str, Any]:
        """
        获取系统综合健康评分（0-100）。

        评分算法（三项加权）：
        - 失败率分（40分权重）：failure_rate=0 → 40分，≥20% → 0分，线性插值
        - 零结果率分（30分权重）：zero_rate=0 → 30分，≥50% → 0分，线性插值
        - 覆盖率分（30分权重）：coverage=100% → 30分，coverage=0% → 0分，线性插值

        健康等级：
        - ≥90：healthy（健康）
        - ≥70：warning（注意）
        - <70 ：critical（告警）
        """
        try:
            quality = self.get_index_quality_stats()
            coverage = self.get_index_coverage()
            search_quality = self.get_search_quality_metrics(hours=24)

            failure_rate = quality.get('failure_rate', 0)
            zero_rate = search_quality.get('zero_results', {}).get('rate', 0) if 'total_searches' in search_quality and search_quality.get('total_searches', 0) > 0 else 0
            table_coverage_rate = coverage['table_coverage']['coverage_rate']

            # 三项加权评分
            failure_score = max(0.0, 40.0 * (1 - failure_rate / 20.0))
            zero_score = max(0.0, 30.0 * (1 - zero_rate / 50.0))
            coverage_score = 30.0 * (table_coverage_rate / 100.0)

            total_score = round(failure_score + zero_score + coverage_score, 1)

            if total_score >= 90:
                status = 'healthy'
            elif total_score >= 70:
                status = 'warning'
            else:
                status = 'critical'

            return {
                'score': total_score,
                'status': status,
                'components': {
                    'failure_rate': {
                        'value': failure_rate,
                        'score': round(failure_score, 1),
                        'weight': 40,
                    },
                    'zero_results_rate': {
                        'value': zero_rate,
                        'score': round(zero_score, 1),
                        'weight': 30,
                    },
                    'table_coverage': {
                        'value': table_coverage_rate,
                        'score': round(coverage_score, 1),
                        'weight': 30,
                    },
                },
                'timestamp': timezone.now().isoformat(),
            }

        except Exception as e:
            logger.error(f"❌ 获取系统健康评分失败: {e}")
            raise

    # ===== 综合报告 =====

    def get_comprehensive_report(self, hours: int = 24) -> Dict[str, Any]:
        """
        获取综合监控报告

        Args:
            hours: 性能/检索质量统计的时间范围（小时），默认 24

        Returns:
            Dict: 综合报告
        """
        try:
            # EQ-007: 先调用一次 get_index_coverage，结果复用传给 detect_anomalies，
            # 避免 detect_anomalies 内部再次调用产生双倍查询开销
            coverage = self.get_index_coverage()
            return {
                'index_quality': self.get_index_quality_stats(),
                'index_coverage': coverage,
                'performance': self.get_performance_metrics(hours=hours),
                'search_quality': self.get_search_quality_metrics(hours=hours),
                'anomalies': self.detect_anomalies(coverage=coverage),
                'generated_at': timezone.now().isoformat()
            }

        except Exception as e:
            logger.error(f"❌ 生成综合报告失败: {e}")
            raise

    # ===== 优化建议 =====

    def get_optimization_suggestions(self) -> List[Dict[str, Any]]:
        """
        获取优化建议

        Returns:
            List[Dict]: 优化建议列表
        """
        suggestions = []

        try:
            # 检查覆盖率
            coverage = self.get_index_coverage()
            if coverage['table_coverage']['coverage_rate'] < 80:
                suggestions.append({
                    'category': 'coverage',
                    'priority': 'high',
                    'title': '提升索引覆盖率',
                    'description': f"当前表格覆盖率为 {coverage['table_coverage']['coverage_rate']:.2f}%，建议为未索引的表格创建索引",
                    'action': '运行: python manage.py rag_index_all'
                })

            # 检查失败率
            quality = self.get_index_quality_stats()
            if quality['failure_rate'] > 10:
                suggestions.append({
                    'category': 'reliability',
                    'priority': 'high',
                    'title': '降低任务失败率',
                    'description': f"当前失败率为 {quality['failure_rate']:.2f}%，建议检查失败原因",
                    'action': '查看失败任务日志，修复问题后运行重试'
                })

            # 检查性能
            performance = self.get_performance_metrics(hours=24)
            if performance.get('avg_response_time_ms', 0) > 500:
                suggestions.append({
                    'category': 'performance',
                    'priority': 'medium',
                    'title': '优化检索性能',
                    'description': f"平均响应时间为 {performance['avg_response_time_ms']:.2f}ms，建议优化索引",
                    'action': '考虑优化检索阈值或检查 embedding 模型配置（向量维度由模型固定，不可随意调整）'
                })

            # 检查检索质量
            search_quality = self.get_search_quality_metrics(hours=24)
            if search_quality.get('zero_results', {}).get('rate', 0) > 30:
                suggestions.append({
                    'category': 'quality',
                    'priority': 'medium',
                    'title': '改善检索效果',
                    'description': f"零结果率为 {search_quality['zero_results']['rate']:.2f}%，建议降低相似度阈值或增加索引内容",
                    'action': '调整 RAG_SIMILARITY_THRESHOLD 配置'
                })

            return suggestions

        except Exception as e:
            logger.error(f"❌ 生成优化建议失败: {e}")
            return []
