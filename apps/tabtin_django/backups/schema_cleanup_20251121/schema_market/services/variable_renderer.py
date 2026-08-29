import copy
import re
from typing import Any, Dict, Iterable, Mapping
from urllib.parse import quote_plus


class VariableValidationError(ValueError):
    """变量配置验证失败"""


class VariableRenderer:
    """
    负责变量校验与模板渲染。

    变量定义示例：
    {
        "keyword": {
            "type": "string",
            "label": "关键词",
            "required": true,
            "placeholder": "请输入关键词",
            "default": "AI",
            "pattern": "^[^\\s]{1,20}$",
            "encode": {
                "url": true
            }
        }
    }
    """

    PLACEHOLDER_PATTERN = re.compile(r"\{\{\s*(?P<name>[\w\.]+)(\|(?P<filter>\w+))?\s*\}\}")

    def __init__(self, definitions: Mapping[str, dict]):
        self.definitions = definitions or {}

    def validate(self, payload: Mapping[str, Any]) -> Dict[str, Any]:
        """
        校验变量并返回经过类型转换后的结果。
        """
        result: Dict[str, Any] = {}
        payload = payload or {}

        for name, definition in self.definitions.items():
            value = payload.get(name, definition.get('default'))

            if self._is_empty(value):
                if definition.get('required'):
                    raise VariableValidationError(f'变量「{name}」为必填项')
                continue

            converted = self._convert_type(name, value, definition)
            self._validate_constraints(name, converted, definition)
            result[name] = converted

        # 附加 payload 中的多余字段（避免前端自定义字段丢失）
        for extra_key, extra_value in payload.items():
            if extra_key not in result:
                result[extra_key] = extra_value

        return result

    def render_text(self, template: str, variables: Mapping[str, Any]) -> str:
        """
        渲染字符串中的占位符。
        支持 {{ variable }} 以及 {{ variable|urlencode }}。
        """
        if not isinstance(template, str):
            return template

        def _replace(match: re.Match) -> str:
            name = match.group('name')
            filter_name = match.group('filter')
            value = self._lookup_value(name, variables)
            if value is None:
                return ''

            if filter_name == 'urlencode':
                return quote_plus(str(value))

            return str(value)

        return self.PLACEHOLDER_PATTERN.sub(_replace, template)

    def render_data(self, data: Any, variables: Mapping[str, Any]) -> Any:
        """
        深拷贝并渲染任意结构。
        """
        cloned = copy.deepcopy(data)
        return self._render_recursive(cloned, variables)

    def _render_recursive(self, value: Any, variables: Mapping[str, Any]) -> Any:
        if isinstance(value, str):
            return self.render_text(value, variables)
        if isinstance(value, list):
            return [self._render_recursive(item, variables) for item in value]
        if isinstance(value, tuple):
            return tuple(self._render_recursive(item, variables) for item in value)
        if isinstance(value, dict):
            return {key: self._render_recursive(val, variables) for key, val in value.items()}
        return value

    # ------------------------- Helper Methods ------------------------- #

    @staticmethod
    def _is_empty(value: Any) -> bool:
        return value is None or (isinstance(value, str) and value.strip() == '')

    @staticmethod
    def _lookup_value(name: str, variables: Mapping[str, Any]) -> Any:
        if name in variables:
            return variables[name]
        # 支持 a.b 样式
        parts = name.split('.')
        current = variables
        for part in parts:
            if isinstance(current, Mapping) and part in current:
                current = current[part]
            else:
                return None
        return current

    def _convert_type(self, name: str, value: Any, definition: Mapping[str, Any]) -> Any:
        value_type = (definition.get('type') or 'string').lower()

        if value_type in ('string', 'text'):
            return str(value)

        if value_type in ('number', 'float', 'int', 'integer'):
            try:
                number = float(value)
            except (TypeError, ValueError):
                raise VariableValidationError(f'变量「{name}」需要是数字')
            if value_type in ('int', 'integer'):
                return int(number)
            return number

        if value_type in ('bool', 'boolean'):
            if isinstance(value, bool):
                return value
            if isinstance(value, str):
                lowered = value.strip().lower()
                if lowered in ('true', '1', 'yes', 'y'):
                    return True
                if lowered in ('false', '0', 'no', 'n'):
                    return False
            raise VariableValidationError(f'变量「{name}」需要是布尔值')

        if value_type == 'select':
            options: Iterable[Mapping[str, Any]] = definition.get('options') or []
            valid_values = {str(opt.get('value')): opt.get('value') for opt in options}
            str_value = str(value)
            if str_value not in valid_values:
                raise VariableValidationError(f'变量「{name}」的值不在可选列表中')
            return valid_values[str_value]

        if value_type == 'url':
            return str(value).strip()

        # 默认：转字符串
        return str(value)

    @staticmethod
    def _validate_constraints(name: str, value: Any, definition: Mapping[str, Any]) -> None:
        import re as _re

        pattern = definition.get('pattern')
        if pattern and isinstance(value, str):
            if not _re.fullmatch(pattern, value):
                raise VariableValidationError(f'变量「{name}」不符合格式要求')

        min_value = definition.get('min')
        max_value = definition.get('max')
        if isinstance(value, (int, float)):
            if min_value is not None and value < min_value:
                raise VariableValidationError(f'变量「{name}」需要大于等于 {min_value}')
            if max_value is not None and value > max_value:
                raise VariableValidationError(f'变量「{name}」需要小于等于 {max_value}')

        max_length = definition.get('max_length')
        if isinstance(value, str) and max_length and len(value) > max_length:
            raise VariableValidationError(f'变量「{name}」长度不能超过 {max_length}')
