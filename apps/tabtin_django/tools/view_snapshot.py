#!/usr/bin/env python3
"""
快照查看工具

用于查看和调试保存的 accessibility tree 快照
"""
import sys
import json
from pathlib import Path
from datetime import datetime


def list_snapshots(base_dir="logs/snapshots", limit=20):
    """列出最近的快照文件"""
    snapshots_dir = Path(base_dir)

    if not snapshots_dir.exists():
        print(f"❌ 快照目录不存在: {snapshots_dir}")
        return

    files = sorted(snapshots_dir.glob("snapshot_*.json"), key=lambda x: x.stat().st_mtime, reverse=True)

    if not files:
        print(f"📂 {snapshots_dir} 中没有找到快照文件")
        return

    print(f"\n📸 最近的 {min(limit, len(files))} 个快照:\n")
    print(f"{'序号':<4} {'文件名':<50} {'大小':<10} {'修改时间':<20}")
    print("-" * 90)

    for idx, filepath in enumerate(files[:limit], 1):
        size = filepath.stat().st_size
        mtime = datetime.fromtimestamp(filepath.stat().st_mtime).strftime("%Y-%m-%d %H:%M:%S")

        # 文件大小格式化
        if size < 1024:
            size_str = f"{size}B"
        elif size < 1024 * 1024:
            size_str = f"{size/1024:.1f}KB"
        else:
            size_str = f"{size/(1024*1024):.1f}MB"

        print(f"{idx:<4} {filepath.name:<50} {size_str:<10} {mtime:<20}")


def view_snapshot(filepath, show_full_tree=False):
    """查看快照详情"""
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            data = json.load(f)

        print(f"\n{'='*80}")
        print(f"📸 快照详情: {Path(filepath).name}")
        print(f"{'='*80}\n")

        # 基本信息
        print(f"⏰ 时间: {data.get('timestamp', 'N/A')}")
        print(f"🔧 节点: {data.get('node_name', 'N/A')}")
        print(f"🧵 Thread ID: {data.get('thread_id', 'N/A')}")

        # 上下文信息
        extra_context = data.get('extra_context', {})
        if extra_context:
            print(f"\n📋 上下文:")
            for key, value in extra_context.items():
                print(f"  {key}: {value}")

        # 快照数据
        snapshot = data.get('snapshot', {})
        print(f"\n🌐 页面信息:")
        print(f"  URL: {snapshot.get('url', 'N/A')}")
        print(f"  Title: {snapshot.get('title', 'N/A')}")

        # Accessibility Tree
        accessibility_tree = snapshot.get('accessibility_tree', '')
        lines = accessibility_tree.split('\n')

        print(f"\n🌳 Accessibility Tree:")
        print(f"  总行数: {len(lines)}")
        print(f"  总字符: {len(accessibility_tree)}")

        # 统计元素
        button_count = sum(1 for line in lines if 'button' in line.lower())
        link_count = sum(1 for line in lines if 'link' in line.lower())
        input_count = sum(1 for line in lines if 'textbox' in line.lower() or 'combobox' in line.lower())

        print(f"  元素统计: {button_count} buttons, {link_count} links, {input_count} inputs")

        # XPath Map
        xpath_map = snapshot.get('xpath_map', {})
        print(f"\n🗺️  XPath Map:")
        print(f"  映射数量: {len(xpath_map)}")

        if xpath_map:
            # 显示前5个映射
            print(f"  示例映射:")
            for idx, (element_id, xpath) in enumerate(list(xpath_map.items())[:5], 1):
                print(f"    {element_id}: {xpath[:60]}{'...' if len(xpath) > 60 else ''}")

        # 预览 Tree（前20行）
        if show_full_tree:
            print(f"\n📜 完整 Accessibility Tree:\n")
            print(accessibility_tree)
        else:
            print(f"\n📜 Accessibility Tree 预览（前20行）:\n")
            for line in lines[:20]:
                print(line)
            if len(lines) > 20:
                print(f"\n  ... 还有 {len(lines) - 20} 行 ...")
                print(f"\n💡 使用 --full 参数查看完整内容")

    except FileNotFoundError:
        print(f"❌ 文件不存在: {filepath}")
    except json.JSONDecodeError as e:
        print(f"❌ JSON 解析失败: {e}")
    except Exception as e:
        print(f"❌ 错误: {e}")


def search_snapshots(keyword, base_dir="logs/snapshots"):
    """搜索包含特定关键词的快照"""
    snapshots_dir = Path(base_dir)

    if not snapshots_dir.exists():
        print(f"❌ 快照目录不存在: {snapshots_dir}")
        return

    files = sorted(snapshots_dir.glob("snapshot_*.json"), key=lambda x: x.stat().st_mtime, reverse=True)

    matches = []
    for filepath in files:
        try:
            with open(filepath, 'r', encoding='utf-8') as f:
                content = f.read()
                if keyword.lower() in content.lower():
                    matches.append(filepath)
        except Exception:
            continue

    if not matches:
        print(f"🔍 未找到包含 '{keyword}' 的快照")
        return

    print(f"\n🔍 找到 {len(matches)} 个匹配的快照:\n")
    for idx, filepath in enumerate(matches, 1):
        mtime = datetime.fromtimestamp(filepath.stat().st_mtime).strftime("%Y-%m-%d %H:%M:%S")
        print(f"{idx}. {filepath.name} ({mtime})")


def main():
    import argparse

    parser = argparse.ArgumentParser(description="查看和调试 accessibility tree 快照")
    parser.add_argument('action', choices=['list', 'view', 'search'],
                       help="操作: list=列出快照, view=查看详情, search=搜索")
    parser.add_argument('target', nargs='?', help="目标文件路径或搜索关键词")
    parser.add_argument('--full', action='store_true', help="显示完整的 accessibility tree")
    parser.add_argument('--limit', type=int, default=20, help="列表显示数量限制")

    args = parser.parse_args()

    if args.action == 'list':
        list_snapshots(limit=args.limit)

    elif args.action == 'view':
        if not args.target:
            print("❌ 请提供快照文件路径")
            sys.exit(1)
        view_snapshot(args.target, show_full_tree=args.full)

    elif args.action == 'search':
        if not args.target:
            print("❌ 请提供搜索关键词")
            sys.exit(1)
        search_snapshots(args.target)


if __name__ == '__main__':
    main()
