/**
 * FullConversationFlowPreview — 整段对话体验（DEV 预览专用）
 *
 * 目的：把「子 Agent = 对话里的一个 step」这套语言**推广到整段对话**，模拟一次
 * 真实任务，从头到尾走一遍：用户提问 → 思考 → 文本 → 工具步（搜索 / 阅读 /
 * 运行 / 改动+diff）→ 子 Agent（字段版：任务·当前动作·模型）→ 待办清单 →
 * 高风险确认 → 失败→修复 → 最终回答。
 *
 * 统一规则（贯穿所有 step，不只是子 Agent）：
 *   - 一切都是 transcript 里的一行 step，顺着读就过去，没有边框卡片把它们框起来
 *   - 单色优先：状态靠字形（↻ ✓ ✗ ○），唯一语义色是「失败」
 *   - **点击 = 就地向下展开**看细节（diff / 命令输出 / 子对话），不是「打开到别处」。
 *     行尾的 chevron（›/⌄）就是「这条能展开」的信号；只有子 Agent 的展开区里
 *     才保留一个次要的「打开完整对话」链接。
 *   - 控制（取消 / 确认）是轻动作，不堆常驻按钮
 *
 * 纯视觉模拟，不接真实 store——用来体感「整段对话读起来顺不顺、乱不乱」。
 */

import React, { useState } from 'react'
import {
  Brain,
  Search,
  Terminal,
  Check,
  XCircle,
  Loader2,
  ChevronRight,
  ChevronDown,
  ArrowUpRight,
  ShieldAlert,
  ListChecks,
} from 'lucide-react'
import { cn } from '@utils/cn'
// 文件类型图标复用 TabCode 的图标系统（与 FileCardHeader 同源）
import { FileIcon } from '@components/shared/file-icon/FileIcon'
// diff 增删的红绿是「信息本身」（语义承载），走设计 token 统一出口取色
import { DIFF, TEXT } from '../registry/chatDesignTokens'
import { basename } from '../utils/path'
// 语法高亮复用与真实 DiffCard / CodeBlock 同一份共享工具（lowlight + .tabtin-code-hl 主题）
import { HighlightedCode } from '../utils/highlightCode'

/* ─── 对话基元 ───────────────────────────────────────────────────────── */

const UserBubble: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="flex justify-end">
    <div className="max-w-[80%] rounded-2xl bg-muted/40 px-3.5 py-2 text-body text-foreground/90">
      {children}
    </div>
  </div>
)

const Prose: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <p className="text-body leading-relaxed text-foreground/90">{children}</p>
)

/** 展开后的细节体：缩进对齐到正文（图标宽度之后），安静、无边框、无竖线 */
const ExpandBody: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="ml-[1.375rem] mb-1 mt-0.5 space-y-1">{children}</div>
)

/** 代码 / 命令输出：极轻底色（非边框），等宽小字 */
const OutputBlock: React.FC<{ lines: string[] }> = ({ lines }) => (
  <div className="rounded-md bg-muted/20 px-2.5 py-1.5">
    {lines.map((l, i) => (
      <div
        key={i}
        className="whitespace-pre-wrap break-all font-mono text-caption leading-relaxed text-muted-foreground/60"
      >
        {l}
      </div>
    ))}
  </div>
)

/** 展开信号：能展开就给个 chevron（›→⌄），表示「就地向下展开」 */
const Disclosure: React.FC<{ open: boolean }> = ({ open }) =>
  open ? (
    <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground/40" />
  ) : (
    <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/40 transition-colors group-hover:text-muted-foreground/60" />
  )

const Thought: React.FC<{ children: React.ReactNode; detail?: React.ReactNode }> = ({ children, detail }) => {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <div
        role={detail ? 'button' : undefined}
        onClick={detail ? () => setOpen((o) => !o) : undefined}
        className={cn(
          'group flex items-center gap-1.5 py-0.5 text-body text-muted-foreground/60',
          detail && 'cursor-pointer rounded-md pr-2 transition-colors hover:bg-muted/20',
        )}
      >
        <Brain className="h-3 w-3 shrink-0 text-muted-foreground/40" />
        <span>{children}</span>
        {detail && <span className="ml-auto"><Disclosure open={open} /></span>}
      </div>
      {open && detail && <ExpandBody>{detail}</ExpandBody>}
    </div>
  )
}

