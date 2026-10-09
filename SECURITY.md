# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Report it privately through GitHub: **Security → Report a vulnerability** on this repository
(https://github.com/bugsee/bugsee-javascript/security/advisories/new), or email security@bugsee.com.

Include the affected package and version, what an attacker can do, and a minimal reproduction. We aim
to acknowledge a report within 3 business days and will keep you informed until it is fixed and
released.

## Scope

The `@bugsee/*` packages published from this repository. Issues in a framework or bundler we integrate
with belong to that project; tell us if our integration makes them worse.

## Supported versions

The SDK is in beta (`0.1.0-beta.x`). Only the latest published beta receives fixes.

## Publishing

Packages are published from GitHub Actions through npm trusted publishing (OIDC); there is no
long-lived npm token. See `.github/workflows/release.yml`.
