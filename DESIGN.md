# Platform port design contract

This Windows port preserves the upstream design system documented in `src/ui/README.md`, `src/dsh/README.md`, and `src/ui/theme/omo-theme.css`. It is not a visual redesign. Existing typography, spacing, colors, sidebar, composer, conversation, and theme tokens remain the source of truth.

## Windows shell

## Screenshot additions

The supplied dark conversation reference establishes three columns: project/thread navigation, conversation and composer, then a read-only file inspector with file tabs and searchable workspace files. Native Windows title-bar controls remain above the content. The light settings reference establishes full-window navigation, section search, breadcrumbs and bottom Back action. Existing functional sections remain; unsupported cloud plan/sync controls are not fabricated. The project reference establishes a centered chooser using real thread workspaces and recent folders, with New project and Continue actions. The device overview uses the current PC and actual Android connection plus local Git memory status; no example quotas, cloud encryption claims or simulated remote devices.

- Use the native Windows title bar and system minimize, maximize, and close controls.
- Use an opaque window background; macOS alone keeps vibrancy and traffic lights.
- Preserve existing narrow-layout behavior and light/dark theme selection.
- Use Ctrl+E for side chat on Windows and Command+E on macOS.
- Label the file-manager target Explorer on Windows while preserving existing IPC IDs.
- Explain that iPhone USB is unsupported on Windows and do not start usbmux retries there.

## Verification

Each native model route has a provider-grouped available-model select above its text editor. Selecting appends a unique fallback for agents/categories and replaces the single mapping target. Direct text editing remains available, with controlled drafts preserving multiline input.

MCP exposes separate existing-configuration discovery and manual file import buttons. Saved servers that have no loaded session status appear as configured, never as connected. Model role editors reuse labeled native selects, existing cards and explicit save-and-reconnect actions; account keys and arbitrary runtime configuration are never sent to the renderer.

About includes a separate Windows app update card using SettingRow and existing Buttons. Manual check, unpublished, current, available, downloading progress, verified, installing and error states are explicit. The install action explains that the app closes for the Windows installer and is disabled during active turns. No installation occurs on a background check.

Profile model overrides reuse the composer model picker and native labeled select controls. MCP import uses the existing settings toolbar button, with importing, success, cancellation and error states. opencodex accounts are a read-only provider card, never showing credential values or offering unsupported pin/remove actions. Android replaces the iPhone navigation item and uses existing card, facts, Button and input styles; device discovery is manual, connection requires choosing a ready device, and disconnect is explicit. Android's browser surface uses readable responsive text, labeled controls, keyboard focus, and safe text rendering for model output.

The omo settings section includes an opencodex card using the existing SettingRow, Button and card styles. Endpoint and password inputs keep the stored key out of IPC responses. Applying explicitly states that omo reconnects. Loading, applying, success model count and failure are visible states.

Drive the real Electron application, not a static replica. Check light/dark desktop and narrow windows, side chat, settings, native window controls, keyboard navigation, and Korean text for overlap or clipping. Existing Playwright screenshots and scenarios are reused.