/* 通用工具步：图标 + 动词（灰）+ 对象（foreground）+ 结果（右，灰）+ 就地展开。
 * 涉及文件时传 fileName → 显示 TabCode 文件类型图标，否则用 lucide Icon。 */
const StepRow: React.FC<{
  Icon?: React.ComponentType<{ className?: string }>
  fileName?: string
  verb: string
  object?: string
  meta?: React.ReactNode
  running?: boolean
  detail?: React.ReactNode
}> = ({ Icon, fileName, verb, object, meta, running, detail }) => {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <div
        role={detail ? 'button' : undefined}
        onClick={detail ? () => setOpen((o) => !o) : undefined}
        className={cn(
          'group flex items-center gap-2 rounded-md py-0.5 pr-2 transition-colors',
          detail && 'cursor-pointer hover:bg-muted/20',
        )}
      >
        {running ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground/60" />
        ) : fileName ? (
          <FileIcon fileName={fileName} className="h-3.5 w-3.5 shrink-0" />
        ) : Icon ? (
          <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
        ) : null}
        <span className="shrink-0 text-body text-muted-foreground/60">{verb}</span>
        {object && <span className="min-w-0 truncate text-body text-foreground/90">{object}</span>}
        {meta && <span className="ml-auto shrink-0 text-caption text-muted-foreground/40 tabular-nums">{meta}</span>}
        {detail && <span className={meta ? 'ml-1' : 'ml-auto'}><Disclosure open={open} /></span>}
      </div>
      {open && detail && <ExpandBody>{detail}</ExpandBody>}
    </div>
  )
}

/* diff 行：+adds / −dels 用透明度区分（不用红绿）；点击就地展开 hunk */
const DiffRow: React.FC<{
  Icon?: React.ComponentType<{ className?: string }>
  fileName?: string
  verb: string
  file: string
  adds?: number
  dels?: number
  detail?: React.ReactNode
}> = ({ Icon, fileName, verb, file, adds, dels, detail }) => {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <div
        role={detail ? 'button' : undefined}
        onClick={detail ? () => setOpen((o) => !o) : undefined}
        className={cn(
          'group flex items-center gap-2 rounded-md py-0.5 pr-2 transition-colors',
          detail && 'cursor-pointer hover:bg-muted/20',
        )}
      >
        {fileName ? (
          <FileIcon fileName={fileName} className="h-3.5 w-3.5 shrink-0" />
        ) : Icon ? (
          <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
        ) : null}
        <span className="shrink-0 text-body text-muted-foreground/60">{verb}</span>
        <span className="min-w-0 truncate text-body text-foreground/90">{file}</span>
        <span className="ml-auto shrink-0 text-caption tabular-nums">
          {adds ? <span className="text-muted-foreground/60">+{adds}</span> : null}
          {adds && dels ? ' ' : null}
          {dels ? <span className="text-muted-foreground/40">−{dels}</span> : null}
        </span>
        {detail && <span className="ml-1"><Disclosure open={open} /></span>}
      </div>
      {open && detail && <ExpandBody>{detail}</ExpandBody>}
    </div>
  )
}

/* ─── 验收面 1：代码变更（diff）——沿用旧 DiffCard 的 DNA，但默认摊开 ───────
 *
 * 设计哲学：diff 是「要验收的产出物」，不是过程——所以**默认就摊开**
 * 让你当场读，而不是藏在一次点击后面。大改动才 cap + 「展开剩余 N 行」。
 * 红绿是信息本身（走 DIFF token），文件名 + +/- 在头部。整体仍是克制的浅描边面。
 */
const DIFF_PREVIEW_CAP = 8

