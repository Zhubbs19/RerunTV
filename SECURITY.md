# Security Policy

## Supported versions

RerunTV is currently prerelease software. Security fixes are developed on
`master` and included in the next beta release.

| Version | Supported |
| --- | --- |
| Latest GitHub beta release | Yes |
| Current `master` branch | Yes, for reports and source fixes |
| Older beta releases | No |
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
- the expected SmartScreen warning for an unsigned beta installer;
- vulnerabilities confined to a third-party plugin that do not bypass a
  RerunTV security boundary;
- issues requiring an already-compromised host or deliberate modification of
  local application files; and
- dependency advisories without a reproducible impact on RerunTV.

## Security model

Knowing the design helps you judge what counts as a vulnerability:

- **LAN services use plain HTTP.** The watch-on-other-devices viewer, the phone
  remote and other plugin servers bind to the local network and are protected by
  a per-boot pairing code, HttpOnly session cookies, rate limits and separate
  view and control scopes. They are not encrypted, so run them only on a network
  you trust. The Android clients allow cleartext traffic for the same reason.
  Administration (installing plugins, approving capabilities, updates) is never
  available remotely.
- **Companion app threat model.** The phone companion talks to the box over
  cleartext HTTP on the LAN (Android `usesCleartextTraffic`, iOS
  `NSAllowsLocalNetworking`). Pairing sends the pairing code once in the query
  string of a `GET /?pair=<code>`, so the code can appear in the box's request
  logs and is visible to anyone who can sniff the network; the box answers with
  a session token that the app stores in the platform secure store and sends as
  an `Authorization: Bearer` header afterwards. Anyone on the same network who
  captures the code or token before the pairing code rotates can act with that
  scope. Mitigations: codes are per-boot and rate limited, view and control
  scopes are separate, and administration is never remote. Android's network
  security config can only allow cleartext per domain, not per private IP range,
  so the app cannot be restricted to LAN addresses at the OS level; use the
  companion only on a network you trust.
- **Plugins are trusted code.** A plugin you install can run in the Electron
  main process with full Node access. Declared capabilities (IPC channels,
  spawned binaries, network ports, filesystem paths) are an approval step shown
  to the user, not a sandbox. Only plugins whose manifest sets `"isolated": true`
  run in a separate process. Install plugins only from sources you trust. See
  the "Trust model" section of `PLUGIN_DEVELOPMENT.md`.
- **The code is AI-written and has not been independently audited.** RerunTV is vibe-coded with an AI
  coding agent. It is covered by tests, CI and static analysis, but it has not had an outside code review
  or a third-party security audit, so please report anything you find privately.
- **Releases are unsigned.** Beta installers are not code-signed, so Windows
  SmartScreen warns on first run.
- **No telemetry.** RerunTV makes no network requests of its own except the ones
  you enable (update checks, weather, optional metadata plugins, and the optional ffmpeg download).

## Research guidelines

Use only systems and data you own or have explicit permission to test. Avoid
privacy violations, service disruption, destructive testing, persistence, and
accessing another person's media or configuration. Stop testing and report the
issue if you encounter sensitive data.

This project does not currently offer a paid bug-bounty program.
