# Security Policy

## Supported versions

RerunTV is currently prerelease software. Security fixes are developed on
`master` and included in the next alpha release.

| Version | Supported |
| --- | --- |
| Latest GitHub alpha release | Yes |
| Current `master` branch | Yes, for reports and source fixes |
| Older alpha releases | No |
| Modified builds and third-party plugins | Only when a RerunTV security boundary is involved |

Users should update to the newest release before reporting a vulnerability
that may already have been fixed. The latest Windows installers are available
from the repository's [Releases page](../../releases).

## Reporting a vulnerability

Do not disclose a suspected vulnerability in a public issue, discussion, pull
request, or social-media post.

Use GitHub's private reporting flow:

1. Open the repository's **Security** tab.
2. Select **Report a vulnerability**.
3. Submit the private advisory form.

If private reporting is unavailable, open a
[minimal public issue](https://github.com/Zhubbs19/RerunTV/issues/new) asking
the maintainer for a private contact method. Do not include technical details
or proof-of-concept material in that issue.

Please include, when available:

- the affected RerunTV version or commit;
- the operating system and installation type;
- the affected component, plugin, protocol, or LAN service;
- clear reproduction steps or a minimal proof of concept;
- the security impact and required preconditions;
- any known workaround or mitigation; and
- your preferred attribution and any proposed disclosure timeline.

Remove secrets and personal data before submitting. Do not attach real access
tokens, pairing links or codes, `channels.json`, private media, unredacted
support bundles, or user-specific filesystem paths.

## What to expect

The project aims to:

- acknowledge a report within three business days;
- provide an initial assessment within seven business days;
- send an update at least weekly while a confirmed issue remains open; and
- coordinate a fix, release, advisory, and reporter credit when appropriate.

These are response targets, not guarantees. Please allow time for a fix and a
new release before public disclosure. If a report is not a security issue, the
maintainer may redirect it to the public issue tracker after removing sensitive
details.

## Scope

Examples of issues that are in scope include:

- arbitrary code execution or privilege-boundary bypasses;
- Electron main, preload, renderer, or custom-protocol boundary failures;
- path traversal or unauthorized local-file access;
- LAN pairing, authentication, authorization, or data-exposure failures;
- updater, installer, release-integrity, or configuration-preservation flaws
  with a security impact;
- plugin capability, integrity, isolation, or sandbox escapes; and
- exposure of credentials, private media, configuration, or filesystem paths.

The following are normally out of scope unless they demonstrate a separate
security impact:

- ordinary playback, layout, performance, or compatibility bugs;
- the expected SmartScreen warning for an unsigned alpha installer;
- vulnerabilities confined to a third-party plugin that do not bypass a
  RerunTV security boundary;
- issues requiring an already-compromised host or deliberate modification of
  local application files; and
- dependency advisories without a reproducible impact on RerunTV.

## Research guidelines

Use only systems and data you own or have explicit permission to test. Avoid
privacy violations, service disruption, destructive testing, persistence, and
accessing another person's media or configuration. Stop testing and report the
issue if you encounter sensitive data.

This project does not currently offer a paid bug-bounty program.
