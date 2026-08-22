/**
 * Static CLI command catalog for UI/capability discovery.
 *
 * Previously generated dynamically by @tabtin/cli via Commander introspection.
 * Now maintained as static data — the single source of truth for UI-visible
 * command metadata. The Go CLI (packages/tabtin-cli-go) owns the runtime
 * implementation of these commands.
 */

export interface CoreCliCommandCatalogEntry {
  name: string
  description: string
  examples: string[]
}

export const CORE_COMMAND_CATALOG: CoreCliCommandCatalogEntry[] = [
  {
    name: 'browser',
    description: '浏览器自动化操作',
    examples: ['home', 'open --url https://example.com', 'tab list', 'glance', 'glance --screenshot --save /tmp/page.png', 'print --save /tmp/page.md', 'resource list', 'session list'],
  },
  {
    name: 'tabsite',
    description: '站点操作 (TabSite)',
    examples: ['create "My Site"', 'list', 'info <site-id>', 'publish <site-id>', 'rollback <site-id> <version>'],
  },
  {
    name: 'device',
    description: '查询当前 Space 可用的设备能力',
    examples: ['info', 'battery', 'network'],
  },
  {
    name: 'space',
    description: 'Space 级数据入口与数据库能力',
    examples: ['list', 'use <space-id>', 'current', 'tables --space-id <space>', 'db-info --space-id <space>', 'db-connection --space-id <space>'],
  },
  {
    name: 'table',
    description: '已知表操作（推荐先用 space 发现目标表）',
    examples: ['--space-id <space> query <sql>', '--space-id <space> create <name>', 'records <table_id>', 'views <table_id>', 'view-column-meta-compat-summary'],
  },
  {
    name: 'speech',
    description: '语音识别 (ASR)',
    examples: ['recognize ./sample.wav', 'submit https://example.com/audio.mp3', 'query <task_id>', 'providers', 'tts "你好，世界"', 'voices'],
  },
  {
    name: 'audio',
    description: '语音与音频 (ASR/TTS)',
    examples: ['recognize ./sample.wav', 'submit https://example.com/audio.mp3', 'query <task_id>', 'providers', 'tts "你好，世界"', 'voices'],
  },
  {
    name: 'slide',
    description: '演示文稿操作',
    examples: ['create "Demo Deck"', 'list', 'outline <project_id>', 'page <project_id> <page_id>', 'preview <project_id>', 'export <project_id>'],
  },
  {
    name: 'media',
    description: '媒体生成（图片 / 视频）',
    examples: ['image "A futuristic city skyline"', 'video "A calm ocean at sunset"', 'status <task_id>', 'list', 'models', 'cancel <task_id>'],
  },
  {
    name: 'task',
    description: '异步任务状态查询与管理',
    examples: ['status <task_id>', 'list', 'cancel <task_id>'],
  },
  {
    name: 'image',
    description: '图像生成（文生图）',
    examples: ['gen "A futuristic city skyline"', 'status <task_id>', 'models', 'cancel <task_id>'],
  },
  {
    name: 'video',
    description: '视频管线（分析 / 裁切 / 模板 / 特效）',
    examples: [
      'analyze ./input.mp4', 'reframe ./input.mp4 --ratio 9:16', 'reframe ./input.mp4 --all',
      'gen "A calm ocean at sunset"', 'build ./scene-script.json', 'export ./project.json -o output.mp4',
      'edit reverse ./input.mp4', 'template list', 'template generate data-comparison --params \'{"datasets":[...]}\'',
      'effects list',
    ],
  },
  {
    name: 'subtitle',
    description: '字幕处理（翻译等）',
    examples: ['translate ./subtitles.srt --target-language en'],
  },
  {
    name: 'status',
    description: '查看 CLI 运行状态（Profile / 连接 / 认证 / Daemon）',
    examples: [''],
  },
  {
    name: 'doctor',
    description: '诊断 CLI 运行环境（连通性、认证、后端健康）',
    examples: [''],
  },
  {
    name: 'code',
    description: '代码工作区文件操作与搜索',
    examples: ['read src/App.tsx', 'glob "*.ts"', 'grep "function" -g "*.ts"', 'search "Where is auth handled?"', 'diagnostics', 'git-diff'],
  },
  {
    name: 'file',
    description: '本地文件生成 (xlsx/docx/pptx/pdf)',
    examples: ['create -t xlsx -o report.xlsx -s @spec.json', 'create -o deck.pptx -s @deck.json', 'create -t pdf -o out.pdf -s -'],
  },
  {
    name: 'desktop',
    description: '桌面操控（截屏、鼠标、键盘、窗口管理）',
    examples: ['screenshot', 'click 500 300', 'type "Hello World"', 'hotkey cmd c', 'scroll 500 300 --dy -3', 'windows', 'activate "Google Chrome"', 'open "Slack"'],
  },
  {
    name: 'terminal',
    description: '打开 / 管理 TabTin 应用内可交互终端',
    examples: ['open', 'open --cwd ~/projects/foo --title "项目终端"', 'list', 'open --session-id <id>'],
  },
  {
    name: 'capabilities',
    description: '工具与 Skill 发现（列表、详情、语义检索）',
    examples: ['list', 'show browser_console', 'categories', 'providers', 'discover "browser glance"'],
  },
  {
    name: 'agent',
    description: '与 AI Agent 对话',
    examples: ['ls', 'models', 'fork <session-id>'],
  },
  {
    name: 'skill',
    description: 'Skill 管理（列表、搜索、安装、卸载、启用/禁用）',
    examples: ['list --space-id <id>', 'search weather', 'install github --space-id <id>', 'remove github', 'info github', 'enable github --space-id <id>'],
  },
]
