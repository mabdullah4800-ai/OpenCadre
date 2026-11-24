# Contributing to OpenCadre

Thanks for looking. This project was built in private by one person working with a fleet of AI coding agents, and opened up so others can use it, fix it and take it further. Issues and pull requests are welcome.

## Getting set up

```bash
git clone https://github.com/mabdullah4800-ai/OpenCadre.git
cd OpenCadre
npm install
npm run typecheck
npm test
npm run dev        # local hub on :8787
```

Use **Node 22 or 24**. CI runs Node 24 on Linux and Windows.

### Known issue: Node 25

Node 25 turns on a built-in `localStorage` that clashes with the console tests. If you must use Node 25, run:

```bash
NODE_OPTIONS=--no-experimental-webstorage npm test
```

Even then, some approval-gate and wake-hook tests that spawn child processes have been seen to fail on Node 25 on Windows. That has not been investigated. If you can reproduce or explain it, please open an issue.

## Where things are

See the map in [AGENTS.md](AGENTS.md). Start with:

- [docs/quickstart.md](docs/quickstart.md) to run a hub and connect two agents
- [docs/CLIENT-ONBOARDING.md](docs/CLIENT-ONBOARDING.md) for per-client setup
- [docs/playbooks/ADD-A-CLIENT.md](docs/playbooks/ADD-A-CLIENT.md) to add support for a new coding tool
- [docs/design/rbac-permission-model.md](docs/design/rbac-permission-model.md) for who can do what

## Pull requests

- One change per PR, branched from `main`.
- `npm run typecheck` and `npm test` pass.
- Say in the PR body what could go wrong (security, concurrency, fail-closed behavior, wording that makes a claim).
- User-visible changes add a line to `CHANGELOG.md` under `## Unreleased`.
- Database migrations are additive only, numbered in `src/migrations.ts` and mirrored in `src/db-postgres.ts`.
- Never commit a secret, a real key, or anyone's personal data. Test fixtures use obvious dummies.

## Skipped tests

This repository starts from a clean snapshot. The private development history and the internal planning and design documents were not published. A few tests depended on them, so they are skipped and marked `PUBLIC-SNAPSHOT SKIP`:

- Four suites are excluded in `vitest.config.ts` because they compare against commits from the old history.
- A handful of individual cases are skipped in place because they read old commits or cite internal documents.

Search for `PUBLIC-SNAPSHOT SKIP` to find them. Rewriting any of them to work from this repository's own history is a good first contribution.

You will also see comments in the code that point at files that are not here: documents under `docs/design`, `docs/planning` or `docs/ops`, and modules such as `src/site-*.ts`, `src/billing-*.ts`, `src/emails.ts` or `public/site`. Those belonged to a hosted service and its internal notes, which are not part of this repository. If a comment is unclear without its document, open an issue and ask.

## Good places to start

- The two largest files, `public/app/app.js` and `src/rest.ts`, would benefit from being split into modules.
- `src/db-postgres.ts` mirrors the schema, but the hub runs on SQLite only. Wiring Postgres in is open work.
- Architecture documentation written for outside readers.

## Security

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).

## Licence

By contributing you agree that your contribution is licensed under the [MIT Licence](LICENSE).
