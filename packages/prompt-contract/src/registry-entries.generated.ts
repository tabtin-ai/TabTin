// DO NOT EDIT BY HAND. 改 .md / overrides.yaml 后 rerun:
//
// 阶段 0.5 产物：从 0_active_renderers.md 抽取 + overrides 合并的 registry-ready 条目。
// 阶段 1 注册表 (registry.ts) 从本文件 import REGISTRY_ENTRIES 填充。

import type { SectionDescriptor } from './section-descriptor.js';

/** 92 条 A + B 类条目（C 类历史项不进注册表）。 */
export const REGISTRY_ENTRIES: SectionDescriptor[] = [
  {
    "id": "principle_section",
    "category": "base_prompt_section",
    "xmlTag": "principle",
    "source": "@tabtin/agent-prompt",
    "language": "zh",
    "charBudget": 1200,
    "cacheBreak": false,
    "injectionTiming": "runtime-create",
    "role": "system",
    "position": "head",
    "description": "平台默认行为规则 + 每轮操作循环",
    "writerLocations": [
      "packages/agent-prompt/src/sections.ts (buildPrincipleSection)",
      "packages/agent-prompt/src/builder.ts (push)"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "host 创建/重建 runtime 时一次注入"
    },
    "presenceInProduction": {
      "observed": true,
      "totalSessions": 38,
      "category": "active"
    }
  },
  {
    "id": "environment_section",
    "category": "base_prompt_section",
    "xmlTag": "environment",
    "source": "@tabtin/agent-prompt",
    "language": "zh",
    "charBudget": 700,
    "cacheBreak": false,
    "injectionTiming": "runtime-create",
    "role": "system",
    "position": "head",
    "description": "Workteam / Space / Session / Workspace 四行运行时身份事实",
    "writerLocations": [
      "packages/agent-prompt/src/sections.ts:76-89 (buildEnvironmentSection)",
      "packages/agent-prompt/src/builder.ts:68-69 (push)"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "host 创建 runtime 时 runtimeIdentity 非空一次注入（Daemon 路径 spaceName/workteamName 未传 → 显示 UUID）"
    },
    "presenceInProduction": {
      "observed": true,
      "totalSessions": 38,
      "category": "active"
    }
  },
  {
    "id": "shell_runtime_section",
    "category": "base_prompt_section",
    "xmlTag": "shell_runtime",
    "source": "@tabtin/agent-prompt",
    "language": "zh",
    "charBudget": 700,
    "cacheBreak": false,
    "injectionTiming": "runtime-create",
    "role": "system",
    "position": "head",
    "description": "run_terminal_command 默认 cwd + $TABTIN_WORKSPACE 用法约定 + envelope hint 指针",
    "writerLocations": [
      "packages/agent-prompt/src/sections.ts:101-114 (buildShellRuntimeSection)",
      "packages/agent-prompt/src/builder.ts:70-71 (push)"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "host 创建/重建 runtime 时一次注入"
    },
    "presenceInProduction": {
      "observed": true,
      "totalSessions": 38,
      "category": "active"
    }
  },
  {
    "id": "platform_data_section",
    "category": "base_prompt_section",
    "xmlTag": "platform_data",
    "source": "@tabtin/agent-prompt",
    "language": "zh",
    "charBudget": 1700,
    "cacheBreak": false,
    "injectionTiming": "runtime-create",
    "role": "system",
    "position": "head",
    "description": "archive / tool-logs 路径布局 + silent memory 用法 + 输出纪律 + 反 prompt-injection 外传",
    "writerLocations": [
      "packages/agent-prompt/src/sections.ts:122-167 (buildPlatformDataSection)",
      "packages/agent-prompt/src/builder.ts:72-73 (push)"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "host 创建/重建 runtime 时一次注入"
    },
    "presenceInProduction": {
      "observed": true,
      "totalSessions": 38,
      "category": "active"
    }
  },
  {
    "id": "apps_section",
    "category": "base_prompt_section",
    "xmlTag": "apps",
    "source": "@tabtin/agent-prompt",
    "language": "zh",
    "charBudget": 3000,
    "cacheBreak": false,
    "injectionTiming": "runtime-create",
    "role": "system",
    "position": "head",
    "description": "当前 Space 启用的 App 能力图谱 + displayName 措辞规则",
    "writerLocations": [
      "packages/agent-prompt/src/sections.ts:184-208 (buildAppsSection)",
      "packages/agent-prompt/src/builder.ts:78-79 (push, 仅 enabledApps 非空时)"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": false
      },
      "runtimeTrigger": "host 创建 runtime 时 enabledApps 非空一次注入",
      "requiresHostConfig": [
        "enabledApps"
      ]
    },
    "presenceInProduction": {
      "observed": true,
      "totalSessions": 38,
      "category": "active"
    }
  },
  {
    "id": "user_portrait_section",
    "category": "base_prompt_section",
    "xmlTag": "user_portrait",
    "source": "@tabtin/agent-prompt",
    "language": "zh",
    "charBudget": 1500,
    "cacheBreak": false,
    "injectionTiming": "runtime-create",
    "role": "system",
    "position": "head",
    "description": "USER 画像 5 段叙事 wrap（M1.4，让 Agent 首日就知道用户是谁）",
    "writerLocations": [
      "packages/agent-prompt/src/sections.ts:228-237 (buildUserPortraitSection)",
      "packages/agent-prompt/src/builder.ts:84-85 (push, 仅 content 非空)"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "host 创建 runtime 时 userPortrait 非空一次注入（按 workteam 异步拉取）",
      "requiresHostConfig": [
        "userPortrait"
      ]
    },
    "presenceInProduction": {
      "observed": true,
      "totalSessions": 38,
      "category": "active"
    }
  },
  {
    "id": "custom_rules_section",
    "category": "base_prompt_section",
    "xmlTag": "custom_rules",
    "source": "@tabtin/agent-prompt",
    "language": "zh",
    "charBudget": 2000,
    "cacheBreak": false,
    "injectionTiming": "runtime-create",
    "role": "system",
    "position": "head",
    "description": "Agent.custom_rules 薄 wrap（用户自定义规则，body 由用户填）",
    "writerLocations": [
      "packages/agent-prompt/src/sections.ts:210-213 (buildCustomRulesSection)",
      "packages/agent-prompt/src/builder.ts:87-88 (push, 仅 rules 非空)"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "host 创建 runtime 时 customRules 非空一次注入",
      "requiresHostConfig": [
        "customRules"
      ]
    },
    "presenceInProduction": {
      "observed": true,
      "totalSessions": 38,
      "category": "active"
    }
  },
  {
    "id": "execution_section",
    "category": "base_prompt_section",
    "xmlTag": "execution",
    "source": "@tabtin/agent-prompt",
    "language": "zh",
    "charBudget": 1900,
    "cacheBreak": false,
    "injectionTiming": "runtime-create",
    "role": "system",
    "position": "mid",
    "description": "核心行为 + 任务流 + 用子 Agent 卸载上下文 + 工具错误处理 + 边界（仅 agent mode 注入）",
    "writerLocations": [
      "packages/agent-prompt/prompts/execution.md (SSoT)",
      "packages/agent-prompt/src/generated-content.ts:5-30 (SECTION_EXECUTION)",
      "packages/agent-prompt/src/builder.ts:96-98 (push, 仅 agentMode='agent')"
    ],
    "renderCondition": {
      "modes": [
        "agent"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "host 创建 runtime 时 agentMode='agent' 一次注入"
    },
    "presenceInProduction": {
      "observed": true,
      "totalSessions": 38,
      "category": "active"
    }
  },
  {
    "id": "safety_section",
    "category": "base_prompt_section",
    "xmlTag": "safety",
    "source": "@tabtin/agent-prompt",
    "language": "zh",
    "charBudget": 1000,
    "cacheBreak": false,
    "injectionTiming": "runtime-create",
    "role": "system",
    "position": "mid",
    "description": "间接注入防御 + 操作安全 + permission_denied 处置",
    "writerLocations": [
      "packages/agent-prompt/prompts/safety.md (SSoT)",
      "packages/agent-prompt/src/generated-content.ts:85-108 (SECTION_SAFETY)",
      "packages/agent-prompt/src/builder.ts:101 (push)"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "host 创建/重建 runtime 时一次注入"
    },
    "presenceInProduction": {
      "observed": true,
      "totalSessions": 38,
      "category": "active"
    }
  },
  {
    "id": "cli_capabilities_section",
    "category": "base_prompt_section",
    "xmlTag": "cli_capabilities",
    "source": "@tabtin/agent-prompt",
    "language": "zh",
    "charBudget": 1300,
    "cacheBreak": false,
    "injectionTiming": "runtime-create",
    "role": "system",
    "position": "tail",
    "description": "可用 tabtin CLI 命令清单 wrap（body 加载自 cli-commands.txt）",
    "writerLocations": [
      "packages/agent-prompt/src/sections.ts:268-271 (buildCliCapabilitiesSection)",
      "packages/agent-prompt/src/builder.ts:117-118 (push, 仅 cliReference 非 null)"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": false
      },
      "runtimeTrigger": "host 创建 runtime 时 cliReference 非空一次注入",
      "requiresHostConfig": [
        "cliReference"
      ]
    },
    "presenceInProduction": {
      "observed": true,
      "totalSessions": 38,
      "category": "active"
    }
  },
  {
    "id": "planning_section",
    "category": "base_prompt_section",
    "xmlTag": "planning",
    "source": "@tabtin/agent-prompt",
    "language": "zh",
    "charBudget": 900,
    "cacheBreak": false,
    "injectionTiming": "runtime-create",
    "role": "system",
    "position": "tail",
    "description": "todo_write 规划纪律 + 多任务上下文消歧（base prompt 末段，BOUNDARY 之前；#2982 短修正句修饰最近未完成任务）",
    "writerLocations": [
      "packages/agent-prompt/prompts/planning.md (SSoT)",
      "packages/agent-prompt/src/generated-content.ts:194-207 (SECTION_PLANNING)",
      "packages/agent-prompt/src/builder.ts:120 (push)"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "host 创建/重建 runtime 时一次注入"
    },
    "presenceInProduction": {
      "observed": true,
      "totalSessions": 38,
      "category": "active"
    }
  },
  {
    "id": "context_block",
    "category": "hook_injection",
    "xmlTag": "context",
    "source": "@tabtin/agent-runtime",
    "language": "en",
    "languageExceptionReason": "language=en 永久例外：本段无段内硬编码英文自然语言；内容为 protocol enum（wrapper attr type=environment）+ schema key 字段名（current_datetime / focused / details / open_tabs），宿主数据值由 host 提供且已中文。决策 4 全中文化审视后确认保留 en",
    "charBudget": 3000,
    "cacheBreak": true,
    "cacheBreakReason": "context-injector.ts buildContextText 注入 current_datetime；7.1（2026-05-21）从秒级 slice(0,19) 降到分钟级 slice(0,16)，同分钟内 byte-identical，仍属动态段故 cacheBreak=true，但已非旧 09/10 报告所称的最大单点 cache 杀手（每轮必破已缓解；详见 99 阶段 7）",
    "injectionTiming": "every-turn",
    "role": "user",
    "position": "head",
    "description": "Tab/App 焦点 + 打开 tabs + 当前时间，让 Agent 知道用户当下聚焦。阶段 6 议题 2 升级为 `<context type=\"environment\">...</context>` SSoT wrapper 形态。",
    "writerLocations": [
      "packages/agent-runtime/src/engine/hooks/context-injector.ts:101-133",
      "packages/agent-runtime/src/engine/hooks/context-injector.ts:138-186",
      "packages/agent-prompt/src/user-context-wrapper.ts (buildUserContextWrapper SSoT)"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "每轮 LLM 前 + getAppContext 返回非空 + buildContextText 非空"
    },
    "presenceInProduction": {
      "observed": true,
      "totalSessions": 38,
      "category": "active"
    }
  },
  {
    "id": "skills_listing",
    "category": "hook_injection",
    "xmlTag": "skills",
    "source": "@tabtin/agent-runtime",
    "language": "zh",
    "charBudget": 8000,
    "cacheBreak": false,
    "injectionTiming": "every-turn",
    "role": "system",
    "position": "tail",
    "description": "Space + Agent 启用的 skills 简表 + whenToUse；每轮 SkillsCap.beforeIteration 触发，BOUNDARY 之后第一块",
    "writerLocations": [
      "packages/agent-runtime/src/capability/core/skills.ts:278-336",
      "packages/agent-runtime/src/skills/skill-budget.ts (truncateSkillsWithinBudget)"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "每轮 beforeIteration + fetchSkills 已注入 + spaceId ready；fetchSkills 抛错保留上一轮 hint"
    },
    "presenceInProduction": {
      "observed": true,
      "totalSessions": 38,
      "category": "active"
    }
  },
  {
    "id": "convergence_hint",
    "category": "hook_injection",
    "xmlTag": "convergence",
    "source": "@tabtin/agent-runtime",
    "language": "zh",
    "charBudget": 500,
    "cacheBreak": false,
    "injectionTiming": "on-demand",
    "role": "system",
    "position": "tail",
    "description": "messages 接近 token 上限时的两档英文 system 提示（轻度 138 chars / 严厉 154 chars）",
    "writerLocations": [
      "packages/agent-runtime/src/capability/governance/cost.ts:295-347",
      "packages/agent-runtime/src/prompts/capability/convergence-hints.ts:21-27"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "每轮 + context pressure >= 0.85 (warn) 或 >= 0.95 (error)"
    },
    "presenceInProduction": {
      "observed": true,
      "totalSessions": 38,
      "category": "active"
    }
  },
  {
    "id": "stall_detection",
    "category": "hook_injection",
    "xmlTag": "stall_detection",
    "source": "@tabtin/agent-runtime",
    "language": "zh",
    "charBudget": 1500,
    "cacheBreak": false,
    "injectionTiming": "on-demand",
    "role": "system",
    "position": "tail",
    "description": "tool failure streak ≥5 时注入英文 system reminder 引导 ask 三件套 / 换工具 / 文字收尾；按 error_kind 7 路分支",
    "writerLocations": [
      "packages/agent-runtime/src/engine/query.ts:2835-2854",
      "packages/agent-runtime/src/engine/tool-failure-tracker.ts:705-814"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "每轮 + tool failure tracker 累积 streak 超阈值（pending 存在且非 grace turn）"
    },
    "presenceInProduction": {
      "observed": true,
      "totalSessions": 38,
      "category": "active"
    }
  },
  {
    "id": "repetition_detection",
    "category": "hook_injection",
    "xmlTag": "repetition_detection",
    "source": "@tabtin/agent-runtime",
    "language": "zh",
    "charBudget": 1200,
    "cacheBreak": false,
    "injectionTiming": "on-demand",
    "role": "system",
    "position": "tail",
    "description": "30s 窗口同 (tool, inputDigest) 计数 ≥3 时注入英文 system reminder 让 LLM 看回灌而非重发",
    "writerLocations": [
      "packages/agent-runtime/src/engine/query.ts:2867-2887",
      "packages/agent-runtime/src/engine/tool-repetition-tracker.ts:672-690"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "每轮 + tool repetition tracker 复读检测命中（pending 存在且非 grace turn）"
    },
    "presenceInProduction": {
      "observed": true,
      "totalSessions": 38,
      "category": "active"
    }
  },
  {
    "id": "read_file_tool",
    "category": "tool_description",
    "source": "@tabtin/agent-runtime",
    "language": "zh",
    "charBudget": 1500,
    "cacheBreak": false,
    "injectionTiming": "tool-call",
    "role": "tools-array",
    "position": "mid",
    "tier": "high-risk",
    "description": "本地文件读取（分页 + cat -n 行号剥离 + 完整读取两个信号 + 单行截断 marker + 图片 resize 信号 + envelope hint 失败处理 + parse_document 边界）",
    "writerLocations": [
      "packages/agent-runtime/src/tools/tabcode-adapter.ts:1195-1225 (READ_FILE_DESCRIPTION)",
      "packages/agent-runtime/src/tools/tabcode-adapter.ts:1498-1503 (createFileReadTool 引用)"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "工具决策时（每次进 tools[] 或包装结果）"
    },
    "presenceInProduction": {
      "observed": true,
      "totalSessions": 38,
      "category": "active"
    }
  },
  {
    "id": "edit_file_tool",
    "category": "tool_description",
    "source": "@tabtin/agent-runtime",
    "language": "zh",
    "charBudget": 1500,
    "cacheBreak": false,
    "injectionTiming": "tool-call",
    "role": "tools-array",
    "position": "mid",
    "tier": "high-risk",
    "description": "字符串精确替换编辑（沉默 fuzzy 兜底 + 显式字面警告 + 行号前缀剥离 + tab/空格混合警告 + replace_all 注意 + .md trailing-space 语义）",
    "writerLocations": [
      "packages/agent-runtime/src/tools/tabcode-adapter.ts:2063-2087"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "工具决策时（每次进 tools[] 或包装结果）"
    },
    "presenceInProduction": {
      "observed": true,
      "totalSessions": 38,
      "category": "active"
    }
  },
  {
    "id": "write_file_tool",
    "category": "tool_description",
    "source": "@tabtin/agent-runtime",
    "language": "zh",
    "charBudget": 1500,
    "cacheBreak": false,
    "injectionTiming": "tool-call",
    "role": "tools-array",
    "position": "mid",
    "tier": "high-risk",
    "description": "整文件写入 / 覆写（read-before-write 软引导 + error_kind=tool_stale_read + 优先 edit_file + 禁止主动建 *.md / README + emoji 禁令）",
    "writerLocations": [
      "packages/agent-runtime/src/tools/tabcode-adapter.ts:2619-2627"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "工具决策时（每次进 tools[] 或包装结果）"
    },
    "presenceInProduction": {
      "observed": true,
      "totalSessions": 38,
      "category": "active"
    }
  },
  {
    "id": "delete_file_tool",
    "category": "tool_description",
    "source": "@tabtin/agent-runtime",
    "language": "zh",
    "charBudget": 1500,
    "cacheBreak": false,
    "injectionTiming": "tool-call",
    "role": "tools-array",
    "position": "mid",
    "tier": "high-risk",
    "description": "单文件删除（拒绝目录 / 文件不存在优雅失败 / Checkpoint 撤销说明）",
    "writerLocations": [
      "packages/agent-runtime/src/tools/tabcode-adapter.ts:2469-2474"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "工具决策时（每次进 tools[] 或包装结果）"
    },
    "presenceInProduction": {
      "observed": true,
      "totalSessions": 38,
      "category": "active"
    }
  },
  {
    "id": "grep_search_tool",
    "category": "tool_description",
    "source": "@tabtin/agent-runtime",
    "language": "zh",
    "charBudget": 1200,
    "cacheBreak": false,
    "injectionTiming": "tool-call",
    "role": "tools-array",
    "position": "mid",
    "tier": "medium",
    "description": "regex 内容搜索（边界引导 grep/glob/semantic 三件套 + 反向引导避免 run_terminal_command grep/rg + 默认 output_mode='files_with_matches' + multiline + brace escape + head_limit/offset 翻页 + agent 工具升级路径）",
    "writerLocations": [
      "packages/agent-runtime/src/tools/tabcode-adapter.ts:2620-2631"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "工具决策时（每次进 tools[] 或包装结果）"
    },
    "presenceInProduction": {
      "observed": true,
      "totalSessions": 38,
      "category": "active"
    }
  },
  {
    "id": "glob_search_tool",
    "category": "tool_description",
    "source": "@tabtin/agent-runtime",
    "language": "zh",
    "charBudget": 1200,
    "cacheBreak": false,
    "injectionTiming": "tool-call",
    "role": "tools-array",
    "position": "mid",
    "tier": "medium",
    "description": "glob 模式文件名搜索（mtime 倒序 + 默认 .gitignore + 边界引导三件套 + 禁递归 list_directory + agent 工具升级路径）",
    "writerLocations": [
      "packages/agent-runtime/src/tools/tabcode-adapter.ts:2913-2918"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "工具决策时（每次进 tools[] 或包装结果）"
    },
    "presenceInProduction": {
      "observed": true,
      "totalSessions": 38,
      "category": "active"
    }
  },
  {
    "id": "run_terminal_command_tool",
    "category": "tool_description",
    "source": "@tabtin/agent-runtime",
    "language": "zh",
    "charBudget": 1900,
    "cacheBreak": false,
    "injectionTiming": "tool-call",
    "role": "tools-array",
    "position": "mid",
    "tier": "high-risk",
    "description": "Shell 命令执行（union 4-case status 分流 + $TABTIN_WORKSPACE / cwd 契约 + 等待场景矩阵 6 行 + 工具偏好清单 + 禁交互命令 + wait_ms:0 长任务背景化 + status=running 由 push 通知激活下一轮）",
    "writerLocations": [
      "packages/agent-runtime/src/capability/core/shell.ts:909-940 (run_terminal_command tool factory + description literal)"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "工具决策时（每次进 tools[] 或包装结果）"
    },
    "presenceInProduction": {
      "observed": true,
      "totalSessions": 38,
      "category": "active"
    }
  },
  {
    "id": "read_raw_ref_tool",
    "category": "tool_description",
    "source": "@tabtin/agent-runtime",
    "language": "en",
    "languageExceptionReason": "底层 context projection 取证工具，对 LLM 可见但用户不直接看；英文描述保持 read-only 取证工具风格，且术语（raw_ref / grep / offset / max_chars）保持英文与参数名一致——中文化会让参数名与描述语言割裂。",
    "charBudget": 500,
    "cacheBreak": false,
    "injectionTiming": "tool-call",
    "role": "tools-array",
    "position": "mid",
    "tier": "low-risk",
    "description": "Context projection 取证工具：只读取当前 session 的 tool-log:// raw_ref，强制 bounded slice，并用 grep/offset/max_chars 避免把完整 raw log 重新塞回模型历史。",
    "writerLocations": [
      "packages/agent-runtime/src/capability/core/raw-ref.ts:170-206 (read_raw_ref tool definition in RawRefCap.tools())"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "工具决策时（每次进 tools[] 或包装结果）"
    },
    "presenceInProduction": {
      "observed": true,
      "totalSessions": 38,
      "category": "active"
    }
  },
  {
    "id": "read_platform_data_tool",
    "category": "tool_description",
    "source": "@tabtin/agent-runtime",
    "language": "en",
    "languageExceptionReason": "平台内部取证工具，对 LLM 可见但用户不直接看；record_type / tool_log_id / grep / offset / max_chars 保持英文以对齐工具参数名。",
    "charBudget": 600,
    "cacheBreak": false,
    "injectionTiming": "tool-call",
    "role": "tools-array",
    "position": "mid",
    "tier": "low-risk",
    "description": "平台数据取证工具：只读取当前 session 的 messages/events/snapshots/tool_logs，强制 bounded slice，不暴露本机 platform-data 路径。",
    "writerLocations": [
      "packages/agent-runtime/src/capability/core/platform-data.ts:202-241 (read_platform_data tool definition in PlatformDataCap.tools())"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "工具决策时（每次进 tools[] 或包装结果）"
    },
    "presenceInProduction": {
      "observed": true,
      "totalSessions": 38,
      "category": "active"
    }
  },
  {
    "id": "ask_user_tool",
    "category": "tool_description",
    "source": "@tabtin/agent-runtime",
    "language": "zh",
    "charBudget": 1200,
    "cacheBreak": false,
    "injectionTiming": "tool-call",
    "role": "tools-array",
    "position": "mid",
    "tier": "medium",
    "description": "多选 / 单选问题（4 use case + Other 选项 + allow_multiple + (Recommended) 标记 + 三件套互斥决策 + 反模式约束）",
    "writerLocations": [
      "packages/agent-runtime/src/tools/ask-tools.ts:109-123"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "工具决策时（每次进 tools[] 或包装结果）"
    },
    "presenceInProduction": {
      "observed": true,
      "totalSessions": 38,
      "category": "active"
    }
  },
  {
    "id": "ask_form_tool",
    "category": "tool_description",
    "source": "@tabtin/agent-runtime",
    "language": "zh",
    "charBudget": 500,
    "cacheBreak": false,
    "injectionTiming": "tool-call",
    "role": "tools-array",
    "position": "mid",
    "tier": "low-risk",
    "description": "多字段表单（凭证 / ID / URL 等字段；与 ask_user / request_approval 边界）",
    "writerLocations": [
      "packages/agent-runtime/src/tools/ask-tools.ts:125-129"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "工具决策时（每次进 tools[] 或包装结果）"
    },
    "presenceInProduction": {
      "observed": true,
      "totalSessions": 38,
      "category": "active"
    }
  },
  {
    "id": "request_approval_tool",
    "category": "tool_description",
    "source": "@tabtin/agent-runtime",
    "language": "zh",
    "charBudget": 1200,
    "cacheBreak": false,
    "injectionTiming": "tool-call",
    "role": "tools-array",
    "position": "mid",
    "tier": "medium",
    "description": "破坏性 / 外部 / 不可逆动作的审批（safe / review / high risk_level 驱动 UI 警示；与 ask_user / ask_form 边界 + 不能带可填字段约束）",
    "writerLocations": [
      "packages/agent-runtime/src/tools/ask-tools.ts:131-135"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "工具决策时（每次进 tools[] 或包装结果）"
    },
    "presenceInProduction": {
      "observed": true,
      "totalSessions": 38,
      "category": "active"
    }
  },
  {
    "id": "todo_write_tool",
    "category": "tool_description",
    "source": "@tabtin/agent-runtime",
    "language": "zh",
    "charBudget": 500,
    "cacheBreak": false,
    "injectionTiming": "tool-call",
    "role": "tools-array",
    "position": "mid",
    "tier": "low-risk",
    "description": "todo 列表（3 步以上任务 + 单 in_progress 约束 + merge 语义 + 单步 / 闲聊不要用）",
    "writerLocations": [
      "packages/agent-runtime/src/tools/core-tools.ts:67-71"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "工具决策时（每次进 tools[] 或包装结果）"
    },
    "presenceInProduction": {
      "observed": true,
      "totalSessions": 38,
      "category": "active"
    }
  },
  {
    "id": "web_search_tool",
    "category": "tool_description",
    "source": "@tabtin/agent-runtime",
    "language": "zh",
    "charBudget": 1200,
    "cacheBreak": false,
    "injectionTiming": "tool-call",
    "role": "tools-array",
    "position": "mid",
    "tier": "medium",
    "description": "实时网络搜索（最新事实 / 当前文档 / 训练数据外信息；搜代码 / 工作空间反向引导走 grep_search / glob_search）",
    "writerLocations": [
      "packages/agent-runtime/src/tools/web-tools.ts:78-82"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "工具决策时（每次进 tools[] 或包装结果）"
    },
    "presenceInProduction": {
      "observed": true,
      "totalSessions": 38,
      "category": "active"
    }
  },
  {
    "id": "parse_document_tool",
    "category": "tool_description",
    "source": "host",
    "language": "zh",
    "charBudget": 1200,
    "cacheBreak": false,
    "injectionTiming": "tool-call",
    "role": "tools-array",
    "position": "mid",
    "tier": "medium",
    "description": "按 file_id 读已上传文档（FileRecord UUID / chat 历史 file chip 来源；与 read_file 边界：path 走 read_file / file_id 走本工具；务必传 query 或 page 精准读防 context 爆炸）",
    "writerLocations": [
      "packages/agent-runtime/src/tools/document-tools.ts:61-72"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "工具决策时（每次进 tools[] 或包装结果）"
    },
    "presenceInProduction": {
      "observed": true,
      "totalSessions": 38,
      "category": "active"
    }
  },
  {
    "id": "present_to_user_tool",
    "category": "tool_description",
    "source": "@tabtin/agent-runtime",
    "language": "zh",
    "charBudget": 500,
    "cacheBreak": false,
    "injectionTiming": "tool-call",
    "role": "tools-array",
    "position": "mid",
    "tier": "low-risk",
    "description": "结构化富内容展示（image / table_preview / resource_ref / file 4 种预定义 kind；自由形态可视化走 show_widget）",
    "writerLocations": [
      "packages/agent-runtime/src/tools/presentation-tools.ts:53-57"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "工具决策时（每次进 tools[] 或包装结果）"
    },
    "presenceInProduction": {
      "observed": true,
      "totalSessions": 38,
      "category": "active"
    }
  },
  {
    "id": "show_widget_tool",
    "category": "tool_description",
    "source": "@tabtin/agent-runtime",
    "language": "zh",
    "charBudget": 500,
    "cacheBreak": false,
    "injectionTiming": "tool-call",
    "role": "tools-array",
    "position": "mid",
    "tier": "low-risk",
    "description": "内联视觉 widget（SVG / HTML / Mermaid 流式渲染；自由形态可视化用本工具；与 present_to_user 边界）",
    "writerLocations": [
      "packages/agent-runtime/src/tools/show-widget/index.ts:176-184"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "工具决策时（每次进 tools[] 或包装结果）"
    },
    "presenceInProduction": {
      "observed": true,
      "totalSessions": 38,
      "category": "active"
    }
  },
  {
    "id": "memory_search_tool",
    "category": "tool_description",
    "source": "host",
    "language": "zh",
    "charBudget": 1200,
    "cacheBreak": false,
    "injectionTiming": "tool-call",
    "role": "tools-array",
    "position": "mid",
    "tier": "medium",
    "description": "搜 Agent 记忆（关于用户的笔记 / 洞察 / 任务总结 / skill；只返 agent 自己写的 memo；搜代码 / 文档反向引导 grep_search / rag_search）",
    "writerLocations": [
      "packages/agent-runtime/src/tools/data-tools.ts:658-662"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "工具决策时（每次进 tools[] 或包装结果）"
    },
    "presenceInProduction": {
      "observed": true,
      "totalSessions": 38,
      "category": "active"
    }
  },
  {
    "id": "skills_read_tool",
    "category": "tool_description",
    "source": "@tabtin/agent-runtime",
    "language": "zh",
    "charBudget": 500,
    "cacheBreak": false,
    "injectionTiming": "tool-call",
    "role": "tools-array",
    "position": "mid",
    "tier": "low-risk",
    "description": "按 canonical key 读 SKILL.md 完整正文（user:slug / app:appId/slug 等 5 种前缀；ext: / tin: 在本地模式不可用）",
    "writerLocations": [
      "packages/agent-runtime/src/tools/skills-tools.ts:226-231"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "工具决策时（每次进 tools[] 或包装结果）"
    },
    "presenceInProduction": {
      "observed": true,
      "totalSessions": 38,
      "category": "active"
    }
  },
  {
    "id": "skills_search_tool",
    "category": "tool_description",
    "source": "@tabtin/agent-runtime",
    "language": "zh",
    "charBudget": 500,
    "cacheBreak": false,
    "injectionTiming": "tool-call",
    "role": "tools-array",
    "position": "mid",
    "tier": "low-risk",
    "description": "按关键词搜本地 skill（name / description / slug / when_to_use 全文子串匹配；想看全部 skill 优先看 <skills> 段）",
    "writerLocations": [
      "packages/agent-runtime/src/tools/skills-tools.ts:313-316"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "工具决策时（每次进 tools[] 或包装结果）"
    },
    "presenceInProduction": {
      "observed": true,
      "totalSessions": 38,
      "category": "active"
    }
  },
  {
    "id": "agent_tool",
    "category": "tool_description",
    "source": "@tabtin/agent-runtime",
    "language": "zh",
    "charBudget": 1200,
    "cacheBreak": false,
    "injectionTiming": "tool-call",
    "role": "tools-array",
    "position": "mid",
    "tier": "medium",
    "description": "子 Agent 启动（不继承父对话 / 独立调工具 / 返回摘要；并行子任务用本工具）",
    "writerLocations": [
      "packages/agent-runtime/src/engine/agent-tool.ts:2130-2163"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "工具决策时（每次进 tools[] 或包装结果）"
    },
    "presenceInProduction": {
      "observed": true,
      "totalSessions": 38,
      "category": "active"
    }
  },
  {
    "id": "referenced_context_data_wrapper",
    "category": "user_wrapper",
    "xmlTag": "context",
    "source": "host",
    "language": "zh",
    "languageExceptionReason": "wrapper attr `type=\"referenced\"` / `stale_after_turn` 是 protocol-level enum，非自然语言；段整体语言按 body（中文用户引用内容）判 zh",
    "charBudget": 6000,
    "cacheBreak": false,
    "injectionTiming": "on-demand",
    "role": "user",
    "position": "head",
    "description": "用户 @ 引用 TabTin 资源（表 / 文档 / memo 等）时，走 `buildUserContextWrapper('referenced', ...)` SSoT 套 `<context type=\"referenced\" stale_after_turn=\"<localUserMsgId>\">...</context>` 外壳并拼进 user message 持久化。跨轮重放阶段 select-recent-history 检测 stale 替换 body 为指针。",
    "writerLocations": [
      "apps/tabtin-electron/src/renderer/src/stores/chat/actions/sendMessageAction.ts:1150-1180",
      "apps/tabtin_django/apps/services/agent_execution/context_assembler.py:402 (Python 复刻 SSoT)",
      "packages/agent-prompt/src/user-context-wrapper.ts (SSoT 实现)",
      "apps/tabtin_django/apps/services/agent_execution/user_context_wrapper.py (Python 等价实现 + contract test)"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "用户消息含 @ 引用 → resolve-context API 拉 schema → 拼进 user message 正文持久化"
    },
    "presenceInProduction": {
      "observed": true,
      "totalSessions": 38,
      "category": "active"
    }
  },
  {
    "id": "attachment_doc_wrapper",
    "category": "user_wrapper",
    "xmlTag": "context",
    "source": "host",
    "language": "zh",
    "languageExceptionReason": "wrapper attr `type=\"attached\"` / `filename` / `stale_after_turn` 是 protocol-level，非自然语言；段整体语言按 body（中文 `[文档: foo]` + 文档正文）判 zh",
    "charBudget": 10000,
    "cacheBreak": false,
    "injectionTiming": "on-demand",
    "role": "user",
    "position": "head",
    "description": "用户上传文件附件（PDF/docx/txt/code 等）时，host 进程 / Django block_normalizer 把解析文本套 `<context type=\"attached\" filename=\"foo.pdf\" stale_after_turn=\"<turnId>\">` SSoT 外壳，内层保留 `[文档: filename]` 标识。",
    "writerLocations": [
      "apps/tabtin-electron/src/main/agent/ElectronAgentHost.ts:2733-2790 (resolveFileAttachments)",
      "apps/tabtin-daemon/src/agent/DaemonAgentHost.ts:2040-2100 (resolveFileAttachments)",
      "apps/tabtin_django/apps/chat/conversation/services/block_normalizer.py:120 (Django _wrap_attached_file)",
      "packages/agent-prompt/src/user-context-wrapper.ts (SSoT 实现)"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "用户拖拽/回形针上传文件附件 → main 进程 resolveFileAttachments → 拼进 user message"
    },
    "presenceInProduction": {
      "observed": true,
      "totalSessions": 38,
      "category": "active"
    }
  },
  {
    "id": "image_attachment_block",
    "category": "user_wrapper",
    "source": "host",
    "language": "zh",
    "charBudget": 0,
    "cacheBreak": false,
    "injectionTiming": "on-demand",
    "role": "user",
    "position": "head",
    "description": "图片附件转 ImageBlock 注入 user message content。不是文本 prompt，但是 messages 内容形态的一部分，影响 token 占用 + provider 多模态路由。",
    "writerLocations": [
      "apps/tabtin-electron/src/main/agent/ElectronAgentHost.ts: buildUserMessageWithAttachments",
      "packages/agent-runtime/src/history/build-initial-messages.ts:23"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "用户拖拽图片 / 截屏粘贴 → 转 ImageBlock → 注入 user message content blocks"
    },
    "presenceInProduction": {
      "observed": true,
      "totalSessions": 38,
      "category": "active"
    }
  },
  {
    "id": "tool_output_fence",
    "category": "tool_result_wrap",
    "source": "@tabtin/agent-runtime",
    "language": "en",
    "languageExceptionReason": "XML wrapper（属性 + 标签语法），不是自然语言文案——LLM 按 XML 协议消费；中文化无意义且会破坏 sanitizer 的 fence-aware 截断 regex（tool-orchestration.ts:556 / query.ts:729）",
    "charBudget": 80,
    "cacheBreak": false,
    "injectionTiming": "tool-call",
    "role": "user",
    "position": "tail",
    "description": "wrapInToolOutputFence() 把工具输出包成 <tool_output tool_name=\"…\" [suspicious=\"true\"]>...</tool_output>，让 LLM 在 messages 里区分'runtime 自己说的'vs'外部不可信数据'，是 FR-09 prompt-injection guardrail 的载体",
    "writerLocations": [
      "packages/agent-runtime/src/engine/tool-output-sanitizer.ts:515-524"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "每次工具调用结果（100% 命中）→ wrapInToolOutputFence"
    },
    "presenceInProduction": {
      "observed": true,
      "totalSessions": 38,
      "category": "active"
    }
  },
  {
    "id": "tool_output_persisted_truncation_banner",
    "category": "tool_result_wrap",
    "source": "@tabtin/agent-runtime",
    "language": "zh",
    "charBudget": 260,
    "cacheBreak": false,
    "injectionTiming": "tool-call",
    "role": "user",
    "position": "mid",
    "description": "buildPersistMeta() 拼装 <persisted-output> 包裹的截断说明——三个 kind（per-tool / per-round / summarize）共享 [... output truncated: <reason>, original N chars. Full output saved to: <path> — use read_file ...] 模板；storage 不可用时 fallback 'Full output not persisted in this host'",
    "writerLocations": [
      "packages/agent-runtime/src/engine/tool-orchestration.ts:946-968",
      "packages/agent-runtime/src/engine/tool-orchestration.ts:807-815 (docstring 描述 banner format)"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "单工具结果 > 50K 或全轮 tool 结果累计 > 150K → enforceToolOutputBudget persist + banner"
    },
    "presenceInProduction": {
      "observed": true,
      "totalSessions": 38,
      "category": "active"
    }
  },
  {
    "id": "subagent_fork_boilerplate_zh",
    "category": "sideloop_llm_prompt",
    "source": "@tabtin/agent-runtime",
    "language": "zh",
    "charBudget": 500,
    "cacheBreak": false,
    "injectionTiming": "tool-call",
    "role": "user",
    "position": "tail",
    "description": "BOILERPLATE_ZH：fork 子 Agent 的行为约束 + 输出格式（5 字段：范围 / 结果 / 关键文件 / 变更文件 / 问题）。阶段 5 删 BOILERPLATE_EN + CJK 自动切换后，这是 fork 唯一 boilerplate，由 buildForkedMessages 嵌入 <fork-boilerplate> 标签'",
    "writerLocations": [
      "packages/agent-runtime/src/engine/fork-query.ts:48-90"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "agent 工具调用 + 最近 user 消息 CJK 比例 >= 30%"
    },
    "presenceInProduction": {
      "observed": true,
      "totalSessions": 38,
      "category": "active"
    }
  },
  {
    "id": "subagent_fork_directive_template",
    "category": "sideloop_llm_prompt",
    "source": "@tabtin/agent-runtime",
    "language": "zh",
    "charBudget": 100,
    "cacheBreak": false,
    "injectionTiming": "tool-call",
    "role": "user",
    "position": "tail",
    "description": "fork 触发时拼装的最终 user message 模板：<fork-boilerplate>\\n{boilerplate}\\n</fork-boilerplate>\\n\\nYour directive: {taskPrompt}——boilerplate 槽位由 detectLanguage 决定 EN/ZH，taskPrompt 是父 Agent 调 agent 工具时传的 prompt 参数",
    "writerLocations": [
      "packages/agent-runtime/src/engine/fork-query.ts:336-339"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "agent 工具调用必经（包装 task prompt 为 <fork-boilerplate>...）"
    },
    "presenceInProduction": {
      "observed": true,
      "totalSessions": 38,
      "category": "active"
    }
  },
  {
    "id": "subagent_fork_placeholder_result",
    "category": "sideloop_llm_prompt",
    "source": "@tabtin/agent-runtime",
    "language": "zh",
    "charBudget": 60,
    "cacheBreak": false,
    "injectionTiming": "tool-call",
    "role": "user",
    "position": "mid",
    "description": "FORK_PLACEHOLDER_RESULT：fork 子 Agent 时父 messages 里所有 tool_result.content 被替换为 'Fork started — processing in background'，确保所有子 Agent 共享同一前缀字节最大化 prompt cache 命中",
    "writerLocations": [
      "packages/agent-runtime/src/engine/fork-query.ts:41",
      "packages/agent-runtime/src/engine/fork-query.ts:142-147 (cloneMessageForFork 应用点)"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "agent 工具 cloneMessageForFork 必经（父 tool_result 占位等待子 agent 完成）"
    },
    "presenceInProduction": {
      "observed": true,
      "totalSessions": 38,
      "category": "active"
    }
  },
  {
    "id": "agent_mode_plan_section",
    "category": "base_prompt_section",
    "xmlTag": "agent_mode",
    "source": "@tabtin/agent-modes",
    "language": "zh",
    "charBudget": 3800,
    "cacheBreak": false,
    "injectionTiming": "runtime-create",
    "role": "system",
    "position": "mid",
    "description": "Plan 模式：强约束只读 + 通过 plan_create/plan_update_todos 二件套产出结构化方案（含 TD-17 容错段）",
    "writerLocations": [
      "packages/agent-modes/src/prompts/plan.md (SSoT)",
      "packages/agent-modes/src/prompt-content.generated.ts (PROMPT_PLAN)",
      "packages/agent-modes/src/prompt-sections.ts:28 (SECTION_AGENT_MODE_PLAN)",
      "packages/agent-modes/src/index.ts:68-70 (getAgentModePromptSection)",
      "packages/agent-prompt/src/builder.ts:93-94 (push, 仅 agentMode='plan')"
    ],
    "renderCondition": {
      "modes": [
        "plan"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "host 创建 runtime 时 agentMode='plan' 触发"
    },
    "presenceInProduction": {
      "observed": false,
      "hitSessions": 0,
      "totalSessions": 38,
      "category": "production-cold"
    }
  },
  {
    "id": "agent_mode_ask_section",
    "category": "base_prompt_section",
    "xmlTag": "agent_mode",
    "source": "@tabtin/agent-modes",
    "language": "zh",
    "charBudget": 1300,
    "cacheBreak": false,
    "injectionTiming": "runtime-create",
    "role": "system",
    "position": "mid",
    "description": "Ask 模式：只对话不动手（research / explain，不调写工具）",
    "writerLocations": [
      "packages/agent-modes/src/prompts/ask.md (SSoT)",
      "packages/agent-modes/src/prompt-content.generated.ts (PROMPT_ASK)",
      "packages/agent-modes/src/prompt-sections.ts:30 (SECTION_AGENT_MODE_ASK)",
      "packages/agent-modes/src/index.ts:68-70 (getAgentModePromptSection)",
      "packages/agent-prompt/src/builder.ts:93-94 (push, 仅 agentMode='ask')"
    ],
    "renderCondition": {
      "modes": [
        "ask"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "host 创建 runtime 时 agentMode='ask' 触发"
    },
    "presenceInProduction": {
      "observed": false,
      "hitSessions": 0,
      "totalSessions": 38,
      "category": "production-cold"
    }
  },
  {
    "id": "agent_mode_study_section",
    "category": "base_prompt_section",
    "xmlTag": "agent_mode",
    "source": "@tabtin/agent-modes",
    "language": "zh",
    "charBudget": 1500,
    "cacheBreak": false,
    "injectionTiming": "runtime-create",
    "role": "system",
    "position": "mid",
    "description": "Study 模式：调研学习专用（输出方案 + plan_create 收尾）",
    "writerLocations": [
      "packages/agent-modes/src/prompts/study.md (SSoT)",
      "packages/agent-modes/src/prompt-content.generated.ts (PROMPT_STUDY)",
      "packages/agent-modes/src/prompt-sections.ts:32 (SECTION_AGENT_MODE_STUDY)",
      "packages/agent-modes/src/index.ts:68-70 (getAgentModePromptSection)",
      "packages/agent-prompt/src/builder.ts:93-94 (push, 仅 agentMode='study')"
    ],
    "renderCondition": {
      "modes": [
        "study"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "host 创建 runtime 时 agentMode='study' 触发"
    },
    "presenceInProduction": {
      "observed": false,
      "hitSessions": 0,
      "totalSessions": 38,
      "category": "production-cold"
    }
  },
  {
    "id": "agent_mode_group_section",
    "category": "base_prompt_section",
    "xmlTag": "agent_mode",
    "source": "@tabtin/agent-modes",
    "language": "zh",
    "charBudget": 1200,
    "cacheBreak": false,
    "injectionTiming": "runtime-create",
    "role": "system",
    "position": "mid",
    "description": "Group 模式：群聊式多 Agent 协作（@ 引导 + 角色协调）",
    "writerLocations": [
      "packages/agent-modes/src/prompts/group.md (SSoT)",
      "packages/agent-modes/src/prompt-content.generated.ts (PROMPT_GROUP)",
      "packages/agent-modes/src/prompt-sections.ts:34 (SECTION_AGENT_MODE_GROUP)",
      "packages/agent-modes/src/index.ts:68-70 (getAgentModePromptSection)",
      "packages/agent-prompt/src/builder.ts:93-94 (push, 仅 agentMode='group')"
    ],
    "renderCondition": {
      "modes": [
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "host 创建 runtime 时 agentMode='group' 触发"
    },
    "presenceInProduction": {
      "observed": false,
      "hitSessions": 0,
      "totalSessions": 38,
      "category": "production-cold"
    }
  },
  {
    "id": "lsp_diagnostics",
    "category": "hook_injection",
    "xmlTag": "context",
    "source": "@tabtin/agent-runtime",
    "language": "zh",
    "charBudget": 4800,
    "cacheBreak": true,
    "cacheBreakReason": "诊断内容每轮可能变化（错误位置 / message / severity）；每轮先 filter 上轮 __lsp_diagnostics_injector__ marker 再 push 新 diagnostic",
    "injectionTiming": "every-turn",
    "role": "user",
    "position": "tail",
    "description": "edit_file/write_file 后下一轮注入 LSP 诊断；外层 `<context type=\"lsp-diagnostic\">` SSoT wrapper + 内层 `<system-reminder><new-diagnostics>...</new-diagnostics></system-reminder>`",
    "writerLocations": [
      "packages/agent-runtime/src/engine/hooks/lsp-diagnostic-injector.ts:159-247",
      "apps/tabtin-electron/src/main/agent/ElectronAgentHost.ts:5458-5470 (装配)",
      "packages/agent-prompt/src/user-context-wrapper.ts (SSoT 外壳)"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": false
      },
      "runtimeTrigger": "每轮 LLM 前 + hasShellTool() && isMainThread && registry 有 pending 诊断"
    },
    "presenceInProduction": {
      "observed": false,
      "hitSessions": 0,
      "totalSessions": 38,
      "category": "production-cold"
    }
  },
  {
    "id": "tool_call_metadata",
    "category": "hook_injection",
    "xmlTag": "tool_call_metadata",
    "source": "@tabtin/agent-runtime",
    "language": "zh",
    "charBudget": 400,
    "cacheBreak": false,
    "injectionTiming": "every-turn",
    "role": "system",
    "position": "head",
    "description": "runtime 原生工具调用元数据契约；全局说明一次顶层 intent，不在每个工具 schema 重复声明",
    "writerLocations": [
      "packages/agent-runtime/src/engine/core/llm-request-builder.ts:98-106",
      "packages/agent-runtime/src/engine/tooling/tool-call-metadata.ts:66-73"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "每轮 LLM 调用前注入"
    },
    "presenceInProduction": {
      "observed": false,
      "hitSessions": 0,
      "totalSessions": 38,
      "category": "production-cold"
    }
  },
  {
    "id": "budget_warn_system",
    "category": "hook_injection",
    "xmlTag": "budget_warn",
    "source": "@tabtin/agent-runtime",
    "language": "zh",
    "charBudget": 400,
    "cacheBreak": false,
    "injectionTiming": "on-demand",
    "role": "system",
    "position": "tail",
    "description": "iteration/token 预算达 warn 阈值时注入英文 system 让 LLM 收口；走 budgetEffectiveSystemPrompt 旁路",
    "writerLocations": [
      "packages/agent-runtime/src/engine/query.ts:2792-2803",
      "packages/agent-runtime/src/prompts/engine/budget-notices.ts:70-86"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "每轮 + iteration budget 评估 stage='warn'"
    },
    "presenceInProduction": {
      "observed": false,
      "hitSessions": 0,
      "totalSessions": 38,
      "category": "production-cold"
    }
  },
  {
    "id": "budget_grace_system",
    "category": "hook_injection",
    "xmlTag": "budget_grace",
    "source": "@tabtin/agent-runtime",
    "language": "zh",
    "charBudget": 500,
    "cacheBreak": false,
    "injectionTiming": "on-demand",
    "role": "system",
    "position": "tail",
    "description": "iteration/token 达 grace 阶段：tools 强制 undefined + 强力 do NOT call any tool，强制 LLM 文字收尾",
    "writerLocations": [
      "packages/agent-runtime/src/engine/query.ts:2804-2817",
      "packages/agent-runtime/src/prompts/engine/budget-notices.ts:163-180"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "每轮 + iteration budget 评估 stage='grace'（旁路 appendSystemInstruction，不进 appendSection）"
    },
    "presenceInProduction": {
      "observed": false,
      "hitSessions": 0,
      "totalSessions": 38,
      "category": "production-cold"
    }
  },
  {
    "id": "continuation_user",
    "category": "hook_injection",
    "source": "@tabtin/agent-runtime",
    "language": "zh",
    "charBudget": 200,
    "cacheBreak": false,
    "injectionTiming": "on-demand",
    "role": "user",
    "position": "tail",
    "description": "max_tokens 续写提示固定字符串；最多 MAX_CONTINUATIONS=3 次",
    "writerLocations": [
      "packages/agent-runtime/src/engine/query.ts:3940-3962"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "stopReason === 'max_tokens' && continuationCount < 3（最多重试 3 次）"
    },
    "presenceInProduction": {
      "observed": false,
      "hitSessions": 0,
      "totalSessions": 38,
      "category": "production-cold"
    }
  },
  {
    "id": "tool_eviction_notice",
    "category": "hook_injection",
    "xmlTag": "context",
    "source": "@tabtin/agent-runtime",
    "language": "zh",
    "languageExceptionReason": "wrapper attr `type=\"tool-eviction\"` 是 protocol-level enum；段整体语言按 body（中文 notice 内容）判 zh",
    "charBudget": 500,
    "cacheBreak": false,
    "injectionTiming": "on-demand",
    "role": "user",
    "position": "tail",
    "description": "dynamicToolManager.evictStale 触发时向 messages 末尾 push `<context type=\"tool-eviction\">[system] 工具下线 notice</context>` 提示 LLM 工具已下线（阶段 6 议题 2：升级 SSoT 外壳 + 接入 marker）",
    "writerLocations": [
      "packages/agent-runtime/src/engine/query.ts:4705-4735",
      "packages/agent-prompt/src/user-context-wrapper.ts (SSoT 外壳)"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "每轮 + dynamicToolManager.evictStale(iteration) 返回非空（query.ts:4705-4731）"
    },
    "presenceInProduction": {
      "observed": false,
      "hitSessions": 0,
      "totalSessions": 38,
      "category": "production-cold"
    }
  },
  {
    "id": "run_observations",
    "category": "hook_injection",
    "xmlTag": "run_observations",
    "source": "@tabtin/agent-runtime",
    "language": "zh",
    "charBudget": 2500,
    "cacheBreak": false,
    "injectionTiming": "every-turn",
    "role": "user",
    "position": "tail",
    "description": "主进程异步事件（autofill 失败 / SpaceEnvChanged）作为 user message 注入；Electron 真实实现 / Daemon async () => [] 空实现",
    "writerLocations": [
      "packages/agent-runtime/src/engine/query.ts:2304-2336",
      "packages/agent-runtime/src/engine/query.ts:1647-1678 (formatRunObservationInjection)",
      "apps/tabtin-electron/src/main/agent/conversation/run-observation-injector.ts:203-246 (createRunObservationInjector 真实实现)",
      "apps/tabtin-daemon/src/agent/DaemonAgentHost.ts:3967-3970 (async () => [] 空实现)"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": false
      },
      "runtimeTrigger": "每轮 LLM 前 + host getRecentRunObservations 返回非空"
    },
    "presenceInProduction": {
      "observed": false,
      "hitSessions": 0,
      "totalSessions": 38,
      "category": "production-cold"
    }
  },
  {
    "id": "memory_recall_section",
    "category": "hook_injection",
    "xmlTag": "context",
    "source": "@tabtin/agent-prompt",
    "language": "zh",
    "charBudget": 800,
    "cacheBreak": true,
    "cacheBreakReason": "每轮根据最近一条 user message 重新拉 TabMemo top-K memo，memo 内容/顺序按相似度+时效变动；同 context-injector 每轮 filter 旧 marker 再 push 新 message",
    "injectionTiming": "every-turn",
    "role": "user",
    "position": "head",
    "description": "Memory v2 自动召回：每轮 LLM 前 memory-injector hook 从 TabMemo 拉相关 memo，buildMemoryRecallSection 渲染 body 后由 buildUserContextWrapper('memory-recall', ...) 套统一 SSoT 外壳。",
    "writerLocations": [
      "packages/agent-prompt/src/sections.ts:272-321 (buildMemoryRecallSection 渲染 body)",
      "packages/agent-runtime/src/engine/hooks/memory-injector.ts (buildMemoryInjectorHook + buildUserContextWrapper 包外壳)",
      "packages/agent-prompt/src/user-context-wrapper.ts (SSoT 外壳)",
      "apps/tabtin-electron/src/main/agent/ElectronAgentHost.ts (composeHooks 装配)",
      "apps/tabtin-daemon/src/agent/DaemonAgentHost.ts (composeHooks 装配)"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "memory-injector hook 每轮 beforeIteration 触发：读 agentConfig.memory.enabled && injection.auto_inject 都 true 才走召回路径",
      "requiresHostConfig": [
        "agentConfig.memory.enabled",
        "agentConfig.memory.injection.auto_inject"
      ]
    },
    "presenceInProduction": {
      "observed": false,
      "hitSessions": 0,
      "totalSessions": 38,
      "category": "production-cold"
    }
  },
  {
    "id": "plan_create_tool",
    "category": "tool_description",
    "source": "@tabtin/agent-runtime",
    "language": "zh",
    "charBudget": 1200,
    "cacheBreak": false,
    "injectionTiming": "tool-call",
    "role": "tools-array",
    "position": "mid",
    "tier": "medium",
    "description": "Plan 文档创建（chat 内联卡片 + 执行按钮 + '是否执行由用户决定，你不决定' 引导 + 后续 plan_update_todos 必须用本工具返回的 document_id）",
    "writerLocations": [
      "packages/agent-runtime/src/tools/plan-tools.ts:400-405"
    ],
    "renderCondition": {
      "modes": [
        "plan",
        "study"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "tool registry 注册（仅 plan/study mode）"
    },
    "presenceInProduction": {
      "observed": false,
      "hitSessions": 0,
      "totalSessions": 38,
      "category": "production-cold"
    }
  },
  {
    "id": "plan_update_todos_tool",
    "category": "tool_description",
    "source": "@tabtin/agent-runtime",
    "language": "zh",
    "charBudget": 1200,
    "cacheBreak": false,
    "injectionTiming": "tool-call",
    "role": "tools-array",
    "position": "mid",
    "tier": "medium",
    "description": "更新已有 draft Plan todos（merge=true upsert / merge=false 整体替换；不重发 proposal 卡片，chat 保留 plan_create 快照）",
    "writerLocations": [
      "packages/agent-runtime/src/tools/plan-tools.ts:525-530"
    ],
    "renderCondition": {
      "modes": [
        "plan",
        "study"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "tool registry 注册（仅 plan/study mode）"
    },
    "presenceInProduction": {
      "observed": false,
      "hitSessions": 0,
      "totalSessions": 38,
      "category": "production-cold"
    }
  },
  {
    "id": "memory_write_tool",
    "category": "tool_description",
    "source": "host",
    "language": "zh",
    "charBudget": 1200,
    "cacheBreak": false,
    "injectionTiming": "tool-call",
    "role": "tools-array",
    "position": "mid",
    "tier": "medium",
    "description": "写一条长期记忆（about_you / insight / task_summary / skill 类型；不要写琐碎 / 临时信息 / 推理草稿本）",
    "writerLocations": [
      "packages/agent-runtime/src/tools/data-tools.ts:803-807"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "工具决策时（每次进 tools[] 或包装结果）"
    },
    "presenceInProduction": {
      "observed": false,
      "hitSessions": 0,
      "totalSessions": 38,
      "category": "production-cold"
    }
  },
  {
    "id": "memory_delete_tool",
    "category": "tool_description",
    "source": "host",
    "language": "zh",
    "charBudget": 1200,
    "cacheBreak": false,
    "injectionTiming": "tool-call",
    "role": "tools-array",
    "position": "mid",
    "tier": "medium",
    "description": "归档记忆（软删除 / 用户可在 TabMemo UI 恢复 / 先用 memory_search 找 memo_id）",
    "writerLocations": [
      "packages/agent-runtime/src/tools/data-tools.ts:871-874"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "工具决策时（每次进 tools[] 或包装结果）"
    },
    "presenceInProduction": {
      "observed": false,
      "hitSessions": 0,
      "totalSessions": 38,
      "category": "production-cold"
    }
  },
  {
    "id": "credential_lookup_tool",
    "category": "tool_description",
    "source": "host",
    "language": "zh",
    "charBudget": 1200,
    "cacheBreak": false,
    "injectionTiming": "tool-call",
    "role": "tools-array",
    "position": "mid",
    "tier": "medium",
    "description": "按 domain / app_package 查保存的凭证（只返元数据 id / url / username / masked_password；浏览器优先走宿主自动填充）",
    "writerLocations": [
      "packages/agent-runtime/src/tools/data-tools.ts:911-915"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "工具决策时（每次进 tools[] 或包装结果）"
    },
    "presenceInProduction": {
      "observed": false,
      "hitSessions": 0,
      "totalSessions": 38,
      "category": "production-cold"
    }
  },
  {
    "id": "credential_retrieve_tool",
    "category": "tool_description",
    "source": "host",
    "language": "zh",
    "charBudget": 1200,
    "cacheBreak": false,
    "injectionTiming": "tool-call",
    "role": "tools-array",
    "position": "mid",
    "tier": "medium",
    "description": "验证凭证可用性 + 返安全 handle（凭证秘密永不返回 ToolResult.content；走宿主自动填充或 skill runtime 注入；无路径时让用户手动登录）",
    "writerLocations": [
      "packages/agent-runtime/src/tools/data-tools.ts:1007-1011"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "工具决策时（每次进 tools[] 或包装结果）"
    },
    "presenceInProduction": {
      "observed": false,
      "hitSessions": 0,
      "totalSessions": 38,
      "category": "production-cold"
    }
  },
  {
    "id": "skill_create_tool",
    "category": "tool_description",
    "source": "@tabtin/agent-runtime",
    "language": "zh",
    "charBudget": 1200,
    "cacheBreak": false,
    "injectionTiming": "tool-call",
    "role": "tools-array",
    "position": "mid",
    "tier": "medium",
    "description": "结构化参数创建新 skill（完整创建流程 + Agent/Group mode + Space 上下文约束 + kebab-case slug 提取 + 成功后告诉用户'下条消息起可用'）",
    "writerLocations": [
      "packages/agent-runtime/src/tools/skill-create-tool.ts:180-184"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "工具决策时（每次进 tools[] 或包装结果）"
    },
    "presenceInProduction": {
      "observed": false,
      "hitSessions": 0,
      "totalSessions": 38,
      "category": "production-cold"
    }
  },
  {
    "id": "relaunch_app_tool",
    "category": "tool_description",
    "source": "@tabtin/agent-runtime",
    "language": "zh",
    "charBudget": 500,
    "cacheBreak": false,
    "injectionTiming": "tool-call",
    "role": "tools-array",
    "position": "mid",
    "tier": "low-risk",
    "description": "重启宿主进程（macOS TCC 授权后；列出哪些权限立即生效 vs 需要重启；'用户回复就是同意信号，不要主动调'）",
    "writerLocations": [
      "packages/agent-runtime/src/tools/system-tools.ts:104-111"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": false
      },
      "runtimeTrigger": "tool registry 注册（仅 Electron host）"
    },
    "presenceInProduction": {
      "observed": false,
      "hitSessions": 0,
      "totalSessions": 38,
      "category": "production-cold"
    }
  },
  {
    "id": "clear_os_error_blacklist_tool",
    "category": "tool_description",
    "source": "@tabtin/agent-runtime",
    "language": "zh",
    "charBudget": 500,
    "cacheBreak": false,
    "injectionTiming": "tool-call",
    "role": "tools-array",
    "position": "mid",
    "tier": "low-risk",
    "description": "清 runtime OS 错误黑名单（TCC 拒绝 / 杀毒拦截 / 云占位符；不支持整体清；POSIX 子树语义解锁 + 实例展开）",
    "writerLocations": [
      "packages/agent-runtime/src/tools/system-tools.ts:221-230"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "工具决策时（每次进 tools[] 或包装结果）"
    },
    "presenceInProduction": {
      "observed": false,
      "hitSessions": 0,
      "totalSessions": 38,
      "category": "production-cold"
    }
  },
  {
    "id": "mcp_call_tool_tool",
    "category": "tool_description",
    "source": "host",
    "language": "zh",
    "charBudget": 1500,
    "cacheBreak": false,
    "injectionTiming": "tool-call",
    "role": "tools-array",
    "position": "mid",
    "tier": "high-risk",
    "description": "MCP server 工具调用（先 tabtin mcp list-tools 发现可用工具；这是唯一的 MCP 相关 FC；其余发现 / 检查走 tabtin mcp <subcommand> CLI）",
    "writerLocations": [
      "apps/tabtin-electron/src/main/services/local-mcp-agent-tools.ts:54-58"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "tool registry 注册（仅当 host 挂了 MCP server）",
      "requiresHostConfig": [
        "hasMcpServer"
      ]
    },
    "presenceInProduction": {
      "observed": false,
      "hitSessions": 0,
      "totalSessions": 38,
      "category": "production-cold"
    }
  },
  {
    "id": "compact_system_prompt",
    "category": "sideloop_llm_prompt",
    "source": "@tabtin/agent-runtime",
    "language": "zh",
    "charBudget": 600,
    "cacheBreak": false,
    "injectionTiming": "on-demand",
    "role": "system",
    "position": "head",
    "description": "compactConversation() 全量 LLM 摘要调用的 system prompt：引导生成结构化 9 段 summary，强调'你的 summary 会替换原消息——遗漏即永久丢失'",
    "writerLocations": [
      "packages/agent-runtime/src/prompts/compact/system.ts:13-23"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "auto-compact pressure >= 0.85 → compactConversation() 内部 LLM call"
    },
    "presenceInProduction": {
      "observed": false,
      "hitSessions": 0,
      "totalSessions": 38,
      "category": "production-cold"
    }
  },
  {
    "id": "compact_user_prompt",
    "category": "sideloop_llm_prompt",
    "source": "@tabtin/agent-runtime",
    "language": "zh",
    "charBudget": 1800,
    "cacheBreak": false,
    "injectionTiming": "on-demand",
    "role": "user",
    "position": "tail",
    "description": "compactConversation() 全量 LLM 摘要的 user 指令：定义 9 段 summary 结构（User Requests / Key Decisions / Files & Code / Tool Results / Errors & Fixes / Current Status / Next Steps / Active Files State / Important Context）+ 硬约束（不泛化、不丢路径、不调工具）",
    "writerLocations": [
      "packages/agent-runtime/src/prompts/compact/user.ts:12-32"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "auto-compact pressure >= 0.85 → compactConversation() 内部 LLM call"
    },
    "presenceInProduction": {
      "observed": false,
      "hitSessions": 0,
      "totalSessions": 38,
      "category": "production-cold"
    }
  },
  {
    "id": "incremental_compact_system_prompt",
    "category": "sideloop_llm_prompt",
    "source": "@tabtin/agent-runtime",
    "language": "zh",
    "charBudget": 1400,
    "cacheBreak": false,
    "injectionTiming": "on-demand",
    "role": "system",
    "position": "head",
    "description": "INCREMENTAL_COMPACT_SYSTEM_PROMPT_TEMPLATE + buildIncrementalCompactSystemPrompt()：reuse 路径的 system prompt 模板（含 {{PRIOR_SUMMARY}} 槽位）。把 PRIOR_SUMMARY 嵌入 system，避免 LLM 把 prior 当作'用户最新指令'。可选附加 originalSystemPrompt 段（reference only）。",
    "writerLocations": [
      "packages/agent-runtime/src/prompts/compact/incremental-system.ts:13-32 (template)",
      "packages/agent-runtime/src/prompts/compact/incremental-system.ts:43-63 (builder)"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "auto-compact + summary reuse 路径触发（增量摘要，复用 prior summary）"
    },
    "presenceInProduction": {
      "observed": false,
      "hitSessions": 0,
      "totalSessions": 38,
      "category": "production-cold"
    }
  },
  {
    "id": "incremental_compact_user_instruction",
    "category": "sideloop_llm_prompt",
    "source": "@tabtin/agent-runtime",
    "language": "zh",
    "charBudget": 1500,
    "cacheBreak": false,
    "injectionTiming": "on-demand",
    "role": "user",
    "position": "tail",
    "description": "INCREMENTAL_COMPACT_USER_INSTRUCTION：reuse 路径末尾 user 指令——9 段对齐全量 compact，但额外强调 'PRIOR_SUMMARY 内容是 ground truth，必须把每一条具体细节带过来'",
    "writerLocations": [
      "packages/agent-runtime/src/prompts/compact/incremental-user.ts:10-30"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "auto-compact + summary reuse 路径触发"
    },
    "presenceInProduction": {
      "observed": false,
      "hitSessions": 0,
      "totalSessions": 38,
      "category": "production-cold"
    }
  },
  {
    "id": "compact_judge_system_prompt",
    "category": "sideloop_llm_prompt",
    "source": "@tabtin/agent-runtime",
    "language": "zh",
    "charBudget": 1500,
    "cacheBreak": false,
    "injectionTiming": "on-demand",
    "role": "system",
    "position": "head",
    "description": "JUDGE_SYSTEM_PROMPT：summary judge 评分调用的 system prompt——reuse 命中后按概率采样一次评分，对比 PRIOR_SUMMARY + NEW_MESSAGES + UPDATED_SUMMARY，输出 0.0-1.0 score + 一句话 reason",
    "writerLocations": [
      "packages/agent-runtime/src/prompts/compact/judge-system.ts:15-32"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "summary reuse 命中后按采样率（默认 5%）触发质量评估"
    },
    "presenceInProduction": {
      "observed": false,
      "hitSessions": 0,
      "totalSessions": 38,
      "category": "production-cold"
    }
  },
  {
    "id": "compact_judge_user_prompt_builder",
    "category": "sideloop_llm_prompt",
    "source": "@tabtin/agent-runtime",
    "language": "zh",
    "charBudget": 450,
    "cacheBreak": false,
    "injectionTiming": "on-demand",
    "role": "user",
    "position": "tail",
    "description": "buildJudgeUserPrompt()：judge 调用的 user prompt builder——拼接 PRIOR_SUMMARY / NEW_MESSAGES（轻量预览，先用 renderMessagesPreviewForJudge 压成 ≤ 4_000 chars）/ UPDATED_SUMMARY + 评分指令",
    "writerLocations": [
      "packages/agent-runtime/src/prompts/compact/judge-user.ts:16-40"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "summary reuse 命中后按采样率触发"
    },
    "presenceInProduction": {
      "observed": false,
      "hitSessions": 0,
      "totalSessions": 38,
      "category": "production-cold"
    }
  },
  {
    "id": "compact_continuing_ack",
    "category": "assistant_ack",
    "source": "@tabtin/agent-runtime",
    "language": "zh",
    "charBudget": 30,
    "cacheBreak": false,
    "injectionTiming": "on-demand",
    "role": "assistant",
    "position": "mid",
    "description": "CONTINUING_ACK = 'Continuing.'——compact 拼装 LLM 调用消息时维持 user/assistant role alternation，当被压缩段最末是 user 消息时插入空 assistant 占位（compact.ts:230, 608, 1048 历史 inline，E1 资源化为本常量）",
    "writerLocations": [
      "packages/agent-runtime/src/prompts/compact/inline-acks.ts:18"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "compact LLM 调用前最后一条 user 是工具结果时 inline ack 维持 user/assistant 交替"
    },
    "presenceInProduction": {
      "observed": false,
      "hitSessions": 0,
      "totalSessions": 38,
      "category": "production-cold"
    }
  },
  {
    "id": "compact_understood_ack",
    "category": "assistant_ack",
    "source": "@tabtin/agent-runtime",
    "language": "zh",
    "charBudget": 80,
    "cacheBreak": false,
    "injectionTiming": "on-demand",
    "role": "assistant",
    "position": "mid",
    "description": "UNDERSTOOD_ACK = 'Understood. Continuing from recent context.'——buildCompactedMessages 在 summary 与 messagesToKeep 之间插入 assistant ack，维持 role alternation",
    "writerLocations": [
      "packages/agent-runtime/src/prompts/compact/inline-acks.ts:21"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "compact 成功且 messagesToKeep[0] 非 assistant 时插入维持顺序"
    },
    "presenceInProduction": {
      "observed": false,
      "hitSessions": 0,
      "totalSessions": 38,
      "category": "production-cold"
    }
  },
  {
    "id": "compact_summary_wrapper",
    "category": "user_wrapper",
    "source": "@tabtin/agent-runtime",
    "language": "zh",
    "charBudget": 400,
    "cacheBreak": false,
    "injectionTiming": "on-demand",
    "role": "user",
    "position": "head",
    "description": "buildCompactedSummaryWrapper()：把 LLM 输出的 summary 包成 [Conversation Summary] header + body + [End of summary] footer + 可选 transcriptPath 段 + [Recent conversation follows] marker——拼成单条 user message 替换原历史",
    "writerLocations": [
      "packages/agent-runtime/src/prompts/compact/wrapper.ts:17 (RECENT_CONVERSATION_MARKER)",
      "packages/agent-runtime/src/prompts/compact/wrapper.ts:20-21 (SUMMARY_HEADER/FOOTER)",
      "packages/agent-runtime/src/prompts/compact/wrapper.ts:43-58 (builder)",
      "packages/agent-runtime/src/prompts/compact/wrapper.ts:64 (SUMMARY_HEADER_MARKER export)"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "compact 成功 → buildCompactedSummaryWrapper 拼装 summary user message"
    },
    "presenceInProduction": {
      "observed": false,
      "hitSessions": 0,
      "totalSessions": 38,
      "category": "production-cold"
    }
  },
  {
    "id": "compact_chunk_too_large_marker",
    "category": "sideloop_llm_prompt",
    "source": "@tabtin/agent-runtime",
    "language": "zh",
    "charBudget": 60,
    "cacheBreak": false,
    "injectionTiming": "on-demand",
    "role": "user",
    "position": "mid",
    "description": "CHUNK_TOO_LARGE_MARKER = '[Chunk too large to summarize, trimmed]'——chunkedCompact 把超大 messagesToSummarize 切片调用 LLM 时单 chunk 自身仍超 token 上限抛错，summary 用本 marker 兜底拼回，让用户和后续轮次知道这部分被跳过而不是丢失",
    "writerLocations": [
      "packages/agent-runtime/src/prompts/compact/fallbacks.ts:15"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "chunked compact 单 chunk 超限（413 / too long）回退占位"
    },
    "presenceInProduction": {
      "observed": false,
      "hitSessions": 0,
      "totalSessions": 38,
      "category": "production-cold"
    }
  },
  {
    "id": "compact_restored_file_context",
    "category": "user_wrapper",
    "source": "@tabtin/agent-runtime",
    "language": "zh",
    "charBudget": 100,
    "cacheBreak": false,
    "injectionTiming": "on-demand",
    "role": "user",
    "position": "tail",
    "description": "buildRestoredFileContext() + RestoredFileEntry：Wave 8 设计——压缩后把'压缩前出现过的文件 read result'重新注入到 summary user message 末尾（在 RECENT_CONVERSATION_MARKER 之前），让 Agent 不需要'压缩后第一件事是重新 read_file'就能继续工作",
    "writerLocations": [
      "packages/agent-runtime/src/prompts/compact/file-restore.ts:16 (RESTORED_FILES_HEADER)",
      "packages/agent-runtime/src/prompts/compact/file-restore.ts:18-25 (RestoredFileEntry type)",
      "packages/agent-runtime/src/prompts/compact/file-restore.ts:49-57 (builder)"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "正常 compact 成功且 postCompactAttachmentBudget > 0（默认 20k tokens）→ 文件恢复段"
    },
    "presenceInProduction": {
      "observed": false,
      "hitSessions": 0,
      "totalSessions": 38,
      "category": "production-cold"
    }
  },
  {
    "id": "compact_context_truncated_placeholder",
    "category": "user_wrapper",
    "source": "@tabtin/agent-runtime",
    "language": "zh",
    "charBudget": 90,
    "cacheBreak": false,
    "injectionTiming": "on-demand",
    "role": "user",
    "position": "mid",
    "description": "CONTEXT_TRUNCATED_PLACEHOLDER = '\\n\\n... [content truncated for context budget] ...\\n\\n'——extractFileAttachments 计算单文件 token 数超 maxPerFile 预算时，取头尾切片中间用本占位字符串拼接",
    "writerLocations": [
      "packages/agent-runtime/src/prompts/compact/truncation-placeholder.ts:15-16"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "post-compact 文件恢复段单文件超预算时头尾保留 + 中间占位"
    },
    "presenceInProduction": {
      "observed": false,
      "hitSessions": 0,
      "totalSessions": 38,
      "category": "production-cold"
    }
  },
  {
    "id": "time_based_microcompact_cleared_message",
    "category": "tool_result_wrap",
    "source": "@tabtin/agent-runtime",
    "language": "zh",
    "charBudget": 60,
    "cacheBreak": false,
    "injectionTiming": "every-turn",
    "role": "user",
    "position": "mid",
    "description": "TIME_BASED_MC_CLEARED_MESSAGE = '[Old tool result content cleared]'——time-based microcompact 把超过 message age 阈值的 tool_result.content 替换为本字符串。区别 layered-prune：time-based 按时间清理（每轮检查），layered-prune 按 emergency pressure 清理",
    "writerLocations": [
      "packages/agent-runtime/src/prompts/compact/time-based-cleared.ts:17",
      "packages/agent-runtime/src/compact/time-based-microcompact.ts:152-153 (import + re-export)"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "pressure >= 0.75 + timeBased.enabled + 距最后 assistant >= gapThresholdMinutes（默认 30）"
    },
    "presenceInProduction": {
      "observed": false,
      "hitSessions": 0,
      "totalSessions": 38,
      "category": "production-cold"
    }
  },
  {
    "id": "auto_compact_emergency_layered_prune_summary",
    "category": "sideloop_llm_prompt",
    "source": "@tabtin/agent-runtime",
    "language": "zh",
    "charBudget": 120,
    "cacheBreak": false,
    "injectionTiming": "on-demand",
    "role": "user",
    "position": "head",
    "description": "auto-compact emergency 档 layered prune 成功后用作 summary 字段的兜底文案：'[Emergency layered prune freed ~${freedTokens} tokens — LLM summary skipped]'。layered prune 释放够 → 跳过 LLM compact 直接用本字符串当 summary 占位",
    "writerLocations": [
      "packages/agent-runtime/src/compact/auto-compact.ts:171"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "emergency 档（pressure >= 0.95）+ layered-prune 释放成功（压力压回阈值以下）"
    },
    "presenceInProduction": {
      "observed": false,
      "hitSessions": 0,
      "totalSessions": 38,
      "category": "production-cold"
    }
  },
  {
    "id": "auto_compact_emergency_hard_trim_fallback",
    "category": "sideloop_llm_prompt",
    "source": "@tabtin/agent-runtime",
    "language": "zh",
    "charBudget": 80,
    "cacheBreak": false,
    "injectionTiming": "on-demand",
    "role": "user",
    "position": "head",
    "description": "auto-compact emergency 档 LLM compact 失败的兜底 summary：'[Emergency hard trim — LLM summary unavailable]'。hardTrim 之后 compactConversation 抛错 → 用本字符串作 summary",
    "writerLocations": [
      "packages/agent-runtime/src/compact/auto-compact.ts:220"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "emergency 档 + hard trim + LLM summary 失败兜底"
    },
    "presenceInProduction": {
      "observed": false,
      "hitSessions": 0,
      "totalSessions": 38,
      "category": "production-cold"
    }
  },
  {
    "id": "auto_compact_soft_trim_fallback",
    "category": "sideloop_llm_prompt",
    "source": "@tabtin/agent-runtime",
    "language": "zh",
    "charBudget": 80,
    "cacheBreak": false,
    "injectionTiming": "on-demand",
    "role": "user",
    "position": "head",
    "description": "auto-compact 中间档（0.85 ≤ p < 0.95）LLM compact 失败的兜底 summary：'[Soft trim fallback — LLM summary unavailable]'。compactConversation 抛错 → softTrim 兜底 + 本字符串作 summary",
    "writerLocations": [
      "packages/agent-runtime/src/compact/auto-compact.ts:267"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "中间档（0.85-0.95）+ LLM summary 失败兜底走 softTrim"
    },
    "presenceInProduction": {
      "observed": false,
      "hitSessions": 0,
      "totalSessions": 38,
      "category": "production-cold"
    }
  },
  {
    "id": "layered_prune_placeholder",
    "category": "tool_result_wrap",
    "source": "@tabtin/agent-runtime",
    "language": "zh",
    "charBudget": 120,
    "cacheBreak": false,
    "injectionTiming": "on-demand",
    "role": "user",
    "position": "mid",
    "description": "buildPrunePlaceholder(toolName) = '[compacted: ${toolName} output cleared — only recent outputs are preserved]'——emergency 档 layeredPrune() 把保护窗口外的非 PROTECTED_TOOLS tool_result 替换为本占位",
    "writerLocations": [
      "packages/agent-runtime/src/compact/layered-prune.ts:94-96"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "emergency 档（pressure >= 0.95）+ layered-prune 占位"
    },
    "presenceInProduction": {
      "observed": false,
      "hitSessions": 0,
      "totalSessions": 38,
      "category": "production-cold"
    }
  },
  {
    "id": "compaction_orchestrator_summary_message_shadow",
    "category": "user_wrapper",
    "source": "@tabtin/agent-runtime",
    "language": "zh",
    "charBudget": 400,
    "cacheBreak": false,
    "injectionTiming": "on-demand",
    "role": "user",
    "position": "head",
    "description": "buildSummaryMessage()（compaction-orchestrator.ts:904）reactive 路径专用——pendingCondenseSummary 信号（types.ts ToolResultSignals.pendingCondense）被任何工具推一份 summary 时拼装。当前无内置生产者；channel 仅保留给未来工具（譬如外部 changelog 摘要）opt-in",
    "writerLocations": [
      "packages/agent-runtime/src/compact/compaction-orchestrator.ts:904-917 (builder)",
      "packages/agent-runtime/src/compact/compaction-orchestrator.ts:296 (调用点：state.pendingCondenseSummary 被消费时)"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "reactive pendingCondense 触发（无内置生产者，W3 已删 summarize_context）"
    },
    "presenceInProduction": {
      "observed": false,
      "hitSessions": 0,
      "totalSessions": 38,
      "category": "production-cold"
    }
  },
  {
    "id": "subagent_summary_microcompact_truncation",
    "category": "tool_result_wrap",
    "source": "@tabtin/agent-runtime",
    "language": "zh",
    "charBudget": 100,
    "cacheBreak": false,
    "injectionTiming": "tool-call",
    "role": "user",
    "position": "mid",
    "description": "microCompactSubagentSummary() 截断模板：'... [${omitted} characters truncated by microCompactSubagentSummary] ...'——子 Agent 完成时返回的 summary > maxChars (默认 10K) 时'保头 2K + 保尾 6K + 中间省略'拼装本占位",
    "writerLocations": [
      "packages/agent-runtime/src/compact/subagent-summary.ts:165",
      "packages/agent-runtime/src/compact/subagent-summary.ts:137 (overhead 估算用)"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "子 agent 成功 + summary > 10000 字符触发头 2k + 尾 6k + 中间截断标记"
    },
    "presenceInProduction": {
      "observed": false,
      "hitSessions": 0,
      "totalSessions": 38,
      "category": "production-cold"
    }
  },
  {
    "id": "subagent_fork_policy_redaction_placeholder",
    "category": "tool_result_wrap",
    "source": "@tabtin/agent-runtime",
    "language": "zh",
    "charBudget": 150,
    "cacheBreak": false,
    "injectionTiming": "tool-call",
    "role": "user",
    "position": "mid",
    "description": "policyFilter() 注入的 redaction 占位：'[REDACTED: tool result unavailable (source removed by compaction)]'（toolName 未知时）或 '[REDACTED: ${toolName} out of sub-agent scope]'——subagent inheritMode + policy（tool_whitelist/blacklist）启用时把 scope 外的 tool_result.content 替换为本占位",
    "writerLocations": [
      "packages/agent-runtime/src/engine/fork-query.ts:270-272"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "fork 子 agent 时按 policy 脱敏父对话历史中的敏感字段"
    },
    "presenceInProduction": {
      "observed": false,
      "hitSessions": 0,
      "totalSessions": 38,
      "category": "production-cold"
    }
  },
  {
    "id": "context_pruning_chinese_truncation_placeholder",
    "category": "tool_result_wrap",
    "source": "@tabtin/agent-runtime",
    "language": "zh",
    "charBudget": 50,
    "cacheBreak": false,
    "injectionTiming": "on-demand",
    "role": "user",
    "position": "mid",
    "description": "softTrim() 把 tool_result.content 替换为中文占位 '[对话历史因长度限制已被截断。之前的内容已移除。]'——auto-compact 中间档 LLM compact 失败时的兜底（auto-compact.ts:263 调 softTrim）",
    "writerLocations": [
      "packages/agent-runtime/src/compact/context-pruning.ts:379"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "auto-compact LLM summary 失败兜底走 softTrim/hardTrim 时占位"
    },
    "presenceInProduction": {
      "observed": false,
      "hitSessions": 0,
      "totalSessions": 38,
      "category": "production-cold"
    }
  },
  {
    "id": "context_pruning_chinese_dropped_messages_notice",
    "category": "user_wrapper",
    "source": "@tabtin/agent-runtime",
    "language": "zh",
    "charBudget": 60,
    "cacheBreak": false,
    "injectionTiming": "on-demand",
    "role": "user",
    "position": "head",
    "description": "hardTrim() 在被砍消息位置 prepend 中文 notice：'[对话历史因长度限制已被截断。之前的 ${dropCount} 条消息已移除。]'——auto-compact emergency 档 LLM compact 失败时（auto-compact.ts:194 调 hardTrim）兜底",
    "writerLocations": [
      "packages/agent-runtime/src/compact/context-pruning.ts:451"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "auto-compact LLM summary 失败兜底 + 真砍消息时通知"
    },
    "presenceInProduction": {
      "observed": false,
      "hitSessions": 0,
      "totalSessions": 38,
      "category": "production-cold"
    }
  },
  {
    "id": "context_pruning_hardtrim_understood_ack",
    "category": "assistant_ack",
    "source": "@tabtin/agent-runtime",
    "language": "zh",
    "charBudget": 30,
    "cacheBreak": false,
    "injectionTiming": "on-demand",
    "role": "assistant",
    "position": "head",
    "description": "hardTrim() 在 kept[0] 是 user 时插入的 assistant ack 'Understood.'——维持 user→assistant 交替（hardTrim 砍掉前 N 条后保证拼回的消息序列合法）",
    "writerLocations": [
      "packages/agent-runtime/src/compact/context-pruning.ts:457-459"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "context-pruning hardTrim 后保留 ack 维持 user/assistant 交替"
    },
    "presenceInProduction": {
      "observed": false,
      "hitSessions": 0,
      "totalSessions": 38,
      "category": "production-cold"
    }
  },
  {
    "id": "subagent_summary_helper_renderpreview_truncated",
    "category": "sideloop_llm_prompt",
    "source": "@tabtin/agent-runtime",
    "language": "zh",
    "charBudget": 100,
    "cacheBreak": false,
    "injectionTiming": "on-demand",
    "role": "user",
    "position": "mid",
    "description": "renderMessagesPreviewForJudge() 内嵌截断 marker：'...[truncated for judge prompt]'（line 51）+ '[thinking N chars]'/'[N blocks]'/'[image]'/'[tool_use name=… id=…]'/'[tool_result tool_use_id=… is_error=true: …]' 一组 block 简化占位 + clip() 末尾 '...[clipped N chars]'",
    "writerLocations": [
      "packages/agent-runtime/src/compact/incremental-prompt.ts:51 (truncated marker)",
      "packages/agent-runtime/src/compact/incremental-prompt.ts:79-91 (block placeholders)",
      "packages/agent-runtime/src/compact/incremental-prompt.ts:99 (clip marker)"
    ],
    "renderCondition": {
      "modes": [
        "agent",
        "plan",
        "ask",
        "study",
        "group"
      ],
      "hosts": {
        "electron": true,
        "daemon": true
      },
      "runtimeTrigger": "judge prompt 用 NEW_MESSAGES 预览（>4000 字符截断）"
    },
    "presenceInProduction": {
      "observed": false,
      "hitSessions": 0,
      "totalSessions": 38,
      "category": "production-cold"
    }
  },
];
