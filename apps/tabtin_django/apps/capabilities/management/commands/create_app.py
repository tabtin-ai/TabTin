"""
App 脚手架（当前主要面向 builtin App 骨架生成）。

生成 App 自身目录 + 尝试修改若干常见接触面，帮助开发者快速起步。
注意：它不是 App 契约权威源，当前仍保留部分历史注册写法，不能替代
`packages/apps/*/app.json` 与 create-builtin-app 文档。

注册解耦后，以下文件已改为约定式自动注册，无需脚手架写入：
  - prompts/apps/__init__.py（pkgutil 自动扫描）
  - registry/index.ts（import.meta.glob 自动注册）
  - i18n/index.ts + lazy-backend.ts（import.meta.glob 自动推导）

用法:
    python manage.py create_app tabxxx
    python manage.py create_app tabxxx --name TabXxx --icon file-text
    python manage.py create_app tabxxx --context-fields current_tabxxx_id current_tabxxx_title
    python manage.py create_app tabxxx --with-tools --with-prompt --with-cli
    python manage.py create_app tabxxx --dry-run    # 仅预览不执行
"""

from __future__ import annotations

import re
from pathlib import Path

from django.core.management.base import BaseCommand

from apps.services.repo_root import get_repo_root

_ROOT = get_repo_root()
_DJ = _ROOT / "apps" / "tabtin_django"
_APPS = _DJ / "apps"
_REN = _ROOT / "apps" / "tabtin-electron" / "src" / "renderer" / "src"

DONE = "✓"
SKIP = "⊘"
FAIL = "✗"
NEW = "+"


# ═══════════════════════════════════════════════════════════
#  File helpers
# ═══════════════════════════════════════════════════════════

def _read(p: Path) -> str:
    try:
        return p.read_text("utf-8", errors="ignore")
    except Exception:
        return ""


def _write(p: Path, content: str, dry: bool) -> bool:
    if dry:
        return True
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, "utf-8")
    return True


def _write_new(p: Path, content: str, dry: bool) -> str:
    """Write only if file doesn't exist. Returns status."""
    if p.exists():
        return SKIP
    _write(p, content, dry)
    return NEW


def _insert_before(p: Path, marker: str, block: str, dry: bool) -> str:
    """Insert block before the line containing marker. Idempotent."""
    content = _read(p)
    check = block.strip()
    if check and check in content:
        return SKIP
    idx = content.find(marker)
    if idx == -1:
        return FAIL
    ls = content.rfind("\n", 0, idx)
    ls = ls + 1 if ls != -1 else 0
    new = content[:ls] + block + "\n" + content[ls:]
    if not dry:
        p.write_text(new, "utf-8")
    return DONE


def _insert_after(p: Path, marker: str, block: str, dry: bool) -> str:
    """Insert block after the line containing marker. Idempotent."""
    content = _read(p)
    check = block.strip()
    if check and check in content:
        return SKIP
    idx = content.find(marker)
    if idx == -1:
        return FAIL
    eol = content.find("\n", idx + len(marker))
    if eol == -1:
        eol = len(content)
    new = content[:eol] + "\n" + block + content[eol:]
    if not dry:
        p.write_text(new, "utf-8")
    return DONE


def _append_to_str(p: Path, marker: str, append_text: str, dry: bool) -> str:
    """Append text inline after marker (same line). Idempotent."""
    content = _read(p)
    if append_text.strip() in content:
        return SKIP
    idx = content.find(marker)
    if idx == -1:
        return FAIL
    new = content[:idx + len(marker)] + append_text + content[idx + len(marker):]
    if not dry:
        p.write_text(new, "utf-8")
    return DONE


def _insert_into_ts_array(
    p: Path,
    array_name: str,
    entry_block: str,
    dry: bool,
) -> str:
    content = _read(p)
    check = entry_block.strip()
    if check and check in content:
        return SKIP

    match = re.search(rf"(?:export\s+)?const\s+{re.escape(array_name)}\b[^\n]*=\s*\[", content)
    if not match:
        return FAIL

    arr_start = match.end()
    close_match = re.search(r"\n[ \t]*\]", content[arr_start:])
    if not close_match:
        return FAIL
    close_idx = arr_start + close_match.start()

    line_start = content.rfind("\n", 0, close_idx) + 1
    new = content[:line_start] + entry_block.rstrip() + "\n" + content[line_start:]
    if not dry:
        p.write_text(new, "utf-8")
    return DONE


# ═══════════════════════════════════════════════════════════
#  Name helpers
# ═══════════════════════════════════════════════════════════

def _display_name(app_id: str) -> str:
    if app_id.startswith("tab"):
        rest = app_id[3:]
        return "Tab" + rest[0].upper() + rest[1:] if rest else "Tab"
    return app_id[0].upper() + app_id[1:]


def _class_name(app_id: str) -> str:
    return app_id[0].upper() + app_id[1:]


# ═══════════════════════════════════════════════════════════
#  Templates
# ═══════════════════════════════════════════════════════════

def T_APPS_PY(app_id: str, config_cls: str) -> str:
    return f'''from django.apps import AppConfig


class {config_cls}(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.{app_id}"
    label = "{app_id}"
'''


