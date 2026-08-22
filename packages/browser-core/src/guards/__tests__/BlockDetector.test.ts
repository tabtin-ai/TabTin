import { describe, it, expect } from 'vitest';
import {
  analyzeBlockProbe,
  buildDetectionScript,
  isAffirmativeLoginGateText,
  type LoginModalCandidate,
  type PageProbe,
} from '../BlockDetector';

/**
 * BlockDetector.analyzeBlockProbe 单测：聚焦新增的登录墙（auth_wall）检测——
 * 覆盖「200 页面 + 登录浮层」（如小红书未登录 explore），并守住高精度（页头登录链接不误报）。
 * 同时回归既有的 Cloudflare / 反爬关键词 / business_403 判定不被登录墙抢占。
 */

function probe(overrides: Partial<PageProbe> = {}): PageProbe {
  return {
    title: '',
    bodyText: '',
    bodyLength: 0,
    httpStatus: 200,
    url: 'https://example.com/',
    pathname: '/',
    cfSelectorHits: 0,
    hasChallengeIframe: false,
    hasPasswordInput: false,
    hasPhoneLoginInput: false,
    hasVerifyCodeInput: false,
    loginModalCandidates: [],
    ...overrides,
  };
}

describe('isAffirmativeLoginGateText', () => {
  it('同句否定优先于门槛子串', () => {
    expect(isAffirmativeLoginGateText('为什么不需要登录？')).toBe(false);
  });
  it('肯定完成语义', () => {
    expect(isAffirmativeLoginGateText('需要登录后才能查看')).toBe(true);
  });
  it('否定 FAQ 不吞掉另一分句的真实门槛', () => {
    const text = '无需登录即可浏览目录；要查看完整内容，需要登录后才能查看。';
    expect(isAffirmativeLoginGateText(text)).toBe(true);
  });

  it('真实门槛「需要登录才能查看的付费内容」仍判定', () => {
    expect(isAffirmativeLoginGateText('该文章是需要登录才能查看的付费内容。')).toBe(true);
  });

  it('仅在「不支持」语境下豁免列表中的登录描述', () => {
    expect(isAffirmativeLoginGateText('暂不支持\n\n- 需要登录才能查看的笔记')).toBe(false);
    expect(isAffirmativeLoginGateText('暂不支持需要登录才能查看的笔记')).toBe(false);
  });
});

