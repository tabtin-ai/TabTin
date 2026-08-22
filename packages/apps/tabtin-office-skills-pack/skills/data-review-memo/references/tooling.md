# Tooling

## Read First

- `app:tabdata/table-query` before analytical SQL or aggregation.
- `app:tabdata/table-operator` before any data write.
- `app:tabdoc/tabdoc-operator` before creating the memo.
- `app:tabslide/html-spec`, `app:tabslide/design-guide`, and `app:tabslide/tabslide-operator` before generating slides.

## Query Safety

- Prefer read-only queries.
- Do not run update/delete/execute-style write operations for analysis.
- For large tables, sample or aggregate instead of dumping all rows into the prompt.
- Preserve metric definitions and filters in the memo.

## Interpretation Rules

- Do not claim causality unless the data supports it.
- Flag missing data and small sample sizes.
- Keep recommendations tied to the observed signal.

## Slide Boundary

If the user asks for a deck, finish the memo first. Use TabSlide skills for slide generation. Playwright/Chromium errors are TabSlide runtime issues, not user setup instructions.

Use the same canonical TabSlide flow as the deck skill:

```bash
tabtin slide create --name "<deck name>" --html @./slides.html
tabtin slide lint --project-id <project-id> --skip-visual --min-severity warning
```

## Resource Rules

- Memo: `tabtin://resource/document/<id>?hint=tabdoc`.
- Source table: `tabtin://resource/table/<id>?hint=tabdata`.
