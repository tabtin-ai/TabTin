# Contributing to TabTin

[中文](CONTRIBUTING.md)

Thank you for your interest in TabTin. Contributions in Chinese and English are welcome.

> Public Preview temporary policy: contributors outside the maintaining organization may open Pull Requests and participate in review, but the current release branch does not yet merge externally submitted code, documentation, or media. Start with Issues, Discussions, reproductions, and product feedback to avoid investing in a large change that cannot enter the current release before the final merge policy is confirmed.

By contributing, you agree to follow the project's [Code of Conduct](CODE_OF_CONDUCT.en.md) and remain responsible for the content, provenance, and verification of your submission.

## Choose the right channel

- Bugs and well-shaped feature requests: use the corresponding Issue template.
- Usage help, open ideas, and early directions: use Discussions.
- Security vulnerabilities: report them privately according to [SECURITY.en.md](SECURITY.en.md). Do not disclose them publicly.
- Small bug fixes, tests, and documentation corrections: open a Pull Request for review, subject to the temporary merge restriction above.
- Changes that significantly affect product behavior, data structures, public APIs, or the overall architecture: start with an Issue or Discussion and align on direction before implementation.

## Development flow

1. Fork the [TabTin public repository](https://github.com/tabtin-ai/TabTin).
2. Create a branch from the latest `main` and keep it focused on one problem.
3. Configure the environment using the public Getting Started and development documentation.
4. Make the change and run relevant tests and static checks.
5. Update affected documentation in both Chinese and English.
6. Open a Pull Request against the public repository's `main` branch.

Public contributors only need to follow the workflow described in this file and the public development documentation.

## Change scope

A Pull Request should solve one independently understandable and reviewable problem. Avoid mixing unrelated refactors, bulk formatting, dependency upgrades, and behavior changes.

If a change affects a public interface, storage structure, or cross-client contract, explain:

- which desktop, mobile, CLI, or integration consumers are affected;
- whether existing clients and data continue to work;
- whether migration, rollback, or a compatibility layer is required;
- how old requests, old responses, and the new behavior were verified.

Unless maintainers explicitly approve a breaking release plan, HTTP, WebSocket, SSE, and other public contracts should evolve additively and remain forward compatible. Preserve existing paths, parameters, enum values, field types, and semantics. New fields should be optional and have safe defaults.

## Testing requirements

Code changes should include tests or explain in the Pull Request why tests cannot currently be provided. Run at least the local checks directly relevant to the changed module and record the commands and results.

Use relevant module READMEs and reproducible repository scripts as the source for development and test commands. The public repository does not currently configure automated CI. The absence of checks does not prove correctness, so local verification recorded in the Pull Request is an important part of review. Any automated checks added later must also pass.

For documentation changes, check at least:

- whether Chinese and English content agree;
- whether relative links exist;
- whether private repositories, internal networks, personal paths, or internal processes are exposed;
- whether future directions are incorrectly presented as current capabilities.

## Minimum Pull Request information

Use the repository template and explain at least:

1. the related problem or context;
2. the purpose and impact of the change;
3. verification commands and results;
4. screenshots or recordings for UI changes;
5. API, data, and compatibility impact;
6. known risks and uncovered boundaries;
7. whether AI was used and how AI-generated work was reviewed and verified.

## AI-assisted contributions

Responsible use of AI for research, coding, testing, and documentation is welcome, but AI does not replace contributor responsibility.

Contributors must:

- understand the code and documentation they submit;
- check sources, risks of training-data-like copying, and third-party licenses;
- run appropriate verification;
- be able to answer maintainer questions about implementation and trade-offs;
- disclose the primary AI tools used and the verification approach in the Pull Request.

Large volumes of raw, unreviewed AI output will not be accepted.

## Commit and documentation style

- Use clear, searchable commit messages that say what changed instead of only `fix` or `update`.
- Never commit secrets, tokens, real business data, personal information, internal addresses, or absolute local paths.
- Write the product name as `TabTin` and follow the public [product concepts](docs/architecture/product-concepts.en.md).
- Project-authored public documentation uses a Chinese source file and a corresponding `.en.md` file. If the two versions differ, the Chinese version governs. Official English text governs licenses and third-party legal notices.

## Review and merge

Maintainers review Pull Requests for correctness, product consistency, compatibility, testing, maintainability, security, and documentation completeness. Opening a Pull Request does not guarantee merge. Maintainers may request a narrower scope, additional verification, or product discussion first.

TabTin is currently maintained under the leadership of Shanghai Mofan Technology Co., Ltd. Community members may earn broader maintenance responsibility through sustained, reliable contributions.

## External contributions

TabTin's public source uses `AGPL-3.0-only` while preserving separate commercial licensing options.

Contributors outside the maintaining organization may submit Pull Requests and participate in review. The current release branch does not merge externally submitted code, documentation, or media. Issues, Discussions, reproductions, and product feedback remain welcome.
