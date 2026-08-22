#!/usr/bin/env python3
"""
template_fill.py — PPTX 模板占位符批量替换

在 unpack 后的 XML 文件中搜索并替换占位符文本。
支持多种占位符格式和精准的 XML 文本节点替换。

占位符格式：
  {{公司名}}   → 双花括号（推荐，不易与正常文本冲突）
  {公司名}     → 单花括号
  %公司名%     → 百分号
  $公司名$     → 美元符号

用法：
  # JSON 格式的替换映射
  python template_fill.py unpacked/ -d '{"公司名": "TabTin", "日期": "2026-02-10"}'

  # 从 JSON 文件读取
  python template_fill.py unpacked/ -f replacements.json

  # 预览模式（不修改文件，只列出匹配的占位符）
  python template_fill.py unpacked/ --scan
"""

import argparse
import json
import os
import re
import sys
from pathlib import Path
from xml.sax.saxutils import escape as _xml_escape

from defusedxml import ElementTree as ET


def scan_placeholders(unpacked_dir: str, patterns: list[str] = None) -> list[dict]:
    """
    扫描解压目录中所有 XML 文件的占位符。

    Args:
        unpacked_dir: 解压目录
        patterns: 占位符正则模式列表（默认匹配 {{...}} 和 {%...%}）

    Returns:
        [{"file": str, "placeholder": str, "context": str}, ...]
    """
    if patterns is None:
        patterns = [
            r"\{\{([^}]+)\}\}",      # {{placeholder}}
            r"\{%\s*([^%]+)\s*%\}",  # {% placeholder %}
            r"\$([A-Za-z_]\w*)\$",   # $placeholder$
        ]

    compiled = [re.compile(p) for p in patterns]
    results = []

    slides_dir = os.path.join(unpacked_dir, "ppt", "slides")
    if not os.path.exists(slides_dir):
        return results

    for fname in sorted(os.listdir(slides_dir)):
        if not fname.endswith(".xml"):
            continue

        fpath = os.path.join(slides_dir, fname)

        try:
            with open(fpath, "r", encoding="utf-8") as f:
                content = f.read()
        except UnicodeDecodeError:
            continue

        for pattern in compiled:
            for match in pattern.finditer(content):
                # 提取上下文（前后 30 个字符）
                start = max(0, match.start() - 30)
                end = min(len(content), match.end() + 30)
                context = content[start:end].replace("\n", " ").strip()

                results.append({
                    "file": fname,
                    "placeholder": match.group(0),
                    "key": match.group(1).strip(),
                    "context": f"...{context}...",
                })

    return results


def fill_template(
    unpacked_dir: str,
    replacements: dict[str, str],
    placeholder_format: str = "{{}}",
) -> dict:
    """
    在解压目录中批量替换占位符。

    工作原理：直接在 XML 文本中做字符串替换。
    因为 OOXML 中文本存储在 <a:t> 元素中，
    替换 XML 文件中的文本等效于替换幻灯片上的文字。

    注意：PowerPoint 有时会将连续文本拆分到多个 <a:r><a:t> 中，
    导致 {{公司名}} 可能被拆成 {{公 + 司名}}。
    本函数会先尝试直接替换，如果失败则尝试合并相邻 <a:t> 后重试。

    Args:
        unpacked_dir: 解压目录
        replacements: {占位符key: 替换值} 映射
        placeholder_format: 占位符格式："{{}}","{}","%%" 或 "$$"

    Returns:
        {"total_replacements": int, "files_modified": int, "details": [...]}
    """
    # 构建实际替换映射（key → 带格式的占位符 → 值）
    format_map = {
        "{{}}": ("{{", "}}"),
        "{}": ("{", "}"),
        "%%": ("%", "%"),
        "$$": ("$", "$"),
    }

    left, right = format_map.get(placeholder_format, ("{{", "}}"))
    actual_replacements = {}
    for key, value in replacements.items():
        placeholder = f"{left}{key}{right}"
        actual_replacements[placeholder] = _xml_escape(str(value), {'"': "&quot;", "'": "&apos;"})

    total_count = 0
    modified_files = 0
    details = []

    # 扫描所有 XML 文件（不仅是幻灯片，也包括布局等）
    for root, dirs, files in os.walk(os.path.join(unpacked_dir, "ppt")):
        for fname in files:
            if not fname.endswith(".xml"):
                continue

            fpath = os.path.join(root, fname)
            try:
                with open(fpath, "r", encoding="utf-8") as f:
                    content = f.read()
            except UnicodeDecodeError:
                continue

            original = content
            file_count = 0

            # 直接文本替换
            for placeholder, value in actual_replacements.items():
                count = content.count(placeholder)
                if count > 0:
                    content = content.replace(placeholder, value)
                    file_count += count

            # 如果直接替换没找到，尝试处理拆分的 <a:t> 标签
            if file_count == 0:
                content = _merge_split_text_and_replace(content, actual_replacements)
                # 计算是否有变化
                if content != original:
                    file_count = 1  # 至少有一处替换

            if content != original:
                with open(fpath, "w", encoding="utf-8") as f:
                    f.write(content)
                total_count += file_count
                modified_files += 1
                rel_path = os.path.relpath(fpath, unpacked_dir)
                details.append({
                    "file": rel_path,
                    "replacements": file_count,
                })

    return {
        "total_replacements": total_count,
        "files_modified": modified_files,
        "details": details,
    }


