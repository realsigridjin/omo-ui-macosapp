# Windows x64 support and desktop workflow extensions

## Summary

This change provides a Windows x64 distribution of OmO UI and preserves the upstream MIT, DeepSeek and font notices. It adds Windows binary discovery, inherited environment handling, PowerShell installation and login, native window controls, Explorer/editor opening and Windows attachment paths.

The integrated desktop workflow includes configurable model profiles, MCP JSON import, opencodex registration and read-only account inventory, Android ADB/browser control, workspace file/diff inspection, full-window settings, a recent-project chooser and a local device/memory overview. macOS/iOS source remains, but this contribution was verified on Windows only.

## Verification

- `npm run typecheck`: passed.
- `npm test`: 47 files, 615 tests passed.
- `npm run test:e2e`: 63 Windows Electron scenarios passed.
- `npm run package:win`: passed; packaged Windows app launched with version `0.1.4-win.1`.
- Real omo 5.1.19 proxy model discovery, account inventory and chat were exercised. Android's emulator ADB reverse connection and browser client completed a real turn.

## Review notes

This is a Windows-focused contribution, including desktop workflow extensions rather than a minimal platform-only patch. The fork has a distinct application ID and distribution name (`OmO UI Windows`). These branding changes can remain fork-specific if upstream adopts the Windows runtime support.

No actual macOS device run was performed. The physical Android phone was discovered, while interaction was checked through the emulator and browser client. The memory overview reports local Git state, not cloud synchronization or subscription quotas. Windows binaries are unsigned. No credentials, user profiles, traces or installation binaries are included in the source commits.
