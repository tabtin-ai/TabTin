export type SmartsheetLocale = 'zh-CN' | 'en-US';

type MessageParams = Record<string, string | number | boolean | null | undefined>;
type Translator = (key: string, params?: MessageParams) => string;

const MESSAGES: Record<SmartsheetLocale, Record<string, string>> = {
  'zh-CN': {
    'validation.required': '此字段为必填项',
    'validation.range': '值必须在 {{min}} 到 {{max}} 之间',
    'validation.optionInvalid': '请选择有效的选项',
    'validation.formatInvalid': '格式不正确',
    'view.unsetValue': '未设置',
    'view.unnamed': '未命名视图',
    'import.unsupportedFormat': '不支持的导入格式: {{format}}',
    'import.optionsInvalid': '导入选项验证失败',
    'import.unknownError': '导入数据时发生未知错误',
    'import.previewFailed': '预览导入数据失败',
    'import.fileNotFound': '文件不存在: {{path}}',
    'import.jsonUnknownError': '导入JSON文件时发生未知错误',
    'import.csvUnknownError': '导入CSV文件时发生未知错误',
    'import.xlsxUnknownError': '导入Excel文件时发生未知错误',
    'import.xlsxSheetMissing': '工作表不存在: {{sheet}}',
    'import.jsonFormatUnsupported': '不支持的JSON格式',
    'import.jsonParseFailed': 'JSON解析失败: {{message}}',
    'export.unsupportedFormat': '不支持的导出格式: {{format}}',
    'export.optionsInvalid': '导出选项验证失败',
    'export.unknownError': '导出数据时发生未知错误',
    'export.tableDataMissing': '表格数据不存在',
    'export.storageError': '从存储导出数据时发生错误',
    'export.multiSheetUnsupported': '不支持Excel多工作表导出',
    'export.multiSheetError': '导出多工作表时发生错误',
    'export.csvUnknownError': '导出CSV文件时发生未知错误',
    'export.jsonUnknownError': '导出JSON文件时发生未知错误',
    'export.xlsxUnknownError': '导出Excel文件时发生未知错误',
    'export.keyValueRequiresTwoColumns': '键值对结构需要至少两列数据',
    'export.failed': '导出失败',
    'errors.projectNotFound': '项目不存在: {{id}}',
    'errors.viewNameRequired': '视图名称不能为空',
    'errors.viewLocked': '已锁定的视图不可修改',
    'errors.defaultViewDelete': '默认视图不可删除',
    'errors.filterRequiresFieldId': '筛选条件缺少字段 ID',
    'errors.sortRequiresFieldId': '排序条件缺少字段 ID',
    'errors.groupRequiresFieldId': '分组条件缺少字段 ID',
    'defaults.columnName': '列{{index}}',
  },
  'en-US': {
    'validation.required': 'This field is required',
    'validation.range': 'Value must be between {{min}} and {{max}}',
    'validation.optionInvalid': 'Please select a valid option',
    'validation.formatInvalid': 'Invalid format',
    'view.unsetValue': 'Unset',
    'view.unnamed': 'Untitled view',
    'import.unsupportedFormat': 'Unsupported import format: {{format}}',
    'import.optionsInvalid': 'Import options validation failed',
    'import.unknownError': 'Unknown error occurred during import',
    'import.previewFailed': 'Failed to preview import data',
    'import.fileNotFound': 'File not found: {{path}}',
    'import.jsonUnknownError': 'Unknown error occurred while importing JSON file',
    'import.csvUnknownError': 'Unknown error occurred while importing CSV file',
    'import.xlsxUnknownError': 'Unknown error occurred while importing Excel file',
    'import.xlsxSheetMissing': 'Worksheet not found: {{sheet}}',
    'import.jsonFormatUnsupported': 'Unsupported JSON format',
    'import.jsonParseFailed': 'JSON parse failed: {{message}}',
    'export.unsupportedFormat': 'Unsupported export format: {{format}}',
    'export.optionsInvalid': 'Export options validation failed',
    'export.unknownError': 'Unknown error occurred during export',
    'export.tableDataMissing': 'Table data not found',
    'export.storageError': 'Error exporting data from storage',
    'export.multiSheetUnsupported': 'Excel multi-sheet export is not supported',
    'export.multiSheetError': 'Error exporting multiple sheets',
    'export.csvUnknownError': 'Unknown error occurred while exporting CSV',
    'export.jsonUnknownError': 'Unknown error occurred while exporting JSON',
    'export.xlsxUnknownError': 'Unknown error occurred while exporting Excel',
    'export.keyValueRequiresTwoColumns': 'Key-value structure requires at least two columns',
    'export.failed': 'Export failed',
    'errors.projectNotFound': 'Project not found: {{id}}',
    'errors.viewNameRequired': 'View name is required',
    'errors.viewLocked': 'Locked view cannot be modified',
    'errors.defaultViewDelete': 'Default view cannot be deleted',
    'errors.filterRequiresFieldId': 'Filter requires fieldId',
    'errors.sortRequiresFieldId': 'Sort requires fieldId',
    'errors.groupRequiresFieldId': 'Group requires fieldId',
    'defaults.columnName': 'Column {{index}}',
  },
};

let currentLocale: SmartsheetLocale = 'zh-CN';
let externalTranslator: Translator | null = null;

const formatMessage = (template: string, params?: MessageParams): string => {
  if (!params) return template;
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => {
    const value = params[key];
    return value === undefined || value === null ? '' : String(value);
  });
};

export const setSmartsheetLocale = (locale: SmartsheetLocale): void => {
  currentLocale = locale;
};

export const setSmartsheetTranslator = (translator: Translator | null): void => {
  externalTranslator = translator;
};

export const t = (key: string, params?: MessageParams): string => {
  if (externalTranslator) {
    return externalTranslator(`smartsheet.${key}`, params);
  }
  const template =
    MESSAGES[currentLocale]?.[key] ??
    MESSAGES['en-US']?.[key] ??
    key;
  return formatMessage(template, params);
};
