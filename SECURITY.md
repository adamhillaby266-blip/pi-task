# Security Policy

## Supported code

Security fixes are assessed against the current `main` source branch. Pi Task is a local developer-source project, not a hosted service or packaged desktop product.

## Report a vulnerability privately

Do **not** report a vulnerability in a public Issue, Discussion, pull request, Pi session export, or screenshot.

Use GitHub's **Report a vulnerability** control for this repository (Security → Advisories → Report a vulnerability). The public repository is configured to use GitHub Private Vulnerability Reporting.

A useful private report includes:

- a concise description of the impact;
- minimal reproduction steps;
- affected source path or component;
- a safe proof of concept that contains no credential, local session, SQLite database, customer/company data, or unpublished file.

Do not send provider keys, cookies, authentication files, proxy credentials, or real project data. A maintainer will acknowledge and coordinate the fix through the private report.

## Security boundary

Pi Task is designed for local loopback use. It reads local Pi state and can invoke a model provider when a user sends a prompt. Do not expose it through LAN, reverse-proxy, or public-host configurations, and do not operate Pi Web and Pi Task simultaneously on the same active Pi session.
