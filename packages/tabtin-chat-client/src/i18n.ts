export type TabtinChatClientLocale = 'zh-CN' | 'en-US';

type MessageParams = Record<string, string | number | boolean | null | undefined>;
type Translator = (key: string, params?: MessageParams) => string;

const MESSAGES: Record<TabtinChatClientLocale, Record<string, string>> = {
  'zh-CN': {
    'errors.missingErrorField': '失败时必须提供 error 字段',
    'errors.unknownError': '未知错误',
    'errors.httpStatus': 'HTTP {{status}}: {{statusText}}',
    'errors.wsConnectFailed': 'WS 连接失败',
    'errors.wsNoTokenOrOrganization': '未登录或未选择组织',
    'errors.wsOpenTimeout': 'WebSocket 连接超时，请检查后端是否启动',
    'errors.wsAuthFailed': 'WebSocket 认证失败',
    'errors.wsSubscribeFailed': 'WS 订阅失败',
    'errors.wsActionResultFailed': 'WS 动作结果上报失败',
    'errors.wsMessageTooLarge': '请求数据过大（{{actualBytes}} bytes），超过上限（{{maxBytes}} bytes）',
    'errors.wsError': 'WebSocket 出错',
    'errors.wsUnknownError': '未知 WebSocket 错误',
    'errors.wsRequestTimeout': '请求超时',
    'errors.streamTimeout': '流式响应超时，请重试',
    'errors.category.llm_call': 'AI 模型暂时不可用，请稍后重试',
    'errors.category.tool_exec': '工具执行失败',
    'errors.category.tool_timeout': '工具执行超时，请重试',
    'errors.category.doom_loop': 'AI 陷入循环，已自动终止',
    'errors.category.context_overflow': '对话内容过长，建议新建对话',
    'errors.category.cancelled': '对话已取消',
    'errors.category.max_iterations': 'AI 达到最大执行次数',
  },
  'en-US': {
    'errors.missingErrorField': 'An error field is required when success is false',
    'errors.unknownError': 'Unknown error',
    'errors.httpStatus': 'HTTP {{status}}: {{statusText}}',
    'errors.wsConnectFailed': 'WebSocket connection failed',
    'errors.wsNoTokenOrOrganization': 'Not logged in or no organization selected',
    'errors.wsOpenTimeout': 'WebSocket connection timeout, check if backend is running',
    'errors.wsAuthFailed': 'WebSocket authentication failed',
    'errors.wsSubscribeFailed': 'WebSocket subscription failed',
    'errors.wsActionResultFailed': 'WS action result failed',
    'errors.wsMessageTooLarge': 'Payload too large ({{actualBytes}} bytes), limit is {{maxBytes}} bytes',
    'errors.wsError': 'WebSocket error',
    'errors.wsUnknownError': 'Unknown WebSocket error',
    'errors.wsRequestTimeout': 'Request timeout',
    'errors.streamTimeout': 'Stream response timed out, please retry',
    'errors.category.llm_call': 'AI model temporarily unavailable, please retry later',
    'errors.category.tool_exec': 'Tool execution failed',
    'errors.category.tool_timeout': 'Tool execution timed out, please retry',
    'errors.category.doom_loop': 'AI entered a loop, auto-terminated',
    'errors.category.context_overflow': 'Conversation too long, please start a new chat',
    'errors.category.cancelled': 'Conversation cancelled',
    'errors.category.max_iterations': 'AI reached maximum execution steps',
  },
};

let currentLocale: TabtinChatClientLocale = 'zh-CN';
let externalTranslator: Translator | null = null;

const formatMessage = (template: string, params?: MessageParams): string => {
  if (!params) return template;
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => {
    const value = params[key];
    return value === undefined || value === null ? '' : String(value);
  });
};

export const setTabtinChatClientLocale = (locale: TabtinChatClientLocale): void => {
  currentLocale = locale;
};

export const getLocale = (): TabtinChatClientLocale => currentLocale;

export const setTabtinChatClientTranslator = (translator: Translator | null): void => {
  externalTranslator = translator;
};

export const t = (key: string, params?: MessageParams): string => {
  if (externalTranslator) {
    return externalTranslator(`tabtinChatClient.${key}`, params);
  }
  const template =
    MESSAGES[currentLocale]?.[key] ??
    MESSAGES['en-US']?.[key] ??
    key;
  return formatMessage(template, params);
};
