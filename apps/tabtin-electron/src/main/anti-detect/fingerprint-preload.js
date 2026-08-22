/**
 * 指纹伪装 Preload Script
 *
 * 🎯 目的：在页面任何脚本执行之前注入指纹伪装代码
 * 📍 注入时机：每次页面加载时自动执行（比 dom-ready 更早）
 * 🔒 生效范围：所有使用该 session 的 WebContentsView
 *
 * ⚠️ 关键修正：由于 contextIsolation: true，必须将脚本注入到【主世界】(Main World) 才能生效！
 */

const { contextBridge, webFrame } = require('electron');

// 注入到主世界的脚本源码
const mainWorldScript = `
(function() {
  'use strict';

  // 防止重复注入
  if (window.__tabtin_fingerprint_injected) return;
  window.__tabtin_fingerprint_injected = true;

  try {
    // ============================================================
    // 0. ✅ UA 覆盖（最优先 - 移除 Electron 标识）
    // ============================================================
    (function overrideUserAgent() {
      const originalUA = navigator.userAgent;

      // 清理 Electron 和应用标识
      const cleanUA = originalUA
        .replace(/\\s+tabtin-electron\\/[\\d.]+/gi, '')
        .replace(/\\s+Electron\\/[\\d.]+/gi, '')
        .trim();

      // 如果 UA 被清理过，才覆盖
      if (cleanUA !== originalUA) {
        try {
          // 使用 getter 覆盖，且不可配置，防止被页面脚本重写
          Object.defineProperty(navigator, 'userAgent', {
            get: () => cleanUA,
            configurable: false,
            enumerable: true
          });
        } catch (e) {
        }
      }
    })();

    // ============================================================
    // 1. Canvas 指纹噪声注入（session-seed 驱动，确定性但不可预测）
    // ============================================================
    (function injectCanvasNoise() {
      const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
      const originalToBlob = HTMLCanvasElement.prototype.toBlob;

      // 每个 session 生成唯一 seed，同一 session 内指纹稳定
      var _seed = (function() {
        var arr = new Uint32Array(1);
        crypto.getRandomValues(arr);
        return arr[0];
      })();

      // xorshift32 — 快速确定性 PRNG
      function xorshift(s) {
        s ^= s << 13;
        s ^= s >>> 17;
        s ^= s << 5;
        return s >>> 0;
      }

      function addCanvasNoise(imageData) {
        if (!imageData || !imageData.data) return;
        var data = imageData.data;
        var state = _seed;
        for (var i = 0; i < data.length; i += 4) {
          state = xorshift(state);
          if ((state & 31) === 0) {
            var channel = state & 3;
            data[i + channel] = data[i + channel] ^ 1;
          }
        }
      }

      HTMLCanvasElement.prototype.toDataURL = function() {
        try {
          var ctx = this.getContext('2d');
          if (ctx) {
            var imageData = ctx.getImageData(0, 0, this.width, this.height);
            addCanvasNoise(imageData);
            ctx.putImageData(imageData, 0, 0);
          }
        } catch (e) {}
        return originalToDataURL.apply(this, arguments);
      };

      HTMLCanvasElement.prototype.toBlob = function(callback) {
        try {
          var ctx = this.getContext('2d');
          if (ctx) {
            var imageData = ctx.getImageData(0, 0, this.width, this.height);
            addCanvasNoise(imageData);
            ctx.putImageData(imageData, 0, 0);
          }
        } catch (e) {}
        return originalToBlob.apply(this, arguments);
      };
    })();

    // ============================================================
    // 2. WebGL 指纹伪装 (智能自适应 V2)
    // ============================================================
    (function injectWebGLSpoof() {
      const UNMASKED_VENDOR_WEBGL = 37445;
      const UNMASKED_RENDERER_WEBGL = 37446;

      function spoofWebGLContext(proto) {
        if (!proto || typeof proto.getParameter !== 'function') return;

        const originalGetParameter = proto.getParameter;
        const originalGetExtension = proto.getExtension;

        proto.getParameter = function(parameter) {
          // 1. 获取真实值
          const realValue = originalGetParameter.apply(this, arguments);

          // 2. 如果不是请求厂商或渲染器，直接返回
          if (parameter !== UNMASKED_VENDOR_WEBGL && parameter !== UNMASKED_RENDERER_WEBGL) {
            return realValue;
          }

          // 3. 获取当前生效的 UA (代表用户想要的平台)
          const ua = navigator.userAgent;
          const realStr = String(realValue);

          // --- 硬件特征检测 ---
          // 检测真实显卡是否带有明显的 Apple 特征 (M1/M2/M3/M4/Iris/Mac)
          const isRealApple = /Apple|Mac|Iris/i.test(realStr);

          // --- 决策逻辑 ---

          // Case A: 目标是 macOS
          if (ua.includes('Macintosh') || ua.includes('Mac OS X')) {
            // 如果真实硬件就是 Apple 系 (M芯片或Intel Mac)，保留原样，这是最真实的
            if (isRealApple) {
               return realValue;
            }
            // 否则 (如 Windows 电脑模拟 Mac)，需要伪装成 Mac 显卡
            return parameter === UNMASKED_VENDOR_WEBGL
              ? 'Google Inc. (Apple)'
              : 'ANGLE (Apple, Apple M1, OpenGL 4.1)';
          }

          // Case B: 目标是 Windows
          if (ua.includes('Windows') || ua.includes('Win64')) {
            // 如果真实硬件是 Apple 芯片，必须伪装 (Windows 不可能跑在 M 芯片上)
            if (isRealApple) {
              return parameter === UNMASKED_VENDOR_WEBGL
                ? 'Google Inc. (NVIDIA)'
                : 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1050 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)';
            }
            // 否则 (真实 PC 模拟 Windows)，保留真实显卡 (无论是 NVIDIA, AMD 还是 Intel 核显)
            return realValue;
          }

          // Case C: 目标是 Android (必须伪装，手机显卡架构完全不同)
          if (ua.includes('Android')) {
             return parameter === UNMASKED_VENDOR_WEBGL ? 'Qualcomm' : 'Adreno (TM) 640';
          }

          // Case D: 目标是 iPhone/iPad (必须伪装，iOS 显卡标识特殊)
          if (ua.includes('iPhone') || ua.includes('iPad')) {
              return parameter === UNMASKED_VENDOR_WEBGL ? 'Apple Inc.' : 'Apple GPU';
          }

          // 默认情况: 保持真实 (例如 Linux 模拟 Linux)
          return realValue;
        };

        proto.getExtension = function(name) {
          // 只有在进行了伪装的情况下，才需要隐藏调试扩展
          // 为了简单起见，这里我们始终拦截，并让它返回我们 getParameter 伪造的值
          // 这样如果 getParameter 返回了真实值，这里也间接“真实”了
          if (name === 'WEBGL_debug_renderer_info') {
             return {
                UNMASKED_VENDOR_WEBGL: UNMASKED_VENDOR_WEBGL,
                UNMASKED_RENDERER_WEBGL: UNMASKED_RENDERER_WEBGL
             };
          }
          return originalGetExtension.apply(this, arguments);
        };
      }

      if (typeof WebGLRenderingContext !== 'undefined') {
        spoofWebGLContext(WebGLRenderingContext.prototype);
      }
      if (typeof WebGL2RenderingContext !== 'undefined') {
        spoofWebGLContext(WebGL2RenderingContext.prototype);
      }

    })();

    // ============================================================
    // 3. WebRTC IP 泄露防护
    // ============================================================
    (function injectWebRTCProtection() {
      if (typeof RTCPeerConnection === 'undefined') return;

      const OriginalRTCPeerConnection = RTCPeerConnection;
      window.RTCPeerConnection = function(config, ...args) {
        if (!config) config = {};
        config.iceTransportPolicy = 'relay';
        const pc = new OriginalRTCPeerConnection(config, ...args);
        const originalAddIceCandidate = pc.addIceCandidate;
        pc.addIceCandidate = function(candidate, ...rest) {
          if (candidate && candidate.candidate && candidate.candidate.indexOf('typ host') >= 0) {
            return Promise.resolve();
          }
          return originalAddIceCandidate.apply(this, [candidate, ...rest]);
        };
        return pc;
      };
      window.RTCPeerConnection.prototype = OriginalRTCPeerConnection.prototype;
    })();

    // ============================================================
    // 4. 插件与 MimeType 枚举伪装（模拟真实 Chrome）
    // ============================================================
    (function injectPluginProtection() {
        if (!navigator.plugins) return;

        var PLUGIN_DATA = [
          { name: 'PDF Viewer',              filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
          { name: 'Chrome PDF Viewer',       filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
          { name: 'Chromium PDF Viewer',     filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
          { name: 'Microsoft Edge PDF Viewer',filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
          { name: 'WebKit built-in PDF',     filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        ];

        var MIME_TYPE = 'application/pdf';
        var MIME_DESC = 'Portable Document Format';
        var MIME_SUFFIXES = 'pdf';

        function makeMimeType(plugin) {
          var mt = Object.create(MimeType.prototype);
          Object.defineProperties(mt, {
            type:        { get: function() { return MIME_TYPE; },    enumerable: true },
            suffixes:    { get: function() { return MIME_SUFFIXES; },enumerable: true },
            description: { get: function() { return MIME_DESC; },   enumerable: true },
            enabledPlugin:{ get: function() { return plugin; },     enumerable: true },
          });
          return mt;
        }

        function makePlugin(data) {
          var p = Object.create(Plugin.prototype);
          var mime = makeMimeType(p);
          Object.defineProperties(p, {
            name:        { get: function() { return data.name; },        enumerable: true },
            filename:    { get: function() { return data.filename; },    enumerable: true },
            description: { get: function() { return data.description; }, enumerable: true },
            length:      { get: function() { return 1; },                enumerable: true },
            0:           { get: function() { return mime; },             enumerable: false },
          });
          p.item = function(i) { return i === 0 ? mime : null; };
          p.namedItem = function(n) { return n === MIME_TYPE ? mime : null; };
          p[Symbol.iterator] = function() { var done = false; return { next: function() { if (done) return { done: true }; done = true; return { value: mime, done: false }; } }; };
          return p;
        }

        var plugins = PLUGIN_DATA.map(makePlugin);
        var allMimes = plugins.map(function(p) { return p[0]; });

        var pluginArray = Object.create(PluginArray.prototype);
        Object.defineProperty(pluginArray, 'length', { get: function() { return plugins.length; }, enumerable: true });
        plugins.forEach(function(p, i) {
          Object.defineProperty(pluginArray, i, { get: function() { return p; }, enumerable: false });
        });
        pluginArray.item = function(i) { return plugins[i] || null; };
        pluginArray.namedItem = function(n) { for (var i = 0; i < plugins.length; i++) { if (plugins[i].name === n) return plugins[i]; } return null; };
        pluginArray.refresh = function() {};
        pluginArray[Symbol.iterator] = function() { var idx = 0; return { next: function() { return idx < plugins.length ? { value: plugins[idx++], done: false } : { done: true }; } }; };

        var mimeTypeArray = Object.create(MimeTypeArray.prototype);
        Object.defineProperty(mimeTypeArray, 'length', { get: function() { return allMimes.length; }, enumerable: true });
        allMimes.forEach(function(m, i) {
          Object.defineProperty(mimeTypeArray, i, { get: function() { return m; }, enumerable: false });
        });
        mimeTypeArray.item = function(i) { return allMimes[i] || null; };
        mimeTypeArray.namedItem = function(n) { for (var i = 0; i < allMimes.length; i++) { if (allMimes[i].type === n) return allMimes[i]; } return null; };
        mimeTypeArray[Symbol.iterator] = function() { var idx = 0; return { next: function() { return idx < allMimes.length ? { value: allMimes[idx++], done: false } : { done: true }; } }; };

        Object.defineProperty(navigator, 'plugins',   { get: function() { return pluginArray; },   configurable: false, enumerable: true });
        Object.defineProperty(navigator, 'mimeTypes',  { get: function() { return mimeTypeArray; }, configurable: false, enumerable: true });
        Object.defineProperty(navigator, 'pdfViewerEnabled', { get: function() { return true; }, configurable: false, enumerable: true });
    })();

    // ============================================================
    // 5. 基础特征隐藏 (借鉴 Crawl4AI)
    // ============================================================
    (function injectBasicStealth() {
      try {
        // 1. 隐藏 navigator.webdriver (关键!)
        // 很多网站检查这个属性来判断是否是自动化工具
        Object.defineProperty(navigator, 'webdriver', {
          get: () => undefined,
          configurable: false,
          enumerable: true
        });

        // 2. 伪造 Permissions API
        // 自动化环境的 notification 权限通常行为不一致
        if (navigator.permissions && navigator.permissions.query) {
          const originalQuery = navigator.permissions.query;
          navigator.permissions.query = (parameters) => (
            parameters.name === 'notifications'
              ? Promise.resolve({ state: Notification.permission, onchange: null })
              : originalQuery(parameters)
          );
        }

        // 3. 确保 navigator.languages 存在且合理
        if (!navigator.languages || navigator.languages.length === 0) {
           Object.defineProperty(navigator, 'languages', {
             get: () => ['en-US', 'en'],
             configurable: false,
             enumerable: true
           });
        }

      } catch (e) {
      }
    })();

    // ============================================================
    // 7. Chrome 对象完整伪装 (🆕 专业级增强)
    // ============================================================
    (function injectChromeObject() {
      try {
        // 检查是否已存在 chrome 对象
        if (window.chrome && window.chrome.__tabtin_injected) return;

        // 🔥 完整的 Chrome 对象（基于真实 Chrome 133 的属性）
        const chromeObject = {
          // 1. runtime (扩展 API)
          runtime: {
            OnInstalledReason: {
              CHROME_UPDATE: "chrome_update",
              INSTALL: "install",
              SHARED_MODULE_UPDATE: "shared_module_update",
              UPDATE: "update"
            },
            OnRestartRequiredReason: {
              APP_UPDATE: "app_update",
              OS_UPDATE: "os_update",
              PERIODIC: "periodic"
            },
            PlatformArch: {
              ARM: "arm",
              ARM64: "arm64",
              MIPS: "mips",
              MIPS64: "mips64",
              X86_32: "x86-32",
              X86_64: "x86-64"
            },
            PlatformNaclArch: {
              ARM: "arm",
              MIPS: "mips",
              MIPS64: "mips64",
              X86_32: "x86-32",
              X86_64: "x86-64"
            },
            PlatformOs: {
              ANDROID: "android",
              CROS: "cros",
              LINUX: "linux",
              MAC: "mac",
              OPENBSD: "openbsd",
              WIN: "win"
            },
            RequestUpdateCheckStatus: {
              NO_UPDATE: "no_update",
              THROTTLED: "throttled",
              UPDATE_AVAILABLE: "update_available"
            },
            // 🔥 关键：id 属性（Chrome 扩展 ID）
            id: undefined,
          },

          // 2. loadTimes (性能 API - 已废弃但仍被检测)
          loadTimes: function() {
            const timing = performance.timing || {};
            const now = Date.now() / 1000;
            return {
              commitLoadTime: (timing.responseStart || 0) / 1000,
              connectionInfo: 'http/1.1',
              finishDocumentLoadTime: (timing.domContentLoadedEventEnd || 0) / 1000,
              finishLoadTime: (timing.loadEventEnd || 0) / 1000,
              firstPaintAfterLoadTime: 0,
              firstPaintTime: (timing.domLoading || 0) / 1000,
              navigationType: 'Other',
              npnNegotiatedProtocol: 'unknown',
              requestTime: (timing.fetchStart || 0) / 1000,
              startLoadTime: (timing.requestStart || 0) / 1000,
              wasAlternateProtocolAvailable: false,
              wasFetchedViaSpdy: false,
              wasNpnNegotiated: false
            };
          },

          // 3. csi (Client Side Instrumentation - 性能监控)
          csi: function() {
            const timing = performance.timing || {};
            return {
              onloadT: Date.now(),
              pageT: Date.now() - (timing.navigationStart || Date.now()),
              startE: timing.navigationStart || Date.now(),
              tran: 15
            };
          },

          // 4. app (Chrome App API)
          app: {
            InstallState: {
              DISABLED: "disabled",
              INSTALLED: "installed",
              NOT_INSTALLED: "not_installed"
            },
            RunningState: {
              CANNOT_RUN: "cannot_run",
              READY_TO_RUN: "ready_to_run",
              RUNNING: "running"
            },
            getDetails: function() {
              return null;
            },
            getIsInstalled: function() {
              return false;
            },
            installState: function(callback) {
              if (callback) callback('not_installed');
            },
            isInstalled: false,
            runningState: function() {
              return 'cannot_run';
            }
          },

          // 5. __tabtin_injected 标记（防止重复注入）
          __tabtin_injected: true,
        };

        // 冻结对象防止检测和篡改
        Object.freeze(chromeObject.runtime.OnInstalledReason);
        Object.freeze(chromeObject.runtime.OnRestartRequiredReason);
        Object.freeze(chromeObject.runtime.PlatformArch);
        Object.freeze(chromeObject.runtime.PlatformNaclArch);
        Object.freeze(chromeObject.runtime.PlatformOs);
        Object.freeze(chromeObject.runtime.RequestUpdateCheckStatus);
        Object.freeze(chromeObject.runtime);
        Object.freeze(chromeObject.app.InstallState);
        Object.freeze(chromeObject.app.RunningState);
        Object.freeze(chromeObject.app);
        Object.freeze(chromeObject);

        // 注入到 window
        if (!window.chrome) {
          Object.defineProperty(window, 'chrome', {
            get: () => chromeObject,
            configurable: false,
            enumerable: true
          });
        } else {
          // 如果已存在，尝试合并属性
          try {
            for (const key of Object.keys(chromeObject)) {
              if (!window.chrome[key]) {
                window.chrome[key] = chromeObject[key];
              }
            }
            window.chrome.__tabtin_injected = true;
          } catch (e) {}
        }

      } catch (e) {
      }
    })();

  } catch (error) {}
})();
`;

