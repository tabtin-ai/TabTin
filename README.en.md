# TabTin

[中文](README.md)

> Public Preview: TabTin is preparing its first complete public source release. Components may have different maturity levels. Refer to the public documentation and verified behavior for the current status.

TabTin is an open-source collaboration platform for people and Agents, built for individuals and teams that want to bring Agents into real work. Developers can run it in their own environments, extend it, and help build the platform.

Public repository: [github.com/tabtin-ai/TabTin](https://github.com/tabtin-ai/TabTin)

> **Let people and Agents work together, and turn individual work into capability the whole team can build on.**
>
> We want work to feel easier, collaboration smoother, and task execution clearer—while making each person's work visible, their decisions understandable, and their contributions verifiable.

## Why TabTin

AI increases individual output, but it does not automatically improve team efficiency.

As teams rely more heavily on Agents, repeated research, lost context and decision rationale, repeated Token spending, methods that are difficult to reuse, and unclear accountability become more visible.

TabTin starts by asking one question: **Can work completed by one person become the next colleague's starting point?**

Teams already using AI deeply are TabTin's first wedge, not its product boundary. TabTin is for any individual or team that wants to bring Agents into real work.

## How collaboration works in TabTin

### Work can be handed off

A handoff can include more than the final document. Task continuation freezes the necessary conversation context and carries documents, tables, cloud files, and local files referenced by the task when they can be shared. The next person can understand how the outcome was formed and create an independent task with an Agent and Workspace they select.

Each person's local files and execution environment remain separate, while completed research does not need to be repeated.

### People and Agents operate on the same result

TabTin provides collaboration applications for messaging, documents, data tables, and presentations. Agents can create and edit this content directly, and data and media collected by the browser can continue into the work applications.

People and Agents work on the same online result instead of repeatedly moving content between chat, downloads, and office software.

### Team methods can be reused

Different Agent roles can have their own rules, models, Skills, and memory. A research method, review rule, test procedure, or release process that has already been validated can be reused in later work instead of depending on a prompt written by one person at one moment.

Agents can execute work, while important decisions, accountability, and acceptance remain human responsibilities.

### Teams can own their Agent work system

TabTin includes more than a client. It also includes server components, an Agent Runtime, real-time collaboration, work applications, and administration capabilities. Individuals and small teams can use the official service, while developers can run Community Server on their own computer or continue developing and modifying the product from source.

We will continue making the architecture more modular and pluggable. Only capabilities that exist in the public source and have been verified are described as current. Future directions belong in the [roadmap](ROADMAP.en.md).

## Open-source scope

TabTin is opening the actual product code, not a separate simplified demo.

The intended public system includes desktop and mobile clients, server components, the Agent Runtime, real-time collaboration, messaging, documents, tables, presentations, model management, and administration. The final Public Preview scope and availability status must match the released snapshot and its verification record.

## Get started

Choose the path that matches your goal:

1. **Desktop client with the official service**: for individuals and small teams that want to experience the product without operating server infrastructure. Visit the [TabTin website](https://tabtin.com/).
2. **Community Server**: for users who want the server and its data to run on their own computer. The official configuration currently operates in local-only mode.
3. **Source development**: for developers who want to understand the architecture, modify the product, or contribute.

Published installation and startup commands must be verified in a clean environment. If the documentation differs from the source, please file a bug.

### Community Server

Community Server requires Docker. After downloading or cloning the [public repository](https://github.com/tabtin-ai/TabTin), use the platform entry point from the source root:

- Windows: double-click `start.bat`.
- macOS: double-click `start.command`.
- macOS or Linux terminal: run `./start.sh`.

Wait for `TabTin Community is READY`, then start a matching desktop client, register or sign in, and configure your own OpenAI-compatible model under **Settings → Model Configuration → BYOK**.

Use `status.bat`, `status.command`, or `./status.sh` to inspect the stack. Use `stop.bat`, `stop.command`, or `./stop.sh` to stop it. Stopping preserves accounts, configuration, and Docker volumes. The official Community Server currently listens only on `127.0.0.1` for a client on the same computer; it is not the entry point for multi-device or Internet-facing deployment. See the [Community Open Source Guide](COMMUNITY_OPEN_SOURCE_GUIDE.md) for the complete flow.

### Source development

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

Community Server listens only on the local machine by default and stores account, configuration, and business data in local Docker volumes. The Community client does not connect to TabTin-maintainer Sentry or update services by default. Full diagnostic bundles may be uploaded only with explicit user consent. Data processing for the official service follows its published privacy policy.

## License and trademarks

TabTin's public source is provided under [AGPL-3.0-only](LICENSE). Organizations whose use or distribution is incompatible with AGPL-3.0-only may contact Shanghai Mofan Technology Co., Ltd. at [contact@larchiveai.com](mailto:contact@larchiveai.com) about separate commercial licensing.

Third-party components remain subject to their respective licenses. See [THIRD_PARTY_NOTICES.en.md](THIRD_PARTY_NOTICES.en.md). The TabTin name and marks are trademarks of the project maintainer. Forks may truthfully state that they are “based on TabTin,” but must not impersonate an official release.

Copyright © 2026 Shanghai Mofan Technology Co., Ltd.
