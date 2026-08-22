# Workflow

## 1. Identify the Mail Scope

Use the current message/thread id when available. Otherwise ask for the target sender, subject, date range, or keyword.

Do not search broad mailbox history without a reason. Email often contains unrelated private content.

## 2. Read and Extract

Extract:

- Requests.
- Commitments.
- Deadlines.
- Owners.
- Dependencies.
- Risks.
- Reply intent.

Mark missing owners, dates, and assumptions as `待确认`.

## 3. Draft Before Action

Show:

- Proposed task rows.
- Reply draft.
- Persistence plan: table update, new table, Tracker, or no write.

The default action is draft-only. Sending mail, writing customer-sensitive data, or creating recurring follow-up requires confirmation.

## 4. Execute Confirmed Steps

After user confirmation:

- Draft a reply from the communication context available in the current session.
- Create or update a task table with TabData tools.
- Create Tracker only for explicit follow-up automation.

## 5. Report Outcome

Return task count, draft status, write status, and unresolved fields.
