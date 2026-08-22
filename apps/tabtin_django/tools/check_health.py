#!/usr/bin/env python
"""
快速健康检查脚本

使用方法：
    python tools/check_health.py           # 快速检查
    python tools/check_health.py --full    # 完整报告
"""
import os
import sys
import django
import argparse
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'tabtin.settings')
django.setup()

from apps.maintenance.celery_health import health_checker


def print_section(title):
    print(f"\n{'=' * 60}")
    print(f"  {title}")
    print('=' * 60)


def print_status(healthy, message):
    if healthy:
        print(f"✅ {message}")
    else:
        print(f"❌ {message}")


def quick_check():
    print_section("🔍 快速健康检查")
    print(f"检查时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")

    print("\n【Worker 状态】")
    worker_health = health_checker.check_workers()
    print_status(
        worker_health['healthy'],
        f"Worker: {len(worker_health['workers'])} 个活跃，"
        f"{worker_health.get('active_tasks_count', 0)} 个任务执行中"
    )
    if not worker_health['healthy']:
        for issue in worker_health['issues']:
            print(f"  ⚠️  {issue}")

    print("\n【队列状态】")
    queue_health = health_checker.check_queue_health()
    print_status(queue_health['healthy'], "队列状态正常")
    if queue_health['queues']:
        for queue, length in queue_health['queues'].items():
            status = "⚠️" if length > 50 else "✅"
            print(f"  {status} {queue}: {length} 个任务")
    if not queue_health['healthy']:
        for issue in queue_health['issues']:
            print(f"  ⚠️  {issue}")

    all_healthy = (
        worker_health['healthy'] and
        queue_health['healthy']
    )
    print_section("总结")
    if all_healthy:
        print("✅ 所有系统运行正常！")
    else:
        print("⚠️  发现一些问题，建议手动检查")

    return all_healthy


def full_report():
    print_section("📊 完整健康报告")
    report = health_checker.full_check()

    import json
    print(json.dumps(report, indent=2, ensure_ascii=False, default=str))

    return report['healthy']


def main():
    parser = argparse.ArgumentParser(description='Tabtin 健康检查工具')
    parser.add_argument('--full', action='store_true', help='显示完整报告')

    args = parser.parse_args()

    try:
        if args.full:
            full_report()
        else:
            quick_check()

        print("\n" + "=" * 60)
        print("💡 提示:")
        print("  - 完整报告: python tools/check_health.py --full")
        print("  - 查看定时任务日志: tail -f logs/django.log | grep health")
        print("=" * 60 + "\n")

    except KeyboardInterrupt:
        print("\n\n操作已取消")
        sys.exit(0)
    except Exception as e:
        print(f"\n❌ 错误: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == '__main__':
    main()
