# Changelog

User-visible changes, newest first. Write each entry for the person it affects.

## Unreleased

- You can sign in to the console on a hub with no sign-in provider. The hub's admin runs `POST /v1/admin/sign-in-links` with the admin token and an email address, and gets a link that signs that browser in once, within ten minutes. The link is refused on a hub that has a sign-in provider configured.
- Initial public release of the OpenCadre hub, console, CLI and client hooks.
- The hub ships without a payment provider. New workspaces start on the non-expiring plan unless `OPENCADRE_BILLING=on`.
