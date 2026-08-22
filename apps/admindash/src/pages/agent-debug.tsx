import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { AgentExecution } from '@/types/agent'
import { Clock, Hash, Pause, Play, RotateCcw, Search, Terminal } from 'lucide-react'
import { useState } from 'react'

// 模拟数据 (保持不变)
const mockExecutions: AgentExecution[] = [
  {
    id: 'exec-001',
    startTime: '2024-12-24 10:30:00',
    endTime: '2024-12-24 10:30:05',
    status: 'completed',
    prompt: '分析知乎页面的文章列表结构',
    response: '已成功提取15条文章数据',
    context: {
      url: 'https://www.zhihu.com/explore',
      browserVersion: 'Chrome 120',
    },
    steps: [
      {
        id: 'step-001',
        timestamp: '10:30:00',
        node: 'analyze',
        type: 'thought',
        content: '开始分析页面DOM结构，寻找文章列表容器',
        metadata: { confidence: 0.95 },
      },
      {
        id: 'step-002',
        timestamp: '10:30:01',
        node: 'extract',
        type: 'action',
        content: '执行XPath查询: //div[@class="List-item"]',
        metadata: { xpath: '//div[@class="List-item"]' },
      },
      {
        id: 'step-003',
        timestamp: '10:30:02',
        node: 'extract',
        type: 'observation',
        content: '找到15个匹配节点',
        metadata: { count: 15 },
      },
      {
        id: 'step-004',
        timestamp: '10:30:03',
        node: 'validate',
        type: 'decision',
        content: '数据验证通过，继续提取字段',
        metadata: { validationPassed: true },
      },
    ],
  },
  {
    id: 'exec-002',
    startTime: '2024-12-24 10:35:00',
    status: 'running',
    prompt: '爬取淘宝商品列表并提取价格',
    context: {
      url: 'https://www.taobao.com',
      browserVersion: 'Chrome 120',
    },
    steps: [
      {
        id: 'step-005',
        timestamp: '10:35:00',
        node: 'analyze',
        type: 'thought',
        content: '检测反爬虫机制...',
        metadata: {},
      },
    ],
  },
]

