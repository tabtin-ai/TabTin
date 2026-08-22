# Git Rebase vs Merge Mermaid

## 为什么用 widget

用户问概念差异时，分支历史的形状比文字更直观。这里不需要像素级细节，也不需要点击，所以用 `format: "mermaid"`，让工具编译时转 SVG。

## show_widget input

```ts
show_widget({
  title: "git rebase vs merge",
  summary: "git rebase 与 merge 对比图：rebase 把 feature 提交重放到 main 顶部形成线性历史；merge 保留分叉并产生一个合并提交。",
  format: "mermaid",
  loading_message: "正在编译 git 历史对比图...",
  code: `
flowchart LR
  subgraph Rebase["rebase：线性历史"]
    A1["main: A"] --> A2["main: B"] --> A3["main: C"]
    A3 --> F1p["feature: F1'"] --> F2p["feature: F2'"]
  end

  subgraph Merge["merge：保留分叉"]
    B1["main: A"] --> B2["main: B"] --> B3["main: C"] --> M["merge commit"]
    B2 --> F1["feature: F1"] --> F2["feature: F2"] --> M
  end
`
})
```

## 注意点

Mermaid 示例不要写 `click` directive；当前 Mermaid 负责静态解释，不负责 sendPrompt。若用户要点击某个提交继续问，改用 SVG 手画并加 `sendPrompt`。