const DiffLine: React.FC<{ kind: 'add' | 'del'; num: number; text: string; lang: string }> = ({ kind, num, text, lang }) => (
  <div className={cn('flex', TEXT.code, 'leading-[18px] px-2.5', kind === 'add' ? DIFF.addBg : DIFF.removeBg)}>
    <span className="w-8 shrink-0 select-none pr-1 text-right tabular-nums text-muted-foreground/40">{num}</span>
    <span className={cn('w-4 shrink-0 select-none text-center', kind === 'add' ? DIFF.addText : DIFF.removeText)}>
      {kind === 'add' ? '+' : '-'}
    </span>
    {/* 代码本身走语法高亮（不再被染成统一红绿），红绿只留在背景 + 行首标记 */}
    <span className="min-w-0 whitespace-pre-wrap break-all">
      <HighlightedCode code={text} lang={lang} />
    </span>
  </div>
)

const FlowDiff: React.FC<{
  verb: string
  file: string
  lang?: string
  startLine?: number
  oldLines?: string[]
  newLines?: string[]
}> = ({ verb, file, lang = 'typescript', startLine = 1, oldLines = [], newLines = [] }) => {
  const [showAll, setShowAll] = useState(false)
  const total = oldLines.length + newLines.length
  const capped = total > DIFF_PREVIEW_CAP && !showAll
  const visOld = capped ? oldLines.slice(0, Math.min(oldLines.length, Math.ceil(DIFF_PREVIEW_CAP / 2))) : oldLines
  const remainAfterOld = DIFF_PREVIEW_CAP - visOld.length
  const visNew = capped ? newLines.slice(0, Math.max(0, remainAfterOld)) : newLines
  const hidden = total - (visOld.length + visNew.length)

  return (
    <div className="my-0.5 overflow-hidden rounded-md border border-border/40">
      <div className="flex items-center gap-2 bg-muted/20 px-2.5 py-1">
        <FileIcon fileName={basename(file)} className="h-3.5 w-3.5 shrink-0" />
        <span className="shrink-0 text-body text-muted-foreground/60">{verb}</span>
        <span className="min-w-0 truncate text-body text-foreground/90">{file}</span>
        <span className="ml-auto shrink-0 text-caption tabular-nums">
          {newLines.length > 0 && <span className={DIFF.addText}>+{newLines.length}</span>}
          {newLines.length > 0 && oldLines.length > 0 ? ' ' : null}
          {oldLines.length > 0 && <span className={DIFF.removeText}>-{oldLines.length}</span>}
        </span>
      </div>
      {/* tabtin-code-hl 作为 hljs 主题色彩作用域（与真实 DiffCard/CodeBlock 同一作用域） */}
      <div className="tabtin-code-hl">
        {visOld.map((l, i) => <DiffLine key={`o${i}`} kind="del" num={startLine + i} text={l} lang={lang} />)}
        {visNew.map((l, i) => <DiffLine key={`n${i}`} kind="add" num={startLine + i} text={l} lang={lang} />)}
      </div>
      {(capped || showAll) && total > DIFF_PREVIEW_CAP && (
        <button
          type="button"
          onClick={() => setShowAll((s) => !s)}
          className="flex w-full items-center gap-1 px-2.5 py-1 text-caption text-muted-foreground/60 transition-colors hover:bg-muted/20"
        >
          {showAll ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          {showAll ? '收起' : `展开剩余 ${hidden} 行`}
        </button>
      )}
    </div>
  )
}

/* ─── 验收面 2：终端——沿用旧 TerminalCard 的 DNA，但失败摊开 / 成功折叠 ──────
 *
 * 哲学：终端输出是「证据」。失败时第一时间要看到报错 → **默认摊开**；成功就
 * 一行状态，想看再展开。stderr 红、状态用语义色，其余单色。
 */
const FlowTerminal: React.FC<{
  command: string
  exitCode: number
  stdout?: string[]
  stderr?: string[]
}> = ({ command, exitCode, stdout = [], stderr = [] }) => {
  // ⚠️ DEV 预览专用简化：真实卡片（TerminalCard）已不再凭退出码判失败——退出码非零
  // （du / grep / build）属正常结束、显示「已完成」，失败以执行层 exited_by / status 为准。
  // 此处仅为视觉 demo 保留 exit≠0 → 失败的简单分支以演示「失败摊开」形态，不接真实数据。
  const failed = exitCode !== 0
  const [open, setOpen] = useState(failed) // 失败默认展开，成功默认折叠
  const hasOutput = stdout.length > 0 || stderr.length > 0
  return (
    <div className="my-0.5 overflow-hidden rounded-md border border-border/40">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 bg-muted/20 px-2.5 py-1 text-left transition-colors hover:bg-muted/30"
      >
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground/40" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/40" />
        )}
        <Terminal className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
        <span className={cn('min-w-0 flex-1 truncate', TEXT.code, 'text-foreground/80')}>$ {command}</span>
        <span className={cn('shrink-0 font-mono', TEXT.meta, failed ? 'text-destructive/80' : 'text-muted-foreground/40')}>
          {failed ? '失败：命令执行失败' : '已完成'}
        </span>
      </button>
      {open && hasOutput && (
        <div className={cn('bg-muted/10 px-2.5 py-1.5', TEXT.code, 'leading-relaxed')}>
          {stdout.map((l, i) => (
            <div key={`out${i}`} className="whitespace-pre-wrap break-all text-muted-foreground/60">{l}</div>
          ))}
          {stderr.map((l, i) => (
            <div key={`err${i}`} className="whitespace-pre-wrap break-all text-destructive/80">{l}</div>
          ))}
        </div>
      )}
    </div>
  )
}

