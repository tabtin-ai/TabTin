export type SmartsheetAdapterElectronLocale = 'zh-CN' | 'en-US';

type MessageParams = Record<string, string | number | boolean | null | undefined>;
type Translator = (key: string, params?: MessageParams) => string;

const MESSAGES: Record<SmartsheetAdapterElectronLocale, Record<string, string>> = {
  'zh-CN': {
    'errors.electronOnly': '仅可在 Electron 环境中使用适配器',
    'errors.ipcMainOnly': 'IPC handler 只能在 Electron 主进程中使用',
    'errors.preloadOnly': 'Preload API 只能在 Electron preload 脚本中使用',
    'errors.rendererOnly': 'ElectronApiAdapter 只能在 Electron 渲染进程中使用',
  },
  'en-US': {
    'errors.electronOnly': 'Electron adapter can only be used in Electron environment',
    'errors.ipcMainOnly': 'IPC handler can only be used in Electron main process',
    'errors.preloadOnly': 'Preload API can only be used in Electron preload script',
    'errors.rendererOnly': 'ElectronApiAdapter can only be used in Electron renderer process',
  },
};

let currentLocale: SmartsheetAdapterElectronLocale = 'zh-CN';
let externalTranslator: Translator | null = null;

const formatMessage = (template: string, params?: MessageParams): string => {
  if (!params) return template;
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => {
    const value = params[key];
    return value === undefined || value === null ? '' : String(value);
  });
};

export const setSmartsheetAdapterElectronLocale = (locale: SmartsheetAdapterElectronLocale): void => {
  currentLocale = locale;
};

export const setSmartsheetAdapterElectronTranslator = (translator: Translator | null): void => {
  externalTranslator = translator;
};

export const t = (key: string, params?: MessageParams): string => {
  if (externalTranslator) {
    return externalTranslator(`smartsheetAdapterElectron.${key}`, params);
  }
  const template =
    MESSAGES[currentLocale]?.[key] ??
    MESSAGES['en-US']?.[key] ??
    key;
  return formatMessage(template, params);
};
