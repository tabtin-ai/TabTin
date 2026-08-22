# Tooling

## Read First

- Prefer existing TabTin operator skills before inventing new persistence paths.
- Use `tabtin` CLI when a documented command covers the step.
- Keep outputs in Space resources (TabDoc / TabData / TabMemo / Tracker) when the user wants durable results.

## Resource Rules

- Document links: `tabtin://resource/document/<id>?hint=tabdoc`
- Table links: `tabtin://resource/table/<id>?hint=tabdata`
- Memo links: `tabtin://resource/memo/<id>?hint=tabmemo` when available

## Do Not Guess

- Do not invent owners, deadlines, metrics, legal conclusions, or customer facts.
- Mark missing fields as `待确认`.
- Ask before creating or overwriting durable resources.

## Failure Handling

If a required App/operator/runtime tool is unavailable, keep a Markdown draft and explain which step could not be completed.
