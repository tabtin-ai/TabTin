"""Tabtin Space Schema 共享依赖与辅助函数。"""

from typing import Optional, List, Dict, Any, Generic, TypeVar, Literal

from datetime import datetime

from pydantic import BaseModel, Field, ConfigDict, field_validator, model_validator

from uuid import UUID

import json

from apps.services.common.ws.protocol import FINGERPRINT_SAFE as _FINGERPRINT_RE

T = TypeVar('T')

_LEGACY_TYPE_TO_CANONICAL: dict[str, str] = {
    "document": "tabdoc",
    "table": "tabdata",
    "slide": "tabslide",
    "video": "tabvideo",
    "canvas": "tabwhiteboard",
    "tabcanvas": "tabwhiteboard",
    "memo": "tabmemo",
    "memo_collection": "tabmemo",
    "code": "tabcode",
    "ppt": "tabslide",
    "site": "tabsite",
    "file": "tabfiles",
    "files": "tabfiles",
    "attachment": "tabfiles",
}

_MAX_PARAMS_BYTES = 65_536

_MAX_PARAMS_KEYS = 50

class StandardResponse(BaseModel, Generic[T]):
    """标准响应模型"""
    success: bool = Field(..., description="操作是否成功")
    code: str = Field(default="SUCCESS", description="业务状态码")
    message: str = Field(default="操作成功", description="响应消息")
    data: Optional[T] = Field(default=None, description="响应数据")

class ErrorResponse(BaseModel):
    """错误响应模型"""
    success: bool = Field(default=False, description="操作失败")
    code: str = Field(..., description="错误码")
    message: str = Field(..., description="错误消息")
    data: Optional[Any] = Field(default=None, description="错误详情")

def normalize_legacy_item_type(raw: str) -> str:
    """将旧短名称转为 DB 规范名（已是规范名则原样返回）"""
    return _LEGACY_TYPE_TO_CANONICAL.get(raw, raw)

def _validate_fingerprint(v: str) -> str:
    if len(v) > 255:
        raise ValueError('fingerprint 最长 255 字符')
    if not _FINGERPRINT_RE.match(v):
        raise ValueError('fingerprint 格式非法，仅允许字母、数字、连字符、下划线、点')
    return v

def _validate_params_size(v: Dict[str, Any]) -> Dict[str, Any]:
    if len(v) > _MAX_PARAMS_KEYS:
        raise ValueError(f"params must have at most {_MAX_PARAMS_KEYS} keys, got {len(v)}")
    size = len(json.dumps(v, ensure_ascii=False, separators=(",", ":")))
    if size > _MAX_PARAMS_BYTES:
        raise ValueError(f"params serialized size must be <= {_MAX_PARAMS_BYTES} bytes, got {size}")
    return v


def coerce_host_space_id(data: Any) -> Any:
    """from_orm / model_validate：把 workspace_id|project_id 填到 wire 字段 space_id。

    ContextItem / Collection 已无 space FK；对外仍返回 space_id。
    """
    if isinstance(data, dict):
        if data.get('space_id') is None:
            hid = data.get('workspace_id') or data.get('project_id')
            if hid is not None:
                return {**data, 'space_id': hid}
        return data

    from apps.tabtinspace.services.asset_host import host_id_of

    hid = host_id_of(data)
    if hid is None:
        return data

    class _HostSpaceProxy:
        __slots__ = ('_obj', 'space_id')

        def __init__(self, obj, space_id):
            object.__setattr__(self, '_obj', obj)
            object.__setattr__(self, 'space_id', space_id)

        def __getattr__(self, name):
            return getattr(object.__getattribute__(self, '_obj'), name)

    return _HostSpaceProxy(data, hid)


__all__ = [
    'Optional',
    'List',
    'Dict',
    'Any',
    'Generic',
    'TypeVar',
    'Literal',
    'datetime',
    'BaseModel',
    'Field',
    'ConfigDict',
    'field_validator',
    'model_validator',
    'UUID',
    'json',
    '_FINGERPRINT_RE',
    'T',
    '_LEGACY_TYPE_TO_CANONICAL',
    '_MAX_PARAMS_BYTES',
    '_MAX_PARAMS_KEYS',
    'StandardResponse',
    'ErrorResponse',
    'normalize_legacy_item_type',
    'coerce_host_space_id',
    '_validate_fingerprint',
    '_validate_params_size',
]