def _merge_split_text_and_replace(xml_content: str, replacements: dict) -> str:
    """
    处理 PowerPoint 将文本拆分到多个 <a:r><a:t> 中的情况。

    例如 {{公司名}} 可能被存储为：
      <a:r><a:rPr/><a:t>{{公</a:t></a:r>
      <a:r><a:rPr/><a:t>司名}}</a:t></a:r>

    策略：找到包含占位符片段的相邻 <a:t> 元素，
    临时合并它们的文本，执行替换，然后写回第一个 <a:t>。
    """
    try:
        root = ET.fromstring(xml_content.encode("utf-8"))
    except ET.ParseError:
        return xml_content

    a_ns = "http://schemas.openxmlformats.org/drawingml/2006/main"
    modified = False

    # 找到所有 spTree 下的 sp 元素（形状）
    for sp in root.iter(f"{{{a_ns}}}txBody"):
        for para in sp.findall(f"{{{a_ns}}}p"):
            runs = para.findall(f"{{{a_ns}}}r")
            if len(runs) < 2:
                continue

            # 合并所有 run 的文本
            texts = []
            for run in runs:
                t_elem = run.find(f"{{{a_ns}}}t")
                if t_elem is not None and t_elem.text:
                    texts.append(t_elem.text)
                else:
                    texts.append("")

            combined = "".join(texts)

            # 检查合并后的文本是否包含占位符
            new_combined = combined
            for placeholder, value in replacements.items():
                new_combined = new_combined.replace(placeholder, value)

            if new_combined != combined:
                # 替换成功：把全部文本放到第一个 run，清空其余
                first_t = runs[0].find(f"{{{a_ns}}}t")
                if first_t is not None:
                    first_t.text = new_combined
                    # 清空后续 run 的文本
                    for run in runs[1:]:
                        t_elem = run.find(f"{{{a_ns}}}t")
                        if t_elem is not None:
                            t_elem.text = ""
                    modified = True

    if modified:
        return ET.tostring(root, encoding="unicode")

    return xml_content


def main():
    parser = argparse.ArgumentParser(
        description="template_fill — PPTX 模板占位符批量替换",
    )
    parser.add_argument("dir", help="解压目录")
    parser.add_argument("-d", "--data", help="替换映射 JSON 字符串")
    parser.add_argument("-f", "--file", help="替换映射 JSON 文件")
    parser.add_argument("--format", default="{{}}", choices=["{{}}", "{}", "%%", "$$"],
                        help="占位符格式（默认: {{}}）")
    parser.add_argument("--scan", action="store_true", help="仅扫描占位符，不替换")

    args = parser.parse_args()

    if args.scan:
        placeholders = scan_placeholders(args.dir)
        if placeholders:
            print(f"找到 {len(placeholders)} 个占位符:")
            for p in placeholders:
                print(f"  [{p['file']}] {p['placeholder']}")
        else:
            print("未找到占位符")
        return

    if not args.data and not args.file:
        print("错误: 需要 --data 或 --file 参数", file=sys.stderr)
        sys.exit(1)

    if args.data:
        replacements = json.loads(args.data)
    else:
        with open(args.file, "r", encoding="utf-8") as f:
            replacements = json.load(f)

    result = fill_template(args.dir, replacements, args.format)
    print(f"✓ 替换完成:")
    print(f"  总替换数: {result['total_replacements']}")
    print(f"  修改文件: {result['files_modified']}")
    for d in result['details']:
        print(f"    {d['file']}: {d['replacements']} 处")


if __name__ == "__main__":
    main()
