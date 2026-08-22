#!/usr/bin/env python3
"""
slide_ops.py — 幻灯片操作工具

在 unpack 后的目录中执行幻灯片级别的操作：
  - 列出所有幻灯片及其布局
  - 复制已有幻灯片（正确处理关系文件）
  - 从布局模板创建新空白幻灯片
  - 删除幻灯片
  - 调整幻灯片顺序

用法：
  python slide_ops.py list unpacked/
  python slide_ops.py duplicate unpacked/ --source slide1.xml --name slide4.xml
  python slide_ops.py create unpacked/ --layout slideLayout2.xml --name slide4.xml
  python slide_ops.py delete unpacked/ --slide slide3.xml
  python slide_ops.py reorder unpacked/ --order slide2.xml,slide1.xml,slide3.xml
"""

import argparse
import os
import re
import shutil
import sys
from pathlib import Path

from defusedxml import ElementTree as ET


# OOXML 命名空间
NS = {
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "rel": "http://schemas.openxmlformats.org/package/2006/relationships",
}

# 注册命名空间前缀（避免 ET 输出时丢失）
for prefix, uri in NS.items():
    ET.register_namespace(prefix if prefix != "rel" else "", uri)

SLIDE_REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide"
LAYOUT_REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout"
NOTES_REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide"
SLIDE_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.slide+xml"


def _read_xml(filepath: str) -> ET.Element:
    """读取 XML 文件并返回根元素。"""
    tree = ET.parse(filepath)
    return tree.getroot()


def _write_xml(root: ET.Element, filepath: str):
    """写入 XML 文件。"""
    tree = ET.ElementTree(root)
    ET.indent(tree, space="  ")
    tree.write(filepath, encoding="utf-8", xml_declaration=True)


def _get_presentation_path(unpacked_dir: str) -> str:
    return os.path.join(unpacked_dir, "ppt", "presentation.xml")


def _get_presentation_rels_path(unpacked_dir: str) -> str:
    return os.path.join(unpacked_dir, "ppt", "_rels", "presentation.xml.rels")


def _get_content_types_path(unpacked_dir: str) -> str:
    return os.path.join(unpacked_dir, "[Content_Types].xml")


def _get_next_rid(rels_root: ET.Element) -> str:
    """获取下一个可用的 rId。"""
    max_id = 0
    for rel in rels_root.findall("{http://schemas.openxmlformats.org/package/2006/relationships}Relationship"):
        rid = rel.get("Id", "")
        m = re.match(r"rId(\d+)", rid)
        if m:
            max_id = max(max_id, int(m.group(1)))
    return f"rId{max_id + 1}"


def _get_next_slide_id(pres_root: ET.Element) -> int:
    """获取下一个可用的幻灯片 ID。"""
    max_id = 255  # OOXML 惯例：从 256 开始
    sld_id_lst = pres_root.find(f"{{{NS['p']}}}sldIdLst")
    if sld_id_lst is not None:
        for sld_id in sld_id_lst.findall(f"{{{NS['p']}}}sldId"):
            id_val = int(sld_id.get("id", "0"))
            max_id = max(max_id, id_val)
    return max_id + 1


def _get_next_slide_filename(unpacked_dir: str) -> str:
    """获取下一个可用的幻灯片文件名。"""
    slides_dir = os.path.join(unpacked_dir, "ppt", "slides")
    if not os.path.exists(slides_dir):
        return "slide1.xml"

    max_num = 0
    for f in os.listdir(slides_dir):
        m = re.match(r"slide(\d+)\.xml", f)
        if m:
            max_num = max(max_num, int(m.group(1)))
    return f"slide{max_num + 1}.xml"


# ============================================================
# list — 列出所有幻灯片
# ============================================================