/* 子 Agent 字段行：任务 + 模型 + 当前动作；点击就地展开子对话片段 */
const SubagentRow: React.FC<{
  status: 'running' | 'completed' | 'failed'
  task: string
  model: string
  action: string
  detail?: React.ReactNode
}> = ({ status, task, model, action, detail }) => {
  const [open, setOpen] = useState(false)
  const Glyph = status === 'completed' ? Check : status === 'failed' ? XCircle : Loader2
  const glyphTone =
    status === 'failed' ? 'text-destructive/80' : status === 'completed' ? 'text-muted-foreground/40' : 'text-muted-foreground/60'
  return (
    <div>
      <div
        role={detail ? 'button' : undefined}
        onClick={detail ? () => setOpen((o) => !o) : undefined}
        className={cn(
          'group flex items-start gap-2 rounded-md py-1 pr-2 transition-colors',
          detail && 'cursor-pointer hover:bg-muted/20',
        )}
      >
        <Glyph className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', glyphTone, status === 'running' && 'animate-spin')} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="min-w-0 truncate text-body text-foreground/90">{task}</span>
            <span className="ml-auto shrink-0 text-caption text-muted-foreground/60">{model}</span>
            {detail && <Disclosure open={open} />}
          </div>
          <div className="mt-0.5 text-caption text-muted-foreground/60">
            <span className={status === 'failed' ? 'text-destructive/80' : undefined}>{action}</span>
          </div>
        </div>
      </div>
      {open && detail && (
        <div className="ml-[1.375rem] mb-1 mt-0.5 space-y-1">
          {detail}
          <button
            type="button"
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center gap-1 text-caption text-muted-foreground/60 transition-colors hover:text-foreground"
          >
            打开完整对话
            <ArrowUpRight className="h-3 w-3" />
          </button>
        </div>
      )}
    </div>
  )
}

/* 待办清单：待办清单——带标题 + 计数的可折叠块，
   行内 ○ 待办 → ↻ 进行 → ✓ 完成；完成项灰 + 删除线。 */
type TodoStatus = 'todo' | 'doing' | 'done'

const TodoRow: React.FC<{ status: TodoStatus; text: string }> = ({ status, text }) => {
  const Glyph = status === 'done' ? Check : status === 'doing' ? Loader2 : null
  return (
    <div className="flex items-center gap-2 px-2 py-0.5">
      {Glyph ? (
        <Glyph
          className={cn(
            'h-3.5 w-3.5 shrink-0',
            status === 'done' ? 'text-muted-foreground/40' : 'text-muted-foreground/60',
            status === 'doing' && 'animate-spin',
          )}
        />
      ) : (
        <span className="h-3.5 w-3.5 shrink-0 rounded-full border border-muted-foreground/40" />
      )}
      <span
        className={cn(
          'text-body',
          status === 'done' ? 'text-muted-foreground/40 line-through' : 'text-foreground/90',
        )}
      >
        {text}
      </span>
    </div>
  )
}

