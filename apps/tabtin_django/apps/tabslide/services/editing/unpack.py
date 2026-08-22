#!/usr/bin/env python3
"""
unpack.py — 智能解压 PPTX 为可编辑的 XML 文件

核心功能：
  1. 解压 PPTX（本质是 ZIP）到目录
  2. XML 美化（2 空格缩进，便于 AI/人类阅读和编辑）
  3. 智能引号转义为 XML 实体（防止编辑工具破坏 Unicode 引号）
  4. 使用 defusedxml 防止 XXE 攻击

用法：
  python unpack.py presentation.pptx unpacked/
  python unpack.py template.pptx unpacked/ --no-pretty
"""

import argparse
import os
import sys
import zipfile
from pathlib import Path

# 智能引号 → XML 实体映射
# 这些 Unicode 引号在某些编辑器中会被转换为 ASCII 引号，
# 转义为 XML 实体后可以安全保留
SMART_QUOTE_MAP = {
    "\u201c": "&#x201C;",  # 左双引号 "
    "\u201d": "&#x201D;",  # 右双引号 "
    "\u2018": "&#x2018;",  # 左单引号 '
    "\u2019": "&#x2019;",  # 右单引号 '
}


def _pretty_print_xml(xml_bytes: bytes) -> bytes:
    """美化 XML 为 2 空格缩进格式。"""
    from defusedxml.minidom import parseString

    try:
        dom = parseString(xml_bytes)
        pretty = dom.toprettyxml(indent="  ", encoding="utf-8")
        # toprettyxml 会加上 <?xml ?> 声明行，如果原始也有就会重复
        # 去掉第一行的 <?xml ?> 如果原始文件已有
        lines = pretty.split(b"\n")
        if len(lines) > 1 and lines[0].startswith(b"<?xml"):
            # 检查是否有空行
            result = b"\n".join(line for line in lines if line.strip())
            return result
        return pretty
    except Exception:
        # XML 解析失败，返回原始内容
        return xml_bytes


def _escape_smart_quotes(text: str) -> str:
    """将智能引号替换为 XML 实体。"""
    for char, entity in SMART_QUOTE_MAP.items():
        text = text.replace(char, entity)
    return text


def unpack(pptx_path: str, output_dir: str, pretty: bool = True) -> dict:
    """
    解压 PPTX 文件到目录。

    Args:
        pptx_path: PPTX 文件路径
        output_dir: 输出目录
        pretty: 是否美化 XML（默认 True）

    Returns:
        {
            "output_dir": str,
            "total_files": int,
            "xml_files": int,
            "media_files": int,
            "slides": [str, ...],  # 幻灯片文件列表
        }
    """
    pptx_path = str(Path(pptx_path).resolve())
    output_dir = str(Path(output_dir).resolve())

    if not os.path.exists(pptx_path):
        raise FileNotFoundError(f"PPTX not found: {pptx_path}")

    if not zipfile.is_zipfile(pptx_path):
        raise ValueError(f"Not a valid ZIP/PPTX file: {pptx_path}")

    os.makedirs(output_dir, exist_ok=True)

    xml_count = 0
    media_count = 0
    total_count = 0
    slides = []

    with zipfile.ZipFile(pptx_path, 'r') as zf:
        for info in zf.infolist():
            # 跳过目录条目
            if info.is_dir():
                continue

            # 解压文件 — 防御 ZIP Slip 路径穿越
            target_path = os.path.normpath(os.path.join(output_dir, info.filename))
            if not target_path.startswith(output_dir + os.sep) and target_path != output_dir:
                raise ValueError(
                    f"ZIP entry path traversal blocked: {info.filename!r}"
                )
            target_dir = os.path.dirname(target_path)
            os.makedirs(target_dir, exist_ok=True)

            data = zf.read(info.filename)
            total_count += 1

            # 记录幻灯片
            if info.filename.startswith("ppt/slides/slide") and info.filename.endswith(".xml"):
                slides.append(info.filename)

            # 记录媒体文件
            if info.filename.startswith("ppt/media/"):
                media_count += 1

            # 对 XML 和 .rels 文件进行美化
            is_xml = info.filename.endswith(".xml") or info.filename.endswith(".rels")

            if is_xml:
                xml_count += 1

                if pretty:
                    # 美化 XML
                    data = _pretty_print_xml(data)

                    # 智能引号转义
                    try:
                        text = data.decode("utf-8")
                        text = _escape_smart_quotes(text)
                        data = text.encode("utf-8")
                    except (UnicodeDecodeError, UnicodeEncodeError):
                        pass  # 非 UTF-8 文件，跳过

            with open(target_path, "wb") as f:
                f.write(data)

    # 排序幻灯片列表
    slides.sort(key=lambda s: int(''.join(filter(str.isdigit, s.split('/')[-1])) or '0'))

    return {
        "output_dir": output_dir,
        "total_files": total_count,
        "xml_files": xml_count,
        "media_files": media_count,
        "slides": slides,
    }


def main():
    parser = argparse.ArgumentParser(
        description="unpack — 智能解压 PPTX 为可编辑的 XML 文件",
    )
    parser.add_argument("input", help="PPTX 文件路径")
    parser.add_argument("output", help="输出目录")
    parser.add_argument("--no-pretty", action="store_true", help="不美化 XML")

    args = parser.parse_args()

    try:
        result = unpack(args.input, args.output, pretty=not args.no_pretty)
        print(f"✓ 解压完成: {result['output_dir']}")
        print(f"  总文件: {result['total_files']}")
        print(f"  XML 文件: {result['xml_files']}")
        print(f"  媒体文件: {result['media_files']}")
        print(f"  幻灯片: {len(result['slides'])}")
        for s in result['slides']:
            print(f"    {s}")
    except Exception as e:
        print(f"✗ 解压失败: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
