import { spawnSync } from "node:child_process";

// `OMO_UI_E2E_REAL=1 playwright test ...` is not valid on Windows; set the env here instead.
const result = spawnSync("npx", ["playwright", "test", "e2e/real.spec.ts"], {
  stdio: "inherit",
  env: { ...process.env, OMO_UI_E2E_REAL: "1" },
  shell: process.platform === "win32",
});

process.exit(result.status ?? 1);