def T_MODELS_PY(app_id: str, app_name: str, ctx_type: str) -> str:
    model_cls = _class_name(app_id) + "Document"
    return f'''"""
{app_name} 数据模型

【开发指南 — Agent 请仔细阅读】

1. 基类 ProjectResourceModel 已内置:
   - project_id    项目关联（ForeignKey -> tabtinspace.Project）
   - status        状态字段（CharField）
   - created_at    创建时间
   - updated_at    更新时间
   - extra_data    JSONField 扩展字段

2. 必须实现的方法:
   - get_context_type() -> str  返回 context_type，与 app_registry 中定义一致
   - get_context_title() -> str 返回资源标题，用于 Agent 上下文展示

3. 添加业务字段时:
   - 必填字段设置 default 或 blank=True，避免迁移时报错
   - 大文本字段用 TextField，短文本用 CharField(max_length=N)
   - 枚举类型用 CharField + choices
   - JSON 结构化数据用 JSONField(default=dict)

4. ForeignKey 约束:
   - 跨数据库引用（如引用 MySQL 的 User）必须加 db_constraint=False
   - related_name="+" 表示不创建反向关系（推荐，减少不必要的关联查询）

5. 迁移:
   - 此模型存储在 PostgreSQL，迁移命令:
     python manage.py makemigrations {app_id}
     python manage.py migrate {app_id} --database=postgresql
"""

from django.db import models

from apps.services.common.base_models import ProjectResourceModel


class {model_cls}(ProjectResourceModel):
    """{app_name} 主资源模型。"""

    title = models.CharField(max_length=255, default="")
    # TODO: 在此添加业务字段
    # content = models.TextField(default="", blank=True)
    # doc_type = models.CharField(max_length=50, default="default", choices=[...])

    created_by = models.ForeignKey(
        "users_auth.User", null=True, blank=True,
        on_delete=models.SET_NULL, db_constraint=False,
        related_name="+",
    )
    updated_by = models.ForeignKey(
        "users_auth.User", null=True, blank=True,
        on_delete=models.SET_NULL, db_constraint=False,
        related_name="+",
    )

    class Meta:
        db_table = "{app_id}_documents"
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["project_id", "status"], name="{app_id[:4]}_proj_st_idx"),
        ]

    def get_context_type(self) -> str:
        return "{ctx_type}"

    def get_context_title(self) -> str:
        return self.title or ""
'''


def T_API_PY(app_id: str, app_name: str) -> str:
    model_cls = _class_name(app_id) + "Document"
    return f'''"""
{app_name} API

【开发指南 — Agent 请仔细阅读】

1. 响应格式:
   - 成功: success_response(data)  → {{"success": true, "data": ...}}
   - 失败: error_response(error_code, message, status)
           → {{"success": false, "error_code": "...", "message": "..."}}
   - 所有接口必须使用这两个函数，禁止手动构造响应

2. 认证:
   - router 已配置 JWTAuth()，所有接口自动需要认证
   - request.auth 是 User 模型实例（不是 dict）
   - 获取用户 ID: str(request.auth.id)
   - 获取工作区: 从 request headers 或 query params 获取

3. 分页约定:
   - 列表接口接受 page/page_size 参数
   - 返回 {{"items": [...], "total": N, "page": P, "page_size": PS}}

4. 写接口:
   - 必须在 schemas.py 中定义 Input Schema（Pydantic BaseModel）
   - POST 创建 / PUT 更新 / DELETE 删除
   - 写接口需要校验 project 归属权限

5. Service 层:
   - 复杂业务逻辑抽到 services/ 目录
   - API 层只做参数校验 + 调用 Service + 格式化返回
"""

from ninja import Router

from apps.users.auth.permissions import JWTAuth
from apps.i18n.response import success_response, error_response

router = Router(auth=JWTAuth())


@router.get("/list")
def list_{app_id}(request, project_id: str = None, page: int = 1, page_size: int = 20):
    """{app_name} 资源列表。"""
    user = request.auth

    # TODO: 实现查询逻辑
    # from apps.{app_id}.models import {model_cls}
    # qs = {model_cls}.objects.filter(project_id=project_id)
    # total = qs.count()
    # items = list(qs[(page-1)*page_size : page*page_size].values())
    # return success_response({{"items": items, "total": total, "page": page, "page_size": page_size}})

    return success_response({{"items": [], "total": 0, "page": page, "page_size": page_size}})
'''


def T_DB_ROUTER_PY(app_id: str) -> str:
    cls = _class_name(app_id) + "Router"
    return f'''"""
数据库路由 — 将 {app_id} 的所有模型操作路由到 PostgreSQL

【注意】此 App 的 migrate 命令必须加 --database=postgresql:
  python manage.py migrate {app_id} --database=postgresql

如果遗漏该参数，迁移会被误记录到 MySQL 的 django_migrations 表，
而 PostgreSQL 实际未执行 DDL，运行时报 column does not exist。
"""

from apps.services.common.db_router import PostgresAppRouter


class {cls}(PostgresAppRouter):
    route_app_labels = {{"{app_id}"}}
'''


