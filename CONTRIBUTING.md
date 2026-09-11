# Contributing to Pi Feats

Thank you for contributing.

## Before opening a pull request

1. Create a focused branch from `main`.
2. Keep changes compatible with the Pi Coding Agent package layout described in [`AGENTS.md`](AGENTS.md).
3. Run:

   ```bash
   npm ci --ignore-scripts
   npm run build:web
   ```

4. Describe the user-visible behavior, validation performed, and any security or profile-sandbox implications in the pull request.

## Reporting issues

Include the Pi Feats version or commit, Pi Coding Agent version, operating system, installation method, steps to reproduce, expected behavior, and relevant sanitized logs. Never include credentials, session transcripts, or private keys.

## Security

Please do not disclose vulnerabilities in public issues before a fix is available. Contact the repository maintainers privately with the impact and reproduction details.
