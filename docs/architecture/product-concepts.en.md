# TabTin Product Concepts

[中文](product-concepts.md)

This document defines the current public product model. It does not record historical designs.

## Product philosophy

TabTin aims to reduce the coordination cost of people and Agents working together, so individual work can be continued, reused, and reviewed by the team.

This collaboration rests on five principles: visible process, controlled permissions, reviewable results, transferable work, and clear human accountability. Teams can then understand how the work was done and build trust from evidence.

## Relationships

```text
Organization
├── Workspace: a member's private execution context
├── Agent: an AI participant identity
├── App: a work application or capability
└── Device: the actual execution environment
```

## Core concepts

| Concept | Definition | Key boundary |
| --- | --- | --- |
| Organization | The organizational and tenant boundary that owns members, resources, and configuration | Organizations are isolated by default |
| Workspace | A member's private execution context with one working root, files, terminal access, Skills, and Checkpoints | Each Workspace has one execution root |
| Agent | An AI identity with a role, rules, models, Skills, memory, and execution preferences | Agent answers “who participates,” not “where execution happens” |
| App | A first-class work application such as documents, tables, terminals, browsers, messaging, or integrations | People and Agents operate on the same App result |
| Device | The runtime that provides terminals, files, browsers, or device control | Must respect Organization, member, and Workspace permissions |

## Work handoffs

TabTin currently provides two complementary forms of work handoff:

- **Task continuation**: the sender transfers an Agent task to another member of the same Organization. TabTin freezes the necessary shareable conversation context and records documents, tables, cloud files, and local files referenced by the task. After the recipient selects their own Agent and Workspace, TabTin creates an independent continuation task. Existing resource permissions still determine which materials are available.
- **Handoff package**: a structured package sent in a team conversation with the work goal, current progress, next steps, and risks. It can reference Agent sessions, related messages, documents, and tables. The recipient can view, acknowledge, or take over the package.

Neither form shares the sender's entire local directory. Both parties' local environments remain separate, and the handoff materials remain subject to Organization and resource permissions.

## Explicit non-goals

- TabTin is not a remote filesystem that shares every member's local directories.
- An Agent does not automatically receive every permission.
- A handoff does not bypass existing resource permissions.
- Transitional implementation names do not automatically become public product concepts.
