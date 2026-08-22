# Tooling

## Available Sources

Use only communication sources already available in the current session.
Do not assume an additional communication CLI or application exists.

## Read First

- `app:tabdata/table-modeling` before creating a task table.
- `app:tabdata/table-operator` before inserting or updating task records.
- `tabtracker` before scheduling follow-up.

## Safety Rules

- Never send a message without explicit user confirmation.
- Never persist access tokens, passwords, full personal identifiers, or unrelated private content.
- If the communication source is unavailable, output a draft reply and ask the user to provide the needed context.

## Resource Rules

- Task table links: `tabtin://resource/table/<id>?hint=tabdata`.
- Draft status should mention the message/thread id when available.
