/**
 * Chromium stealth 启动参数
 *
 * 参考来源：
 * - Scrapling v0.4.2 STEALTH_ARGS + DEFAULT_ARGS（见 support/Browser/scrapling-design-analysis.md）
 * - puppeteer-extra-stealth 社区实践
 *
 * 分类标准：每个参数都必须有明确的反检测效果，纯功能开关不收录。
 * Electron 端通过 main-process-config.ts 的 parseStealthArgs 处理
 * --enable-features / --disable-features 的合并，--test-type 会被排除。
 */
export const STEALTH_ARGS: string[] = [
  // ── 反检测核心 ──────────────────────────────────────────────

  // 移除 navigator.webdriver=true，最关键的反自动化标记
  '--disable-blink-features=AutomationControlled',
  // 禁用 Chrome 测试模式标记（Electron 端会排除此项，Daemon 端需要）
  '--test-type',
  // 隐藏 "Chrome is being controlled by automated test software" 信息栏
  '--disable-infobars',
  // 跳过首次运行向导，真实用户不会触发
  '--no-first-run',
  // 跳过默认浏览器检查弹窗
  '--no-default-browser-check',
  // 禁用会话崩溃恢复气泡，避免意外 UI
  '--disable-session-crashed-bubble',
  // 禁用搜索引擎选择页（Chrome 115+ 欧盟合规要求）
  '--disable-search-engine-choice-screen',

  // ── 指纹保护 ────────────────────────────────────────────────

  // Canvas 数据噪声注入，防止 canvas fingerprinting
  '--fingerprinting-canvas-image-data-noise',
  // ClientRects 噪声注入，防止 DOM 元素尺寸指纹
  '--fingerprinting-client-rects-noise',
  // 统一色彩配置文件，消除 color profile 维度的指纹差异
  '--force-color-profile=srgb',
  // 禁用字体渲染提示，减少字体指纹维度
  '--font-render-hinting=none',

  // ── WebRTC 防护 ─────────────────────────────────────────────

  // 禁止非代理 UDP 连接，防止通过 WebRTC 泄漏真实 IP
  '--webrtc-ip-handling-policy=disable_non_proxied_udp',
  // 强制执行上述 WebRTC 策略，确保不被绕过
  '--force-webrtc-ip-handling-policy',

  // ── 语言与区域伪装 ──────────────────────────────────────────

  // 统一浏览器 UI 语言标识（含 fallback），避免 navigator.language 暴露地区
  '--lang=en-US,en',
  // 统一 Accept-Language HTTP 头
  '--accept-lang=en-US',

  // ── 行为模拟 ────────────────────────────────────────────────

  // 模拟真实用户的自动播放策略（Chrome 默认值）
  '--autoplay-policy=user-gesture-required',
  // 模拟真实桌面设备的交互能力声明（hover + 精确指针）
  '--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4',
  // headless 检测绕过：最大化窗口模拟真实用户行为
  '--start-maximized',

  // ── 隐私保护（减少 Google 服务痕迹）──────────────────────────

  // 关闭 Chrome 同步，避免同步账号相关的异常信号
  '--disable-sync',
  // 关闭翻译栏，避免触发翻译服务请求
  '--disable-translate',
  // 使用基本密码存储，避免访问系统钥匙串引发权限弹窗
  '--password-store=basic',
  // 使用模拟钥匙串（macOS），避免系统钥匙串交互
  '--use-mock-keychain',
  // 禁用客户端钓鱼检测，避免 Safe Browsing 网络请求
  '--disable-client-side-phishing-detection',
  // 禁用 Safe Browsing 自动更新，避免后台更新请求
  '--safebrowsing-disable-auto-update',
  // 禁用域名可靠性监测，防止错误报告发送到 Google
  '--disable-domain-reliability',
  // 仅记录指标但不上报，防止遥测数据泄露自动化痕迹
  '--metrics-recording-only',
  // 禁用信用卡上传和钱包卡保存提示，避免意外弹窗
  '--disable-offer-upload-credit-cards',
  '--disable-offer-store-unmasked-wallet-cards',
  // 禁用 Cookie 加密，避免系统钥匙串依赖导致的兼容问题
  '--disable-cookie-encryption',

  // ── 后台行为控制（防止自动化下行为差异）───────────────────────

  // 禁用后台网络活动，防止 Chrome 发送意外请求
  '--disable-background-networking',
  // 避免后台标签页被浏览器降低优先级或暂停执行
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--disable-background-timer-throttling',
  // 避免自动化快速交互时 IPC 消息被限流
  '--disable-ipc-flooding-protection',
  // 禁用挂起检测，避免自动化操作触发假死判断弹窗
  '--disable-hang-monitor',
  // 禁用超链接审计 ping，减少额外网络请求
  '--no-pings',
  // 禁用服务自动运行，减少后台进程
  '--no-service-autorun',
  // 禁用有后台页面的组件扩展，减少扩展相关信号
  '--disable-component-extensions-with-background-pages',

  // ── 崩溃防护与稳定性 ────────────────────────────────────────

  // 禁用崩溃报告器，防止崩溃数据暴露自动化痕迹
  '--disable-crash-reporter',
  '--disable-breakpad',
  // 避免 /dev/shm 空间不足导致崩溃（Docker / CI 环境常见）
  '--disable-dev-shm-usage',

  // ── UI 伪装与一致性 ─────────────────────────────────────────

  // 静音，避免意外音频暴露自动化环境
  '--mute-audio',
  // 隐藏滚动条，headless 模式下保持渲染一致性
  '--hide-scrollbars',
  // 禁用表单重复提交确认，避免意外弹窗中断自动化
  '--disable-prompt-on-repost',
  // 空白主页，防止初始化时加载默认页面产生额外请求
  '--homepage=about:blank',
  // 确保 GPU 加速可用，防止因 GPU 黑名单导致渲染差异
  '--ignore-gpu-blocklist',
  // 禁用地址栏预渲染，防止意外的页面加载
  '--prerender-from-omnibox=disabled',
  // 减少日志输出，避免日志中泄露自动化痕迹
  '--disable-logging',

  // ── 性能优化（兼具反检测效果）──────────────────────────────

  // 异步 DNS 解析，减少 DNS 查询延迟
  '--enable-async-dns',
  // TCP 快速打开，加速连接建立
  '--enable-tcp-fast-open',
  // 更积极的缓存丢弃策略
  '--aggressive-cache-discard',
  // 简化缓存后端，减少 I/O 开销
  '--enable-simple-cache-backend',

  // ── 渲染一致性（减少时序指纹）──────────────────────────────

  // 禁用线程动画和滚动，使渲染行为更一致可预测
  '--disable-threaded-animation',
  '--disable-threaded-scrolling',
  // 减少光栅化和图像动画的渲染差异
  '--disable-partial-raster',
  '--disable-image-animation-resync',
  '--disable-checker-imaging',

  // ── 现代浏览器特征信号 ──────────────────────────────────────

  // 启用 PDF 标签导出和文档大纲，让浏览器匹配现代 Chrome 的功能特征
  '--export-tagged-pdf',
  '--generate-pdf-document-outline',

  // ── 站点隔离 ────────────────────────────────────────────────

  // 禁用站点隔离试验，减少跨域 iframe 限制导致的行为差异
  '--disable-site-isolation-trials',

  // ── Feature Flags ────────────────────────────────────────────

  // NetworkService: 现代网络栈；TrustTokens: Privacy Sandbox 特征
  '--enable-features=NetworkService,NetworkServiceInProcess,TrustTokens,TrustTokensAlwaysAllowIssuance',
  // AudioServiceOutOfProcess: 避免进程外音频服务暴露；TranslateUI: 配合 --disable-translate；
  // BlinkGenPropertyTrees: 避免实验性渲染特征；IsolateOrigins/site-per-process: 配合 --disable-site-isolation-trials
  // AutofillServerCommunication: 防止自动填充后端请求；OptimizationHints: 防止优化提示网络请求
  // MediaRouter/DialMediaRouteProvider: 防止 Cast/DIAL 设备发现请求暴露环境
  '--disable-features=AudioServiceOutOfProcess,TranslateUI,BlinkGenPropertyTrees,IsolateOrigins,site-per-process,AutofillServerCommunication,OptimizationHints,MediaRouter,DialMediaRouteProvider',
];

/**
 * Playwright/Patchright 默认添加的"有害"参数
 * 这些参数暴露了自动化特征，需要主动移除
 */
export const HARMFUL_ARGS_TO_REMOVE: string[] = [
  '--enable-automation',
  '--disable-popup-blocking',
  '--disable-component-update',
  '--disable-default-apps',
  '--disable-extensions',
];

/**
 * 合并 stealth 参数到启动配置：移除有害参数，添加 stealth 参数，去重。
 */
export function applyStealthArgs(existingArgs: string[]): string[] {
  const filtered = existingArgs.filter(
    (arg) => !HARMFUL_ARGS_TO_REMOVE.some((harmful) => arg.startsWith(harmful)),
  );
  return [...new Set([...filtered, ...STEALTH_ARGS])];
}
