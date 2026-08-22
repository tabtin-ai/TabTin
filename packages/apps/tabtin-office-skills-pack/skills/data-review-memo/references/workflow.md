# Workflow

## 1. Frame the Analysis

Confirm:

- Business question.
- Table/resource id or table name.
- Date range.
- Metric definitions.
- Output target: answer only, TabDoc memo, or slide handoff.

If the user asks “analyze this table” without a question, first propose 2-4 useful review angles and ask which one matters.

## 2. Inspect Before Querying

Check available fields, data types, and obvious missing values before writing aggregations.

Avoid assumptions such as `status`, `owner`, `amount`, or `created_at` unless the schema confirms them.

## 3. Query Safely

Start with read-only queries:

- Counts and coverage.
- Grouped metrics.
- Time trend if a time field exists.
- Outlier samples.

Keep query intent and limitations so the memo can be reproduced.

## 4. Write the Memo

Separate:

- Facts: directly observed values.
- Interpretation: likely meaning.
- Recommendations: actions to take.
- Limitations: missing data, short window, ambiguous fields.

## 5. Persist After Confirmation

Show the memo summary before writing to TabDoc. If the user asks to modify data, preview affected records and wait for confirmation.
