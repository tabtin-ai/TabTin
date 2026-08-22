# Tooling

## Required Reads

Read these before generating slides:

- `app:tabslide/html-spec`
- `app:tabslide/tabslide-operator`

Read this when style or visual design matters:

- `app:tabslide/design-guide`

Read these when the source material needs retrieval:

- `app:tabdoc/tabdoc-operator`
- `app:tabdata/table-query`

## Canonical TabSlide Flow

```bash
tabtin slide create --name "<deck name>" --html @./slides.html
tabtin slide lint --project-id <project-id> --skip-visual --min-severity warning
```

Use preview only when needed:

```bash
tabtin slide preview --project-id <project-id>
```

## Guardrails

- Do not invent TabSlide CLI flags beyond those documented by the operator skill.
- Do not generate image-only slides unless the HTML spec calls for rasterized regions.
- Keep text editable by default.
- Put one key message on each slide.
- Keep data sources and metric definitions on data slides.

## Runtime Boundary

TabSlide owns its rendering runtime. If the CLI reports Playwright/Chromium/browser binary missing, classify it as a TabSlide runtime environment issue. Do not instruct the user to install browser binaries, install npm packages, or modify dependencies.

## Resource Rules

- Script/brief document: `tabtin://resource/document/<id>?hint=tabdoc`.
- Slide project: `tabtin://resource/slide/<id>?hint=tabslide` when available.