def T_PROMPT_PY(app_id: str, app_name: str) -> str:
    const = f"SECTION_{app_id.upper()}"
    return f'''"""
{app_name} App 提示词 — Agent System Prompt 片段

【开发指南 — Agent 请仔细阅读】

1. 此变量会在用户聚焦 {app_name} 时自动拼接到 Agent System Prompt 中
2. 命名必须是 SECTION_{{大写APP_ID}}，才能被 APP_SECTIONS 自动扫描注册
3. 提示词编写要求:
   - 第一段: 告诉 Agent「用户正在什么场景」
   - 第二段: 描述此 App 的核心能力和可用工具
   - 第三段: 操作约束和注意事项
   - 关键: 不要教 Agent Python/JS 语法，而是告诉它「什么时候该用哪个工具」
4. 可以用 {{变量}} 引用运行时上下文（如当前资源 ID），
   但注意这些变量由 prompt 渲染引擎提供
"""

{const} = \"\"\"
## {app_name}

当前用户正在使用 {app_name} 模块。

### 可用能力

- 查询和管理 {app_name} 资源
- TODO: 列出本 App 的核心能力

### 可用工具

- `{app_id}.list`: 列出资源
- TODO: 列出关联的 FC 工具及其用途

### 操作约束

- 修改/删除操作需要用户确认
- TODO: 列出领域特定的约束规则
\"\"\"
'''


def T_HANDLER_TSX(app_id: str, app_name: str, handler_var: str, icon: str,
                  rid_field: str, *, searchable: bool = True) -> str:
    icon_cls = "".join(w.capitalize() for w in icon.split("-"))
    pane = _class_name(app_id) + "PaneHost"
    short = _class_name(app_id)
    search_block = ""
    if searchable:
        search_block = f"""
  searchable: true,
  searchLabelKey: 'organization:search.{app_id}',"""
    return f'''/**
 * {app_name} ContextTypeHandler — 前端 App 注册入口
 *
 * 【开发指南 — Agent 请仔细阅读】
 *
 * 1. 此文件是 App 在前端的核心注册，由 import.meta.glob 自动发现
 *    只要放在 handlers/ 目录并 export 一个 ContextTypeHandler，即可注册
 *
 * 2. 必须实现的字段:
 *    - type / appId:    与后端 app_registry 中的 id 一致
 *    - displayLabel:    侧边栏和 Tab 显示的 App 名称
 *    - getTabLabel:     每个 Tab 的标题（从 item 中提取）
 *    - getTabIcon:      Tab 图标（Lucide React 组件）
 *    - renderPane:      渲染主面板，item.id 是资源 ID
 *
 * 3. PaneHost 组件:
 *    - 使用 React.lazy 懒加载，路径: @components/{{app_id}}/{{PaneHost}}
 *    - 你需要在 src/components/{{app_id}}/ 下创建该组件
 *    - PaneHost 接收 resourceId 和 className 两个 props
 *
 * 4. 图标:
 *    - 从 lucide-react 导入，当前使用 {icon_cls}
 *    - 图标列表: https://lucide.dev/icons/
 *
 * 5. quickAction:
 *    - 控制「新建」按钮在首页面板的显示
 *    - 实际创建回调需要在 useCreateHandlers.ts 中注册
 */

import React from 'react'
import {{ {icon_cls} }} from 'lucide-react'
import type {{ ContextTypeHandler }} from '../types'
import i18n from '@/i18n'

const {pane} = React.lazy(
  () => import('@components/{app_id}/{pane}').then(m => ({{ default: m.{pane} }}))
)

export const {handler_var}: ContextTypeHandler = {{
  type: '{app_id}',
  appId: '{app_id}',
  persistOnly: true,
  displayLabel: '{app_name}',
  displayEmoji: '📄',{search_block}
  appMeta: {{ idField: '{rid_field}' }},

  quickAction: {{
    icon: <{icon_cls} className="h-5 w-5" />,
    labelKey: 'context:home.quickActions.new{short}',
  }},

  getTabLabel: (item) => item.title || i18n.t('label.untitled', {{ ns: '{app_id}' }}),

  getTabIcon: () => <{icon_cls} className="h-4 w-4 shrink-0" />,

  renderPane: (item, ctx) => (
    <React.Suspense
      fallback={{
        <div className="flex h-full items-center justify-center">
          <span className="text-sm text-muted-foreground">Loading...</span>
        </div>
      }}
    >
      <div
        className="h-full w-full"
        onPointerDownCapture={{() => ctx?.onPaneInteraction?.()}}
        onFocusCapture={{() => ctx?.onPaneInteraction?.()}}
      >
        <{pane} resourceId={{item.id}} className="h-full w-full" />
      </div>
    </React.Suspense>
  ),
}}
'''


