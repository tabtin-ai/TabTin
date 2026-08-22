# TabTin

[中文](README.md)

> Public Preview: TabTin is preparing its first complete public source release. Components may have different maturity levels. Refer to the public documentation and verified behavior for the current status.

TabTin is an open-source collaboration platform for people and Agents, built for individuals and teams that want to bring Agents into real work. Developers can self-host, extend, and help build the platform.

> **Let people and Agents work together, and turn individual work into capability the whole team can build on.**
>
> We want work to feel easier, collaboration smoother, and task execution clearer—while making each person's work visible, their decisions understandable, and their contributions verifiable.

## Why TabTin

AI increases individual output, but it does not automatically improve team efficiency.

When teams begin using Agents deeply, different working styles create new collaboration costs. Good methods are difficult to reuse. Tasks are researched again when ownership changes. Tokens are spent repeatedly rebuilding the same context. Final documents are visible, while the judgments and trade-offs behind them are easily lost. Agents may produce a large amount of material without anyone taking real responsibility for the outcome.

TabTin starts with one question: **Can work completed by one person become the next colleague's starting point?**

Teams already using AI deeply are TabTin's first wedge, not its product boundary. TabTin is for any individual or team that wants to bring Agents into real work.

## How collaboration works in TabTin

### Work can be handed off

A handoff can include more than the final document. It may include the Agent task, the necessary conversation context, and selected documents and attachments. The next person can understand how the outcome was formed and continue in their own Agent and Workspace.

Each person's local files and execution environment remain separate, while completed research does not need to be repeated.

### People and Agents operate on the same result

TabTin provides collaboration applications for messaging, documents, data tables, and presentations. Agents can create and edit this content directly, and data and media collected by the browser can continue into the work applications.

People and Agents work on the same online result instead of repeatedly moving content between chat, downloads, and office software.

### Team methods can be reused

Different Agent roles can have their own rules, models, Skills, and memory. A research method, review rule, test procedure, or release process that has already been validated can be reused in later work instead of depending on a prompt written by one person at one moment.

Agents can execute work, while important decisions, accountability, and acceptance remain human responsibilities.

### Teams can own their Agent work system

TabTin includes more than a client. It also includes server components, an Agent Runtime, real-time collaboration, work applications, and administration capabilities. Small teams can start with the client, organizations that need control over data and infrastructure can self-host, and developers can continue from the source.

We will continue making the architecture more modular and pluggable. Only capabilities that exist in the public source and have been verified are described as current. Future directions belong in the [roadmap](ROADMAP.en.md).

## Open-source scope

TabTin is opening the actual product code, not a separate simplified demo.

The intended public system includes desktop and mobile clients, server components, the Agent Runtime, real-time collaboration, messaging, documents, tables, presentations, model management, and administration. The final Public Preview scope and availability status must match the released snapshot and its verification record.

## Get started

Choose the path that matches your goal:

1. **Desktop client with the official service**: for individuals and small teams that want to experience the product without operating server infrastructure. Visit the [TabTin website](https://tabtin.com/).
2. **Full self-hosting**: for teams that need control over data, model configuration, member permissions, and infrastructure.
3. **Source development**: for developers who want to understand the architecture, modify the product, or contribute.

Published installation and startup commands must be verified in a clean environment. If the documentation differs from the source, please file a bug.

### Community source development

If this is your first time running TabTin from source, start with the [Beginner's Guide to Local Development and Desktop Packaging](docs/development/getting-started.en.md). It covers environment setup, checks, startup, packaging, and troubleshooting in order.

Windows and macOS users can double-click the platform launcher in the repository root:

- Windows: `start-community-dev.bat`
- macOS: `start-community-dev.command`

You can also run the canonical entry point from a terminal:

```bash
node scripts/dev.mjs community
```

For a mainland China network, we recommend selecting the China download profile explicitly:

```bash
node scripts/dev.mjs community --region cn
```

The double-click launchers select the download source automatically. The entry point checks the development environment, installs dependencies when needed, prepares the public client configuration, waits for a healthy backend, and then starts Electron. See the [Electron open-source development guide](apps/tabtin-electron/docs/open-source-development.md) for region selection, backend reuse, and troubleshooting. The [Chinese guide](apps/tabtin-electron/docs/open-source-development.zh-CN.md) is also available.

## Documentation

- [Product concepts](docs/architecture/product-concepts.en.md)
- [Contributing](CONTRIBUTING.en.md)
- [Support](SUPPORT.en.md)
- [Security](SECURITY.en.md)
- [Code of Conduct](CODE_OF_CONDUCT.en.md)
- [Roadmap](ROADMAP.en.md)
- [Changelog](CHANGELOG.en.md)

## Join the community

Use Issues for bugs and well-shaped feature requests, Discussions for help and open-ended ideas, and follow [SECURITY.en.md](SECURITY.en.md) to report vulnerabilities privately.

Contributions in Chinese and English are welcome. When AI is used, the contributor remains responsible for understanding, reviewing, and verifying the submitted work. See [CONTRIBUTING.en.md](CONTRIBUTING.en.md).

## Data and privacy

Self-hosted deployments do not send business data to the TabTin maintainers by default. Error reporting and diagnostics in official clients follow the published privacy policy. Full diagnostic bundles may be uploaded only with explicit user consent.

## License and trademarks

TabTin's public source is provided under [AGPL-3.0-only](LICENSE). Organizations whose use or distribution is incompatible with AGPL-3.0-only may ask Shanghai Mofan Technology Co., Ltd. about separate commercial licensing.

Third-party components remain subject to their respective licenses. See [THIRD_PARTY_NOTICES.en.md](THIRD_PARTY_NOTICES.en.md). The TabTin name and marks are trademarks of the project maintainer. Forks may truthfully state that they are “based on TabTin,” but must not impersonate an official release.

Copyright © 2026 Shanghai Mofan Technology Co., Ltd.