try {
  webFrame.executeJavaScript(mainWorldScript);
} catch (_) {}

// ════════════════════════════════════════════════════════════════════
// Wave 3 G3：密码捕获事件桥接（page main world → preload → main process）
// ════════════════════════════════════════════════════════════════════
//
// 设计：
//   - 主世界由 `installPasswordCaptureScript` 在 dom-ready 时注入
//     PASSWORD_CAPTURE_SCRIPT，监听 form submit / button click / dynamic DOM；
//   - 主世界用 `window.postMessage({__tabtin_password_capture: true, ...})` 把
//     凭据透出；
//   - 这里在 preload (isolated world) 监听 `message` 事件，校验 source 后
//     通过 ipcRenderer 转给主进程；
//   - 主进程 `credential-vault:password-captured` handler 内部调
//     `onPasswordSubmitted`，做登录验证 + 三模式决策 + emit save-prompt。
//
// 安全：
//   - `event.source === window` 保证消息来自当前 page 而非第三方 iframe
//     postMessage 注入；
//   - **永远忽略 page 自报的 `data.url`**（Wave 3 P0 视角 1#2 投毒修复）：
//     恶意 page 即便伪造 url 字段，preload 也不传给主进程；URL 由主进程从
//     `event.sender.getURL()` 取，这是不可被 page 控制的真实 URL；
//   - 整条链路（page → preload → main）都在同一进程内，密码不出 webContents；
//   - preload 这里**不打日志**（密码不进 stdout/stderr）。
try {
  const { ipcRenderer } = require('electron');
  window.addEventListener('message', (event) => {
    try {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || typeof data !== 'object' || data.__tabtin_password_capture !== true) return;
      if (typeof data.password !== 'string' || !data.password) return;
      // **不传 url 字段**（Wave 3 P0 视角 1#2）—— 主进程从 sender.getURL() 取真实 URL，
      // 永远不信 page 自报的 url 来防止任意域名凭据投毒攻击。
      ipcRenderer.invoke('credential-vault:password-captured', {
        username: typeof data.username === 'string' ? data.username : '',
        password: data.password,
      }).catch(() => {
        // 主进程拒绝（sender 不在 webContentsMap 等）静默——不能在 console
        // 留下任何线索（密码相关链路绝不打日志）
      });
    } catch (_) {
      // 异常静默：preload 不能向 page 暴露任何错误细节
    }
  }, false);
} catch (_) {
  // require('electron') 失败属环境异常（非 Electron preload 上下文）—— 静默
}