export function AgentDebugPage() {
  const [selectedExecution, setSelectedExecution] = useState<AgentExecution | null>(
    mockExecutions[0]
  )

  return (
    <div className="panel-container">
      {/* 顶部工具栏 */}
      <div className="flex h-12 items-center justify-between border-b px-4">
        <div className="flex items-center gap-2">
          <Terminal className="h-5 w-5 text-muted-foreground" />
          <h1 className="font-semibold">Agent Debugger</h1>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center rounded-md border bg-muted/50 px-2 py-1">
            <Search className="mr-2 h-4 w-4 text-muted-foreground" />
            <input
              className="bg-transparent text-body focus:outline-none w-64"
              placeholder="搜索 Prompt 或 ID..."
            />
          </div>
          <div className="h-4 w-px bg-border mx-1" />
          <Button variant="ghost" size="icon" className="h-8 w-8">
            <Play className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8">
            <Pause className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8">
            <RotateCcw className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* 主面板区域 */}
      <div className="split-view flex-1 overflow-hidden">
        {/* 左侧：执行列表 */}
        <div className="flex min-h-0 flex-col bg-muted/10">
          <div className="panel-header text-body uppercase tracking-wider text-muted-foreground">
            Execution History
          </div>
          <ScrollArea className="flex-1">
            <div className="divide-y border-b">
              {mockExecutions.map((execution) => (
                <button
                  type="button"
                  key={execution.id}
                  onClick={() => setSelectedExecution(execution)}
                  className={`w-full p-3 text-left transition-colors hover:bg-accent/50 ${
                    selectedExecution?.id === execution.id
                      ? 'bg-accent border-l-2 border-l-primary pl-[10px]'
                      : 'border-l-2 border-l-transparent'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-mono text-body text-muted-foreground">
                      {execution.id}
                    </span>
                    <span
                      className={`text-caption px-1.5 py-0.5 rounded-sm uppercase font-medium ${
                        execution.status === 'completed'
                          ? 'bg-success/10 text-success dark:bg-success/10 dark:text-success'
                          : execution.status === 'running'
                            ? 'bg-info/10 text-info dark:bg-info/10 dark:text-info'
                            : 'bg-destructive/10 text-destructive dark:bg-destructive/10 dark:text-destructive'
                      }`}
                    >
                      {execution.status}
                    </span>
                  </div>
                  <p className="text-body font-medium line-clamp-2 mb-1">{execution.prompt}</p>
                  <div className="flex items-center text-body text-muted-foreground">
                    <Clock className="h-3 w-3 mr-1" />
                    {execution.startTime}
                  </div>
                </button>
              ))}
            </div>
          </ScrollArea>
        </div>

        {/* 右侧：执行详情 */}
        <div className="flex min-h-0 flex-col bg-background">
          {selectedExecution ? (
            <Tabs defaultValue="steps" className="flex h-full min-h-0 flex-col">
              <div className="flex items-center border-b px-4">
                <TabsList className="h-10 p-0 bg-transparent">
                  <TabsTrigger
                    value="steps"
                    className="h-full rounded-none border-b-2 border-transparent px-4 data-[state=active]:border-primary data-[state=active]:bg-transparent"
                  >
                    Timeline
                  </TabsTrigger>
                  <TabsTrigger
                    value="prompt"
                    className="h-full rounded-none border-b-2 border-transparent px-4 data-[state=active]:border-primary data-[state=active]:bg-transparent"
                  >
                    Prompt
                  </TabsTrigger>
                  <TabsTrigger
                    value="context"
                    className="h-full rounded-none border-b-2 border-transparent px-4 data-[state=active]:border-primary data-[state=active]:bg-transparent"
                  >
                    Context
                  </TabsTrigger>
                  <TabsTrigger
                    value="response"
                    className="h-full rounded-none border-b-2 border-transparent px-4 data-[state=active]:border-primary data-[state=active]:bg-transparent"
                  >
                    Response
                  </TabsTrigger>
                </TabsList>
                <div className="ml-auto text-body font-mono text-muted-foreground">
                  ID: {selectedExecution.id}
                </div>
              </div>

              <div className="flex-1 min-h-0 overflow-hidden bg-muted/5">
                <TabsContent value="steps" className="m-0 h-full min-h-0">
                  <ScrollArea className="h-full">
                    <div className="p-4 max-w-4xl mx-auto">
                      <div className="relative space-y-0">
                        {/* 垂直连接线 */}
                        <div className="absolute left-4 top-2 bottom-2 w-px bg-border" />

                        {selectedExecution.steps.map((step, index) => (
                          <div key={step.id} className="relative pl-10 pb-6 group">
                            {/* 节点图标 */}
                            <div
                              className={`absolute left-0 top-0 w-8 h-8 rounded-full border-4 border-background flex items-center justify-center z-10
                              ${
                                step.type === 'thought'
                                  ? 'bg-type-ai/15 text-type-ai dark:bg-type-ai/15'
                                  : step.type === 'action'
                                    ? 'bg-info/10 text-info dark:bg-info/10'
                                    : step.type === 'observation'
                                      ? 'bg-success/10 text-success dark:bg-success/10'
                                      : 'bg-warning/10 text-warning dark:bg-warning/10'
                              }`}
                            >
                              <span className="text-body font-bold">{index + 1}</span>
                            </div>

                            {/* 内容卡片 */}
                            <div className="rounded-lg border bg-card p-3 shadow-sm hover:shadow-md transition-shadow">
                              <div className="flex items-center justify-between mb-2">
                                <div className="flex items-center gap-2">
                                  <span className="font-semibold text-body">{step.node}</span>
                                  <span
                                    className={`text-caption px-1.5 py-0.5 rounded uppercase tracking-wider font-medium
                                    ${
                                      step.type === 'thought'
                                        ? 'bg-type-ai/10 text-type-ai border border-type-ai/30'
                                        : step.type === 'action'
                                          ? 'bg-info/10 text-info border border-info/30'
                                          : step.type === 'observation'
                                            ? 'bg-success/10 text-success border border-success/30'
                                            : 'bg-warning/10 text-warning border border-warning/30'
                                    }`}
                                  >
                                    {step.type}
                                  </span>
                                </div>
                                <span className="text-body font-mono text-muted-foreground">
                                  {step.timestamp}
                                </span>
                              </div>

                              <p className="text-body leading-relaxed">{step.content}</p>

                              {step.metadata && Object.keys(step.metadata).length > 0 && (
                                <div className="mt-3 bg-muted/50 rounded p-2 border font-mono text-body">
                                  {JSON.stringify(step.metadata, null, 2)}
                                </div>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </ScrollArea>
                </TabsContent>

                <TabsContent value="prompt" className="m-0 h-full min-h-0 p-0">
                  <div className="flex h-full min-h-0 flex-col">
                    <ScrollArea className="flex-1">
                      <div className="p-4 font-mono text-body leading-relaxed">
                        {selectedExecution.prompt}
                      </div>
                    </ScrollArea>
                  </div>
                </TabsContent>

                <TabsContent value="context" className="m-0 h-full min-h-0 p-0">
                  <ScrollArea className="h-full">
                    <div className="p-4">
                      <pre className="font-mono text-body bg-muted/30 p-4 rounded-lg border">
                        {JSON.stringify(selectedExecution.context, null, 2)}
                      </pre>
                    </div>
                  </ScrollArea>
                </TabsContent>

                <TabsContent value="response" className="m-0 h-full min-h-0 p-0">
                  <ScrollArea className="h-full">
                    <div className="p-4">
                      <pre className="font-mono text-body bg-muted/30 p-4 rounded-lg border">
                        {selectedExecution.response || 'Pending...'}
                      </pre>
                    </div>
                  </ScrollArea>
                </TabsContent>
              </div>
            </Tabs>
          ) : (
            <div className="flex h-full items-center justify-center text-muted-foreground bg-muted/5">
              <div className="text-center">
                <Hash className="h-12 w-12 mx-auto mb-4 opacity-20" />
                <p>Select an execution to view details</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
