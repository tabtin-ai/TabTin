# Tooling

## Read First

- `app:tabdoc/tabdoc-operator` before creating or updating a TabDoc note.
- `app:tabdata/table-modeling` before creating a new action item table.
- `app:tabdata/table-operator` before inserting or updating records.
- `tabtracker` before creating scheduled follow-up.

## Resource Rules

- Return TabDoc links as `tabtin://resource/document/<id>?hint=tabdoc`.
- Return TabData links as `tabtin://resource/table/<id>?hint=tabdata` when a table id is available.
- Mention Tracker name/id only after creation succeeds.

## Do Not Guess

- Do not invent owner, deadline, priority, project name, or table schema.
- Do not create duplicate action item tables if the user already has one.
- Do not schedule follow-up unless the user explicitly asks for ongoing automation.

## Failure Handling

If the operator skill or runtime tool is unavailable, keep the output as Markdown and explain which persistence step could not be completed.
