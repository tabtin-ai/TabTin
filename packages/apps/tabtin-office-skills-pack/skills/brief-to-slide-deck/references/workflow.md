# Workflow

## 1. Confirm the Deck Brief

Before generating slides, confirm:

- Audience.
- Goal of the presentation.
- Page count or expected speaking time.
- Visual direction.
- Source materials and whether a TabDoc script should be created.

If the user only says “make a PPT”, propose a concise structure and ask for missing constraints.

## 2. Build the Story First

Create a slide outline before writing HTML:

- One message per slide.
- Evidence behind each message.
- Suggested visual treatment.
- Speaker note or talk track when useful.

For messy source material, write a TabDoc script first and use it as the stable source of truth.

## 3. Read TabSlide Standards

Before generating HTML, read:

- `app:tabslide/html-spec` always.
- `app:tabslide/design-guide` when visual quality matters.
- `app:tabslide/tabslide-operator` before executing CLI commands.

## 4. Generate and Check

Use this flow:

1. Write `slides.html` that follows the HTML spec.
2. Create the TabSlide project with `tabtin slide create --name "<deck name>" --html @./slides.html`.
3. For an existing deck, append a page with `cat slide.html | tabtin slide add-page --project-id <id> --html -`.
4. Run `tabtin slide lint --skip-visual --min-severity warning` for fast checks.
5. Use preview only when visual inspection is needed and the runtime is ready.

## 5. Runtime Error Policy

If `preview`, `lint`, or `generate` reports Playwright, Chromium, browser binary, or similar runtime dependency errors:

- Do not give the user browser-install commands.
- Do not install Playwright browsers on the user's behalf.
- Say: “TabSlide runtime environment is missing or not ready.”
- Preserve the raw error for product/admin diagnosis.
- Continue with the HTML, outline, and lint results that are available.
