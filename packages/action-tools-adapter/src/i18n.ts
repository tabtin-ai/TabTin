export type ActionToolsAdapterLocale = 'zh-CN' | 'en-US';

type MessageParams = Record<string, string | number | boolean | null | undefined>;
type Translator = (key: string, params?: MessageParams) => string;

const MESSAGES: Record<ActionToolsAdapterLocale, Record<string, string>> = {
  'zh-CN': {
    'errors.taskExecuteFailed': '任务执行失败',
    'errors.taskNotFound': '任务不存在',
    'errors.taskTimeout': '任务等待超时（{{timeout}}ms）',
  },
  'en-US': {
    'errors.taskExecuteFailed': 'Task execution failed',
    'errors.taskNotFound': 'Task not found',
    'errors.taskTimeout': 'Task timed out after {{timeout}}ms',
  },
};

let currentLocale: ActionToolsAdapterLocale = 'zh-CN';
let externalTranslator: Translator | null = null;

const formatMessage = (template: string, params?: MessageParams): string => {
  if (!params) return template;
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => {
    const value = params[key];
    return value === undefined || value === null ? '' : String(value);
  });
};

export const setActionToolsAdapterLocale = (locale: ActionToolsAdapterLocale): void => {
  currentLocale = locale;
};

export const setActionToolsAdapterTranslator = (translator: Translator | null): void => {
  externalTranslator = translator;
};

export const t = (key: string, params?: MessageParams): string => {
  if (externalTranslator) {
    return externalTranslator(`actionToolsAdapter.${key}`, params);
  }
  const template =
    MESSAGES[currentLocale]?.[key] ??
    MESSAGES['en-US']?.[key] ??
    key;
  return formatMessage(template, params);
};
