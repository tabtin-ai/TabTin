# Security Policy

[中文](SECURITY.md)

## Supported versions

TabTin supports only the latest public stable version. Public Preview or experimental components may have additional limitations described in their release notes.

| Version | Security support |
| --- | --- |
| Latest public stable version | Supported |
| Earlier versions | No separate fix commitment |
| Unreleased branches and locally modified builds | No formal support |

If a problem occurs only on an older release, first check whether it can be reproduced on the latest public stable version.

## Report a vulnerability privately

Prefer **Report a vulnerability** on the [TabTin public repository's Security page](https://github.com/tabtin-ai/TabTin/security). If that entry is not yet visible, email [contact@larchiveai.com](mailto:contact@larchiveai.com) with `[SECURITY]` in the subject. Do not disclose an unpatched vulnerability through a normal Issue, Discussion, Pull Request, group chat, or social media.

Include as much of the following as possible:

- affected versions, components, and deployment type;
- vulnerability class and potential impact;
- minimal reproduction steps or proof of concept;
- required permissions, configuration, and prerequisites;
- any scope confirmed not to be affected;
- a suggested remediation, if available;
- preferred attribution, if any.

Remove real secrets, tokens, personal information, business data, conversation content, internal addresses, and unnecessary local paths. Do not access, modify, or delete data that does not belong to you in order to demonstrate a vulnerability.

## Response expectations

The maintenance team's target is to complete initial triage and respond with next steps within **five business days**. This is not a fixed remediation deadline.

Remediation time depends on impact, reproduction reliability, implementation complexity, release coordination, and user protection. Maintainers will provide reasonable status updates to the reporter.

## Coordinated disclosure

Do not publish vulnerability details before maintainers confirm that users have reasonable protection. Maintainers and the reporter will coordinate disclosure timing, announcement scope, and attribution based on impact and remediation progress.

If a report is not considered a security vulnerability, maintainers may suggest moving it to a normal Issue or Discussion. Sensitive information will be removed before any public conversion.

## Security research boundaries

Good-faith security research is welcome, but the following activities are not authorized:

- disrupting service availability or performing denial-of-service testing;
- accessing, downloading, modifying, or deleting another person's data;
- using social engineering, phishing, or harassment to obtain access;
- broad automated scanning of production organizations without permission;
- publishing directly exploitable details before remediation.

Limit testing to accounts, organizations, devices, and deployments that you own or have explicit permission to use.

## Deployment responsibility

The official Community Server listens only on the local machine by default. Anyone who changes that configuration to allow other devices or expose the service to the Internet is responsible for operating-system security, network boundaries, TLS, databases, object storage, secret management, backups, monitoring, and dependency updates. TabTin security updates do not replace infrastructure security management.
