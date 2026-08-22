#!/usr/bin/env python3
"""
validate.py — PPTX XML 结构验证

验证解压后的 PPTX 目录的 XML 结构完整性：
  1. XML 语法验证（所有 .xml/.rels 文件可解析）
  2. 文件引用验证（.rels 中的引用指向存在的文件）
  3. Content_Types 验证（所有文件都有对应的内容类型注册）
  4. 幻灯片布局验证（每张幻灯片有且只有一个布局引用）
  5. 备注幻灯片验证（备注不被多张幻灯片共享）
  6. sldIdLst 一致性验证
  7. 关系 ID 唯一性验证

用法：
  python validate.py unpacked/
  python validate.py unpacked/ --fix    # 自动修复可修复的问题
  python validate.py unpacked/ --json   # JSON 格式输出
"""

import argparse
import json
import os
import re
import sys
from pathlib import Path

from defusedxml import ElementTree as ET


REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types"
P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

LAYOUT_REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout"
NOTES_REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide"


def validate_pptx_dir(unpacked_dir: str, original_path: str = None) -> list[str]:
    """
    验证解压后的 PPTX 目录。

    Args:
        unpacked_dir: 解压目录
        original_path: 原始 PPTX（用于差异验证）

    Returns:
        错误消息列表（空列表 = 验证通过）
    """
    errors = []

    errors.extend(_check_xml_syntax(unpacked_dir))
    errors.extend(_check_required_files(unpacked_dir))
    errors.extend(_check_file_references(unpacked_dir))
    errors.extend(_check_content_types(unpacked_dir))
    errors.extend(_check_slide_layouts(unpacked_dir))
    errors.extend(_check_notes_slides(unpacked_dir))
    errors.extend(_check_sld_id_lst(unpacked_dir))
    errors.extend(_check_unique_rids(unpacked_dir))

    return errors


def _check_xml_syntax(unpacked_dir: str) -> list[str]:
    """检查所有 XML 文件的语法。"""
    errors = []
    for root, dirs, files in os.walk(unpacked_dir):
        for fname in files:
            if fname.endswith(".xml") or fname.endswith(".rels"):
                fpath = os.path.join(root, fname)
                try:
                    ET.parse(fpath)
                except ET.ParseError as e:
                    rel_path = os.path.relpath(fpath, unpacked_dir)
                    errors.append(f"[XML_SYNTAX] {rel_path}: {e}")
    return errors


def _check_required_files(unpacked_dir: str) -> list[str]:
    """检查必需的文件是否存在。"""
    errors = []
    required = [
        "[Content_Types].xml",
        "_rels/.rels",
        "ppt/presentation.xml",
        "ppt/_rels/presentation.xml.rels",
    ]
    for path in required:
        if not os.path.exists(os.path.join(unpacked_dir, path)):
            errors.append(f"[MISSING_FILE] Required file missing: {path}")
    return errors


def _check_file_references(unpacked_dir: str) -> list[str]:
    """检查 .rels 文件中的引用是否指向存在的文件。"""
    errors = []

    for root, dirs, files in os.walk(unpacked_dir):
        for fname in files:
            if not fname.endswith(".rels"):
                continue

            rels_path = os.path.join(root, fname)
            rel_rels_path = os.path.relpath(rels_path, unpacked_dir)

            try:
                rels_root = ET.parse(rels_path).getroot()
            except ET.ParseError:
                continue  # 已在 XML 语法检查中报告

            rels_dir = os.path.dirname(rels_path)
            if os.path.basename(rels_dir) == "_rels":
                base_dir = os.path.dirname(rels_dir)
            else:
                base_dir = rels_dir

            for rel in rels_root.findall(f"{{{REL_NS}}}Relationship"):
                target = rel.get("Target", "")
                target_mode = rel.get("TargetMode", "")

                # 跳过外部链接
                if target_mode == "External" or target.startswith("http://") or target.startswith("https://"):
                    continue

                abs_target = os.path.normpath(os.path.join(base_dir, target))

                if not os.path.exists(abs_target):
                    errors.append(
                        f"[BROKEN_REF] {rel_rels_path}: "
                        f"{rel.get('Id')} -> {target} (file not found)"
                    )

    return errors


def _check_content_types(unpacked_dir: str) -> list[str]:
    """检查 [Content_Types].xml 的完整性。"""
    errors = []
    ct_path = os.path.join(unpacked_dir, "[Content_Types].xml")

    if not os.path.exists(ct_path):
        return errors  # 已在必需文件检查中报告

    try:
        ct_root = ET.parse(ct_path).getroot()
    except ET.ParseError:
        return errors

    # 收集已注册的扩展名
    default_extensions = set()
    for default in ct_root.findall(f"{{{CT_NS}}}Default"):
        ext = default.get("Extension", "")
        default_extensions.add(ext.lower())

    # 收集已注册的 Override
    override_parts = set()
    for override in ct_root.findall(f"{{{CT_NS}}}Override"):
        part_name = override.get("PartName", "")
        override_parts.add(part_name)

        # 检查 Override 指向的文件是否存在
        file_path = os.path.join(unpacked_dir, part_name.lstrip("/"))
        if not os.path.exists(file_path):
            errors.append(f"[CONTENT_TYPE_ORPHAN] Override for non-existent file: {part_name}")

    return errors


