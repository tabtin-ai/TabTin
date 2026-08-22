export type TabtinConfigLocale = 'zh-CN' | 'en-US';

type MessageParams = Record<string, string | number | boolean | null | undefined>;
type Translator = (key: string, params?: MessageParams) => string;

const MESSAGES: Record<TabtinConfigLocale, Record<string, string>> = {
  'zh-CN': {
    'errors.invalidUrl': '{{name}} 不是合法 URL: {{value}}',
    'errors.apiBaseUrlConflict': 'API_BASE_URL 配置冲突：{{tabtinKey}}={{tabtinValue}}, {{viteKey}}={{viteValue}}',
    'errors.apiBaseUrlMissing': '缺少 API_BASE_URL，请设置以下环境变量之一：{{keys}}',
    'errors.apiBaseUrlMustEndWithApi': 'API_BASE_URL 必须以 /api 结尾，当前为: {{value}}',
  },
  'en-US': {
    'errors.invalidUrl': '{{name}} is not a valid URL: {{value}}',
    'errors.apiBaseUrlConflict': 'API_BASE_URL conflict: {{tabtinKey}}={{tabtinValue}}, {{viteKey}}={{viteValue}}',
    'errors.apiBaseUrlMissing': 'Missing API_BASE_URL. Please set one of: {{keys}}',
    'errors.apiBaseUrlMustEndWithApi': 'API_BASE_URL must end with /api. Current value: {{value}}',
  },
};

let currentLocale: TabtinConfigLocale = 'zh-CN';
let externalTranslator: Translator | null = null;

const formatMessage = (template: string, params?: MessageParams): string => {
  if (!params) return template;
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => {
    const value = params[key];
    return value === undefined || value === null ? '' : String(value);
  });
};

export const setTabtinConfigLocale = (locale: TabtinConfigLocale): void => {
  currentLocale = locale;
};

export const setTabtinConfigTranslator = (translator: Translator | null): void => {
  externalTranslator = translator;
};

export const t = (key: string, params?: MessageParams): string => {
  if (externalTranslator) {
    return externalTranslator(`tabtinConfig.${key}`, params);
  }
  const template =
    MESSAGES[currentLocale]?.[key] ??
    MESSAGES['en-US']?.[key] ??
    key;
  return formatMessage(template, params);
};
