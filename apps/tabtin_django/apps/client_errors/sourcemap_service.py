"""
SourceMap V3 解析与堆栈还原服务

纯 Python 实现，无需外部依赖：
- VLQ Base64 解码器
- SourceMap V3 mappings 解析
- 混淆堆栈 → 原始文件/行/列 映射
"""

import bisect
import json
import logging
import re
from dataclasses import dataclass
from typing import Optional

from .models import SourceMapFile

logger = logging.getLogger(__name__)

# ── VLQ Base64 解码 ──

_B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
_B64_TABLE = {c: i for i, c in enumerate(_B64_CHARS)}

_VLQ_SHIFT = 5
_VLQ_BASE = 1 << _VLQ_SHIFT       # 32
_VLQ_CONTINUATION = _VLQ_BASE      # 第 6 位
_VLQ_MASK = _VLQ_BASE - 1          # 0b11111


def _decode_vlq(segment: str) -> list[int]:
    """解码一段 VLQ Base64 字符串，返回整数列表。"""
    values = []
    shift = 0
    value = 0

    for ch in segment:
        digit = _B64_TABLE.get(ch)
        if digit is None:
            raise ValueError(f"Invalid Base64 VLQ character: {ch}")

        value += (digit & _VLQ_MASK) << shift
        shift += _VLQ_SHIFT

        if not (digit & _VLQ_CONTINUATION):
            # 最低位为符号位
            if value & 1:
                values.append(-(value >> 1))
            else:
                values.append(value >> 1)
            value = 0
            shift = 0

    return values


# ── SourceMap 解析 ──


@dataclass
class OriginalPosition:
    source: str
    line: int       # 1-based
    column: int     # 0-based
    name: Optional[str] = None


class SourceMapConsumer:
    """解析 SourceMap V3 JSON 并提供位置查找。"""

    def __init__(self, raw_json: str):
        data = json.loads(raw_json)
        self.sources: list[str] = data.get("sources", [])
        self.names: list[str] = data.get("names", [])
        self._mappings: list[tuple[int, int, int, int, int, Optional[int]]] = []
        # 行号索引：line -> (start_index, end_index) in _mappings
        self._line_index: dict[int, tuple[int, int]] = {}
        self._parse_mappings(data.get("mappings", ""))

    def _parse_mappings(self, mappings_str: str):
        """解析 mappings 字符串，生成 (gen_line, gen_col, source_idx, orig_line, orig_col, name_idx) 列表。"""
        gen_line = 0
        prev_col = 0
        prev_source = 0
        prev_orig_line = 0
        prev_orig_col = 0
        prev_name = 0

        for line in mappings_str.split(";"):
            gen_line += 1
            prev_col = 0

            if not line:
                continue

            for segment in line.split(","):
                if not segment:
                    continue

                fields = _decode_vlq(segment)
                if not fields:
                    continue

                prev_col += fields[0]

                if len(fields) >= 4:
                    prev_source += fields[1]
                    prev_orig_line += fields[2]
                    prev_orig_col += fields[3]

                    name_idx = None
                    if len(fields) >= 5:
                        prev_name += fields[4]
                        name_idx = prev_name

                    self._mappings.append((
                        gen_line, prev_col,
                        prev_source, prev_orig_line, prev_orig_col,
                        name_idx,
                    ))

        # 构建行号索引
        self._build_line_index()

    def _build_line_index(self):
        """为每行建立 _mappings 中的起止索引，加速按行查找。"""
        if not self._mappings:
            return
        current_line = self._mappings[0][0]
        start = 0
        for i, m in enumerate(self._mappings):
            if m[0] != current_line:
                self._line_index[current_line] = (start, i)
                current_line = m[0]
                start = i
        self._line_index[current_line] = (start, len(self._mappings))

    def original_position(self, line: int, column: int) -> Optional[OriginalPosition]:
        """
        根据生成文件的行号（1-based）和列号（0-based）查找原始位置。
        使用行索引 + 二分查找。
        """
        if not self._mappings:
            return None

        # 通过行索引快速定位该行的映射范围
        line_range = self._line_index.get(line)
        if line_range is None:
            return None

        start, end = line_range
        # 提取该行所有映射的列号，用二分查找
        cols = [self._mappings[i][1] for i in range(start, end)]
        idx = bisect.bisect_right(cols, column) - 1
        if idx < 0:
            return None

        best = self._mappings[start + idx]
        if best is None:
            return None

        _, _, src_idx, orig_line, orig_col, name_idx = best
        source = self.sources[src_idx] if 0 <= src_idx < len(self.sources) else "?"
        name = self.names[name_idx] if name_idx is not None and 0 <= name_idx < len(self.names) else None

        return OriginalPosition(
            source=source,
            line=orig_line + 1,  # 转为 1-based
            column=orig_col,
            name=name,
        )


