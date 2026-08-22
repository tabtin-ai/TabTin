"""
PPTX Editing Tools — 基于 OpenXML 的 PPTX 模板编辑工具链

工作流：
  1. unpack.py   → 解压 PPTX 为美化的 XML 文件
  2. slide_ops.py → 幻灯片操作（复制/新建/删除/重排序）
  3. [手动或脚本编辑 XML]
  4. template_fill.py → 批量替换占位符
  5. clean.py    → 清理孤立文件
  6. validate.py → PPTX 结构验证
  7. pack.py     → 压缩打包为 PPTX
"""
