import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import type { ModelMapping, ModelMappingKind, ModelRung } from "../shared/ipc";

/** The block of `~/.omo/omo.jsonc` that OmO Native reads; omo reloads the file when it changes. */
const NATIVE = "[native]";
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MODEL = /^[^\s/]+\/\S+$/;
const MAX_RUNGS = 12;

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `<home>/.omo/omo.jsonc`, the config file OmO Native reads. */
export function omoConfigPath(homeDir: string): string {
  return path.join(homeDir, ".omo", "omo.jsonc");
}

async function readText(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
    throw error;
  }
}

function parseConfig(text: string): JsonObject {
  if (text.trim() === "") return {};
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !isRecord(value)) throw new Error("omo.jsonc is not valid JSONC; fix it before editing models here");
  return value;
}

/** The ordered chain one agent or category entry names: `models` first, else its single `model`. */
function rungsOf(entry: unknown): ModelRung[] {
  if (!isRecord(entry)) return [];
  const reasoning = typeof entry["reasoning"] === "string" ? entry["reasoning"] : typeof entry["variant"] === "string" ? entry["variant"] : null;
  const list = Array.isArray(entry["models"]) ? entry["models"] : typeof entry["model"] === "string" ? [entry["model"]] : [];
  return list.flatMap((item, index): ModelRung[] => {
    if (typeof item === "string") return [{ model: item, reasoning: index === 0 ? reasoning : null }];
    if (isRecord(item) && typeof item["model"] === "string") {
      const own = typeof item["reasoning"] === "string" ? item["reasoning"] : typeof item["variant"] === "string" ? item["variant"] : null;
      return [{ model: item["model"], reasoning: own }];
    }
    return [];
  });
}

/** Reads the agent and category model chains under `"[native]"`; entries with no model are omitted. */
export async function readModelMapping(homeDir: string): Promise<ModelMapping> {
  const config = parseConfig(await readText(omoConfigPath(homeDir)));
  const native = isRecord(config[NATIVE]) ? config[NATIVE] : {};
  const section = (key: ModelMappingKind): Record<string, ModelRung[]> => {
    const block = isRecord(native[key]) ? native[key] : {};
    return Object.fromEntries(Object.entries(block).map(([name, entry]) => [name, rungsOf(entry)] as const).filter(([, rungs]) => rungs.length > 0));
  };
  return { path: omoConfigPath(homeDir), agents: section("agents"), categories: section("categories") };
}

/**
 * Sets one agent's or category's model chain under `"[native]"` in place, keeping the file's comments and other keys.
 * `null` or an empty chain removes the override so omo's built-in chain applies again. The write is atomic.
 */
export async function writeModelChain(homeDir: string, kind: ModelMappingKind, name: string, rungs: ModelRung[] | null): Promise<ModelMapping> {
  if (kind !== "agents" && kind !== "categories") throw new TypeError("kind must be agents or categories");
  if (!NAME.test(name)) throw new TypeError("name must be an agent or category id");
  if (rungs !== null && (rungs.length > MAX_RUNGS || rungs.some((rung) => !MODEL.test(rung.model) || (rung.reasoning !== null && !NAME.test(rung.reasoning))))) {
    throw new TypeError("each rung needs a provider/model id and an optional reasoning level");
  }
  const file = omoConfigPath(homeDir);
  const text = await readText(file);
  const config = parseConfig(text);
  const existing = isRecord(config[NATIVE]) && isRecord(config[NATIVE][kind]) ? config[NATIVE][kind][name] : undefined;
  const format = { insertSpaces: true, tabSize: 2, eol: "\n" };
  let next = text.trim() === "" ? "{}\n" : text;
  const set = (pathParts: (string | number)[], value: unknown): void => {
    next = applyEdits(next, modify(next, pathParts, value, { formattingOptions: format }));
  };
  if (rungs === null || rungs.length === 0) {
    if (existing === undefined) return readModelMapping(homeDir);
    // Only the model keys belong to this screen; a description or prompt on the same entry stays.
    const others = isRecord(existing) ? Object.keys(existing).filter((key) => !["model", "models", "reasoning", "variant"].includes(key)) : [];
    if (others.length === 0) set([NATIVE, kind, name], undefined);
    else for (const key of ["model", "models", "reasoning", "variant"]) if (isRecord(existing) && key in existing) set([NATIVE, kind, name, key], undefined);
  } else {
    const models = rungs.map((rung) => (rung.reasoning === null ? rung.model : { model: rung.model, reasoning: rung.reasoning }));
    for (const key of ["model", "reasoning", "variant"]) if (isRecord(existing) && key in existing) set([NATIVE, kind, name, key], undefined);
    set([NATIVE, kind, name, "models"], models);
  }
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temp, next.endsWith("\n") ? next : `${next}\n`, "utf8");
  await rename(temp, file);
  return readModelMapping(homeDir);
}
