export type CrawlIntegrationLocale = 'zh-CN' | 'en-US';

type MessageParams = Record<string, string | number | boolean | null | undefined>;
type Translator = (key: string, params?: MessageParams) => string;

const MESSAGES: Record<CrawlIntegrationLocale, Record<string, string>> = {
  'zh-CN': {
    'errors.schema.objectRequired': 'Schema 必须是一个对象',
    'errors.schema.listSelectorRequired': 'Schema 缺少必需的 listSelector 字段',
    'errors.schema.fieldsRequired': 'Schema 必须包含至少一个字段',
    'errors.schema.fieldInvalid': '字段 #{{index}} 格式错误',
    'errors.schema.fieldMissingName': '字段 #{{index}} 缺少 name 属性',
    'errors.schema.fieldMissingSelector': '字段 \"{{name}}\" 缺少 selector 属性',
    'errors.schema.fieldInvalidType': '字段 \"{{name}}\" 的 type 必须是: text, attribute, html, regex',
    'errors.schema.fieldAttributeRequired': '字段 \"{{name}}\" 的 type=attribute 时必须指定 attribute 属性',
    'errors.schema.fieldRegexRequired': '字段 \"{{name}}\" 的 type=regex 时必须指定 regex 属性',
    'errors.schema.unknown': '未知错误',

    'errors.http.unauthorized': '未授权访问',
    'errors.http.forbidden': '访问被禁止',
    'errors.http.rateLimit': '请求频率过高',
    'errors.http.clientError': '客户端错误: {{status}} {{statusText}}',
    'errors.http.serverError': '服务器错误: {{status}} {{statusText}}',
    'errors.http.generic': 'HTTP 错误: {{status}} {{statusText}}',
    'errors.http.timeout': '请求超时',
    'errors.http.networkFailed': '网络连接失败',
    'errors.http.status': 'HTTP 错误: {{status}}',
    'errors.http.unknownWithMessage': '未知错误: {{message}}',
    'errors.electron.launcherClosed': 'Launcher已关闭',
    'errors.checksum.finalizedUpdate': '校验和已完成，无法继续更新',
    'errors.checksum.alreadyFinalized': '校验和已完成',
    'errors.deepLocator.nonNegativeIndex': 'deepLocator().nth() 需要非负索引',
    'errors.snapshot.resolveIframeByXPathFailed': '无法通过 XPath 解析 iframe 元素',
    'errors.snapshot.mapIframeFrameIdFailed': '无法将 iframe 映射到子 frameId',
    'errors.snapshot.resolveIframeByCssHopFailed': '无法通过 CSS hop 解析 iframe',
    'errors.snapshot.mapCssIframeFrameIdFailed': '无法将 CSS iframe hop 映射到子 frameId',
    'errors.locator.unsupportedFilePayload': '不支持的文件 payload 类型',
    'errors.locator.fileInputRequired': '目标元素不是 <input type="file">',
    'errors.locator.elementNotVisible': '元素不可见（缺少 box model）',
    'errors.locator.nonNegativeIndex': 'locator().nth() 需要非负索引',
    'errors.locator.invalidBoxModel': '无效的 box model 内容 quad',
    'errors.context.noActivePage': 'awaitActivePage: 当前无可用页面',
    'errors.robots.invalidUrl': '提供的 URL 无效',
    'errors.robots.fetchTimeout': 'robots.txt 获取超时',
    'errors.browser.alreadyInitializing': '浏览器已在初始化中',
    'errors.browser.contextNotInitialized': '上下文未初始化',
    'errors.electron.cdpTargetNotFound': '无法找到匹配的 CDP target (title: {{title}}, url: {{url}})',
    'errors.snapshot.missingCdpSession': '缺少 frame {{id}} 的 CDP session',
    'errors.frameLocator.childFrameResolveFailed': 'frameLocator 无法解析子 frame，selector: {{selector}}',
    'errors.page.unsupportedEvent': '不支持的事件: {{event}}',
    'errors.locator.verifyFileInputFailed': '无法验证文件输入元素',
    'errors.locator.unsupportedFileItem': 'setInputFiles 参数无效，期望路径或 payload',
    'errors.locator.fillFailed': '填充元素失败（{{reason}}）',
    'errors.locator.elementNotFound': '未找到元素: {{selector}}',
    'errors.browser.notReady': '浏览器未就绪（状态: {{state}}）',
    'errors.lifecycle.waitTimeout': '生命周期等待超时（{{ms}}ms）',
    'errors.context.waitForTopLevelPageTimeout': '等待顶层页面超时（{{ms}}ms，无顶层页面）',
    'errors.context.noPageForMainFrame': '未找到 mainFrameId 对应页面: {{id}}',
    'errors.context.newPageTargetNotAttached': '创建页面超时：target 未附加（{{id}}）',
    'errors.frame.evaluationFailed': '执行失败',
    'errors.ariaTree.builderMissing': 'AriaTreeBuilder 不可用（crawl-structure 已移除）',
    'errors.ariaTree.moduleRequired': 'AriaTree helpers 不可用（crawl-structure 已移除）。原因: {{reason}}',
    'errors.launch.localJsonVersionTimeout': '等待 /json/version 超时（端口 {{port}}）{{detail}}',
    'errors.launch.localJsonVersionTimeoutDetail': '（最后错误: {{message}}）',
    'errors.launch.browserbaseSessionNotFound': 'Browserbase session 未找到: {{id}}',
    'errors.launch.browserbaseMissingConnectUrl': 'Browserbase session 缺少 connectUrl: {{id}}',
    'errors.launch.browserbaseUnexpectedShape': 'Browserbase session 创建返回结构异常',
    'errors.launch.electronConnectFailed': '连接 Electron WebContentsView 失败: {{error}}',
    'errors.logger.unknownFormatterType': '未知 formatter 类型: {{type}}',

    'errors.crawl.suggestionsLabel': '建议',
    'errors.crawl.retryAfter': '可以在 {{ms}}ms 后重试',

    'progress.httpRequestPreparing': '准备发送 HTTP 请求',
    'progress.completed': '抓取完成',

    'diagnose.issues.maxConcurrency': '已达到最大并发数限制',
    'diagnose.suggestions.maxConcurrency': '考虑增加 maxConcurrency 配置或等待当前请求完成',
    'diagnose.issues.highErrorRate': '错误率过高: {{rate}}%',
    'diagnose.suggestions.checkNetwork': '检查网络连接和目标服务器状态',

    'config.validation.geo.latitudeRange': '纬度必须在 -90 到 90 之间',
    'config.validation.geo.longitudeRange': '经度必须在 -180 到 180 之间',
    'config.validation.geo.accuracyPositive': '精度必须为正数',
    'config.validation.viewport.positive': '视口尺寸必须为正数',
    'config.validation.deviceScale.positive': '设备缩放因子必须为正数',
    'config.validation.cpuThrottling.range': 'CPU 限制率必须在 1 到 100 之间',
    'config.validation.memoryLimit.positive': '内存限制必须为正数',

    'config.summary.location': '位置: {{value}}',
    'config.summary.location.custom': '自定义',
    'config.summary.device': '设备: {{value}}',
    'config.summary.device.customMobile': '自定义移动设备',
    'config.summary.incognito': '隐身模式',
    'config.summary.blocked': '屏蔽: {{items}}',
    'config.summary.blocked.images': '图片',
    'config.summary.blocked.css': 'CSS',
    'config.summary.blocked.fonts': '字体',
    'config.summary.default': '默认配置',

    'errors.suggestions.retryBackoff': '指数退避重试',
    'errors.suggestions.reduceFrequency': '降低请求频率',
    'errors.suggestions.rotateProxy': '使用代理轮换',
    'errors.suggestions.tryAlternativeEngine': '尝试切换引擎',
    'errors.suggestions.switchToWebContents': '从 HTTP 切换到 WebContents 引擎以支持 JavaScript 渲染',
    'errors.suggestions.manualIntervention': '需要人工处理',
    'errors.suggestions.solveCaptcha': '手动解决验证码',
    'errors.suggestions.changeUserAgent': '使用不同的 User-Agent',
    'errors.suggestions.checkConfigAndUrl': '检查配置和 URL',
  },
  'en-US': {
    'errors.schema.objectRequired': 'Schema must be an object.',
    'errors.schema.listSelectorRequired': 'Schema is missing required listSelector.',
    'errors.schema.fieldsRequired': 'Schema must contain at least one field.',
    'errors.schema.fieldInvalid': 'Field #{{index}} is invalid.',
    'errors.schema.fieldMissingName': 'Field #{{index}} is missing name.',
    'errors.schema.fieldMissingSelector': 'Field \"{{name}}\" is missing selector.',
    'errors.schema.fieldInvalidType': 'Field \"{{name}}\" type must be: text, attribute, html, regex.',
    'errors.schema.fieldAttributeRequired': 'Field \"{{name}}\" with type=attribute must specify attribute.',
    'errors.schema.fieldRegexRequired': 'Field \"{{name}}\" with type=regex must specify regex.',
    'errors.schema.unknown': 'Unknown error',

    'errors.http.unauthorized': 'Unauthorized access',
    'errors.http.forbidden': 'Access forbidden',
    'errors.http.rateLimit': 'Too many requests',
    'errors.http.clientError': 'Client error: {{status}} {{statusText}}',
    'errors.http.serverError': 'Server error: {{status}} {{statusText}}',
    'errors.http.generic': 'HTTP error: {{status}} {{statusText}}',
    'errors.http.timeout': 'Request timed out',
    'errors.http.networkFailed': 'Network connection failed',
    'errors.http.status': 'HTTP error: {{status}}',
    'errors.http.unknownWithMessage': 'Unknown error: {{message}}',
    'errors.electron.launcherClosed': 'Launcher is closed',
    'errors.checksum.finalizedUpdate': 'Cannot update finalized checksum.',
    'errors.checksum.alreadyFinalized': 'Checksum already finalized.',
    'errors.deepLocator.nonNegativeIndex': 'deepLocator().nth() expects a non-negative index.',
    'errors.snapshot.resolveIframeByXPathFailed': 'Failed to resolve iframe element by XPath.',
    'errors.snapshot.mapIframeFrameIdFailed': 'Could not map iframe to child frameId.',
    'errors.snapshot.resolveIframeByCssHopFailed': 'Failed to resolve iframe via CSS hop.',
    'errors.snapshot.mapCssIframeFrameIdFailed': 'Could not map CSS iframe hop to child frameId.',
    'errors.locator.unsupportedFilePayload': 'Unsupported file payload buffer type.',
    'errors.locator.fileInputRequired': 'Target is not an <input type=\"file\"> element.',
    'errors.locator.elementNotVisible': 'Element not visible (no box model).',
    'errors.locator.nonNegativeIndex': 'locator().nth() expects a non-negative index.',
    'errors.locator.invalidBoxModel': 'Invalid box model content quad.',
    'errors.context.noActivePage': 'awaitActivePage: no page available.',
    'errors.robots.invalidUrl': 'Invalid URL provided.',
    'errors.robots.fetchTimeout': 'robots.txt fetch timeout.',
    'errors.browser.alreadyInitializing': 'Already initializing.',
    'errors.browser.contextNotInitialized': 'Context not initialized.',
    'errors.electron.cdpTargetNotFound': 'No matching CDP target found (title: {{title}}, url: {{url}}).',
    'errors.snapshot.missingCdpSession': 'Missing CDP session for frame {{id}}.',
    'errors.frameLocator.childFrameResolveFailed': 'frameLocator: could not resolve child frame for selector: {{selector}}.',
    'errors.page.unsupportedEvent': 'Unsupported event: {{event}}.',
    'errors.locator.verifyFileInputFailed': 'Unable to verify file input element.',
    'errors.locator.unsupportedFileItem': 'Unsupported setInputFiles item – expected path or payload.',
    'errors.locator.fillFailed': 'Failed to fill element ({{reason}}).',
    'errors.locator.elementNotFound': 'Element not found for selector: {{selector}}.',
    'errors.browser.notReady': 'Browser not ready (state: {{state}}).',
    'errors.lifecycle.waitTimeout': 'Lifecycle wait timed out after {{ms}}ms.',
    'errors.context.waitForTopLevelPageTimeout': 'waitForFirstTopLevelPage timed out after {{ms}}ms (no top-level Page).',
    'errors.context.noPageForMainFrame': 'No Page found for mainFrameId={{id}}.',
    'errors.context.newPageTargetNotAttached': 'newPage timeout: target not attached ({{id}}).',
    'errors.frame.evaluationFailed': 'Evaluation failed.',
    'errors.ariaTree.builderMissing': 'AriaTreeBuilder unavailable (crawl-structure removed).',
    'errors.ariaTree.moduleRequired': 'AriaTree helpers unavailable (crawl-structure removed). Reason: {{reason}}',
    'errors.launch.localJsonVersionTimeout': 'Timed out waiting for /json/version on port {{port}}{{detail}}.',
    'errors.launch.localJsonVersionTimeoutDetail': ' (last error: {{message}})',
    'errors.launch.browserbaseSessionNotFound': 'Browserbase session not found: {{id}}.',
    'errors.launch.browserbaseMissingConnectUrl': 'Browserbase session resume missing connectUrl for {{id}}.',
    'errors.launch.browserbaseUnexpectedShape': 'Browserbase session creation returned an unexpected shape.',
    'errors.launch.electronConnectFailed': 'Failed to connect to Electron WebContentsView: {{error}}.',
    'errors.logger.unknownFormatterType': 'Unknown formatter type: {{type}}.',

    'errors.crawl.suggestionsLabel': 'Suggestions',
    'errors.crawl.retryAfter': 'Retry after {{ms}}ms',

    'progress.httpRequestPreparing': 'Preparing HTTP request',
    'progress.completed': 'Crawl completed',

    'diagnose.issues.maxConcurrency': 'Maximum concurrency limit reached',
    'diagnose.suggestions.maxConcurrency': 'Increase maxConcurrency or wait for current requests to finish',
    'diagnose.issues.highErrorRate': 'High error rate: {{rate}}%',
    'diagnose.suggestions.checkNetwork': 'Check network connection and target server status',

    'config.validation.geo.latitudeRange': 'Latitude must be between -90 and 90',
    'config.validation.geo.longitudeRange': 'Longitude must be between -180 and 180',
    'config.validation.geo.accuracyPositive': 'Accuracy must be positive',
    'config.validation.viewport.positive': 'Viewport dimensions must be positive',
    'config.validation.deviceScale.positive': 'Device scale factor must be positive',
    'config.validation.cpuThrottling.range': 'CPU throttling rate must be between 1 and 100',
    'config.validation.memoryLimit.positive': 'Memory limit must be positive',

    'config.summary.location': 'Location: {{value}}',
    'config.summary.location.custom': 'Custom',
    'config.summary.device': 'Device: {{value}}',
    'config.summary.device.customMobile': 'Custom mobile device',
    'config.summary.incognito': 'Incognito mode',
    'config.summary.blocked': 'Blocked: {{items}}',
    'config.summary.blocked.images': 'Images',
    'config.summary.blocked.css': 'CSS',
    'config.summary.blocked.fonts': 'Fonts',
    'config.summary.default': 'Default configuration',

    'errors.suggestions.retryBackoff': 'Retry with exponential backoff',
    'errors.suggestions.reduceFrequency': 'Reduce request frequency',
    'errors.suggestions.rotateProxy': 'Use proxy rotation',
    'errors.suggestions.tryAlternativeEngine': 'Try an alternative engine',
    'errors.suggestions.switchToWebContents': 'Switch from HTTP to WebContents engine for JavaScript rendering',
    'errors.suggestions.manualIntervention': 'Manual intervention required',
    'errors.suggestions.solveCaptcha': 'Solve CAPTCHA manually',
    'errors.suggestions.changeUserAgent': 'Use a different user agent',
    'errors.suggestions.checkConfigAndUrl': 'Check configuration and URL',
  },
};

let currentLocale: CrawlIntegrationLocale = 'zh-CN';
let externalTranslator: Translator | null = null;

const formatMessage = (template: string, params?: MessageParams): string => {
  if (!params) return template;
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => {
    const value = params[key];
    return value === undefined || value === null ? '' : String(value);
  });
};

export const setCrawlIntegrationLocale = (locale: CrawlIntegrationLocale): void => {
  currentLocale = locale;
};

export const setCrawlIntegrationTranslator = (translator: Translator | null): void => {
  externalTranslator = translator;
};

export const t = (key: string, params?: MessageParams): string => {
  if (externalTranslator) {
    return externalTranslator(`crawlIntegration.${key}`, params);
  }
  const template =
    MESSAGES[currentLocale]?.[key] ??
    MESSAGES['en-US']?.[key] ??
    key;
  return formatMessage(template, params);
};
