---
name: resource-link
description: >
  插入资源链接——在 chat 文字流里给资源链接，markdown
  link 形态 [显示文本](tabtin://resource/<type>/<id>?hint=<carrierApp>)，
  用户点击直接在 Space 内打开。行业格式（http/https/
  file/mailto）也兼容；不要写 file:// 让用户自己复制粘贴。
metadata:
  version: 1.0.0
  tabtin:
    category: media
    autoActivateFor: []
    tags:
      - chat
      - link
      - markdown
      - resource
      - tabtin-uri
      - file
      - hyperlink
    tools: []
---

# resource-link

聊天里要"指给用户看一份东西"时，**写 markdown link**——用户点了直接在当前 Space 内的 tab 打开（不跳浏览器、不跳系统应用）。

## 先判定

1. 你要让用户**马上看到**这份产物 → 用 `open_in_space` 工具（不是本 SKILL；见 `platform:visualization/open-in-space`）
2. 你想给一份让用户**自己决定何时打开**的引用 → 写 markdown link（本 SKILL）
3. 你想留一张富卡片让用户后续多次回访 → 用 `present_to_user(items=[{kind: "resource_ref", ...}])`
4. 一段文字说得清的元数据（"这份在 doc_xyz"），不要变成链接强迫用户跳转

## 写法

**自有格式（首选）**：

```
[查看《项目方案》](tabtin://resource/<type>/<id>?hint=<carrierAppId>)
```

- `<type>` —— 资源类型小写字符串，与 chat 上下文 ContextRefType 同集合（`document` / `table` / `slide` / `code_file` / `webpage` / `email_thread` / `memo` / `whiteboard` / `site` / `video` / `file` / `folder` / `tracker` / `agenda_event` / ...）。完整列表由 manifest 聚合，不固定写死；写错了用户点击会落到系统打开兜底，不是产品事故，但体验不优雅
- `<id>` —— 资源业务 ID。本地文件路径 / URL 等含特殊字符的 id 必须 `encodeURIComponent`，否则 `?` `#` `&` 会污染 query
- `?hint=<carrierAppId>` —— 可选；告诉用户偏好系统"我建议用哪个 App 打开"。常用值：`tabdoc` / `tabdata` / `tabcode` / `tabweb` / `tabmemo` / `tabwhiteboard` / `tabslide` / `tabsite` / `tabvideo` / `tabmail` / `tabfolder` / `tabtracker`。完整 carrier 列表由各 App `app.json#opens` 声明聚合，写错时系统按 manifest_default 兜底（不报错）

**行业格式（也支持）**：

```
[外部网页](https://example.com)
[本地报告](file:///Users/x/report.html)
[联系](mailto:a@b.com)
```

行业格式不带 `?hint=`——载体由用户偏好 + manifest 默认决定。chat 也支持**裸路径 autolink**：直接写 `/Users/x/y.md` 会被识别成可点链接（绝对路径才识别，相对路径不动）。

## D2 优先级（用户偏好 > 你的 hint）

用户的"始终用 X 打开此类资源"设定**永远胜过** `?hint=` —— hint 是建议，不是命令。Agent 不应当假设 hint 一定生效；写 hint 是为了"用户没设过偏好时给一个合理默认"。

## 例子

```
我已经把分析放进 [《Q3 销售解读》](tabtin://resource/document/doc_xyz?hint=tabdoc) 里。
原始数据在 [销售明细表](tabtin://resource/table/tbl_abc?hint=tabdata)。
脚本：[gen_report.py](tabtin://resource/code_file/%2Ftmp%2Fgen_report.py?hint=tabcode)
本地导出：[/tmp/q3.html](file:///tmp/q3.html)
邮件回复 [客户](mailto:cust@example.com?subject=Q3%20review)
```

## 不要做

- **写 `file:///path` 让用户复制粘贴**：W3 之后裸路径 + `file://` 都已能 chat 里点开，**不要再绕一圈**输出"请打开终端 cd /Users/... && cat ..."这种引导
- **同一份资源同时输出 markdown link + open_in_space 工具调用**：用户会被同一动作触发两次（你点了，我又自动展开）。要么写 link 让用户控制时机，要么调工具立即展开，二选一
- **tab id 替代 resource id**：`tabtin://resource/document/tab_<random>` 是错的——`<id>` 是资源本身的业务 id（doc_xxx / tbl_xxx），不是 carrier 内部的 tab 实例 id
- **硬编码 hint 到非业务 type**：比如 `?hint=tabweb` 但 pointer 是 `mailto:` —— 语义荒谬；当 hint 与 type/scheme 不可达时系统会按 D2 manifest_default 兜底，不会按你的 hint 走
- **遗忘 encodeURIComponent**：`tabtin://resource/code_file//Users/x/r.md?hint=tabcode` 错（`/` 没编码会让 path 解析失败）；正确：`tabtin://resource/code_file/%2FUsers%2Fx%2Fr.md?hint=tabcode`

## 与其他形态的边界

| 你想表达的语义 | 用什么 | 用户感受 |
|--------------|------|--------|
| "看这份" + 让用户自己决定何时打开 | markdown link（本 SKILL） | chat 里多一个可点链接 |
| "我替你打开了" + 立即看到 tab | `open_in_space` 工具 | tab 立刻在 Space 内出现 |
| "留个卡片，方便随时回看" | `present_to_user(kind="resource_ref")` | chat 里嵌一张资源卡 |
| "外部商品页 / 第三方 url" | markdown link 写 https:// 即可 | 用户点击在 Space 内的 tabweb 打开（用户已设外部应用偏好则跳浏览器） |

短结论：**链接是"等用户来"，工具是"我去开"。** 别混用。
