#!/usr/bin/env python3
"""
日志查看工具
用于查看API请求响应的详细日志
"""

import os
import sys
import json
import argparse
from datetime import datetime, timedelta
import re

def parse_log_line(line):
    """解析日志行"""
    # 匹配日志格式: LEVEL TIMESTAMP [module] message
    pattern = r'(\w+)\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2},\d{3})\s+\[(\w+)\]\s+(.*)'
    match = re.match(pattern, line.strip())

    if match:
        level, timestamp, module, message = match.groups()
        return {
            'level': level,
            'timestamp': timestamp,
            'module': module,
            'message': message,
            'raw': line.strip()
        }
    return None

def filter_logs_by_request_id(logs, request_id):
    """根据请求ID过滤日志"""
    filtered = []
    for log in logs:
        if request_id in log['message']:
            filtered.append(log)
    return filtered

def filter_logs_by_time(logs, hours=1):
    """根据时间过滤日志（最近N小时）"""
    cutoff_time = datetime.now() - timedelta(hours=hours)
    filtered = []

    for log in logs:
        try:
            log_time = datetime.strptime(log['timestamp'], '%Y-%m-%d %H:%M:%S,%f')
            if log_time >= cutoff_time:
                filtered.append(log)
        except ValueError:
            # 如果时间解析失败，保留日志
            filtered.append(log)

    return filtered

def main():
    parser = argparse.ArgumentParser(description='查看API请求响应日志')
    parser.add_argument('--file', '-f', default='/www/wwwroot/tabtin/logs/api_requests.log',
                       help='日志文件路径')
    parser.add_argument('--request-id', '-r', help='按请求ID过滤')
    parser.add_argument('--hours', type=int, default=1, help='显示最近N小时的日志')
    parser.add_argument('--level', '-l', choices=['DEBUG', 'INFO', 'WARNING', 'ERROR'],
                       help='按日志级别过滤')
    parser.add_argument('--tail', '-t', type=int, help='显示最后N行')
    parser.add_argument('--follow', action='store_true', help='实时跟踪日志')

    args = parser.parse_args()

    if not os.path.exists(args.file):
        print(f"日志文件不存在: {args.file}")
        return 1

    if args.follow:
        import subprocess
        subprocess.run(["tail", "-f", args.file])
        return 0

    # 读取日志文件
    try:
        with open(args.file, 'r', encoding='utf-8') as f:
            lines = f.readlines()
    except Exception as e:
        print(f"读取日志文件失败: {e}")
        return 1

    # 解析日志
    logs = []
    for line in lines:
        parsed = parse_log_line(line)
        if parsed:
            logs.append(parsed)

    # 应用过滤器
    if args.request_id:
        logs = filter_logs_by_request_id(logs, args.request_id)

    if args.level:
        logs = [log for log in logs if log['level'] == args.level]

    if not args.request_id:  # 如果没有指定请求ID，按时间过滤
        logs = filter_logs_by_time(logs, args.hours)

    if args.tail:
        logs = logs[-args.tail:]

    # 显示日志
    if not logs:
        print("没有找到匹配的日志")
        return 0

    print(f"找到 {len(logs)} 条日志记录:")
    print("=" * 80)

    for log in logs:
        color = {
            'DEBUG': '\033[36m',    # 青色
            'INFO': '\033[32m',     # 绿色
            'WARNING': '\033[33m',  # 黄色
            'ERROR': '\033[31m',    # 红色
        }.get(log['level'], '\033[0m')

        reset_color = '\033[0m'

        print(f"{color}{log['level']:<8}{reset_color} {log['timestamp']} [{log['module']}] {log['message']}")

    return 0

if __name__ == '__main__':
    sys.exit(main())
