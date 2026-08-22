# Mermaid ER Example

Use `format: "mermaid"` for ER / flow / sequence / Gantt diagrams. The tool compiles Mermaid to SVG during execute; never include Mermaid runtime script in HTML.

```text
show_widget({
  summary: "订单域 ER 图：用户创建多个订单，订单包含多条订单项，商品被订单项引用。",
  format: "mermaid",
  loading_message: "正在编译 ER 图…",
  code: `
erDiagram
  USER ||--o{ ORDER : places
  ORDER ||--|{ ORDER_ITEM : contains
  PRODUCT ||--o{ ORDER_ITEM : referenced_by
  USER {
    string id
    string name
  }
  ORDER {
    string id
    datetime created_at
  }
  ORDER_ITEM {
    string id
    int quantity
  }
  PRODUCT {
    string id
    string title
  }`
})
```
