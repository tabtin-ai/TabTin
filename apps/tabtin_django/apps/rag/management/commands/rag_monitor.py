"""
Django 管理命令：显示 RAG 监控报告
"""

from django.core.management.base import BaseCommand
import json


class Command(BaseCommand):
    help = '显示 RAG 模块监控报告'

    def add_arguments(self, parser):
        parser.add_argument(
            '--json',
            action='store_true',
            help='以 JSON 格式输出',
        )
        parser.add_argument(
            '--hours',
            type=int,
            default=24,
            help='统计时间范围（小时）',
        )

    def handle(self, *args, **options):
        from apps.rag.services import MonitorService

        service = MonitorService()
        hours = options['hours']

        # EQ-008: 统一收集数据，避免后续重复调用各子方法
        # EQ-013: 将 hours 传入 get_comprehensive_report
        report = service.get_comprehensive_report(hours=hours)
        suggestions = service.get_optimization_suggestions()

        quality = report['index_quality']
        coverage = report['index_coverage']
        performance = report['performance']
        search_quality = report['search_quality']
        anomalies = report['anomalies']

        if options['json']:
            # EQ-013: hours 已由 get_comprehensive_report(hours=hours) 正确传入
            # EQ-014: 在 JSON 输出中补充 optimization_suggestions 字段
            report['optimization_suggestions'] = suggestions
            self.stdout.write(json.dumps(report, ensure_ascii=False, indent=2))
            return

        # 格式化输出（EQ-008: 直接引用上方已缓存的变量，不再重复调用服务方法）
        self.stdout.write("=" * 70)
        self.stdout.write(self.style.HTTP_INFO("RAG 模块监控报告"))
        self.stdout.write("=" * 70)

        # 1. 索引质量
        self.stdout.write("\n" + self.style.WARNING("【索引质量】"))
        self.stdout.write(f"  表格向量数: {quality['total_tables']}")
        self.stdout.write(f"  记录向量数: {quality['total_records']}")
        self.stdout.write(f"  文档向量数: {quality.get('total_documents', 0)}")
        self.stdout.write(f"  技能向量数: {quality.get('total_skills', 0)}")
        self.stdout.write(f"  失败率: {quality['failure_rate']}%")
        recent = quality['recent_24h']
        self.stdout.write(
            f"  最近24h新增: 表格 {recent['tables']}, 记录 {recent['records']}, "
            f"文档 {recent.get('documents', 0)}"
        )

        # 2. 覆盖率
        self.stdout.write("\n" + self.style.WARNING("【索引覆盖率】"))
        table_cov = coverage['table_coverage']
        self.stdout.write(f"  表格覆盖率: {table_cov['coverage_rate']}% ({table_cov['indexed']}/{table_cov['total']})")

        record_cov = coverage['record_coverage']
        self.stdout.write(f"  记录覆盖率: {record_cov['coverage_rate']}% ({record_cov['indexed']}/{record_cov['total']})")

        doc_cov = coverage.get('document_coverage', {})
        if doc_cov:
            self.stdout.write(f"  文档覆盖率: {doc_cov.get('coverage_rate', 0)}% ({doc_cov.get('indexed', 0)}/{doc_cov.get('total', 0)})")

        # 3. 性能指标
        self.stdout.write("\n" + self.style.WARNING(f"【性能指标】(最近{hours}小时)"))
        if performance['total_searches'] > 0:
            self.stdout.write(f"  总检索次数: {performance['total_searches']}")
            self.stdout.write(f"  平均响应时间: {performance['avg_response_time_ms']}ms")

            dist = performance['response_time_distribution']
            self.stdout.write(f"  响应时间分布:")
            self.stdout.write(f"    快速(<100ms): {dist['fast_lt_100ms']}")
            self.stdout.write(f"    中等(100-500ms): {dist['medium_100_500ms']}")
            self.stdout.write(f"    慢速(>500ms): {dist['slow_gt_500ms']}")
        else:
            self.stdout.write("  暂无检索数据")

        # 4. 检索质量
        self.stdout.write("\n" + self.style.WARNING(f"【检索质量】(最近{hours}小时)"))
        if search_quality['total_searches'] > 0:
            self.stdout.write(f"  平均相似度: {search_quality['avg_similarity_score']}")
            self.stdout.write(f"  平均结果数: {search_quality['avg_results_count']}")
            self.stdout.write(f"  零结果率: {search_quality['zero_results']['rate']}%")

            if search_quality['hot_queries']:
                self.stdout.write(f"\n  热门查询:")
                for i, q in enumerate(search_quality['hot_queries'][:5], 1):
                    self.stdout.write(f"    {i}. {q['query']} ({q['count']}次)")
        else:
            self.stdout.write("  暂无检索数据")

        # 5. 异常检测
        self.stdout.write("\n" + self.style.WARNING("【异常检测】"))
        if anomalies['has_anomalies']:
            self.stdout.write(self.style.ERROR(f"  发现 {anomalies['anomaly_count']} 个异常:"))
            for anomaly in anomalies['anomalies']:
                severity_style = {
                    'high': self.style.ERROR,
                    'medium': self.style.WARNING,
                    'low': self.style.NOTICE
                }.get(anomaly['severity'], self.style.NOTICE)

                severity_upper = anomaly['severity'].upper()
                message_text = f"[{severity_upper}] {anomaly['message']}"
                self.stdout.write(f"    {severity_style(message_text)}")
        else:
            self.stdout.write(self.style.SUCCESS("  ✅ 未发现异常"))

        # 6. 优化建议
        self.stdout.write("\n" + self.style.WARNING("【优化建议】"))
        if suggestions:
            for i, sug in enumerate(suggestions, 1):
                priority_style = {
                    'high': self.style.ERROR,
                    'medium': self.style.WARNING,
                    'low': self.style.NOTICE
                }.get(sug['priority'], self.style.NOTICE)

                priority_upper = sug['priority'].upper()
                title_text = f"[{priority_upper}] {sug['title']}"
                self.stdout.write(f"\n  {i}. {priority_style(title_text)}")
                self.stdout.write(f"     {sug['description']}")
                self.stdout.write(f"     行动: {sug['action']}")
        else:
            self.stdout.write(self.style.SUCCESS("  ✅ 系统运行良好，无需优化"))

        self.stdout.write("\n" + "=" * 70)