const TodoBlock: React.FC<{ items: { status: TodoStatus; text: string }[] }> = ({ items }) => {
  const [open, setOpen] = useState(true)
  return (
    <div className="rounded-lg bg-muted/20 px-1 py-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-muted/20"
      >
        <ListChecks className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
        <span className="text-body text-foreground/90">待办</span>
        <span className="text-caption text-muted-foreground/40 tabular-nums">{items.length}</span>
        <span className="ml-auto"><Disclosure open={open} /></span>
      </button>
      {open && (
        <div className="pb-0.5">
          {items.map((it) => (
            <TodoRow key={it.text} status={it.status} text={it.text} />
          ))}
        </div>
      )}
    </div>
  )
}

/* 高风险确认：唯一允许的小色面（轻量、非状态卡），按钮是文字按钮 */
const ApprovalInline: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="rounded-lg bg-muted/30 px-3 py-2">
    <div className="flex items-center gap-2 text-body text-foreground/90">
      <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
      <span className="min-w-0">{children}</span>
    </div>
    <div className="mt-2 flex items-center gap-2">
      <button
        type="button"
        className="rounded-md border border-border/60 px-2.5 py-1 text-caption text-foreground/90 transition-colors hover:bg-muted/40"
      >
        允许一次
      </button>
      <button
        type="button"
        className="rounded-md px-2.5 py-1 text-caption text-muted-foreground/60 transition-colors hover:bg-muted/40"
      >
        总是允许
      </button>
      <button
        type="button"
        className="rounded-md px-2.5 py-1 text-caption text-muted-foreground/60 transition-colors hover:bg-muted/40"
      >
        拒绝
      </button>
    </div>
  </div>
)

const StepGroup: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="my-0.5">{children}</div>
)

/* 子对话片段（子 Agent 展开后就地 peek） */
const MiniLine: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="text-caption text-muted-foreground/60">{children}</div>
)

/* ─── 整段对话 ───────────────────────────────────────────────────────── */