# ── 堆栈还原 ──

# 匹配 Electron/Chromium 堆栈帧格式
_FRAME_RE = re.compile(
    r"at\s+(?P<func>.*?)\s*\(?(?P<url>(?:https?|file)://[^:)]+|[^\s:)]+\.js):(?P<line>\d+):(?P<col>\d+)\)?"
)

# 从 URL 中提取文件路径（去掉协议和 hash/query）
_URL_PATH_RE = re.compile(r"(?:https?|file)://[^/]*(/[^?#]*)")


def _normalize_file_path(url: str) -> str:
    """从 URL 或路径中提取标准化的文件路径用于匹配 SourceMap。"""
    m = _URL_PATH_RE.match(url)
    if m:
        return m.group(1)
    return url


def _find_sourcemap(version: str, file_path: str) -> Optional[SourceMapFile]:
    """查找匹配的 SourceMap 文件。"""
    normalized = _normalize_file_path(file_path)

    # 精确匹配
    sm = SourceMapFile.objects.using("postgresql").filter(
        app_version=version,
        file_path=normalized,
    ).first()
    if sm:
        return sm

    # 尝试只匹配文件名（Electron 打包后路径可能变化）
    filename = normalized.rsplit("/", 1)[-1]
    return SourceMapFile.objects.using("postgresql").filter(
        app_version=version,
        file_path__endswith=f"/{filename}",
    ).first()


def resolve_stack_trace(stack_trace: str, app_version: str) -> Optional[str]:
    """
    将混淆的堆栈还原为原始源码位置。

    返回还原后的堆栈字符串，如果无法还原则返回 None。
    """
    if not stack_trace or not app_version:
        return None

    # 缓存已解析的 SourceMap consumer（同一堆栈中可能多帧来自同一文件）
    consumers: dict[str, Optional[SourceMapConsumer]] = {}
    resolved_lines = []
    any_resolved = False

    for line in stack_trace.splitlines():
        m = _FRAME_RE.search(line)
        if not m:
            resolved_lines.append(line)
            continue

        func_name = m.group("func").strip()
        url = m.group("url")
        gen_line = int(m.group("line"))
        gen_col = int(m.group("col"))

        # 获取或加载 SourceMap
        cache_key = f"{app_version}:{url}"
        if cache_key not in consumers:
            sm = _find_sourcemap(app_version, url)
            if sm:
                try:
                    consumers[cache_key] = SourceMapConsumer(sm.map_data)
                except Exception:
                    logger.warning("Failed to parse sourcemap for %s", url)
                    consumers[cache_key] = None
            else:
                consumers[cache_key] = None

        consumer = consumers[cache_key]
        if consumer is None:
            resolved_lines.append(line)
            continue

        pos = consumer.original_position(gen_line, gen_col)
        if pos:
            any_resolved = True
            display_name = pos.name or func_name or "<anonymous>"
            resolved_lines.append(
                f"    at {display_name} ({pos.source}:{pos.line}:{pos.column})"
            )
        else:
            resolved_lines.append(line)

    if not any_resolved:
        return None

    return "\n".join(resolved_lines)
