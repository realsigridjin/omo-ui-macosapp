import { constants } from "node:fs";
import { copyFile, mkdir, open, readFile, rename, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import JSON5 from "json5";
import type { ModelRoute, ModelRoutingInput, ModelRoutingSettings } from "../../shared/model-routing";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
async function load(home: string): Promise<{ file: string; text: string | null; value: Record<string, unknown> }> {
  for (const name of ["omo.jsonc", "omo.json"]) {
    const file = path.join(home, ".omo", name);
    let text: string;
    try { text = await readFile(file, "utf8"); }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") continue; throw error; }
    const value: unknown = JSON5.parse(text.replace(/^\uFEFF/, ""));
    if (!record(value)) throw new Error("Invalid omo model configuration.");
    return { file, text, value };
  }
  return { file: path.join(home, ".omo", "omo.jsonc"), text: null, value: {} };
}
function rows(value: unknown, mapping = false): ModelRoute[] {
  if (value === undefined) return [];
  if (!record(value)) throw new Error("Invalid omo model routing section.");
  return Object.entries(value).map(([name, entry]) => {
    if (!record(entry)) throw new Error("Invalid omo model routing entry.");
    const refs = mapping ? [entry["model"]] : Array.isArray(entry["models"]) ? entry["models"] : entry["model"] === undefined ? [] : [entry["model"]];
    return { name, models: refs.map((ref) => {
      if (typeof ref === "string") return ref;
      if (record(ref) && typeof ref["model"] === "string") return typeof ref["reasoning"] === "string" ? `${ref["model"]}:${ref["reasoning"]}` : ref["model"];
      throw new Error("Invalid omo model reference.");
    }) };
  });
}
export async function readModelRouting(home: string): Promise<ModelRoutingSettings> {
  const config = await load(home);
  const native = config.value["[senpi]"];
  if (native !== undefined && !record(native)) throw new Error("Invalid native model configuration.");
  const view = { ...config.value, ...(record(native) ? native : {}) };
  for (const key of ["categories", "agents", "models"]) {
    const base = config.value[key];
    const override = record(native) ? native[key] : undefined;
    if (record(base) && record(override)) view[key] = { ...base, ...override };
  }
  return { configPath: config.file, categories: rows(view["categories"]), agents: rows(view["agents"]), mappings: rows(view["models"], true) };
}
function parseInput(value: unknown): ModelRoutingInput {
  if (!record(value)) throw new Error("Invalid model settings.");
  const result: ModelRoutingInput = { categories: [], agents: [], mappings: [] };
  for (const group of ["categories", "agents", "mappings"] as const) {
    const entries = value[group];
    if (!Array.isArray(entries) || entries.length > 200) throw new Error("Invalid model routing list.");
    const names = new Set<string>();
    for (const entry of entries) {
      if (!record(entry) || typeof entry["name"] !== "string" || !/^[A-Za-z0-9_.-]+$/.test(entry["name"]) || names.has(entry["name"])) throw new Error("Model route names must be unique letters, numbers, dots, underscores or hyphens.");
      const models = entry["models"];
      if (!Array.isArray(models) || models.length > 20 || (group === "mappings" && models.length !== 1) || models.some((model) => typeof model !== "string" || model.trim() === "" || /[\r\n\0]/.test(model))) throw new Error("Invalid model routing references.");
      const refs: string[] = [];
      for (const ref of models) { if (typeof ref !== "string") throw new Error("Invalid model reference."); refs.push(ref.trim()); }
      names.add(entry["name"]);
      result[group].push({ name: entry["name"], models: refs });
    }
  }
  return result;
}
export async function saveModelRouting(home: string, input: unknown): Promise<ModelRoutingSettings> {
  const settings = parseInput(input);
  const config = await load(home);
  // Native overrides belong in the native block; other harnesses and root mappings remain untouched.
  const previous = config.value["[senpi]"];
  if (previous !== undefined && !record(previous)) throw new Error("Invalid native model configuration.");
  const native: Record<string, unknown> = record(previous) ? { ...previous } : {};
  for (const group of ["categories", "agents", "mappings"] as const) {
    const key = group === "mappings" ? "models" : group;
    const rootSection = config.value[key];
    const nativeSection = native[key];
    if ((rootSection !== undefined && !record(rootSection)) || (nativeSection !== undefined && !record(nativeSection))) throw new Error("Invalid model configuration section.");
    const section = { ...(record(rootSection) ? rootSection : {}), ...(record(nativeSection) ? nativeSection : {}) };
    for (const row of settings[group]) {
      const existing = section[row.name];
      const entry = record(existing) ? { ...existing } : {};
      if (group === "mappings") {
        entry["model"] = row.models[0];
        if (row.models[0]?.includes(":")) delete entry["reasoning"];
      }
      else {
        const originalModels = Array.isArray(entry["models"]) ? entry["models"] : [];
        entry["models"] = row.models.map((ref) => originalModels.find((old) => record(old) && (typeof old["reasoning"] === "string" ? `${old["model"]}:${old["reasoning"]}` : old["model"]) === ref) ?? ref);
        delete entry["model"];
      }
      section[row.name] = entry;
    }
    native[key] = section;
  }
  await mkdir(path.dirname(config.file), { recursive: true });
  if (config.text !== null) {
    try { await copyFile(config.file, `${config.file}.models.bak`, constants.COPYFILE_EXCL); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; if (!(await stat(`${config.file}.models.bak`)).isFile()) throw error; }
  }
  const stagedPath = `${config.file}.${randomUUID()}.tmp`;
  const staged = await open(stagedPath, "wx", 0o600);
  try { await staged.writeFile(JSON.stringify({ ...config.value, "[senpi]": native }, null, 2) + "\n"); await staged.sync(); }
  finally { await staged.close(); }
  await rename(stagedPath, config.file);
  return { configPath: config.file, ...settings };
}
