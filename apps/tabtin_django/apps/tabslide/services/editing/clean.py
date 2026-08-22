#!/usr/bin/env python3
"""
clean.py — 清理解压 PPTX 目录中的孤立文件

检测并删除未被任何幻灯片引用的资源文件，包括：
  - 孤立的幻灯片（不在 presentation.xml 的 sldIdLst 中）
  - 孤立的媒体文件（图片/音视频）
  - 孤立的图表/SmartArt/嵌入对象
  - 孤立的备注幻灯片
  - 过时的 .rels 文件
  - [Content_Types].xml 中的悬空条目

迭代清理：级联删除（删除图表后，图表引用的图片也变成孤立的）

用法：
  python clean.py unpacked/
  python clean.py unpacked/ --dry-run  # 仅预览，不删除
"""

import argparse
import os
import re
import sys
from pathlib import Path

from defusedxml import ElementTree as ET


REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types"
P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

SLIDE_REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide"

# 需要检查孤立文件的目录
RESOURCE_DIRS = [
    "ppt/media",
    "ppt/embeddings",
    "ppt/charts",
    "ppt/diagrams",
    "ppt/tags",
    "ppt/drawings",
    "ppt/ink",
    "ppt/notesSlides",
]


def get_referenced_files(unpacked_dir: str) -> set[str]:
    """
    遍历所有 .rels 文件，收集所有被引用的文件路径。

    返回相对于 unpacked_dir 的标准化路径集合。
    """
    referenced = set()
    ppt_dir = os.path.join(unpacked_dir, "ppt")

    for root, dirs, files in os.walk(unpacked_dir):
        for fname in files:
            if not fname.endswith(".rels"):
                continue

            rels_path = os.path.join(root, fname)
            try:
                rels_root = ET.parse(rels_path).getroot()
            except ET.ParseError:
                continue

            # .rels 文件所在目录的父目录（_rels/ 的上一级）
            rels_dir = os.path.dirname(rels_path)
            if os.path.basename(rels_dir) == "_rels":
                base_dir = os.path.dirname(rels_dir)
            else:
                base_dir = rels_dir

            for rel in rels_root.findall(f"{{{REL_NS}}}Relationship"):
                target = rel.get("Target", "")
                if not target or target.startswith("http://") or target.startswith("https://"):
                    continue

                # 解析相对路径
                abs_target = os.path.normpath(os.path.join(base_dir, target))
                rel_target = os.path.relpath(abs_target, unpacked_dir)
                referenced.add(rel_target)

    return referenced


def get_valid_slides(unpacked_dir: str) -> set[str]:
    """获取 presentation.xml sldIdLst 中的有效幻灯片文件名。"""
    pres_path = os.path.join(unpacked_dir, "ppt", "presentation.xml")
    rels_path = os.path.join(unpacked_dir, "ppt", "_rels", "presentation.xml.rels")

    if not os.path.exists(pres_path) or not os.path.exists(rels_path):
        return set()

    pres_root = ET.parse(pres_path).getroot()
    rels_root = ET.parse(rels_path).getroot()

    # 获取 sldIdLst 中的 rId
    valid_rids = set()
    sld_id_lst = pres_root.find(f"{{{P_NS}}}sldIdLst")
    if sld_id_lst is not None:
        for sld_id in sld_id_lst.findall(f"{{{P_NS}}}sldId"):
            rid = sld_id.get(f"{{{R_NS}}}id")
            if rid:
                valid_rids.add(rid)

    # rId → filename
    valid_slides = set()
    for rel in rels_root.findall(f"{{{REL_NS}}}Relationship"):
        if rel.get("Id") in valid_rids:
            target = rel.get("Target", "")
            valid_slides.add(os.path.basename(target))

    return valid_slides


