import { build } from "esbuild";

const common = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  sourcemap: true,
  external: ["electron"],
  // Prefer ESM entries: a UMD build such as jsonc-parser's requires its own files at runtime, outside the bundle.
  mainFields: ["module", "main"],
  logLevel: "warning",
};

try {
  await Promise.all([
    build({ ...common, entryPoints: ["electron/main.ts"], outfile: "dist-electron/main.cjs" }),
    build({ ...common, entryPoints: ["electron/preload.ts"], outfile: "dist-electron/preload.cjs" }),
    build({ ...common, entryPoints: ["scripts/smoke-bridge.ts"], outfile: "dist-electron/smoke-bridge.cjs" }),
  ]);
} catch (error) {
  console.error(error);
  process.exit(1);
}
