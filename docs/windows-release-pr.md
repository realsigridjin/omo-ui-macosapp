# Windows app updates, MCP import, model routing and automatic releases

## Changes

- Add a separate Windows app update card with GitHub release discovery and SHA-256 verified installer download.
- Discover existing Claude/Cursor MCP configurations, preserve authentication and connection fields, and show saved servers before session connection.
- Add native omo research-agent, task-category and named model-routing settings with backup and reconnect.
- Release version `0.1.4-win.3` and add a Windows-only CI/release workflow for this fork.

## Automatic release behavior

The PR runs TypeScript, unit, Electron E2E and Windows packaging checks. On merge into `windows-support`, the same checks run and publish `v<package.json version>` with the Windows installer and `SHA256SUMS`. Windows prerelease versions are marked prerelease. Existing releases are never overwritten. The desktop updater reads these assets from this repository.

## Verification

Local type checks passed, all 669 unit tests and 64 Electron scenarios passed, and the final Windows package completed. The latest model-routing preservation adjustment passed focused tests after the full suite. The packaged application was launched and checked. Existing user MCP discovery imported five actual servers and reconnected. Model settings were exercised in an isolated user configuration and accepted by omo's config doctor.

Windows packages are unsigned. No actual remote app-update installation was exercised because this fork has no published newer release yet. macOS is not a supported release target of this fork.