def T_HOME_SECTION_TSX(app_id: str, app_name: str, hs_var: str, icon: str) -> str:
    icon_cls = "".join(w.capitalize() for w in icon.split("-"))
    short = _class_name(app_id)
    return f'''import {{ {icon_cls} }} from 'lucide-react'
import {{ createResourceListSection }} from './ResourceListSection'

export const {hs_var} = createResourceListSection({{
  appId: '{app_id}',
  icon: {icon_cls},
  createLabelKey: 'home.assetBrowser.new{short}',
  emptyLabelKey: 'home.assetBrowser.{app_id}Empty',
  unavailableLabelKey: 'home.assetBrowser.{app_id}Unavailable',
  untitledLabelKey: 'label.untitled{short}',
  tabLabelKey: 'home.assetBrowser.{app_id}',
}})
'''


def T_I18N_ZH(app_name: str, app_id: str) -> str:
    short = _class_name(app_id)
    return f'''{{"home": {{"assetBrowser": {{"new{short}": "新建{app_name}","{app_id}Empty": "暂无{app_name}","{app_id}Unavailable": "{app_name}不可用","{app_id}": "{app_name}"}}}},"label": {{"untitled": "未命名{app_name}"}}}}'''


def T_I18N_EN(app_name: str, app_id: str) -> str:
    short = _class_name(app_id)
    return f'''{{"home": {{"assetBrowser": {{"new{short}": "New {app_name}","{app_id}Empty": "No {app_name} yet","{app_id}Unavailable": "{app_name} unavailable","{app_id}": "{app_name}"}}}},"label": {{"untitled": "Untitled {app_name}"}}}}'''


def T_TOOL_REGISTRY_PY(app_id: str, app_name: str) -> str:
    return f'''"""
{app_name} HTTP API 服务实现集

【W6 后注意 — 本目录不再向 ToolHub 注册 LLM 工具】

宪法不变量 1（W6 落地）：本地 TS Runtime 是 LLM 工具的唯一来源。
本目录下的 BaseTool 子类作为 **HTTP API 服务实现**保留——给 view / CLI route handler 调用，
不再出现在 LLM 工具表里。

LLM 触达本域能力的正确路径：
  - 走 tabtin CLI：`tabtin {app_id} <verb>` → CLI Server route → 调本目录下服务实现
  - 走前端 Action Tool：在 `packages/action-tools/src/tools/{app_id}/` 声明 FC

不要再调 `ToolHub.register_provider`——那是 W6 前的死路径。
"""

from apps.services.tools import BaseTool


def get_{app_id}_tools() -> list[BaseTool]:
    """返回 {app_name} 域的所有 HTTP API 服务实现（仅供 view / CLI route 使用）。"""
    # TODO: 添加 BaseTool 子类实例
    # from .my_tool import MyToolTool
    # return [MyToolTool()]
    return []
'''


def T_CLI_COMMAND_TS(app_id: str, app_name: str) -> str:
    short = app_id
    fn = "".join(w.capitalize() for w in short.split("_"))
    return f'''/**
 * tabtin {short} — {app_name} CLI commands.
 *
 * 【开发指南】
 * - transport.request(method, path) 发起请求到 CLI Server
 * - handleCommandError 统一处理非 200 响应
 * - 新增子命令: 复制 list 命令块，修改 command/description/action
 * - 写操作用 POST/PUT/DELETE，读操作用 GET
 */

import {{ Command }} from 'commander'
import {{ getTransport }} from '../transport/index.js'
import {{ formatOutput, type OutputFormat }} from '../formatters/json.js'
import {{ handleCommandError }} from '../errors/index.js'

export function register{fn}Command(program: Command) {{
  const cmd = program.command('{short}').description('{app_name} operations')

  cmd
    .command('list')
    .description('List {app_name} resources')
    .option('-f, --format <format>', 'Output format', 'json')
    .action(async (opts) => {{
      try {{
        const transport = getTransport()
        const res = await transport.request('GET', '/{short}/list')
        if (res.status !== 200) {{
          handleCommandError(res, {{ context: '{short} list' }})
          return
        }}
        process.stdout.write(formatOutput(res.data?.data?.items ?? res.data?.data ?? [], opts.format as OutputFormat) + '\\n')
      }} catch (err: unknown) {{
        const message = err instanceof Error ? err.message : String(err)
        console.error(`Error: ${{message}}`)
        process.exit(1)
      }}
    }})
}}
'''


def T_CLI_ROUTE_TS(app_id: str, app_name: str) -> str:
    short = app_id
    fn = "".join(w.capitalize() for w in short.split("_"))
    return f'''/**
 * {app_name} CLI Server route handler.
 *
 * 【开发指南】
 * - 由 cli-server.ts 在 url.startsWith('/{short}/') 时调用
 * - djangoRequest(url, method, body) 代理到 Django 后端
 * - 如需本地操作（不经 Django），直接调 sendJSON(res, 200, data)
 * - 精细路由可在此函数内用 if/switch 按 url 分发
 */

import http from 'node:http'
import {{ djangoRequest, type SendJSON }} from './shared/error-handler'

export async function handle{fn}Route(
  url: string,
  method: string,
  body: any,
  res: http.ServerResponse,
  sendJSON: SendJSON,
) {{
  try {{
    const result = await djangoRequest(method, url, body)
    sendJSON(res, result.status, result.data)
  }} catch (err: unknown) {{
    const message = err instanceof Error ? err.message : 'Internal server error'
    sendJSON(res, 500, {{ error: message }})
  }}
}}
'''