def list_slides(unpacked_dir: str) -> list[dict]:
    """列出解压目录中的所有幻灯片信息。"""
    pres_path = _get_presentation_path(unpacked_dir)
    rels_path = _get_presentation_rels_path(unpacked_dir)

    pres_root = _read_xml(pres_path)
    rels_root = _read_xml(rels_path)

    # 构建 rId → target 映射
    rid_map = {}
    for rel in rels_root.findall("{http://schemas.openxmlformats.org/package/2006/relationships}Relationship"):
        rid_map[rel.get("Id")] = {
            "target": rel.get("Target"),
            "type": rel.get("Type"),
        }

    # 读取幻灯片顺序
    slides = []
    sld_id_lst = pres_root.find(f"{{{NS['p']}}}sldIdLst")

    if sld_id_lst is not None:
        for sld_id in sld_id_lst.findall(f"{{{NS['p']}}}sldId"):
            sid = sld_id.get("id")
            rid = sld_id.get(f"{{{NS['r']}}}id")
            rel_info = rid_map.get(rid, {})
            target = rel_info.get("target", "unknown")
            filename = os.path.basename(target) if target else "unknown"

            # 读取幻灯片的布局信息
            layout = "unknown"
            slide_rels_path = os.path.join(
                unpacked_dir, "ppt", "slides", "_rels", f"{filename}.rels"
            )
            if os.path.exists(slide_rels_path):
                slide_rels = _read_xml(slide_rels_path)
                for srel in slide_rels.findall("{http://schemas.openxmlformats.org/package/2006/relationships}Relationship"):
                    if LAYOUT_REL_TYPE in srel.get("Type", ""):
                        layout = os.path.basename(srel.get("Target", ""))
                        break

            slides.append({
                "index": len(slides) + 1,
                "id": sid,
                "rId": rid,
                "filename": filename,
                "layout": layout,
            })

    return slides


# ============================================================
# duplicate — 复制已有幻灯片
# ============================================================

def duplicate_slide(
    unpacked_dir: str,
    source_name: str,
    target_name: str = None,
    position: int = None,
) -> dict:
    """
    复制一张幻灯片。

    Args:
        unpacked_dir: 解压目录
        source_name: 源幻灯片文件名（如 slide1.xml）
        target_name: 目标文件名（默认自动生成）
        position: 插入位置（1-indexed），None = 追加到末尾

    Returns:
        {"filename": str, "id": int, "rId": str}
    """
    if target_name is None:
        target_name = _get_next_slide_filename(unpacked_dir)

    slides_dir = os.path.join(unpacked_dir, "ppt", "slides")
    rels_dir = os.path.join(unpacked_dir, "ppt", "slides", "_rels")

    src_path = os.path.join(slides_dir, source_name)
    dst_path = os.path.join(slides_dir, target_name)

    if not os.path.exists(src_path):
        raise FileNotFoundError(f"Source slide not found: {source_name}")

    if os.path.exists(dst_path):
        raise FileExistsError(f"Target slide already exists: {target_name}")

    # 1. 复制幻灯片 XML
    shutil.copy2(src_path, dst_path)

    # 2. 复制 .rels 文件，但去掉 notesSlide 引用（防止两张幻灯片共享备注）
    src_rels = os.path.join(rels_dir, f"{source_name}.rels")
    dst_rels = os.path.join(rels_dir, f"{target_name}.rels")

    if os.path.exists(src_rels):
        os.makedirs(rels_dir, exist_ok=True)
        rels_root = _read_xml(src_rels)

        # 删除 notesSlide 关系
        to_remove = []
        for rel in rels_root.findall("{http://schemas.openxmlformats.org/package/2006/relationships}Relationship"):
            if NOTES_REL_TYPE in rel.get("Type", ""):
                to_remove.append(rel)
        for rel in to_remove:
            rels_root.remove(rel)

        _write_xml(rels_root, dst_rels)

    # 3. 注册到 [Content_Types].xml
    _add_content_type(unpacked_dir, f"/ppt/slides/{target_name}", SLIDE_CONTENT_TYPE)

    # 4. 注册到 presentation.xml.rels
    rels_path = _get_presentation_rels_path(unpacked_dir)
    rels_root = _read_xml(rels_path)
    new_rid = _get_next_rid(rels_root)

    new_rel = ET.SubElement(rels_root, "{http://schemas.openxmlformats.org/package/2006/relationships}Relationship")
    new_rel.set("Id", new_rid)
    new_rel.set("Type", SLIDE_REL_TYPE)
    new_rel.set("Target", f"slides/{target_name}")
    _write_xml(rels_root, rels_path)

    # 5. 注册到 presentation.xml 的 sldIdLst
    pres_path = _get_presentation_path(unpacked_dir)
    pres_root = _read_xml(pres_path)
    new_sid = _get_next_slide_id(pres_root)

    sld_id_lst = pres_root.find(f"{{{NS['p']}}}sldIdLst")
    if sld_id_lst is None:
        sld_id_lst = ET.SubElement(pres_root, f"{{{NS['p']}}}sldIdLst")

    new_sld_id = ET.SubElement(sld_id_lst, f"{{{NS['p']}}}sldId")
    new_sld_id.set("id", str(new_sid))
    new_sld_id.set(f"{{{NS['r']}}}id", new_rid)

    # 处理位置
    if position is not None and position > 0:
        # 移动到指定位置
        sld_ids = list(sld_id_lst)
        if position <= len(sld_ids):
            sld_id_lst.remove(new_sld_id)
            sld_id_lst.insert(position - 1, new_sld_id)

    _write_xml(pres_root, pres_path)

    return {
        "filename": target_name,
        "id": new_sid,
        "rId": new_rid,
    }


