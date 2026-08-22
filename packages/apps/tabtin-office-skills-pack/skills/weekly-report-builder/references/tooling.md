# Tooling

## Read First

- `app:tabdoc/tabdoc-operator` before creating, replacing, or appending a report.
- `app:tabdata/table-query` before querying task or metric tables.
- `app:tabdata/table-operator` before writing table records.
- `app:tabslide/html-spec`, `app:tabslide/design-guide`, and `app:tabslide/tabslide-operator` before generating slides.

## Data Discipline

- Keep a short source map: user input, Memo, Doc, Table.
- Ask for table names or resource ids when they are not present in the context.
- Treat missing access as a coverage gap, not as permission to invent summary points.

## Slide Boundary

Slides are optional. Do not start TabSlide generation until the report narrative is stable and the user confirms audience/page count.

When the user confirms slide generation, use the same canonical TabSlide flow as the deck skill:

```bash
tabtin slide create --name "<deck name>" --html @./slides.html
tabtin slide lint --project-id <project-id> --skip-visual --min-severity warning
```

If TabSlide commands surface Playwright or Chromium errors, do not tell the user to install browsers. Report it as a TabSlide runtime environment issue and include the raw error for diagnosis.

## Resource Rules

- Reports: `tabtin://resource/document/<id>?hint=tabdoc`.
- Slide projects: `tabtin://resource/slide/<id>?hint=tabslide` when a slide resource id/link is available.
