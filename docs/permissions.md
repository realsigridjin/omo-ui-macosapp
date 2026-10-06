# Permissions

OmO UI shows a permission-mode picker in the composer (Full access / Work in this project / Ask
first). This page records the probe that decided the picker could ship and exactly what it writes.

## What the picker writes

Choosing a mode merges omo's `permissionPreset` key into the workspace project settings file
`<workspace>/.omo/settings.json` through the main process (`electron/workspace-settings.ts`):

```json
{
  "permissionPreset": "ask"
}
```

omo's app-server reads that file before each turn of a thread rooted in the workspace. Under
`ask`, tool calls that need permission arrive in the app as `item/commandExecution/requestApproval`
server requests, which the existing approval card answers; under `workspace`, in-project reads,
listings, edits and shell commands run without asking.

## Probe (2026-10-06, omo 5.1.19)

Question: does `omo app-server --listen stdio://` honor `permissionPreset` from project or global
settings for a thread's tool calls?

Method: a Node JSON-RPC client (`initialize` with `experimentalApi`, then `thread/start`, one turn
asking the model — zai/glm-5.3-flash — to run `echo probe` with the bash tool) in a scratch
workspace `/tmp/omo-perm-probe`, counting inbound approval server requests. `turn/start` resolves
immediately with the running turn, so completion was gated on the `turn/completed` notification.
Every round used a fresh app-server process and deleted its thread after checking `thread.cwd`.

| Settings carrying `permissionPreset: "ask"` | Trust entry for the folder | Tool calls ran | Approval requests |
| --- | --- | --- | --- |
| `.senpi/settings.json` (project) | no | yes | 0 |
| `.senpi/settings.json` (project) | yes | yes | 0 |
| `.omo/settings.json` (project) | yes | yes | **1** |
| `.omo/settings.json` (project) | no | yes | **2** |
| `~/.omo/agent/settings.json` (global) | yes | yes | **1** |

Verbatim evidence from the honored rounds (the transcript files listed at the end):

- `project-omo-trusted`: one server request
  `{"method":"item/commandExecution/requestApproval","params":{"reason":"Tool: eval\n\nPatterns:\n  - *","availableDecisions":["accept","acceptForSession","decline","cancel"]}}`
- `project-omo-untrusted`: two server requests, `reason: "Tool: eval"` then
  `reason: "Command: $ echo probe"`; after `acceptForSession` replies the turn reached
  `turn/completed` with `dynamicToolCall` items.
- `global-ask`: one server request `item/commandExecution/requestApproval` while
  `thread/start` still reported `approvalPolicy: "never"` and `sandbox: {type: "dangerFullAccess"}`.

Findings:

1. The preset is honored. Approval requests flow to subscribers exactly like the documented
   approvals flow, regardless of the wire `approval_policy`/`sandbox` fields staying fixed.
2. omo reads project settings from `<cwd>/.omo/settings.json` — its project-scoped remap of the
   `.senpi/settings.json` its settings guide documents — and ignores `.senpi/settings.json`.
   `config/read { cwd, includeLayers: true }` confirms the project layer resolves to
   `"dotCodexFolder": "<cwd>/.omo"`.
3. No trust decision is required: the untrusted `.omo` round still asked for approvals.
4. The interactive-only first runs of this probe produced turns that completed with zero assistant
   items: `session.log` showed `claude_sdk_oauth_session_continuity kind:failed` and
   `No credential slots available` (the machine's subscription credential pool was saturated), and
   the session file held an assistant message with `stopReason: "aborted"`, 0 input tokens. Pinning
   the probe to an API-key model (zai/glm-5.3-flash) produced real tool calls and the evidence
   above. A "completed" turn with no assistant items means the model call failed, not that
   permissions were bypassed.

The throwaway probe transcript files lived at `/tmp/omo-perm-probe/transcript-*.jsonl` and were
deleted with the scratch workspace after this document captured their decisive frames (see the
commit message for the cleanup receipt).

## The wire fields stay fixed

`thread/start` keeps reporting `approvalPolicy: "never"` and `sandbox: {type: "dangerFullAccess"}`
even while the preset is honored; `config/read` maps them the same way. They describe the Codex
compatibility posture, not omo's effective confirmation policy, so the UI never labels the mode
from those fields.
