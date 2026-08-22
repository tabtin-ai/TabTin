# Tooling

## Read First

- `app:tabdoc/tabdoc-operator` before creating the customer brief.
- `app:tabdata/table-query` before querying customer, opportunity, or renewal tables.
- `app:tabdata/table-operator` before updating follow-up records.
- `tabtracker` before scheduling customer follow-up.

## Source Boundaries

- Use only communication sources already available in the current session. Do not assume an additional communication CLI or application exists.
- Ask for customer table names or ids when not present.
- Use TabData query for read-only discovery; write only after confirmation.

## Sensitive Data Rules

- Treat pricing, contracts, legal terms, personal data, and negotiation status as sensitive.
- Do not persist unrelated mailbox content.
- Do not send email automatically.

## Resource Rules

- Customer brief: `tabtin://resource/document/<id>?hint=tabdoc`.
- Customer/follow-up table: `tabtin://resource/table/<id>?hint=tabdata`.