# ============================================================
# create — 从布局创建新空白幻灯片
# ============================================================

# 最小幻灯片 XML 模板
MINIMAL_SLIDE_XML = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
       xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
       xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr>
        <p:cNvPr id="1" name=""/>
        <p:cNvGrpSpPr/>
        <p:nvPr/>
      </p:nvGrpSpPr>
      <p:grpSpPr>
        <a:xfrm>
          <a:off x="0" y="0"/>
          <a:ext cx="0" cy="0"/>
          <a:chOff x="0" y="0"/>
          <a:chExt cx="0" cy="0"/>
        </a:xfrm>
      </p:grpSpPr>
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr>
    <a:masterClrMapping/>
  </p:clrMapOvr>
</p:sld>"""


def create_slide(
    unpacked_dir: str,
    layout_name: str = "slideLayout1.xml",
    target_name: str = None,
    position: int = None,
) -> dict:
    """
    从布局模板创建新空白幻灯片。

    Args:
        unpacked_dir: 解压目录
        layout_name: 布局文件名（如 slideLayout2.xml）
        target_name: 目标文件名（默认自动生成）
        position: 插入位置（1-indexed）

    Returns:
        {"filename": str, "id": int, "rId": str}
    """
    if target_name is None:
        target_name = _get_next_slide_filename(unpacked_dir)

    slides_dir = os.path.join(unpacked_dir, "ppt", "slides")
    rels_dir = os.path.join(unpacked_dir, "ppt", "slides", "_rels")
    os.makedirs(slides_dir, exist_ok=True)
    os.makedirs(rels_dir, exist_ok=True)

    dst_path = os.path.join(slides_dir, target_name)

    if os.path.exists(dst_path):
        raise FileExistsError(f"Slide already exists: {target_name}")

    # 验证布局文件存在
    layout_path = os.path.join(unpacked_dir, "ppt", "slideLayouts", layout_name)
    if not os.path.exists(layout_path):
        raise FileNotFoundError(f"Layout not found: {layout_name}")

    # 1. 创建幻灯片 XML
    with open(dst_path, "w", encoding="utf-8") as f:
        f.write(MINIMAL_SLIDE_XML)

    # 2. 创建 .rels 文件，指向布局
    rels_xml = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="{LAYOUT_REL_TYPE}" Target="../slideLayouts/{layout_name}"/>
</Relationships>"""

    rels_path = os.path.join(rels_dir, f"{target_name}.rels")
    with open(rels_path, "w", encoding="utf-8") as f:
        f.write(rels_xml)

    # 3. 注册到 [Content_Types].xml
    _add_content_type(unpacked_dir, f"/ppt/slides/{target_name}", SLIDE_CONTENT_TYPE)

    # 4-5. 注册到 presentation.xml.rels 和 presentation.xml
    rels_root_path = _get_presentation_rels_path(unpacked_dir)
    rels_root = _read_xml(rels_root_path)
    new_rid = _get_next_rid(rels_root)

    new_rel = ET.SubElement(rels_root, "{http://schemas.openxmlformats.org/package/2006/relationships}Relationship")
    new_rel.set("Id", new_rid)
    new_rel.set("Type", SLIDE_REL_TYPE)
    new_rel.set("Target", f"slides/{target_name}")
    _write_xml(rels_root, rels_root_path)

    pres_path = _get_presentation_path(unpacked_dir)
    pres_root = _read_xml(pres_path)
    new_sid = _get_next_slide_id(pres_root)

    sld_id_lst = pres_root.find(f"{{{NS['p']}}}sldIdLst")
    if sld_id_lst is None:
        sld_id_lst = ET.SubElement(pres_root, f"{{{NS['p']}}}sldIdLst")

    new_sld_id = ET.SubElement(sld_id_lst, f"{{{NS['p']}}}sldId")
    new_sld_id.set("id", str(new_sid))
    new_sld_id.set(f"{{{NS['r']}}}id", new_rid)

    if position is not None and position > 0:
        sld_ids = list(sld_id_lst)
        if position <= len(sld_ids):
            sld_id_lst.remove(new_sld_id)
            sld_id_lst.insert(position - 1, new_sld_id)

    _write_xml(pres_root, pres_path)

    return {
        "filename": target_name,
        "id": new_sid,
        "rId": new_rid,
    }