describe('analyzeBlockProbe —— 登录墙检测（auth_wall）', () => {
  it('小红书未登录：200 页面 + 手机号登录输入 + 「登录探索」门槛文案 → auth_wall', () => {
    const signal = analyzeBlockProbe(probe({
      title: '小红书 - 你的生活兴趣社区',
      bodyText: '登录探索更多内容 输入手机号 父母离婚后。子女的婚礼真的很。。。',
      bodyLength: 400,
      httpStatus: 200,
      url: 'https://www.xiaohongshu.com/explore',
      pathname: '/explore',
      hasPhoneLoginInput: true,
    }));

    expect(signal.blocked).toBe(true);
    expect(signal.type).toBe('auth_wall');
    expect(signal.loginRequired).toBe(true);
    expect(signal.shouldUpgrade).toBe(false);
    // 登录墙不是反爬封禁，不应带 error_code（blocked/rate_limited 会误导升级逻辑）。
    expect(signal.error_code).toBeUndefined();
  });

  it('认证身份明确的登录对话框（role=dialog）→ auth_wall，即使无表单输入信号', () => {
    const signal = analyzeBlockProbe(probe({
      title: '内容社区',
      bodyText: '推荐 关注 发现',
      loginModalCandidates: [{
        dialog: true,
        authTitled: true,
        areaCoverageAvailable: false,
        horizontalCoverage: 0.8,
        utilityDock: true,
        hasPublicContent: false,
        form: false,
        fixed: false,
        coverage: 0.1,
      }],
    }));
    expect(signal.type).toBe('auth_wall');
    expect(signal.loginRequired).toBe(true);
  });

  it('无认证标题、无表单的登录 Dialog 仍保守判为 auth_wall', () => {
    const signal = analyzeBlockProbe(probe({
      title: '内容社区',
      bodyText: 'Sign in to continue',
      loginModalCandidates: [{ dialog: true, form: false, fixed: false, coverage: 0.1 }],
    }));
    expect(signal.type).toBe('auth_wall');
    expect(signal.loginRequired).toBe(true);
  });

  it('带多条辅助链接的 fixed 登录 Dialog 仍判为 auth_wall', () => {
    const signal = analyzeBlockProbe(probe({
      title: 'Sign in',
      bodyText: 'Sign in to continue Terms Privacy Help',
      loginModalCandidates: [{
        dialog: true,
        authTitled: false,
        hasPublicContent: true,
        form: false,
        fixed: true,
        coverage: 0.5,
      }],
    }));
    expect(signal.type).toBe('auth_wall');
  });

  it('非 fixed 的 OAuth 式 Dialog 即使含辅助链接也不因公开内容标记被放行', () => {
    const signal = analyzeBlockProbe(probe({
      title: 'Continue',
      bodyText: 'Sign in to continue Terms Privacy Help',
      loginModalCandidates: [{
        dialog: true,
        authTitled: false,
        // 模拟含三条辅助链接的非 fixed OAuth Dialog；它不是 Dock/Drawer。
        hasPublicContent: true,
        utilityDock: false,
        form: false,
        fixed: false,
        coverage: 0.5,
      }],
    }));
    expect(signal.type).toBe('auth_wall');
  });

  it('登录容器内有可见登录表单要素 → auth_wall', () => {
    const signal = analyzeBlockProbe(probe({
      title: '内容社区',
      bodyText: '推荐 关注 发现',
      loginModalCandidates: [{ dialog: false, form: true, fixed: false, coverage: 0.08 }],
    }));
    expect(signal.type).toBe('auth_wall');
    expect(signal.loginRequired).toBe(true);
  });

  it('fixed 定位 + 大面积视口遮罩（无表单，如二维码扫码浮层）→ auth_wall', () => {
    const signal = analyzeBlockProbe(probe({
      title: '内容社区',
      bodyText: '扫码下载 App',
      loginModalCandidates: [{ dialog: false, form: false, fixed: true, coverage: 0.85 }],
    }));
    expect(signal.type).toBe('auth_wall');
    expect(signal.loginRequired).toBe(true);
  });

  it('登录路由 URL（/passport/login）→ auth_wall', () => {
    const signal = analyzeBlockProbe(probe({
      title: '登录',
      bodyText: '账号 密码',
      url: 'https://passport.example.com/passport/login',
      pathname: '/passport/login',
    }));
    expect(signal.type).toBe('auth_wall');
  });

  it('登录字样 + 可见密码框 → auth_wall', () => {
    const signal = analyzeBlockProbe(probe({
      title: '登录 - 某站',
      bodyText: '欢迎登录',
      hasPasswordInput: true,
    }));
    expect(signal.type).toBe('auth_wall');
  });

  it('英文门槛文案 sign in to continue → auth_wall', () => {
    const signal = analyzeBlockProbe(probe({
      title: 'Feed',
      bodyText: 'Sign in to continue reading this article.',
    }));
    expect(signal.type).toBe('auth_wall');
    expect(signal.loginRequired).toBe(true);
  });

  it('「需要登录后才能查看」肯定门槛 → auth_wall（无弹窗软墙）', () => {
    const signal = analyzeBlockProbe(probe({
      bodyText: '需要登录后才能查看全文。以下为摘要……',
      bodyLength: 40,
    }));
    expect(signal.blocked).toBe(true);
    expect(signal.type).toBe('auth_wall');
    expect(signal.reason).toBe('内容需要登录后才能查看');
  });

  it('否定 FAQ + 真实「需要登录后才能查看」同页 → 仍 auth_wall', () => {
    const bodyText = '无需登录即可浏览目录；要查看完整内容，需要登录后才能查看。';
    const signal = analyzeBlockProbe(probe({
      title: '混合公开与受限',
      bodyText,
      bodyLength: bodyText.length,
      url: 'https://example.com/article',
      pathname: '/article',
    }));
    expect(signal.blocked).toBe(true);
    expect(signal.type).toBe('auth_wall');
    expect(signal.loginRequired).toBe(true);
    expect(signal.reason).toBe('内容需要登录后才能查看');
  });

  it('「该文章是需要登录才能查看的付费内容」→ auth_wall（不可被描述豁免吞掉）', () => {
    const bodyText = '该文章是需要登录才能查看的付费内容。';
    const signal = analyzeBlockProbe(probe({
      title: '付费文章',
      bodyText,
      bodyLength: bodyText.length,
      url: 'https://example.com/article',
      pathname: '/article',
    }));
    expect(signal.blocked).toBe(true);
    expect(signal.type).toBe('auth_wall');
    expect(signal.loginRequired).toBe(true);
  });
});

