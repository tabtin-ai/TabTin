"""
数据导入解析器

从 CSV、Excel、JSON 等格式文件中解析出 (headers, rows) 二维表结构。
从 import_service.py 拆分而来。
"""
import csv
import io
import json
from typing import List, Dict, Any, Optional, Tuple

import openpyxl


def parse_csv(file_content: str, max_rows: int = 0) -> Tuple[List[str], List[List[str]]]:
    """
    解析CSV文件内容

    Args:
        file_content: CSV文件内容（字符串）
        max_rows: 最大解析行数，0 表示不限制

    Returns:
        Tuple: (列名列表, 数据行列表)
    """
    cleaned = file_content.lstrip('\ufeff')
    csv_file = io.StringIO(cleaned)
    reader = csv.reader(csv_file)

    headers = next(reader, [])
    if max_rows > 0:
        rows: List[List[str]] = []
        for row in reader:
            rows.append(row)
            if len(rows) >= max_rows:
                break
    else:
        rows = list(reader)

    return headers, rows


def parse_excel(file_bytes: bytes, sheet_name: Optional[str] = None, max_rows: int = 0) -> Tuple[List[str], List[List[Any]]]:
    """
    解析Excel文件内容

    Args:
        file_bytes: Excel文件字节内容
        sheet_name: 工作表名称（None表示使用第一个工作表）
        max_rows: 最大解析数据行数，0 表示不限制

    Returns:
        Tuple: (列名列表, 数据行列表)
    """
    wb = None
    try:
        wb = openpyxl.load_workbook(io.BytesIO(file_bytes), read_only=True)

        if sheet_name:
            ws = wb[sheet_name]
        else:
            ws = wb.active

        # Excelize / 部分导出器会写出错误的 <dimension>（如 A1），
        # openpyxl read_only 信任该声明会导致只读出 1 行 1 列。
        # reset_dimensions() 忽略声明，按实际单元格迭代。
        if hasattr(ws, "reset_dimensions"):
            ws.reset_dimensions()

        headers: List[str] = []
        data_rows: List[List[Any]] = []
        for row_idx, row in enumerate(ws.iter_rows(values_only=True)):
            cells = list(row) if row is not None else []
            if row_idx == 0:
                headers = [str(cell) if cell is not None else '' for cell in cells]
            else:
                # reset_dimensions 后各行宽度可能不齐，按表头长度补齐
                normalized = [cell if cell is not None else '' for cell in cells]
                if len(normalized) < len(headers):
                    normalized.extend([''] * (len(headers) - len(normalized)))
                elif len(headers) > 0 and len(normalized) > len(headers):
                    normalized = normalized[:len(headers)]
                data_rows.append(normalized)
                if max_rows > 0 and len(data_rows) >= max_rows:
                    break

        return headers, data_rows

    except ValueError:
        raise
    except Exception as e:
        raise ValueError(f"Excel文件解析失败: {str(e)}")
    finally:
        if wb is not None:
            wb.close()


def parse_table_full_json(data: Dict[str, Any]) -> Tuple[List[str], List[List[Any]]]:
    """
    解析 table_full JSON 快照为通用导入结构（headers + rows）。

    说明：
    - headers 使用 fields 中定义的字段名，保持字段顺序；
    - records 支持从 `fields` 或 `data` 读取记录值；
    - 记录键优先按字段 ID 匹配，兼容字段名键。
    """
    raw_fields = data.get('fields')
    raw_records = data.get('records')

    if not isinstance(raw_fields, list) or not isinstance(raw_records, list):
        raise ValueError("table_full 格式非法：fields/records 必须是数组")

    ordered_fields: List[Tuple[int, int, str, str]] = []
    headers: List[str] = []
    field_name_by_id: Dict[str, str] = {}
    seen_headers: set[str] = set()

    for index, item in enumerate(raw_fields):
        if not isinstance(item, dict):
            continue
        field_id = str(item.get('id') or '').strip()
        field_name = str(item.get('name') or '').strip()
        if not field_id or not field_name:
            continue
        if field_name in seen_headers:
            continue
        seen_headers.add(field_name)
        raw_order = item.get('order')
        if isinstance(raw_order, (int, float)):
            normalized_order = int(raw_order)
        else:
            normalized_order = 10 ** 9
        ordered_fields.append((normalized_order, index, field_id, field_name))

    ordered_fields.sort(key=lambda item: (item[0], item[1]))
    for _, _, field_id, field_name in ordered_fields:
        headers.append(field_name)
        field_name_by_id[field_id] = field_name

    if not headers:
        raise ValueError("table_full 格式非法：fields 为空或缺少有效字段定义")

    rows: List[List[Any]] = []
    for record in raw_records:
        if not isinstance(record, dict):
            continue

        source_values = record.get('fields')
        if not isinstance(source_values, dict):
            source_values = record.get('data')
        if not isinstance(source_values, dict):
            source_values = {}

        normalized_by_header: Dict[str, Any] = {}

        for key, value in source_values.items():
            key_str = str(key)
            if key_str in field_name_by_id:
                normalized_by_header[field_name_by_id[key_str]] = value

        for key, value in source_values.items():
            key_str = str(key)
            if key_str in seen_headers and key_str not in normalized_by_header:
                normalized_by_header[key_str] = value

        row = [normalized_by_header.get(header, '') for header in headers]
        rows.append(row)

    return headers, rows


def parse_json(json_content: str) -> Tuple[List[str], List[List[Any]]]:
    """
    解析JSON文件内容

    Args:
        json_content: JSON文件内容（字符串）
        支持格式：
        1. [{"field1": "value1", "field2": "value2"}, ...]  # 对象数组
        2. {"headers": ["field1", "field2"], "data": [[...], [...]]}  # 结构化格式
        3. {"fields": [...], "records": [...], "metadata": {"format":"table_full"}}  # table_full 快照

    Returns:
        Tuple: (列名列表, 数据行列表)
    """
    try:
        data = json.loads(json_content)

        if isinstance(data, list) and data and isinstance(data[0], dict):
            headers = list(data[0].keys())
            rows = []
            for obj in data:
                row = [obj.get(h, '') for h in headers]
                rows.append(row)
            return headers, rows

        elif isinstance(data, dict) and 'headers' in data and 'data' in data:
            return data['headers'], data['data']

        elif isinstance(data, dict) and 'records' in data and 'fields' in data:
            return parse_table_full_json(data)

        else:
            raise ValueError("JSON格式不支持，请使用对象数组、结构化格式或 table_full 快照")

    except json.JSONDecodeError as e:
        raise ValueError(f"JSON解析失败: {str(e)}")