# ============================================================
# delete — 删除幻灯片
# ============================================================

def delete_slide(unpacked_dir: str, slide_name: str) -> bool:
    """
    删除一张幻灯片及其关系文件。

    Args:
        unpacked_dir: 解压目录
        slide_name: 幻灯片文件名（如 slide3.xml）

    Returns:
        是否成功删除
    """
    # 1. 从 presentation.xml 的 sldIdLst 中移除
    pres_path = _get_presentation_path(unpacked_dir)
    pres_root = _read_xml(pres_path)

    rels_path = _get_presentation_rels_path(unpacked_dir)
    rels_root = _read_xml(rels_path)

    # 找到对应的 rId
    target_rid = None
    for rel in rels_root.findall("{http://schemas.openxmlformats.org/package/2006/relationships}Relationship"):
        if rel.get("Target") == f"slides/{slide_name}":
            target_rid = rel.get("Id")
            rels_root.remove(rel)
            break

    if target_rid is None:
        print(f"Warning: {slide_name} not found in presentation.xml.rels", file=sys.stderr)
        return False

    # 从 sldIdLst 中删除
    sld_id_lst = pres_root.find(f"{{{NS['p']}}}sldIdLst")
    if sld_id_lst is not None:
        for sld_id in sld_id_lst.findall(f"{{{NS['p']}}}sldId"):
            if sld_id.get(f"{{{NS['r']}}}id") == target_rid:
                sld_id_lst.remove(sld_id)
                break

    _write_xml(pres_root, pres_path)
    _write_xml(rels_root, rels_path)

    # 2. 删除幻灯片文件和 .rels 文件
    slide_path = os.path.join(unpacked_dir, "ppt", "slides", slide_name)
    slide_rels = os.path.join(unpacked_dir, "ppt", "slides", "_rels", f"{slide_name}.rels")

    if os.path.exists(slide_path):
        os.remove(slide_path)
    if os.path.exists(slide_rels):
        os.remove(slide_rels)

    # 3. 从 [Content_Types].xml 中移除
    _remove_content_type(unpacked_dir, f"/ppt/slides/{slide_name}")

    return True


# ============================================================
# reorder — 调整幻灯片顺序
# ============================================================

def reorder_slides(unpacked_dir: str, order: list[str]) -> list[str]:
    """
    调整幻灯片顺序。

    Args:
        unpacked_dir: 解压目录
        order: 幻灯片文件名列表，按期望顺序

    Returns:
        新顺序列表
    """
    pres_path = _get_presentation_path(unpacked_dir)
    pres_root = _read_xml(pres_path)
    rels_path = _get_presentation_rels_path(unpacked_dir)
    rels_root = _read_xml(rels_path)

    # 构建 target → rId 映射
    target_to_rid = {}
    for rel in rels_root.findall("{http://schemas.openxmlformats.org/package/2006/relationships}Relationship"):
        target = os.path.basename(rel.get("Target", ""))
        target_to_rid[target] = rel.get("Id")

    # 构建 rId → sldId 元素映射
    sld_id_lst = pres_root.find(f"{{{NS['p']}}}sldIdLst")
    if sld_id_lst is None:
        return order

    rid_to_element = {}
    for sld_id in sld_id_lst.findall(f"{{{NS['p']}}}sldId"):
        rid = sld_id.get(f"{{{NS['r']}}}id")
        rid_to_element[rid] = sld_id

    # 清空并按新顺序重建
    for child in list(sld_id_lst):
        sld_id_lst.remove(child)

    for slide_name in order:
        rid = target_to_rid.get(slide_name)
        if rid and rid in rid_to_element:
            sld_id_lst.append(rid_to_element[rid])

    _write_xml(pres_root, pres_path)

    return order


