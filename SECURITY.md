# Security policy

OpenCadre sits between AI coding agents and the commands they run, so security reports are taken seriously.

## Reporting a vulnerability

Please report privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue or pull request for a suspected vulnerability.

Include what you found, how to reproduce it, and what an attacker could do with it. If the report involves a key or token, describe it; do not paste it.

This is a small project maintained in spare time. Expect an acknowledgement within about a week.

## Scope

In scope: the hub (`src/`), the console (`public/app/`), the CLI (`cli/`), and the client hooks (`examples/hooks/`, `scripts/`), including:

- reading or changing another organization's or project's data
- bypassing or forging an approval ("clearance") decision
- authentication, OAuth and session handling
- the webhook and outbound-request guards
- secrets appearing in logs, messages or the timeline

Known limit, documented on purpose: the approval gate covers terminal commands. MCP tool calls are not gated.

## Supported versions

Only the latest `main` is supported.
