# Templates

## Deck Outline

```markdown
# <Deck Title>

## Slide 1: <Conclusion Title>
- Message: <one sentence>
- Evidence: <source>
- Visual: <layout idea>

## Slide 2: <Conclusion Title>
- Message: <one sentence>
- Evidence: <source>
- Visual: <layout idea>
```

## Slide HTML Skeleton

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Deck</title>
  </head>
  <body>
    <section class="slide">
      <h1>结论式标题</h1>
      <p>关键论点，保持可编辑。</p>
    </section>
  </body>
</html>
```

Always refine this skeleton according to `app:tabslide/html-spec`; do not treat it as a full spec.

## Delivery Receipt

```markdown
已生成演示材料：

- 讲稿：<tabtin doc link or 未创建>
- 幻灯片：<tabtin slide link/project id or 未生成>
- 页数：<N>
- 检查：<lint/preview 状态>
- 待确认：<visual style / audience / duration / missing source>
```

## Runtime Error Receipt

```markdown
Deck 内容已准备，但 TabSlide runtime 未完成生成/预览：

- 阶段：<create/generate/lint/preview>
- 原始错误：<error excerpt>
- 已保留产物：<outline/html/doc>
- 下一步：需要产品/管理员检查 TabSlide runtime 环境。
```
