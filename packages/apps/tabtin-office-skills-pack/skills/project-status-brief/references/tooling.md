# Tooling

## Read First

- `app:tabdoc/tabdoc-operator` before creating or appending a project brief.
- `app:tabdata/table-query` before querying task/project tables.
- `app:tabdata/table-operator` before updating task records.
- `app:tabslide/html-spec`, `app:tabslide/design-guide`, and `app:tabslide/tabslide-operator` before generating slides.

## Table Safety

- Query first; write later only after confirmation.
- For updates, preview record ids, old values, new values, and reason.
- Never run destructive data operations for a status brief.

## Slide Boundary

If the user wants a deck, first finalize the brief. Then create a TabSlide project and generate pages according to the TabSlide operator and HTML spec.

Use the same canonical TabSlide flow as the deck skill:

```bash
tabtin slide create --name "<deck name>" --html @./slides.html
tabtin slide lint --project-id <project-id> --skip-visual --min-severity warning
```

If TabSlide reports Playwright/Chromium missing, treat it as a TabSlide runtime environment issue. Do not tell the user to install Playwright.

## Resource Rules

- Brief document: `tabtin://resource/document/<id>?hint=tabdoc`.
- Task/project table: `tabtin://resource/table/<id>?hint=tabdata`.
- Slide project: `tabtin://resource/slide/<id>?hint=tabslide` when available.
