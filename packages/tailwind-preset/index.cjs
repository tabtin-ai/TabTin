/** @type {import('tailwindcss').Config} */
module.exports = {
  plugins: [
    /**
     * 容器查询插件（@container / @lg/name: / @[Npx]: 变体）。
     * Tailwind v3 不内置容器查询，必须注册官方插件才会产出对应 CSS，
     * 否则这些变体静默失效、只剩 hidden 等默认值生效（见 ）。
     * 放在共享 preset 里，让 Electron / tabtin-web / admindash 及共享 UI 包
     * （如 table-ui）统一可用，避免各 app 各自注册或漏注册。
     */
    require('@tailwindcss/container-queries'),
    /**
     * hover-device 变体：仅在支持精确指针悬停的设备（鼠标/触控板）上生效。
     * 用于"桌面端 hover 才显示操作按钮、触控端始终显示"的场景。
     */
    function ({ addVariant }) {
      addVariant('hover-device', '@media (hover: hover) and (pointer: fine)')
    },
    /**
     * 统一滚动条工具类，供所有使用 tailwind-preset 的包（Electron / tabtin-web / admindash）共用。
     * 三类按需选用：
     *   scrollbar-hidden — 完全隐藏（内容仍可滚动）
     *   scrollbar-thin  — 细滚动条，始终可见（适合侧边面板等需要位置提示的场景）
     *   scrollbar-hover — 默认隐藏，鼠标悬停容器时才显示（推荐，视觉更干净）
     *
     * 特殊场景不适用此方案：
     *   表格引擎 canvas 虚拟滚动条 → 用 .tt-grid-scrollbar + data-scrolling 属性
     *   Monaco 编辑器 → 用 .tabcode-editor opacity 覆盖
     */
    function ({ addUtilities }) {
      addUtilities({
        '.scrollbar-hidden': {
          '-ms-overflow-style': 'none',
          'scrollbar-width': 'none',
          '&::-webkit-scrollbar': { display: 'none' },
        },
        '.scrollbar-thin': {
          '&::-webkit-scrollbar': { width: '6px', height: '6px' },
          '&::-webkit-scrollbar-track': { background: 'transparent' },
          '&::-webkit-scrollbar-thumb': {
            background: 'hsl(var(--border))',
            'border-radius': '9999px',
          },
          '&::-webkit-scrollbar-thumb:hover': {
            background: 'hsl(var(--muted-foreground) / 0.6)',
          },
        },
        '.scrollbar-hover': {
          'scrollbar-width': 'thin',
          'scrollbar-color': 'transparent transparent',
          '&::-webkit-scrollbar': { width: '6px', height: '6px' },
          '&::-webkit-scrollbar-track': { background: 'transparent' },
          '&::-webkit-scrollbar-thumb': {
            'background-color': 'transparent',
            'border-radius': '9999px',
          },
          '&:hover': {
            'scrollbar-color': 'hsl(var(--border)) transparent',
          },
          '&:hover::-webkit-scrollbar-thumb': {
            'background-color': 'hsl(var(--border))',
          },
          '&:hover::-webkit-scrollbar-thumb:hover': {
            'background-color': 'hsl(var(--muted-foreground) / 0.6)',
          },
        },
      })
    },
  ],
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        // 正文阅读内容（Agent 回复主体）的最高对比文字色。比 `foreground` 强一档，
        // 用于把"主内容"与侧边栏/次要 chrome 的文字层级拉开。未定义 --content-foreground
        // 的 app（web/admindash）回退到 --foreground，零破坏。
        'foreground-strong': 'hsl(var(--content-foreground, var(--foreground)))',
        // 次正文档：介于 `foreground`（正文）与 `muted-foreground`（次文字）之间，
        // 用于表单 label、说明性正文等「次要但需清晰」的文字（design-system §3 文字层级）。
        // --foreground-secondary 由 color-mix 派生（见 globals.css）；未定义的 app
        // （web/admindash）回退到 --muted-foreground，零破坏。
        'foreground-secondary': 'var(--foreground-secondary, hsl(var(--muted-foreground)))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
          // 主题色用于文字/图标时的降饱和版本（design-system §6.8）：text-primary-text
          text: 'var(--primary-text)',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        success: {
          DEFAULT: 'hsl(var(--success))',
          foreground: 'hsl(var(--success-foreground))',
        },
        warning: {
          DEFAULT: 'hsl(var(--warning))',
          foreground: 'hsl(var(--warning-foreground))',
        },
        info: {
          DEFAULT: 'hsl(var(--info))',
          foreground: 'hsl(var(--info-foreground))',
        },
        // 数据可视化分类调色板（参考 shadcn/ui charts）：bg-chart-1 … bg-chart-5、text-chart-*。
        // 仅用于仪表盘图表（域内例外 design-system §16.2），不作 Shell 主色。
        chart: {
          1: 'hsl(var(--chart-1))',
          2: 'hsl(var(--chart-2))',
          3: 'hsl(var(--chart-3))',
          4: 'hsl(var(--chart-4))',
          5: 'hsl(var(--chart-5))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
          // 主题色用于文字/图标时的降饱和版本（design-system §6.8）：text-accent-text
          text: 'var(--accent-text)',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
      },
      fontSize: {
        'micro':    ['11px',     { lineHeight: '16px' }],
        'caption':  ['12px',     { lineHeight: '18px' }],
        'body':     ['14px',     { lineHeight: '22px' }],
        'subtitle': ['16px',     { lineHeight: '24px' }],
        'title':    ['20px',     { lineHeight: '28px' }],
        'heading':  ['24px',     { lineHeight: '32px' }],
        'display':  ['32px',     { lineHeight: '40px' }],
      },
      borderRadius: {
        interactive: 'var(--radius-interactive, 0.5rem)',
      },
      zIndex: {
        'sticky':       '10',
        'floating':     '20',
        'banner':       '30',
        'overlay':      '40',
        'modal':        '50',
        'dropdown':     '55',
        'toast':        '60',
        'global':       '9999',
        'above-global': '10000',
        'toast-host':   '10050',
      },
    },
  },
}
