# Security policy

## Supported versions

NeuralNote is pre-alpha. Security fixes are applied to the current default branch and, when releases exist, the newest published prerelease. Older commits, builds, and prereleases are not supported.

| Version | Supported |
| --- | --- |
| Current default branch | Yes |
| Newest published prerelease | Best effort |
| Older commits or prereleases | No |

## Report a vulnerability

Do not open a public issue, discussion, or pull request for a suspected vulnerability.

Use [GitHub private vulnerability reporting](https://github.com/ThomasPritchard/NeuralNote/security/advisories/new). If the private report form is unavailable, open a public issue asking the maintainer for a private contact method, but include no vulnerability details in that issue.

Include what you can of the following:

- The affected version, release, or commit.
- The security impact and who could be affected.
- Reproduction steps or a minimal proof of concept.
- Relevant operating-system and provider configuration.
- Any known mitigations or suggested fix.

Remove API keys, vault contents, personal data, and credentials from reports and attachments.
Do not attach `.env.sonar`, SonarScanner output containing credentials, private
analysis artifacts, coverage reports derived from private vaults, or CI logs that
contain tokens.

## What to expect

The maintainer will aim to acknowledge a report within 3 business days and provide an initial assessment within 7 business days. These are targets rather than a service-level agreement for this pre-alpha project.

Please keep the report private while it is investigated. The maintainer will coordinate a disclosure date with you after a fix or mitigation is available. If the report is accepted, the advisory will credit you unless you prefer to remain anonymous.

## Scope

Reports are especially useful when they affect:

- Vault confidentiality, integrity, path handling, or unintended file access.
- API-key storage, logs, provider requests, or other secret handling.
- Tauri IPC, updater behaviour, downloaded helpers, or local sidecars.
- Citation provenance where forged evidence could create a security impact.
- Build, release, or CI systems that could affect distributed artifacts.
- Repository history or generated client bundles that expose credentials or private data.

Reports about an upstream dependency should explain the reachable impact on NeuralNote. General hardening suggestions and bugs without a security impact belong in the public issue tracker.

There is currently no bug bounty or paid reward programme.

## Good-faith research

Keep testing to systems and data you own or have explicit permission to use. Avoid privacy violations, data loss, service disruption, social engineering, and accessing other people's data. Research that follows this policy and applicable law will be treated as authorised, good-faith activity for this project. This statement cannot authorise testing of third-party services or systems.
