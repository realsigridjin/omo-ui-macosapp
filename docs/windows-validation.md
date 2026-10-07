# Windows validation

## Scope

Windows x64 desktop support preserves the existing Electron UI and macOS code paths. iPhone USB support is intentionally unavailable on Windows. No publisher signing certificate is configured.

## Reproducible checks

Run from the repository root with Node.js 22 or later:

```powershell
npm ci
npm run typecheck
npm test
npm run test:e2e
npm run package:win
```

Do not run build/package commands concurrently with Electron E2E tests. Vite removes and recreates `dist`, so a test that relaunches during another build can load a missing document or stale asset names.

`npm run test:e2e:real` uses the installed omo and makes real model requests. The default E2E suite uses the existing deterministic fake omo and never replaces the user's installation.

## Verified implementation contracts

MCP/model-routing increment `0.1.4-win.3`: TypeScript checks and all 49 unit files / 669 tests passed; full Windows Electron E2E passed 64 scenarios. MCP import regression passed 49 cases, including Claude discovery, BOM/VS Code input and native authentication fields. Actual UI imported 5 existing MCP servers into the real agent directory and reconnected. Research agent, category fallback and named mapping changes were saved through the UI in an isolated user configuration; omo's native config doctor reported no diagnostics. Actual server tool connection remains session/lazy and is distinct from the saved inventory. User research model preferences were not replaced by QA examples.

- About has a separate Windows app update card. Checks use this fork's GitHub releases and include Windows prereleases; an empty release list is reported as unpublished. Installers are size-bounded and SHA-256 verified before opening the Windows installer and closing the app. Active turns disable the install button. Download failures keep non-executable `.part` files for inspection and never launch them. Actual update installation needs a published newer release; none exists at this checkpoint.

App update increment `0.1.4-win.2`: TypeScript checks passed, all 48 unit files / 665 tests passed, and all 64 Windows Electron scenarios passed. The update-specific 50 backend cases cover version ordering, checksums, truncated/error streams, untrusted redirects, timeouts and guarded installer launch. The real GitHub query displayed unpublished, and desktop light / narrow dark About views were inspected. E2E also checked a newer release candidate and the enabled install action. No real downloaded installer was executed because no newer release is published.

- Profile model overrides persist per Daily/Geeky and Normal/Heavy lane, including Automatic and unavailable-model display. Settings exposes the same stored mapping.
- MCP JSON import uses the native file picker, preserves existing server names and settings, writes `mcp.json` with a backup, then reconnects omo.
- The registered local opencodex management API returned 15 sanitized account entries; credentials are not returned to the renderer.
- Android ADB discovery found a Samsung phone and an emulator. The emulator reverse connection opened the browser page, and the real phone-sized browser client completed a turn with the agent response `android-ready`. The physical Samsung interaction was not exercised.
- Screenshot additions are functional Windows surfaces: workspace file/diff inspection, searchable full-window settings, recent-project chooser and device/local-memory overview. No cloud subscription quotas or cloud synchronization status are simulated.

- Settings > omo includes opencodex endpoint and optional key registration. A real `/models` HTTP response is parsed before any file change; other providers and existing keys are preserved. The previous file is backed up to `models.json.backup`. Applying reconnects the app-server, and running turns disable the apply button. Advertised reasoning metadata replaces stale support flags while existing user model entries remain registered.

- Windows PATH uses semicolons and case-insensitive PATH/Path keys.
- Discovery checks the override, install receipt, local bin, and PATH for `omo.exe`.
- Explicit `.mjs` overrides run through Node mode on Windows, allowing existing test fixtures without shebang execution.
- The app-server handshake and chat use the existing JSON-RPC protocol.
- Installer/update use the official PowerShell installer; timeout/cancellation terminates the owned process tree.
- Account login launches a separate interactive PowerShell console with encoded, literal-quoted arguments.
- The file-manager action uses Explorer; editor and terminal arguments preserve spaces and special characters.
- Attachment parsing and file URLs handle Windows drive paths and UNC paths.
- Native Windows window controls and Ctrl+E replace macOS traffic lights and Command+E.

## Evidence and limits

Final feature build on 2026-10-06: TypeScript checks passed, 47 unit files / 615 tests passed, and the full Windows Electron E2E suite passed 63 tests. The Windows package completed successfully and the packaged application was launched. Windows desktop light/dark and narrow settings, project selection, real workspace file/diff inspection, profile selection persistence and opencodex account display were checked. Android's emulator ADB reverse connection and browser client received the agent response `android-ready`. Physical Samsung discovery was checked, not physical-device interaction. The following earlier counts describe prior implementation checkpoints, not the final suite.

Proxy addition: typecheck and 41 unit files / 520 tests passed; the final full Electron E2E run passed 56 tests. Applying the actual `http://127.0.0.1:10100/v1` proxy in Settings preserved the stored key and other providers, registered 60 models including retained user/legacy entries, reconnected omo, and returned `proxy-ready` through a real model request. Supported GPT and DeepSeek reasoning levels were confirmed through the app-server model list. The original settings file is retained in `models.json.backup`.

On 2026-10-06, TypeScript checks passed, the unit suite passed 40 files / 491 tests, and the final Windows Electron E2E run passed all 55 tests. The focused attachment regression run also passed. A real installed omo 5.1.19 app-server completed a chat and returned `windows-ready` through the UI. Desktop light/dark and 520-pixel narrow window captures were inspected. A parallel packaging/build run caused one transient relaunch failure; serial execution of the affected scenarios and the final entire E2E suite passed without retries.

Screenshots and test traces are produced under `test-results`; the Playwright report is under `playwright-report`. Windows packages are under `release`.

macOS branches are covered by existing tests on this workstation but have not been executed on a macOS device. Real account OAuth was not performed because it would modify the user's credentials. The official installer was inspected and tested with controlled scripts rather than reinstalling the user's working omo.

## Data isolation

Keep source, the lockfile, and the latest release/evidence. Move obsolete QA profiles and superseded reports to a dated `_quarantine` directory outside the checkout, with their original paths recorded. Do not follow or move live user credential directories. Deletion is the user's decision; use the user's `trash` command rather than permanent deletion.