export const FullConversationFlowPreview: React.FC = () => (
  <div className="space-y-3">
    <UserBubble>把子 Agent 那张卡片换成我们刚定的对话内形态，弄完跑一下测试和 lint</UserBubble>

    <div className="space-y-2">
      <Thought detail={<MiniLine>旧卡片是「状态面板」式：边框 + 头部计数 + 取消全部。目标是把它变成对话里的 step 流。先定位实现，再分工重写 + 补测试。</MiniLine>}>
        思考 8 秒
      </Thought>
      <Prose>先摸清现状：找到旧的聚合卡片实现，看看它怎么渲染的，再动手。</Prose>

      <StepGroup>
        <StepRow
          Icon={Search}
          verb="搜索"
          object="“SubagentAggregateView”"
          meta="命中 6 处"
          detail={
            <OutputBlock
              lines={[
                'blocks/BlockTimeline.tsx:36',
                'ChatComponentPreview.tsx:20',
                'SubagentAggregateView.tsx:492',
                'useSubagentRuns.ts:14  …共 6 处',
              ]}
            />
          }
        />
        <StepRow
          fileName="SubagentAggregateView.tsx"
          verb="阅读"
          object="SubagentAggregateView.tsx"
          detail={
            <OutputBlock
              lines={[
                '492  export const SubagentAggregateView = ({ runs }) => {',
                '493    const counts = countByStatus(runs)',
                '494    return (',
                '495      <div className={cn(CARD_RADIUS, "border …")}>  // 聚合卡外壳',
                '…  （read_file 返回的是文件原文，不是「总行数」这种统计字段）',
              ]}
            />
          }
        />
      </StepGroup>

      <Prose>
        现在是一张带边框、有头部计数和「取消全部」按钮的聚合卡。我并行派两个子 Agent：一个重写组件，一个补测试。
      </Prose>

      <StepGroup>
        <SubagentRow
          status="completed"
          task="把聚合卡重写成对话内形态"
          model="claude-4-sonnet"
          action="完成"
          detail={
            <>
              <MiniLine>阅读 SubagentAggregateView.tsx · 提取字段</MiniLine>
              <MiniLine>新建 SubagentConversationForm.tsx · step 行形态</MiniLine>
              <MiniLine>结论：去掉边框 / 计数器 / 竖线，任务·动作·模型三字段</MiniLine>
            </>
          }
        />
        <SubagentRow
          status="completed"
          task="补充渲染快照测试"
          model="gpt-5-mini"
          action="完成"
          detail={
            <>
              <MiniLine>写 SubagentConversationForm.test.tsx</MiniLine>
              <MiniLine>运行 vitest -t snapshot · 生成 3 个快照</MiniLine>
            </>
          }
        />
      </StepGroup>

      <Prose>两个子任务回来了。改动落到这几个文件（diff 默认摊开，这是要验收的产出）：</Prose>

      <StepGroup>
        <FlowDiff
          verb="新建"
          file="SubagentConversationForm.tsx"
          lang="typescript"
          startLine={1}
          newLines={[
            "export const SubagentConversationForm = ({ state }) => (",
            "  <div className=\"space-y-2\">",
            "    <Thought>思考 6 秒</Thought>",
            "    <Prose>先并行派几个子任务…</Prose>",
            "    {steps.map(s => <SubagentStep key={s.id} step={s} />)}",
            "    <Prose>{closing}</Prose>",
            "  </div>",
            ")",
            "",
            "const SubagentStep = ({ step }) => { … }",
            "const statusGlyph = (status) => { … }",
            "// …余下实现",
          ]}
        />
        <FlowDiff
          verb="改"
          file="ChatComponentPreview.tsx"
          lang="typescript"
          startLine={341}
          oldLines={["<SubagentAggregateView runs={runs} />"]}
          newLines={["<SubagentConversationForm state=\"done\" />"]}
        />
      </StepGroup>

      <Prose>旧的聚合卡组件可以删了，这步有点重，先跟你确认：</Prose>

      <ApprovalInline>
        删除旧组件 <span className="font-medium text-foreground">SubagentAggregateView.tsx</span>（已确认无引用）
      </ApprovalInline>

      <StepGroup>
        <DiffRow
          fileName="SubagentAggregateView.tsx"
          verb="删除"
          file="SubagentAggregateView.tsx"
          detail={<OutputBlock lines={['已删除 · 删除前确认无引用（delete_file 只回 path，不带行数）']} />}
        />
      </StepGroup>

      <Prose>更新一下计划，跑收尾检查：</Prose>

      <StepGroup>
        <TodoBlock
          items={[
            { status: 'done', text: '重写组件为对话内形态' },
            { status: 'done', text: '接入预览页' },
            { status: 'doing', text: '跑测试与 lint' },
          ]}
        />
      </StepGroup>

      <StepGroup>
        <FlowTerminal
          command="pnpm test"
          exitCode={1}
          stderr={[
            'FAIL  SubagentConversationForm.test.tsx',
            ' ● 快照不匹配：新结构改了 DOM',
            'Tests: 1 failed, 42 passed',
          ]}
        />
      </StepGroup>

      <Prose>失败的输出直接摊在眼前——快照过期了，内容没问题，更新快照重跑。</Prose>

      <StepGroup>
        <FlowDiff
          verb="改"
          file="__snapshots__/SubagentConversationForm.snap"
          lang="xml"
          startLine={12}
          oldLines={['<div class="aggregate-card">']}
          newLines={['<div class="conversation-step">']}
        />
        <FlowTerminal
          command="pnpm test"
          exitCode={0}
          stdout={['Test Files  12 passed (12)', 'Tests  43 passed (43)']}
        />
        <StepRow Icon={Check} verb="运行" object="lint" meta="已完成" />
      </StepGroup>

      <Prose>
        搞定。子 Agent 卡片已经换成对话内形态：任务 / 当前动作 / 模型三个字段顺着对话往下读，跑完沉淀成一句话，失败才标红，行内不再有竖线和计数器。测试 43 全过、lint 干净，旧聚合卡已删。
      </Prose>
      <Prose>
        体感一下整段：每条 step 都能就地向下展开看细节（diff / 输出 / 子对话），不跳走、不开新场所——你觉得这条流读下来顺吗？
      </Prose>
    </div>
  </div>
)

FullConversationFlowPreview.displayName = 'FullConversationFlowPreview'
