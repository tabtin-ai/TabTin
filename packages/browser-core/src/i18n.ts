/**
 * browser-core 本地 i18n — 仅包含 browser-core 实际使用的 key。
 *
 * 宿主可通过 setBrowserCoreTranslator() 注入外部翻译函数来覆盖。
 */

type MessageParams = Record<string, string | number | boolean | null | undefined>;
type Translator = (key: string, params?: MessageParams) => string;

const MESSAGES: Record<string, Record<string, string>> = {
  'zh-CN': {
    'errors.webContentsViewMissing': 'WebContentsView {{id}} 不存在或已销毁',
    'errors.webContentsDestroyed': 'WebContents 已被销毁',
    'errors.cdpNotAttached': 'WebContents {{id}} 未附加 CDP，请先调用 getOrAttach()',
    'errors.unknownError': '未知错误',
    'errors.dom.emptySelector': '选择器为空',
    'errors.dom.elementNotFoundXpath': '未找到 XPath 元素',
    'errors.dom.elementNotFoundSelector': '未找到选择器元素',
    'errors.dom.elementNotReady': '元素未就绪',
    'errors.dom.elementNotClickable': '元素不可点击',
    'errors.dom.elementNoValue': '元素没有 value 属性',
    'errors.dom.unsupportedAction': '不支持的动作',
    'errors.dom.scrollNoTarget': '页面上没有可滚动的区域',
    'errors.dom.scrollNoEffect': '滚动未产生位移（可能滚错了容器，或页面阻止了滚动）',
  },
  'en-US': {
    'errors.webContentsViewMissing': 'WebContentsView {{id}} does not exist or has been destroyed',
    'errors.webContentsDestroyed': 'WebContents has been destroyed',
    'errors.cdpNotAttached': 'CDP not attached for WebContents {{id}}. Call getOrAttach() first.',
    'errors.unknownError': 'Unknown error',
    'errors.dom.emptySelector': 'Empty selector',
    'errors.dom.elementNotFoundXpath': 'Element not found for XPath',
    'errors.dom.elementNotFoundSelector': 'Element not found for selector',
    'errors.dom.elementNotReady': 'Element not ready',
    'errors.dom.elementNotClickable': 'Element is not clickable',
    'errors.dom.elementNoValue': 'Element has no value property',
    'errors.dom.unsupportedAction': 'Unsupported action',
    'errors.dom.scrollNoTarget': 'No scrollable area on the page',
    'errors.dom.scrollNoEffect': 'Scroll produced no movement (wrong container or page blocked scrolling)',
  },
};

let currentLocale = 'zh-CN';
let externalTranslator: Translator | null = null;

const formatMessage = (template: string, params?: MessageParams): string => {
  if (!params) return template;
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => {
    const value = params[key];
    return value === undefined || value === null ? '' : String(value);
  });
};

export const setBrowserCoreLocale = (locale: string): void => {
  currentLocale = locale;
};

export const setBrowserCoreTranslator = (translator: Translator | null): void => {
  externalTranslator = translator;
};

export const t = (key: string, params?: MessageParams): string => {
  if (externalTranslator) {
    return externalTranslator(key, params);
  }
  const template =
    MESSAGES[currentLocale]?.[key] ??
    MESSAGES['en-US']?.[key] ??
    key;
  return formatMessage(template, params);
};