# ============================================================
# 辅助函数
# ============================================================

def _add_content_type(unpacked_dir: str, part_name: str, content_type: str):
    """在 [Content_Types].xml 中添加 Override 条目。"""
    ct_path = _get_content_types_path(unpacked_dir)
    ct_root = _read_xml(ct_path)

    # 检查是否已存在
    ct_ns = "http://schemas.openxmlformats.org/package/2006/content-types"
    for override in ct_root.findall(f"{{{ct_ns}}}Override"):
        if override.get("PartName") == part_name:
            return  # 已存在

    new_override = ET.SubElement(ct_root, f"{{{ct_ns}}}Override")
    new_override.set("PartName", part_name)
    new_override.set("ContentType", content_type)
    _write_xml(ct_root, ct_path)


def _remove_content_type(unpacked_dir: str, part_name: str):
    """从 [Content_Types].xml 中移除 Override 条目。"""
    ct_path = _get_content_types_path(unpacked_dir)
    ct_root = _read_xml(ct_path)

    ct_ns = "http://schemas.openxmlformats.org/package/2006/content-types"
    for override in ct_root.findall(f"{{{ct_ns}}}Override"):
        if override.get("PartName") == part_name:
            ct_root.remove(override)
            break

    _write_xml(ct_root, ct_path)


# ============================================================
# CLI 入口
# ============================================================

def main():
    parser = argparse.ArgumentParser(
        description="slide_ops — 幻灯片操作工具",
    )
    subparsers = parser.add_subparsers(dest="command", help="操作命令")

    # list
    list_p = subparsers.add_parser("list", help="列出所有幻灯片")
    list_p.add_argument("dir", help="解压目录")

    # duplicate
    dup_p = subparsers.add_parser("duplicate", help="复制幻灯片")
    dup_p.add_argument("dir", help="解压目录")
    dup_p.add_argument("--source", required=True, help="源幻灯片文件名")
    dup_p.add_argument("--name", help="目标文件名（默认自动生成）")
    dup_p.add_argument("--position", type=int, help="插入位置（1-indexed）")

    # create
    create_p = subparsers.add_parser("create", help="创建新空白幻灯片")
    create_p.add_argument("dir", help="解压目录")
    create_p.add_argument("--layout", default="slideLayout1.xml", help="布局文件名")
    create_p.add_argument("--name", help="目标文件名")
    create_p.add_argument("--position", type=int, help="插入位置（1-indexed）")

    # delete
    del_p = subparsers.add_parser("delete", help="删除幻灯片")
    del_p.add_argument("dir", help="解压目录")
    del_p.add_argument("--slide", required=True, help="幻灯片文件名")

    # reorder
    reorder_p = subparsers.add_parser("reorder", help="调整顺序")
    reorder_p.add_argument("dir", help="解压目录")
    reorder_p.add_argument("--order", required=True, help="顺序（逗号分隔）")

    args = parser.parse_args()

    if args.command == "list":
        slides = list_slides(args.dir)
        for s in slides:
            print(f"  [{s['index']}] {s['filename']}  (id={s['id']}, layout={s['layout']})")

    elif args.command == "duplicate":
        result = duplicate_slide(args.dir, args.source, args.name, args.position)
        print(f"✓ 复制完成: {result['filename']} (id={result['id']}, {result['rId']})")

    elif args.command == "create":
        result = create_slide(args.dir, args.layout, args.name, args.position)
        print(f"✓ 创建完成: {result['filename']} (id={result['id']}, layout={args.layout})")

    elif args.command == "delete":
        ok = delete_slide(args.dir, args.slide)
        if ok:
            print(f"✓ 删除完成: {args.slide}")
        else:
            print(f"✗ 删除失败: {args.slide}", file=sys.stderr)
            sys.exit(1)

    elif args.command == "reorder":
        order = [s.strip() for s in args.order.split(",")]
        reorder_slides(args.dir, order)
        print(f"✓ 顺序调整完成: {' → '.join(order)}")

    else:
        parser.print_help()


if __name__ == "__main__":
    main()
