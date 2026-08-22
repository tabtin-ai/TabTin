# Workflow

## 1. Confirm Scope

Before writing anything durable, identify:

- Meeting topic and date.
- Source material: transcript, notes, chat log, or user summary.
- Intended audience: private notes, team share, customer-facing summary.
- Whether the user wants only a draft or also wants TabDoc/TabData/Tracker updates.

Ask a short follow-up when any of these affect the result and are missing.

## 2. Extract the Meeting Model

Create a working model with:

- Context and meeting goal.
- Key decisions.
- Action items: task, owner, due date, priority, dependency, source quote.
- Risks and unresolved questions.

If owner, date, priority, or dependency is not explicit, mark it as `待确认`.

## 3. Preview Before Persisting

Show the user:

- A short meeting summary.
- The action item table.
- Missing fields.
- What will be written where.

Do not create or update resources until the user confirms the persistence step.

## 4. Persist After Confirmation

Use TabDoc for the narrative meeting note. Use TabData for action items only when the user wants structured follow-up.

For Tracker, require an explicit automation request such as “每天提醒”, “下周跟进”, or “持续追踪”. Creating a Tracker changes future behavior and should not be bundled silently into note-taking.

## 5. Finish With a Clear Receipt

Report resource links, action count, skipped fields, and any automation status. If everything stayed as a draft, say so.