describe('analyzeBlockProbe —— 精度守护（不误报）', () => {
  it('公开主内容旁的非认证 Dock 含 Portfolio 登录 CTA → 不判登录墙（Yahoo 回归）', () => {
    const signal = analyzeBlockProbe(probe({
      title: 'Apple Inc. (AAPL) Stock Price',
      bodyText: [
        'Apple Inc. (AAPL) 333.02 +3.53% News headlines Financial Highlights',
        'Sign in to access your portfolio',
      ].join(' '),
      bodyLength: 2400,
      // Yahoo 的行情 Dock 使用 role=dialog/aria-modal，但主体是公开行情；
      // Portfolio 只是其中一个可选模块，并非当前 AAPL 内容的登录墙。
      loginModalCandidates: [{
        dialog: true,
        authTitled: false,
        hasPublicContent: true,
        utilityDock: true,
        form: false,
        fixed: false,
        coverage: 0.84,
      }],
      hasPageLevelLoginGate: false,
    }));

    expect(signal.blocked).toBe(false);
    expect(signal.type).not.toBe('auth_wall');
    expect(signal.loginRequired).toBeUndefined();
  });

  it('后台零视口中的公开 Dock 仍不判登录墙（Yahoo Agent 后台页回归）', () => {
    const backgroundDock = {
      dialog: true,
      authTitled: false,
      hasPublicContent: true,
      utilityDock: true,
      form: false,
      fixed: false,
      coverage: 0,
      viewportAvailable: false,
      horizontalCoverage: 0.69,
    } satisfies LoginModalCandidate;

    const signal = analyzeBlockProbe(probe({
      title: 'Apple Inc. (AAPL) Stock Price',
      bodyText: 'Apple Inc. (AAPL) Sign in to access your portfolio',
      bodyLength: 15194,
      loginModalCandidates: [backgroundDock],
      hasPageLevelLoginGate: false,
    }));

    expect(signal.blocked).toBe(false);
    expect(signal.type).not.toBe('auth_wall');
  });

  it('页头「登录」入口按钮（class 含 login、小尺寸、非 dialog、无表单）→ 不判登录墙（，36kr 案例）', () => {
    const signal = analyzeBlockProbe(probe({
      title: '36氪创投平台',
      bodyText: '登录 返回36氪 融资快报 融资事件 项目库 机构库 创业者认证 投资人认证',
      bodyLength: 3000,
      url: 'https://pitchhub.36kr.com/',
      pathname: '/',
      // 页头登录入口：命中 [class*="login"] 选择器 + 文本「登录」，但无任何墙特征
      loginModalCandidates: [{ dialog: false, form: false, fixed: false, coverage: 0.01 }],
    }));
    expect(signal.blocked).toBe(false);
    expect(signal.type).not.toBe('auth_wall');
  });

  it('静态大容器（class 含 login、覆盖全视口但非 fixed 遮罩、无表单）→ 不判登录墙', () => {
    const signal = analyzeBlockProbe(probe({
      title: '内容页',
      bodyText: '登录 正文内容完整可读……',
      bodyLength: 2000,
      loginModalCandidates: [{ dialog: false, form: false, fixed: false, coverage: 1 }],
    }));
    expect(signal.blocked).toBe(false);
  });

  it('正常内容页：页头只有「登录」链接、无登录表单/浮层/门槛文案 → 不判登录墙', () => {
    const signal = analyzeBlockProbe(probe({
      title: '一篇正常文章',
      bodyText: '登录 注册 首页 这是一篇讲浏览器自动化的长文，正文内容完整可读……',
      bodyLength: 1200,
    }));
    expect(signal.blocked).toBe(false);
    expect(signal.type).not.toBe('auth_wall');
  });

  it('普通页面带邮件订阅输入框（非手机号/密码）+ 页头登录链接 → 不误报', () => {
    const signal = analyzeBlockProbe(probe({
      title: '产品官网',
      bodyText: '登录 订阅我们的 newsletter 获取更新',
      bodyLength: 800,
      // 邮件订阅 input 既非 password 也非 phone，不构成登录表单强信号
    }));
    expect(signal.blocked).toBe(false);
  });

  it('完全正常页面 → NO_BLOCK', () => {
    const signal = analyzeBlockProbe(probe({
      title: 'Example Domain',
      bodyText: 'This domain is for use in illustrative examples.',
      bodyLength: 200,
    }));
    expect(signal.blocked).toBe(false);
    expect(signal.confidence).toBe(0);
  });

  it('FAQ「为什么不需要登录」→ 不判登录墙（dyxhsdownloader 否定门槛回归）', () => {
    const signal = analyzeBlockProbe(probe({
      title: '抖音小红书无水印下载',
      bodyText: [
        '粘贴分享链接或整段分享文案… 解析',
        '05为什么不需要登录？06用这个工具会被平台封号吗？',
      ].join(' '),
      bodyLength: 1200,
      url: 'https://dyxhsdownloader.com/',
      pathname: '/',
      // 探针未设 hasPageLevelLoginGate 时走 Node fallback，必须与脚本语义一致
    }));
    expect(signal.blocked).toBe(false);
    expect(signal.type).not.toBe('auth_wall');
    expect(signal.loginRequired).toBeUndefined();
  });

  it('下载器「暂不支持」列表下的登录描述 → 不判登录墙（dyxhs 正文回归）', () => {
    const bodyText = [
      '免费在线下载。完全免费。',
      '### 小红书',
      '暂不支持',
      '- 需要登录才能查看的笔记',
      '- 私密合集',
      '05为什么不需要登录？',
      '工具只解析公开可见的分享内容。',
    ].join('\n');
    const signal = analyzeBlockProbe(probe({
      title: '视频与图片下载',
      bodyText,
      bodyLength: bodyText.length,
      url: 'https://dyxhsdownloader.com/',
      pathname: '/',
    }));
    expect(signal.blocked).toBe(false);
    expect(signal.type).not.toBe('auth_wall');
  });

  it('「无需登录即可使用」→ 不判登录墙', () => {
    const signal = analyzeBlockProbe(probe({
      bodyText: '本工具免费，无需登录即可使用解析功能。',
      bodyLength: 80,
    }));
    expect(signal.blocked).toBe(false);
    expect(signal.type).not.toBe('auth_wall');
  });

  it('login not required → 不判登录墙', () => {
    const signal = analyzeBlockProbe(probe({
      bodyText: 'Download videos free. Login not required.',
      bodyLength: 80,
    }));
    expect(signal.blocked).toBe(false);
    expect(signal.type).not.toBe('auth_wall');
  });

  it('裸「需要登录」无完成语义 → 不判登录墙（收紧后）', () => {
    const signal = analyzeBlockProbe(probe({
      bodyText: '关于需要登录的说明见帮助中心。正文完整可读……',
      bodyLength: 400,
    }));
    expect(signal.blocked).toBe(false);
    expect(signal.type).not.toBe('auth_wall');
  });
});

