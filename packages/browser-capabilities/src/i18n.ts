export type BrowserCapabilitiesLocale = 'zh-CN' | 'en-US';

type MessageParams = Record<string, string | number | boolean | null | undefined>;
type Translator = (key: string, params?: MessageParams) => string;

const MESSAGES: Record<BrowserCapabilitiesLocale, Record<string, string>> = {
  'zh-CN': {
    'errors.viewManager.mainWindowUnavailable': '主窗口不可用',
    'errors.viewManager.viewNotFound': 'View 不存在: {{id}}',
    'errors.viewManager.viewStateNotFound': 'View 状态不存在: {{id}}',
  },
  'en-US': {
    'errors.viewManager.mainWindowUnavailable': 'Main window is unavailable',
    'errors.viewManager.viewNotFound': 'View not found: {{id}}',
    'errors.viewManager.viewStateNotFound': 'View state not found: {{id}}',
  },
};

let currentLocale: BrowserCapabilitiesLocale = 'zh-CN';
let externalTranslator: Translator | null = null;

const formatMessage = (template: string, params?: MessageParams): string => {
  if (!params) return template;
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => {
    const value = params[key];
    return value === undefined || value === null ? '' : String(value);
  });
};

export const setBrowserCapabilitiesLocale = (locale: BrowserCapabilitiesLocale): void => {
  currentLocale = locale;
};

export const setBrowserCapabilitiesTranslator = (translator: Translator | null): void => {
  externalTranslator = translator;
};

export const t = (key: string, params?: MessageParams): string => {
  if (externalTranslator) {
    return externalTranslator(`browserCapabilities.${key}`, params);
  }
  const template =
    MESSAGES[currentLocale]?.[key] ??
    MESSAGES['en-US']?.[key] ??
    key;
  return formatMessage(template, params);
};
