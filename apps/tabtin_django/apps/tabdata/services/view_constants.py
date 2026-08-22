"""
视图服务共享常量

集中定义所有视图相关的常量，避免在 ViewDataService 类属性和子模块之间重复。
"""
from typing import Dict, Set, Tuple


VERSION_TOKEN_BASE_DEFAULT = 4_000_000_000_000

MODEL_FIELDS: Set[str] = {
    'id',
    'row_id',
    'table_id',
    'order',
    'status',
    'tags',
    'created_by_id',
    'updated_by_id',
    'created_at',
    'updated_at',
}

COLUMN_STATISTIC_FUNCS_CONFIG_KEY = 'column_statistic_funcs'

STAT_FUNC_NONE = 'none'
STAT_FUNC_COUNT = 'count'
STAT_FUNC_EMPTY = 'empty'
STAT_FUNC_FILLED = 'filled'
STAT_FUNC_UNIQUE = 'unique'
STAT_FUNC_SUM = 'sum'
STAT_FUNC_AVERAGE = 'average'
STAT_FUNC_MIN = 'min'
STAT_FUNC_MAX = 'max'
STAT_FUNC_CHECKED = 'checked'
STAT_FUNC_UNCHECKED = 'unchecked'
STAT_FUNC_PERCENT_EMPTY = 'percent_empty'
STAT_FUNC_PERCENT_FILLED = 'percent_filled'
STAT_FUNC_PERCENT_UNIQUE = 'percent_unique'
STAT_FUNC_PERCENT_CHECKED = 'percent_checked'
STAT_FUNC_PERCENT_UNCHECKED = 'percent_unchecked'
STAT_FUNC_EARLIEST_DATE = 'earliest_date'
STAT_FUNC_LATEST_DATE = 'latest_date'
STAT_FUNC_DATE_RANGE_DAYS = 'date_range_days'
STAT_FUNC_DATE_RANGE_MONTHS = 'date_range_months'

CHECKBOX_TRUE_VALUES: Set[str] = {'true', '1', 'yes', 'y', 'on'}
CHECKBOX_FALSE_VALUES: Set[str] = {'false', '0', 'no', 'n', 'off'}

CHECKBOX_TRUE_STORAGE_STRINGS: Tuple[str, ...] = (
    'true',
    'True',
    'TRUE',
    '1',
    'yes',
    'Yes',
    'YES',
    'y',
    'Y',
    'on',
    'On',
    'ON',
)

CHECKBOX_FALSE_STORAGE_STRINGS: Tuple[str, ...] = (
    'false',
    'False',
    'FALSE',
    '0',
    'no',
    'No',
    'NO',
    'n',
    'N',
    'off',
    'Off',
    'OFF',
    '',
)

FILTER_OPERATOR_ALIASES: Dict[str, str] = {
    '=': 'equals',
    '==': 'equals',
    'eq': 'equals',
    'is': 'equals',
    'equals': 'equals',
    '!=': 'not_equals',
    'neq': 'not_equals',
    'is_not': 'not_equals',
    'isnot': 'not_equals',
    'not_equals': 'not_equals',
    'contains': 'contains',
    'not_contains': 'not_contains',
    'does_not_contain': 'not_contains',
    'doesnotcontain': 'not_contains',
    'is_empty': 'is_empty',
    'isempty': 'is_empty',
    'empty': 'is_empty',
    'is_not_empty': 'is_not_empty',
    'isnotempty': 'is_not_empty',
    'not_empty': 'is_not_empty',
    'greater_than': 'greater_than',
    'isgreater': 'greater_than',
    'gt': 'greater_than',
    '>': 'greater_than',
    'greater_than_or_equals': 'greater_than_or_equals',
    'isgreaterequal': 'greater_than_or_equals',
    'gte': 'greater_than_or_equals',
    '>=': 'greater_than_or_equals',
    'less_than': 'less_than',
    'isless': 'less_than',
    'lt': 'less_than',
    '<': 'less_than',
    'less_than_or_equals': 'less_than_or_equals',
    'islessequal': 'less_than_or_equals',
    'lte': 'less_than_or_equals',
    '<=': 'less_than_or_equals',
    'in': 'in',
    'is_any_of': 'in',
    'isanyof': 'in',
    'not_in': 'not_in',
    'is_none_of': 'not_in',
    'isnoneof': 'not_in',
    'has_any_of': 'has_any_of',
    'hasanyof': 'has_any_of',
    'has_all_of': 'has_all_of',
    'hasallof': 'has_all_of',
    'has_none_of': 'has_none_of',
    'hasnoneof': 'has_none_of',
    'is_exactly': 'is_exactly',
    'isexactly': 'is_exactly',
    'is_not_exactly': 'is_not_exactly',
    'isnotexactly': 'is_not_exactly',
    'is_within': 'is_within',
    'iswithin': 'is_within',
    'is_not_within': 'is_not_within',
    'isnotwithin': 'is_not_within',
}

FILTER_NEGATIVE_OPERATOR_MAP: Dict[str, str] = {
    'not_equals': 'equals',
    'not_contains': 'contains',
    'not_in': 'in',
    'has_none_of': 'has_any_of',
    'is_not_exactly': 'is_exactly',
    'is_not_within': 'is_within',
}