describe('buildDetectionScript —— 注入脚本守护', () => {
  it('生成的脚本是合法 JavaScript（脚本为字符串，编译期查不出语法错）', () => {
    const script = buildDetectionScript(['#cf-wrapper']);
    // 只做语法构造（new Function 解析即抛 SyntaxError），不执行——node 环境无 DOM。
    expect(() => new Function(`return ${script}`)).not.toThrow();
    // 采集字段齐全（判定字段在纯函数侧，脚本只出事实）。
    expect(script).toContain('loginModalCandidates');
    expect(script).toContain('getBoundingClientRect');
    expect(script).toContain('authTitled');
    expect(script).toContain('hasPageLevelLoginGate');
    expect(script).toContain('hasPublicContent');
    expect(script).toContain('utilityDock');
    expect(script).toContain('collectPageGateText');
  });

  it('有视口但候选面积不可测时，公开 Dock 回退横向尺寸且不判登录墙', () => {
    const publicLink = (text: string) => ({
      offsetWidth: 40,
      offsetHeight: 16,
      innerText: text,
      getClientRects: () => [{}],
      getAttribute: (name: string) => (
        name === 'href' ? `/quote/${text}` : ''
      ),
    });
    const loginLink = {
      ...publicLink('Sign in'),
      getAttribute: (name: string) => (
        name === 'href' ? 'https://login.example.com/' : ''
      ),
    };
    const dock = {
      tagName: 'DIV',
      id: '',
      className: 'dock right',
      offsetWidth: 250,
      offsetHeight: 0,
      innerText: [
        'Trending tickers',
        'Apple Microsoft Bitcoin Ethereum',
        'Public market data and news '.repeat(12),
        'Portfolio Sign in to access your portfolio',
      ].join(' '),
      getClientRects: () => [{}],
      getAttribute: (name: string) => {
        if (name === 'role') return 'dialog';
        if (name === 'aria-modal') return 'true';
        if (name === 'aria-label') return 'Dock';
        if (name === 'class') return 'dock right';
        return '';
      },
      hasAttribute: () => false,
      querySelector: (selector: string) => (
        selector === 'h1,h2,h3,h4,[role="heading"]'
          ? { innerText: 'Trending Tickers' }
          : null
      ),
      querySelectorAll: (selector: string) => {
        if (selector === 'input') return [];
        if (selector === 'a[href]') {
          return [
            publicLink('AAPL'),
            publicLink('MSFT'),
            publicLink('BTC-USD'),
            loginLink,
          ];
        }
        return [];
      },
      getBoundingClientRect: () => ({
        width: 250,
        height: 0,
      }),
    };
    const body = {
      nodeType: 1,
      tagName: 'BODY',
      id: '',
      className: '',
      offsetWidth: 682,
      offsetHeight: 892,
      innerText: 'Apple Inc. (AAPL) public quote and financial news',
      scrollWidth: 682,
      firstChild: null,
      getAttribute: () => '',
      getClientRects: () => [{}],
    };
    const fakeDocument = {
      title: 'Apple Inc. (AAPL) Stock Price',
      body,
      documentElement: { scrollWidth: 682 },
      querySelector: () => null,
      querySelectorAll: (selector: string) => {
        if (selector === 'iframe' || selector === 'input') return [];
        if (
          selector === 'main'
          || selector === 'article'
          || selector === '[role="main"]'
        ) return [];
        if (selector.includes('[role="dialog"]')) return [dock];
        return [];
      },
    };
    const fakeWindow = {
      innerWidth: 681,
      innerHeight: 892,
      getComputedStyle: (node: unknown) => ({
        position: node === dock ? 'relative' : 'static',
        display: 'block',
        visibility: 'visible',
      }),
    };
    const runScript = new Function(
      'document',
      'window',
      'location',
      'performance',
      `return ${buildDetectionScript([])}`,
    );

    const pageProbe = runScript(
      fakeDocument,
      fakeWindow,
      {
        href: 'https://finance.example.com/quote/AAPL/',
        pathname: '/quote/AAPL/',
      },
      { getEntriesByType: () => [] },
    ) as PageProbe;

    expect(pageProbe.loginModalCandidates).toEqual([
      expect.objectContaining({
        dialog: true,
        authTitled: false,
        form: false,
        fixed: false,
        coverage: 0,
        viewportAvailable: true,
        areaCoverageAvailable: false,
        horizontalCoverage: 0.37,
        utilityDock: true,
        hasPublicContent: true,
      }),
    ]);
    expect(analyzeBlockProbe(pageProbe).blocked).toBe(false);
  });

  it('主内容门槛采集异常时回退正文检测，不把未知当作无门槛', () => {
    const primary = {
      nodeType: 1,
      tagName: 'MAIN',
      id: '',
      className: '',
      offsetWidth: 320,
      offsetHeight: 480,
      parentElement: null,
      firstChild: null,
      getAttribute: () => '',
      getClientRects: () => [],
    };
    const bodyText = 'Sign in to continue reading this article.';
    const fakeDocument = {
      title: 'Members only',
      body: {
        innerText: bodyText,
        scrollWidth: 320,
      },
      documentElement: { scrollWidth: 320 },
      querySelector: () => null,
      querySelectorAll: (selector: string) => {
        if (selector === 'main') return [primary];
        return [];
      },
    };
    const fakeWindow = {
      innerWidth: 320,
      innerHeight: 480,
      getComputedStyle: () => {
        throw new Error('style collection failed');
      },
    };
    const fakeLocation = {
      href: 'https://example.com/article',
      pathname: '/article',
    };
    const fakePerformance = {
      getEntriesByType: () => [],
    };
    const runScript = new Function(
      'document',
      'window',
      'location',
      'performance',
      `return ${buildDetectionScript([])}`,
    );

    const pageProbe = runScript(
      fakeDocument,
      fakeWindow,
      fakeLocation,
      fakePerformance,
    ) as PageProbe;
    const signal = analyzeBlockProbe(pageProbe);

    expect(signal.blocked).toBe(true);
    expect(signal.type).toBe('auth_wall');
    expect(signal.loginRequired).toBe(true);
  });
});

describe('analyzeBlockProbe —— 既有判定回归（登录墙不抢占）', () => {
  it('Cloudflare 挑战优先于登录墙（先过人机验证才谈登录）', () => {
    const signal = analyzeBlockProbe(probe({
      title: 'Just a moment...',
      bodyText: '请登录 login',
      cfSelectorHits: 1,
      hasChallengeIframe: true,
      // 即使叠了登录信号，CF 仍应先定性
      hasPasswordInput: true,
    }));
    expect(signal.type).toBe('cloudflare');
  });

  it('HTTP 403 + 业务权限文案（无登录表单信号）→ business_403', () => {
    const signal = analyzeBlockProbe(probe({
      title: 'Forbidden',
      bodyText: "You don't have permission to access this resource.",
      httpStatus: 403,
    }));
    expect(signal.blocked).toBe(true);
    expect(signal.type).toBe('business_403');
  });

  it('限流关键词 → rate_limit（不被登录墙抢占）', () => {
    const signal = analyzeBlockProbe(probe({
      title: 'Too Many Requests',
      bodyText: 'You have sent too many requests. Rate limit exceeded.',
      httpStatus: 429,
    }));
    expect(signal.type).toBe('rate_limit');
  });
});
