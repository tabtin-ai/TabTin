/**
 * CliCap 的平台文生图工作流指令。
 *
 * 仅作为 `tabtin media` 的相关 CLI 描述出现，不放进 query 无关的静态
 * system prompt。只在 Agent 的 CLI 清单里出现一级命令 `media` 时才允许承诺能力；
 * 未出现或模型目录为空时必须如实说明，禁止用 SVG、文件或外部占位图伪造生图结果。
 *
 * ：随 CliCap 从 `@tabtin/agent-runtime` 迁至本宿主包——它是
 * CliCap 独占的渲染指令，与 Cap 本体同居 host 侧。
 */
export const MEDIA_IMAGE_CLI_INSTRUCTION =
  '- **AI 文生图**：仅当本清单含一级命令 `media` 时才可承诺。普通生图直接运行 ' +
  '`tabtin media image generate --prompt "…" --format json`，不要自行选择或传入 `--model`，' +
  '由平台按管理后台场景绑定选择默认模型。仅当用户明确指定某个模型时，才先运行 ' +
  '`tabtin media image models --format json`；该目录只返回管理后台为生图场景绑定的模型。' +
  '只有用户指定的模型出现在目录中时，才可追加 `--model "<model_name>"`（也可用 `id` UUID）；' +
  '若不在目录中，明确说明该模型未在当前场景开通，禁止改选后台未绑定的模型。命令会等待图片完成' +
  '并继续等待永久转存（若先返回 `status:"running"`，继续读 output_file / 等后台完成通知，不要当成已成功）。' +
  '**正式产物判据**：stdout JSON 的 `stored_files` 至少一项包含非空 `file_id` 与 `access_url`；' +
  '`access_url` 必须是非空 HTTPS 地址，否则视为失败；' +
  '`status:"succeeded"` 只表示生成成功，不代表永久保存成功。若 `delivery_status:"temporary_preview"`' +
  '或只有 `result_urls` / `result_url`，必须明确告知“临时预览、尚未保存”，禁止伪装成正式产物。' +
  '`storage_status:"partial"` 时只把 `stored_files` 中成功项当正式产物，并如实说明部分转存失败。' +
  '有连接 UI 的会话里，客户端会在对话流**自动**展示生成中画布并在完成后换成成品图；' +
  '确认有正式产物或临时预览后只需用一两句文字确认即可，**严禁**再调用 `present_to_user` / `show_widget` 展示同一张图' +
  '（重复调用会导致双图或 URL 转义损坏后的「图片加载失败」）。' +
  'headless / Daemon 无 UI 会话时直接返回 HTTPS URL 和简短说明，不要调用 `present_to_user`。' +
  '通用文生图优先走上述 TabTin 原生 CLI；LibTV 等扩展 Skill 仅在用户明确点名，' +
  '或该 Skill 密钥可用且任务明确需要其专有能力时使用。' +
  '若命令未出现或模型目录为空，明确说明该能力未开通；禁止用 SVG / `show_widget` / ' +
  '`create_file` / 外部占位图冒充 AI 生成图片。';