def clean(unpacked_dir: str, dry_run: bool = False) -> dict:
    """
    清理解压目录中的孤立文件。

    Args:
        unpacked_dir: 解压目录
        dry_run: 仅预览不删除

    Returns:
        {"removed_files": [str, ...], "iterations": int}
    """
    unpacked_dir = str(Path(unpacked_dir).resolve())
    all_removed = []
    iteration = 0

    # Phase 1: 删除孤立幻灯片
    orphan_slides = _find_orphan_slides(unpacked_dir)
    for slide_name in orphan_slides:
        slide_path = os.path.join(unpacked_dir, "ppt", "slides", slide_name)
        rels_path = os.path.join(unpacked_dir, "ppt", "slides", "_rels", f"{slide_name}.rels")

        if not dry_run:
            if os.path.exists(slide_path):
                os.remove(slide_path)
            if os.path.exists(rels_path):
                os.remove(rels_path)

        all_removed.append(f"ppt/slides/{slide_name} (orphan slide)")
        if os.path.exists(rels_path):
            all_removed.append(f"ppt/slides/_rels/{slide_name}.rels")

    # 清理 presentation.xml.rels 中的悬空 Relationship
    if orphan_slides and not dry_run:
        _clean_presentation_rels(unpacked_dir, orphan_slides)

    # Phase 2: 迭代清理资源文件
    while True:
        iteration += 1
        removed_this_round = []

        referenced = get_referenced_files(unpacked_dir)

        for res_dir in RESOURCE_DIRS:
            full_dir = os.path.join(unpacked_dir, res_dir)
            if not os.path.exists(full_dir):
                continue

            for fname in os.listdir(full_dir):
                fpath = os.path.join(full_dir, fname)
                if os.path.isdir(fpath):
                    continue

                # 跳过 .rels 文件（它们在这里单独处理）
                if fname.endswith(".rels"):
                    continue

                rel_path = os.path.relpath(fpath, unpacked_dir)

                if rel_path not in referenced:
                    if not dry_run:
                        os.remove(fpath)
                        # 也删除对应的 .rels
                        rels_file = os.path.join(full_dir, "_rels", f"{fname}.rels")
                        if os.path.exists(rels_file):
                            os.remove(rels_file)
                    removed_this_round.append(rel_path)

        # 清理孤立的 .rels 文件
        for res_dir in RESOURCE_DIRS:
            rels_dir = os.path.join(unpacked_dir, res_dir, "_rels")
            if not os.path.exists(rels_dir):
                continue
            for fname in os.listdir(rels_dir):
                if not fname.endswith(".rels"):
                    continue
                # 对应的资源文件应该存在
                resource_name = fname[:-5]  # 去掉 .rels
                resource_path = os.path.join(unpacked_dir, res_dir, resource_name)
                if not os.path.exists(resource_path):
                    rels_file = os.path.join(rels_dir, fname)
                    if not dry_run:
                        os.remove(rels_file)
                    removed_this_round.append(os.path.relpath(rels_file, unpacked_dir))

        all_removed.extend(removed_this_round)

        # 如果没有更多文件被删除，退出迭代
        if not removed_this_round:
            break

        if iteration > 10:
            break  # 安全阀

    # Phase 3: 清理 [Content_Types].xml
    if all_removed and not dry_run:
        _clean_content_types(unpacked_dir)

    return {
        "removed_files": all_removed,
        "iterations": iteration,
    }


def _find_orphan_slides(unpacked_dir: str) -> list[str]:
    """找出不在 sldIdLst 中的幻灯片文件。"""
    valid = get_valid_slides(unpacked_dir)
    slides_dir = os.path.join(unpacked_dir, "ppt", "slides")

    orphans = []
    if os.path.exists(slides_dir):
        for fname in os.listdir(slides_dir):
            if re.match(r"slide\d+\.xml$", fname) and fname not in valid:
                orphans.append(fname)

    return orphans


def _clean_presentation_rels(unpacked_dir: str, orphan_slides: list[str]):
    """清理 presentation.xml.rels 中指向已删除幻灯片的 Relationship。"""
    rels_path = os.path.join(unpacked_dir, "ppt", "_rels", "presentation.xml.rels")
    if not os.path.exists(rels_path):
        return

    rels_root = ET.parse(rels_path).getroot()
    to_remove = []

    for rel in rels_root.findall(f"{{{REL_NS}}}Relationship"):
        target = rel.get("Target", "")
        target_name = os.path.basename(target)
        if target_name in orphan_slides:
            to_remove.append(rel)

    for rel in to_remove:
        rels_root.remove(rel)

    tree = ET.ElementTree(rels_root)
    ET.indent(tree, space="  ")
    tree.write(rels_path, encoding="utf-8", xml_declaration=True)


def _clean_content_types(unpacked_dir: str):
    """清理 [Content_Types].xml 中指向不存在文件的 Override 条目。"""
    ct_path = os.path.join(unpacked_dir, "[Content_Types].xml")
    if not os.path.exists(ct_path):
        return

    ct_root = ET.parse(ct_path).getroot()
    to_remove = []

    for override in ct_root.findall(f"{{{CT_NS}}}Override"):
        part_name = override.get("PartName", "")
        # PartName 以 / 开头
        file_path = os.path.join(unpacked_dir, part_name.lstrip("/"))
        if not os.path.exists(file_path):
            to_remove.append(override)

    for elem in to_remove:
        ct_root.remove(elem)

    tree = ET.ElementTree(ct_root)
    ET.indent(tree, space="  ")
    tree.write(ct_path, encoding="utf-8", xml_declaration=True)


def main():
    parser = argparse.ArgumentParser(
        description="clean — 清理 PPTX 解压目录中的孤立文件",
    )
    parser.add_argument("dir", help="解压目录")
    parser.add_argument("--dry-run", action="store_true", help="仅预览，不删除")

    args = parser.parse_args()

    result = clean(args.dir, dry_run=args.dry_run)

    if result["removed_files"]:
        action = "将删除" if args.dry_run else "已删除"
        print(f"{'[预览] ' if args.dry_run else ''}✓ 清理完成 ({result['iterations']} 轮迭代):")
        for f in result["removed_files"]:
            print(f"  {action}: {f}")
    else:
        print("✓ 没有发现孤立文件")


if __name__ == "__main__":
    main()