# ═══════════════════════════════════════════════════════════
#  Command
# ═══════════════════════════════════════════════════════════

class Command(BaseCommand):
    help = "App 脚手架（builtin 骨架生成器，不是 App 契约权威源）"

    def add_arguments(self, p):
        p.add_argument("app_id", help="App ID，如 tabxxx")
        p.add_argument("--name", help="显示名（默认自动推导，如 TabXxx）")
        p.add_argument("--icon", default="file-text", help="Lucide 图标名（默认 file-text）")
        p.add_argument("--context-fields", nargs="+",
                        help="context_fields 字段名（默认 current_{short}_id）")
        p.add_argument("--with-tools", action="store_true", help="同时创建工具域")
        p.add_argument("--with-prompt", action="store_true", help="同时创建提示词")
        p.add_argument("--with-cli", action="store_true", help="同时创建 CLI 命令")
        p.add_argument("--dry-run", action="store_true", help="仅预览不执行")

    def handle(self, *args, **opts):
        aid = opts["app_id"]
        dry = opts["dry_run"]
        name = opts["name"] or _display_name(aid)
        icon = opts["icon"]
        short = aid[3:] if aid.startswith("tab") else aid

        fields = opts["context_fields"] or [f"current_{short}_id"]
        rid_field = fields[0]
        with_tools = opts["with_tools"]
        with_prompt = opts["with_prompt"]
        with_cli = opts["with_cli"]

        config_cls = _class_name(aid) + "Config"
        handler_var = f"{aid}Handler"
        hs_var = f"{aid}HomeSection"

        try:
            from apps.services.common.app_registry import CORE_APPS
            if aid in CORE_APPS:
                self.stderr.write(self.style.ERROR(f"App '{aid}' 已存在于 CORE_APPS 中。"))
                raise SystemExit(1)
            order = max(a.order for a in CORE_APPS.values()) + 1
        except ImportError:
            order = 99

        log: list[tuple[str, str]] = []

        def _log(status: str, msg: str):
            log.append((status, msg))

        mode = "DRY-RUN" if dry else "执行"
        self.stdout.write(self.style.HTTP_INFO(
            f"\n{'='*70}\n  App 脚手架 [{mode}]: {name} ({aid})\n{'='*70}\n"
        ))

        # ── Step 1: App 目录 ──
        self.stdout.write(self.style.MIGRATE_HEADING("  [1/8] 生成 App 目录"))
        app_dir = _APPS / aid
        for fname, content in [
            ("__init__.py", ""),
            ("apps.py", T_APPS_PY(aid, config_cls)),
            ("models.py", T_MODELS_PY(aid, name, aid)),
            ("api.py", T_API_PY(aid, name)),
            ("db_router.py", T_DB_ROUTER_PY(aid)),
        ]:
            s = _write_new(app_dir / fname, content, dry)
            _log(s, f"  {app_dir.relative_to(_ROOT)}/{fname}")

        for d in ["services", "migrations"]:
            s = _write_new(app_dir / d / "__init__.py", "", dry)
            _log(s, f"  {app_dir.relative_to(_ROOT)}/{d}/__init__.py")

        for st, msg in log[-7:]:
            self.stdout.write(f"    {st} {msg}")

        # ── Step 2: 后端注册 ──
        self.stdout.write(self.style.MIGRATE_HEADING("\n  [2/8] 后端主模块注册"))

        # 2.1 app_registry.py — CORE_APPS
        reg = _APPS / "services" / "common" / "app_registry.py"
        cf_str = ", ".join(
            f'AppContextField("{f}", "{f.replace("current_","").replace("_id","")}"'
            + (", is_resource_id=True)" if f == rid_field else ")")
            for f in fields
        )
        td_str = f'tool_domains=("{aid}",),\n' if with_tools else ""
        hp_str = "True" if with_prompt else "False"
        entry = (
            f'    "{aid}": AppDefinition(\n'
            f'        id="{aid}",\n'
            f'        name="{name}",\n'
            f'        icon="{icon}",\n'
            f'        context_type="{aid}",\n'
            f'        searchable=True,\n'
            f'        can_create=True,\n'
            f'        is_default_enabled=True,\n'
            f'        order={order},\n'
            f'        context_fields=(\n'
            f'            {cf_str},\n'
            f'        ),\n'
            f'        {td_str}'
            f'        has_prompt_section={hp_str},\n'
            f'    ),'
        )
        s = _insert_before(reg, "\n}", entry, dry)
        _log(s, f"app_registry.py → CORE_APPS['{aid}']")
        self.stdout.write(f"    {s} app_registry.py → CORE_APPS")

        # 2.2 settings.py — INSTALLED_APPS
        settings = _DJ / "tabtin" / "settings.py"
        app_path = f"'apps.{aid}.apps.{config_cls}',"
        s = _insert_before(settings, "]  # end-creation-apps",
                           f"    {app_path}", dry)
        if s == FAIL:
            s = _insert_before(settings, "'apps.tabchat.apps.TabchatConfig',",
                               f"    {app_path}", dry)
        _log(s, f"settings.py → INSTALLED_APPS")
        self.stdout.write(f"    {s} settings.py → INSTALLED_APPS")

        # 2.3 settings.py — DATABASE_ROUTERS
        router_cls = _class_name(aid) + "Router"
        router_path = f"'apps.{aid}.db_router.{router_cls}',"
        s = _insert_before(settings,
                           "'apps.services.common.db_router.DefaultDatabaseRouter',",
                           f"    {router_path}", dry)
        _log(s, f"settings.py → DATABASE_ROUTERS")
        self.stdout.write(f"    {s} settings.py → DATABASE_ROUTERS")

        # 2.4 urls_deferred.py — 非核心 tab* app 路由延迟注册入口
        # tabtin/urls.py 只保留核心路由（auth/chat/tabtinspace 等），
        # 新建 App 的路由统一插入 urls_deferred.py 的 _register_tab_app_routers() 函数。
        # 注入锚点（首选）：`# @create_app: ...` 显式契约注释，不依赖任何业务 App 字符串，
        # 抗 Wave 级重构。若该注释被意外删除则退化到「函数体起始」兜底。
        urls_deferred = _DJ / "tabtin" / "urls_deferred.py"
        router_var = f"{aid}_router"
        url_block = (
            f"    from apps.{aid}.api import router as {router_var}\n"
            f'    _safe_add_router("/{aid}", {router_var}, tags=["{name}"])\n'
        )
        s = _insert_before(
            urls_deferred,
            "# @create_app: 新增 App 路由",
            url_block,
            dry,
        )
        if s == FAIL:
            # 兜底：函数体起始。生成风格略差（新 App 与 tabdata 紧邻），
            # 但能保证脚手架最低程度可用，且会触发下面的 stderr 提醒。
            s = _insert_after(
                urls_deferred,
                "def _register_tab_app_routers():",
                "\n" + url_block,
                dry,
            )
        if s == FAIL:
            self.stderr.write(self.style.ERROR(
                "    ✗ urls_deferred.py 自动注入失败：显式锚点与函数体起始均未匹配，"
                "urls_deferred.py 可能被大幅重构。\n"
                "      请在 _register_tab_app_routers() 函数内手动添加以下两行：\n"
                f"\n        from apps.{aid}.api import router as {router_var}\n"
                f'        _safe_add_router("/{aid}", {router_var}, tags=["{name}"])\n'
                "\n      并在函数末尾重新插入锚点注释："
                "\n        # @create_app: 新增 App 路由由 `python manage.py create_app` 脚手架自动插入到此注释之前，锚点请勿删除\n"
            ))
        _log(s, "urls_deferred.py → _register_tab_app_routers")
        self.stdout.write(f"    {s} urls_deferred.py → 路由挂载（_register_tab_app_routers）")

        # 2.5 schemas.py — UpdateContextRequest
        schemas = _APPS / "chat" / "conversation" / "schemas.py"
        schema_block = f"    # {aid}\n" + "\n".join(
            f"    {f}: Optional[str] = None" for f in fields
        )
        s = _insert_before(schemas, "# 通用", schema_block + "\n", dry)
        if s == FAIL:
            s = _insert_before(schemas, "sandbox_path", schema_block + "\n", dry)
        _log(s, f"schemas.py → UpdateContextRequest")
        self.stdout.write(f"    {s} schemas.py → UpdateContextRequest")

        # ── Step 3: Agent 系统 ──
        self.stdout.write(self.style.MIGRATE_HEADING("\n  [3/8] Agent 系统"))
        self.stdout.write("    ℹ agent_state.py — 当前仍建议人工核对，不要仅依赖脚手架提示")

        if with_prompt:
            prompt_dir = _APPS / "services" / "agent_engine" / "prompts" / "apps"
            s = _write_new(prompt_dir / f"{aid}.py", T_PROMPT_PY(aid, name), dry)
            _log(s, f"prompts/apps/{aid}.py")
            self.stdout.write(f"    {s} prompts/apps/{aid}.py（APP_SECTIONS 自动扫描，无需修改 __init__.py）")
        else:
            self.stdout.write(f"    {SKIP} 提示词（未指定 --with-prompt）")

        if with_tools:
            tool_dir = _APPS / "services" / "tools" / "domains" / aid
            s = _write_new(tool_dir / "__init__.py",
                           T_TOOL_REGISTRY_PY(aid, name), dry)
            _log(s, f"tools/domains/{aid}/__init__.py")
            self.stdout.write(f"    {s} tools/domains/{aid}/ HTTP API 服务实现目录")

            # W6 后 ToolHub.register_provider 路径已废弃——LLM 工具的唯一来源是本地
            # TS Runtime（packages/agent-runtime + packages/action-tools）。
            # 这里只生成 BaseTool 服务实现骨架，提示开发者按以下三种方式之一暴露能力：
            self.stdout.write(
                f"    ℹ HTTP API 暴露方式（W6 后不再走 ToolHub）：\n"
                f"      1) Go CLI: 在 packages/tabtin-cli-go/cmd/ 加子命令 → CLI Server route → 调本目录服务\n"
                f"      2) 前端 Action Tool: packages/action-tools/src/tools/{aid}/ 下声明 FC\n"
                f"      3) Extension: BaseExtension.get_cli_commands() 声明 CliCommandDescriptor"
            )
        else:
            self.stdout.write(f"    {SKIP} 工具域（未指定 --with-tools）")

        # ── Step 4: 前端 Handler ──
        self.stdout.write(self.style.MIGRATE_HEADING("\n  [4/8] 前端 Handler"))

        handler_dir = _REN / "components" / "context-space" / "registry" / "handlers"
        s = _write_new(handler_dir / f"{aid}.tsx",
                       T_HANDLER_TSX(aid, name, handler_var, icon, rid_field, searchable=True), dry)
        _log(s, f"handlers/{aid}.tsx")
        self.stdout.write(f"    {s} handlers/{aid}.tsx")

        # ── Step 5: 前端 HomeSection ──
        self.stdout.write(self.style.MIGRATE_HEADING("\n  [5/8] 前端 HomeSection"))

        hs_dir = _REN / "components" / "context-space" / "registry" / "homeSections"
        s = _write_new(hs_dir / f"{aid}.tsx",
                       T_HOME_SECTION_TSX(aid, name, hs_var, icon), dry)
        _log(s, f"homeSections/{aid}.tsx")
        self.stdout.write(f"    {s} homeSections/{aid}.tsx")

        # ── Step 6: 前端注册 ──
        self.stdout.write(self.style.MIGRATE_HEADING("\n  [6/8] 前端注册"))
        self.stdout.write(f"    {DONE} registry/index.ts — import.meta.glob 自动注册，无需修改")

        # i18n
        zh_dir = _REN / "i18n" / "locales" / "zh-CN"
        en_dir = _REN / "i18n" / "locales" / "en-US"
        s = _write_new(zh_dir / f"{aid}.json", T_I18N_ZH(name, aid), dry)
        _log(s, f"i18n/zh-CN/{aid}.json")
        self.stdout.write(f"    {s} i18n/zh-CN/{aid}.json")

        s = _write_new(en_dir / f"{aid}.json", T_I18N_EN(name, aid), dry)
        _log(s, f"i18n/en-US/{aid}.json")
        self.stdout.write(f"    {s} i18n/en-US/{aid}.json")

        self.stdout.write(f"    {DONE} i18n ns + lazy-backend — import.meta.glob 自动推导，无需修改")

        # chat-client context.ts
        ctx_ts = _ROOT / "packages" / "tabtin-chat-client" / "src" / "types" / "context.ts"
        if ctx_ts.exists():
            ts_fields = "\n".join(
                f"  {f}?: string | null" for f in fields
            )
            ts_block = f"  // ── {aid} ──\n{ts_fields}\n"
            s = _insert_before(ctx_ts, "// ── 通用 ──", ts_block, dry)
            if s == FAIL:
                s = _insert_before(ctx_ts, "sandbox_path", ts_block, dry)
            _log(s, "chat-client context.ts")
            self.stdout.write(f"    {s} chat-client/context.ts → 类型字段")

        # ── Step 7: CLI（可选）──
        self.stdout.write(self.style.MIGRATE_HEADING("\n  [7/8] CLI 命令"))

        if with_cli:
            cli_cmd_dir = _ROOT / "packages" / "tabtin-cli-go" / "cmd"
            cli_short = aid
            s = _write_new(cli_cmd_dir / f"{cli_short}.ts",
                           T_CLI_COMMAND_TS(aid, name), dry)
            _log(s, f"Go CLI cmd/{cli_short}.go (需手动添加 CommandDef)")
            self.stdout.write(f"    {s} CLI 命令 commands/{cli_short}.ts")

            fn_name = "".join(w.capitalize() for w in cli_short.split("_"))
            core_commands = _ROOT / "packages" / "tabtin-cli-go" / "cmd" / "apps.go"
            if core_commands.exists():
                import_line = f"import {{ register{fn_name}Command }} from './commands/{cli_short}.js'"
                s_import = _insert_after(
                    core_commands,
                    "import { registerCapabilitiesCommand } from './commands/capabilities.js'",
                    import_line,
                    dry,
                )
                definition_entry = (
                    f"  {{\n"
                    f"    name: '{cli_short}',\n"
                    f"    register: register{fn_name}Command,\n"
                    f"    uiVisible: true,\n"
                    f"    requiresSkill: true,\n"
                    f"    routeMode: 'cli_server',\n"
                    f"  }},"
                )
                s_definition = _insert_into_ts_array(core_commands, "CORE_COMMAND_DEFINITIONS", definition_entry, dry)
                if FAIL in (s_import, s_definition):
                    s = FAIL
                elif DONE in (s_import, s_definition):
                    s = DONE
                elif SKIP in (s_import, s_definition):
                    s = SKIP
                else:
                    s = FAIL
                _log(s, "Go CLI apps.go")
                self.stdout.write(f"    {s} Go CLI apps.go → 需手动添加 CommandDef 注册（Node CLI 模板已过时）")
            else:
                _log(FAIL, "Go CLI apps.go")
                self.stdout.write(f"    {FAIL} Go CLI apps.go 不存在")

            cli_route_dir = _ROOT / "apps" / "tabtin-electron" / "src" / "main" / "cli" / "routes"
            s = _write_new(cli_route_dir / f"{cli_short}.ts",
                           T_CLI_ROUTE_TS(aid, name), dry)
            _log(s, f"cli/routes/{cli_short}.ts")
            self.stdout.write(f"    {s} CLI Server routes/{cli_short}.ts")

            cli_srv = _ROOT / "apps" / "tabtin-electron" / "src" / "main" / "cli" / "cli-server.ts"
            if cli_srv.exists():
                s1 = _insert_after(cli_srv, "from './routes/media'",
                    f"import {{ handle{fn_name}Route }} from './routes/{cli_short}'", dry)
                if s1 == FAIL:
                    s1 = _insert_after(cli_srv, "from './routes/",
                        f"import {{ handle{fn_name}Route }} from './routes/{cli_short}'", dry)
                route_block = (
                    f"    if (url.startsWith('/{cli_short}/')) {{\n"
                    f"      await handle{fn_name}Route(url, method, body, res, sendJSON)\n"
                    f"      return\n"
                    f"    }}"
                )
                s2 = _insert_before(cli_srv,
                    "sendJSON(res, 404, { success: false, error: `Unknown route: ${url}` })", route_block, dry)
                if FAIL in (s1, s2):
                    s = FAIL
                elif DONE in (s1, s2):
                    s = DONE
                elif SKIP in (s1, s2):
                    s = SKIP
                else:
                    s = FAIL
                _log(s, "cli-server.ts")
                self.stdout.write(f"    {s} cli-server.ts → 路由挂载")
            else:
                _log(FAIL, "cli-server.ts")
                self.stdout.write(f"    {FAIL} cli-server.ts 不存在")
        else:
            self.stdout.write(f"    {SKIP} 未指定 --with-cli")

        # ── Step 8: 汇总 ──
        self.stdout.write(self.style.MIGRATE_HEADING("\n  [8/8] 汇总"))

        created = sum(1 for s, _ in log if s == NEW)
        modified = sum(1 for s, _ in log if s == DONE)
        skipped = sum(1 for s, _ in log if s == SKIP)
        failed = sum(1 for s, _ in log if s == FAIL)

        self.stdout.write(self.style.HTTP_INFO(
            f"\n  新建: {created} | 修改: {modified} | "
            f"已存在: {skipped} | 失败: {failed}"
        ))

        if failed > 0:
            self.stdout.write(self.style.WARNING(
                "\n  部分注册点插入失败，可能需要手动处理："
            ))
            for s, msg in log:
                if s == FAIL:
                    self.stdout.write(self.style.ERROR(f"    {FAIL} {msg}"))
            raise SystemExit(1)

        if not dry:
            self.stdout.write(self.style.MIGRATE_HEADING("\n  下一步（按顺序执行）:"))
            self.stdout.write(f"    ── 后端 ──")
            self.stdout.write(f"    1. 打开 apps/{aid}/models.py，添加业务字段（参考文件顶部的开发指南）")
            self.stdout.write(f"    2. 打开 apps/{aid}/api.py，实现 CRUD 接口（参考文件顶部的开发指南）")
            self.stdout.write(f"    3. 创建迁移: python manage.py makemigrations {aid}")
            self.stdout.write(f"    4. 执行迁移: python manage.py migrate {aid} --database=postgresql")
            self.stdout.write(f"       ⚠️ 必须加 --database=postgresql，否则迁移会记录到错误的库")
            if with_prompt:
                self.stdout.write(f"    ── Agent 系统 ──")
                self.stdout.write(f"    5. 完善 prompts/apps/{aid}.py 中的提示词（参考文件顶部的开发指南）")
            self.stdout.write(f"    ── 前端 ──")
            self.stdout.write(f"    6. 创建 src/components/{aid}/{_class_name(aid)}PaneHost.tsx 组件")
            self.stdout.write(f"       该组件接收 resourceId 和 className props，渲染 App 主界面")
            self.stdout.write(f"    7. 在 useCreateHandlers.ts 中添加 {aid} 的创建回调")
            self.stdout.write(f"       该回调在用户点击 Quick Action「新建」按钮时触发")
            if with_tools:
                self.stdout.write(f"    ── 工具 ──")
                self.stdout.write(f"    8. 添加工具: python manage.py create_tool {aid}.my_tool --domain {aid} --description \"工具描述\"")
            self.stdout.write(f"    ── 验证 ──")
            self.stdout.write(f"    9. 审计: python manage.py audit_apps --app {aid}")
            self.stdout.write(f"       确认所有 MUST 项通过，RECOMMEND 项按需处理")
        else:
            self.stdout.write(self.style.NOTICE(
                "\n  这是 DRY-RUN 预览，去掉 --dry-run 执行实际创建"
            ))

        self.stdout.write("")
