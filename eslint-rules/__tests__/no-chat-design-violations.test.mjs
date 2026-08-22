import { RuleTester } from 'eslint'
import rule from '../no-chat-design-violations.js'

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
})

ruleTester.run('no-chat-design-violations', rule, {
  valid: [
    // 语义 token 完全合规
    { name: '语义色 token', code: `const x = 'text-success/80'` },
    { name: '正常 muted', code: `const x = 'text-muted-foreground/60'` },
    { name: '语义字号', code: `const x = 'text-body font-medium'` },
    { name: '不带后缀的 muted', code: `const x = 'text-muted-foreground hover:text-foreground'` },
    // /80 也合规
    { name: 'foreground /80', code: `const x = 'text-foreground/80 break-words'` },
    // success / accent / primary 的色面**不查**（chip / TodoCard 等小面合理）
    { name: 'bg-success/10 在 chip 场景合法', code: `const x = 'rounded-md bg-success/10 text-success'` },
    { name: 'bg-accent/10 输入气泡合法', code: `const x = 'bg-accent/[0.08] rounded-2xl'` },
    { name: 'bg-primary/10 dialog 主按钮 hover 合法', code: `const x = 'hover:bg-primary/10'` },
    // /5 是 tonal hint，不查
    { name: 'bg-warning/5 装饰提示合法', code: `const x = 'rounded-md bg-warning/5'` },
    { name: 'bg-destructive/5 装饰提示合法', code: `const x = 'rounded-md bg-destructive/5'` },
    // 非 className 字符串里出现违规模式不报（譬如 i18n key、注释字面）—— 但实际 lint
    // 也会触发，只能靠位置上下文判断；测试用例只验证规则本身的 string-level 行为
    // tracking/leading 等修饰类不触发
    { name: 'tracking-wider 不触发', code: `const x = 'text-caption font-medium tracking-wider uppercase'` },
  ],
  invalid: [
    // 1. 硬编码 Tailwind 原色
    {
      name: 'text-red-500',
      code: `const x = 'text-red-500 font-medium'`,
      errors: [{ messageId: 'rawColor' }],
    },
    {
      name: 'bg-green-50',
      code: `const x = 'bg-green-50 dark:bg-green-900/10'`,
      errors: [{ messageId: 'rawColor' }],
    },
    {
      name: 'border-amber-500',
      code: `const x = 'border-amber-500/40 ring-1'`,
      errors: [{ messageId: 'rawColor' }],
    },
    // 2. 违规透明度 /50 /70
    {
      name: 'text-muted-foreground/70',
      code: `const x = 'text-muted-foreground/70'`,
      errors: [{ messageId: 'badOpacity' }],
    },
    {
      name: 'text-foreground/50',
      code: `const x = 'text-foreground/50'`,
      errors: [{ messageId: 'badOpacity' }],
    },
    {
      name: 'bg-muted/70',
      code: `const x = 'hover:bg-muted/70'`,
      errors: [{ messageId: 'badOpacity' }],
    },
    {
      name: 'border-destructive/50',
      code: `const x = 'border-destructive/50 ring-destructive/30'`,
      errors: [{ messageId: 'badOpacity' }],
    },
    // 3. 设计系统禁用字号
    {
      name: 'text-xs',
      code: `const x = 'text-xs font-medium'`,
      errors: [{ messageId: 'rawFontSize' }],
    },
    {
      name: 'text-2xl',
      code: `const x = 'text-2xl font-semibold'`,
      errors: [{ messageId: 'rawFontSize' }],
    },
    // 4. 像素 / em 硬编码字号
    {
      name: 'text-[10px]',
      code: `const x = 'text-[10px] leading-none'`,
      errors: [{ messageId: 'pixelFontSize' }],
    },
    {
      name: 'text-[0.85em]',
      code: `const x = '[&_code]:text-[0.85em]'`,
      errors: [{ messageId: 'pixelFontSize' }],
    },
    // 5. 警示色容器面（destructive / warning + /8 /10 /15 /20）
    {
      name: 'bg-destructive/10 整片色面',
      code: `const x = 'rounded-md bg-destructive/10 px-2'`,
      errors: [{ messageId: 'semanticBgFace' }],
    },
    {
      name: 'bg-warning/10 整片色面',
      code: `const x = 'border bg-warning/10 px-3 py-2'`,
      errors: [{ messageId: 'semanticBgFace' }],
    },
    {
      name: 'bg-warning/15 中等饱和度面',
      code: `const x = 'bg-warning/15 text-warning'`,
      errors: [{ messageId: 'semanticBgFace' }],
    },
    {
      name: 'bg-destructive/8 dogfood 期出现的小整数面',
      code: `const x = 'bg-destructive/8 text-destructive'`,
      errors: [{ messageId: 'semanticBgFace' }],
    },
    // 5. 模板字符串里命中（确认 TemplateElement visitor 正常）
    {
      name: '模板字符串静态片段命中 text-red-500',
      code: 'const x = `flex text-red-500 ${tone}`',
      errors: [{ messageId: 'rawColor' }],
    },
    {
      name: '模板字符串静态片段命中 /70',
      code: 'const x = `text-muted-foreground/70 ${suffix}`',
      errors: [{ messageId: 'badOpacity' }],
    },
  ],
})

console.log('no-chat-design-violations.test.mjs ✓')