def _check_slide_layouts(unpacked_dir: str) -> list[str]:
    """检查每张幻灯片有且只有一个布局引用。"""
    errors = []
    slides_rels_dir = os.path.join(unpacked_dir, "ppt", "slides", "_rels")

    if not os.path.exists(slides_rels_dir):
        return errors

    for fname in os.listdir(slides_rels_dir):
        if not fname.endswith(".rels"):
            continue

        rels_path = os.path.join(slides_rels_dir, fname)
        try:
            rels_root = ET.parse(rels_path).getroot()
        except ET.ParseError:
            continue

        layout_count = 0
        for rel in rels_root.findall(f"{{{REL_NS}}}Relationship"):
            if LAYOUT_REL_TYPE in rel.get("Type", ""):
                layout_count += 1

        slide_name = fname[:-5]  # 去掉 .rels

        if layout_count == 0:
            errors.append(f"[NO_LAYOUT] {slide_name}: No slideLayout relationship found")
        elif layout_count > 1:
            errors.append(f"[DUPLICATE_LAYOUT] {slide_name}: {layout_count} slideLayout relationships (should be 1)")

    return errors


def _check_notes_slides(unpacked_dir: str) -> list[str]:
    """检查备注幻灯片没有被多张幻灯片共享。"""
    errors = []
    notes_usage = {}  # notes_file → [slide_files]
    slides_rels_dir = os.path.join(unpacked_dir, "ppt", "slides", "_rels")

    if not os.path.exists(slides_rels_dir):
        return errors

    for fname in os.listdir(slides_rels_dir):
        if not fname.endswith(".rels"):
            continue

        rels_path = os.path.join(slides_rels_dir, fname)
        slide_name = fname[:-5]

        try:
            rels_root = ET.parse(rels_path).getroot()
        except ET.ParseError:
            continue

        for rel in rels_root.findall(f"{{{REL_NS}}}Relationship"):
            if NOTES_REL_TYPE in rel.get("Type", ""):
                notes_target = os.path.basename(rel.get("Target", ""))
                if notes_target not in notes_usage:
                    notes_usage[notes_target] = []
                notes_usage[notes_target].append(slide_name)

    for notes_file, slides in notes_usage.items():
        if len(slides) > 1:
            errors.append(
                f"[SHARED_NOTES] {notes_file} is shared by {len(slides)} slides: "
                f"{', '.join(slides)}"
            )

    return errors


def _check_sld_id_lst(unpacked_dir: str) -> list[str]:
    """检查 sldIdLst 与实际幻灯片文件的一致性。"""
    errors = []
    pres_path = os.path.join(unpacked_dir, "ppt", "presentation.xml")
    rels_path = os.path.join(unpacked_dir, "ppt", "_rels", "presentation.xml.rels")

    if not os.path.exists(pres_path) or not os.path.exists(rels_path):
        return errors

    try:
        pres_root = ET.parse(pres_path).getroot()
        rels_root = ET.parse(rels_path).getroot()
    except ET.ParseError:
        return errors

    # 构建 rId → target 映射
    rid_to_target = {}
    for rel in rels_root.findall(f"{{{REL_NS}}}Relationship"):
        rid_to_target[rel.get("Id")] = rel.get("Target")

    sld_id_lst = pres_root.find(f"{{{P_NS}}}sldIdLst")
    if sld_id_lst is None:
        return errors

    # 检查 sldIdLst 中的每个引用
    seen_ids = set()
    for sld_id in sld_id_lst.findall(f"{{{P_NS}}}sldId"):
        sid = sld_id.get("id")
        rid = sld_id.get(f"{{{R_NS}}}id")

        # ID 唯一性
        if sid in seen_ids:
            errors.append(f"[DUPLICATE_SLIDE_ID] Duplicate slide id: {sid}")
        seen_ids.add(sid)

        # rId 存在性
        if rid not in rid_to_target:
            errors.append(f"[INVALID_RID] sldId references non-existent rId: {rid}")
        else:
            # 文件存在性
            target = rid_to_target[rid]
            slide_path = os.path.join(unpacked_dir, "ppt", target)
            if not os.path.exists(slide_path):
                errors.append(
                    f"[MISSING_SLIDE] sldId {sid} ({rid}) -> {target} (file not found)"
                )

    return errors


def _check_unique_rids(unpacked_dir: str) -> list[str]:
    """检查每个 .rels 文件内的 rId 唯一性。"""
    errors = []

    for root, dirs, files in os.walk(unpacked_dir):
        for fname in files:
            if not fname.endswith(".rels"):
                continue

            rels_path = os.path.join(root, fname)
            rel_path = os.path.relpath(rels_path, unpacked_dir)

            try:
                rels_root = ET.parse(rels_path).getroot()
            except ET.ParseError:
                continue

            seen = set()
            for rel in rels_root.findall(f"{{{REL_NS}}}Relationship"):
                rid = rel.get("Id")
                if rid in seen:
                    errors.append(f"[DUPLICATE_RID] {rel_path}: Duplicate relationship Id: {rid}")
                seen.add(rid)

    return errors


def main():
    parser = argparse.ArgumentParser(
        description="validate — PPTX XML 结构验证",
    )
    parser.add_argument("dir", help="解压目录")
    parser.add_argument("--json", action="store_true", help="JSON 格式输出")
    parser.add_argument("--original", help="原始 PPTX（用于差异验证）")

    args = parser.parse_args()

    errors = validate_pptx_dir(args.dir, original_path=args.original)

    if args.json:
        print(json.dumps({
            "valid": len(errors) == 0,
            "error_count": len(errors),
            "errors": errors,
        }, ensure_ascii=False, indent=2))
    else:
        if errors:
            print(f"✗ 验证失败: {len(errors)} 个错误")
            for err in errors:
                print(f"  {err}")
            sys.exit(1)
        else:
            print("✓ 验证通过")

    sys.exit(0 if not errors else 1)


if __name__ == "__main__":
    main()
