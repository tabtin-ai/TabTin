#!/usr/bin/env python3
"""
pack.py — 将编辑后的 XML 目录重新打包为 PPTX

核心功能：
  1. XML 压缩（去除美化缩进，还原紧凑格式）
  2. 保留文本元素中的空白（<a:t> 等以 :t 结尾的元素）
  3. 可选：打包前运行 PPTX 结构验证
  4. ZIP_DEFLATED 压缩输出

用法：
  python pack.py unpacked/ output.pptx
  python pack.py unpacked/ output.pptx --validate
  python pack.py unpacked/ output.pptx --original template.pptx --validate
"""

import argparse
import os
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path


# 智能引号 XML 实体 → Unicode 还原映射
SMART_QUOTE_RESTORE = {
    "&#x201C;": "\u201c",
    "&#x201D;": "\u201d",
    "&#x2018;": "\u2018",
    "&#x2019;": "\u2019",
}


def _condense_xml(xml_bytes: bytes) -> bytes:
    """
    压缩 XML：去除美化缩进，保留文本内容。

    关键：以 :t 结尾的元素（如 <a:t>, <w:t>）的文本内容必须保留，
    其他元素间的空白文本节点全部去除。
    """
    from defusedxml.minidom import parseString

    try:
        dom = parseString(xml_bytes)

        # 递归去除空白文本节点（但保留 :t 元素内的文本）
        _strip_whitespace_nodes(dom.documentElement)

        result = dom.toxml(encoding="UTF-8")

        # 还原智能引号
        try:
            text = result.decode("utf-8")
            for entity, char in SMART_QUOTE_RESTORE.items():
                text = text.replace(entity, char)
            result = text.encode("utf-8")
        except (UnicodeDecodeError, UnicodeEncodeError):
            pass

        return result

    except Exception:
        # 如果解析失败，返回原始内容
        return xml_bytes


def _strip_whitespace_nodes(node):
    """递归去除空白文本节点，但保留 :t 元素的文本内容。"""
    remove_list = []

    for child in node.childNodes:
        if child.nodeType == child.TEXT_NODE:
            # 如果父元素 tagName 以 :t 结尾，保留文本
            parent_tag = node.tagName if hasattr(node, 'tagName') else ""
            if parent_tag.endswith(":t"):
                continue
            # 否则，如果是纯空白文本节点，标记删除
            if child.data.strip() == "":
                remove_list.append(child)
        elif child.nodeType == child.COMMENT_NODE:
            # 去除注释
            remove_list.append(child)
        elif child.nodeType == child.ELEMENT_NODE:
            _strip_whitespace_nodes(child)

    for node_to_remove in remove_list:
        node.removeChild(node_to_remove)


def pack(
    input_dir: str,
    output_path: str,
    validate: bool = False,
    original_path: str = None,
) -> str:
    """
    将目录打包为 PPTX 文件。

    Args:
        input_dir: 解压后的 XML 目录
        output_path: 输出 PPTX 文件路径
        validate: 是否在打包前验证
        original_path: 原始 PPTX（用于差异验证，只报告新增错误）

    Returns:
        输出文件路径
    """
    input_dir = str(Path(input_dir).resolve())
    output_path = str(Path(output_path).resolve())

    if not os.path.isdir(input_dir):
        raise NotADirectoryError(f"Input directory not found: {input_dir}")

    # 检查必要文件
    content_types = os.path.join(input_dir, "[Content_Types].xml")
    if not os.path.exists(content_types):
        raise FileNotFoundError(f"Missing [Content_Types].xml in {input_dir}")

    # 可选：验证
    if validate:
        from .validate import validate_pptx_dir
        errors = validate_pptx_dir(input_dir, original_path=original_path)
        if errors:
            print("⚠ 验证发现问题:", file=sys.stderr)
            for err in errors:
                print(f"  - {err}", file=sys.stderr)
            raise RuntimeError(f"验证失败: {len(errors)} 个错误。请修复后重试。")

    # 在临时目录中操作（不修改原始文件）
    with tempfile.TemporaryDirectory(prefix="pack_") as tmp_dir:
        work_dir = os.path.join(tmp_dir, "work")
        shutil.copytree(input_dir, work_dir)

        # 压缩所有 XML 文件
        for root, dirs, files in os.walk(work_dir):
            for fname in files:
                if fname.endswith(".xml") or fname.endswith(".rels"):
                    fpath = os.path.join(root, fname)
                    with open(fpath, "rb") as f:
                        data = f.read()
                    condensed = _condense_xml(data)
                    with open(fpath, "wb") as f:
                        f.write(condensed)

        # 创建 ZIP
        os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)

        with zipfile.ZipFile(output_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for root, dirs, files in os.walk(work_dir):
                for fname in files:
                    fpath = os.path.join(root, fname)
                    arcname = os.path.relpath(fpath, work_dir)
                    zf.write(fpath, arcname)

    return output_path


def main():
    parser = argparse.ArgumentParser(
        description="pack — 将编辑后的 XML 目录打包为 PPTX",
    )
    parser.add_argument("input", help="解压后的目录")
    parser.add_argument("output", help="输出 PPTX 文件路径")
    parser.add_argument("--validate", action="store_true", help="打包前验证 XML 结构")
    parser.add_argument("--original", help="原始 PPTX（用于差异验证）")

    args = parser.parse_args()

    try:
        result = pack(
            args.input, args.output,
            validate=args.validate,
            original_path=args.original,
        )
        file_size = os.path.getsize(result)
        print(f"✓ 打包完成: {result} ({file_size:,} bytes)")
    except Exception as e:
        print(f"✗ 打包失败: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
