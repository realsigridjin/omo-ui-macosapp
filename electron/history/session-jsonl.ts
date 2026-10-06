import type { HistoricalTask, HistoryResult, HistoryTurn, MemoryWriteNotice, SessionNotice } from "../../shared/ipc";
import { parseTodo } from "../../src/state/live-wire";
import type { DynamicToolCallContentItem, DynamicToolCallItem, ThreadItem, TurnError, UserInput } from "../../shared/protocol";

type JsonObject = Record<string, unknown>;

interface Entry {
  id: string;
  parentId: string | null;
  type: string;
  timestamp: number | null;
  raw: JsonObject;
}

interface TurnBuilder {
  id: string;
  startedAt: number | null;
  lastTimestamp: number | null;
  items: ThreadItem[];
  tools: Map<string, DynamicToolCallItem>;
  hasAssistant: boolean;
  stopReason: string | null;
  error: TurnError | null;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEntry(line: string): Entry | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    // Truncated or corrupt lines are expected in live session files.
    void error;
    return null;
  }
  if (!isRecord(value) || typeof value["type"] !== "string" || value["type"] === "session") return null;
  const id = value["id"];
  if (typeof id !== "string") return null;
  const parentId = value["parentId"];
  const timestamp = typeof value["timestamp"] === "string" ? Date.parse(value["timestamp"]) : Number.NaN;
  return {
    id,
    parentId: typeof parentId === "string" ? parentId : null,
    type: value["type"],
    timestamp: Number.isNaN(timestamp) ? null : timestamp,
    raw: value,
  };
}

function activeBranch(entries: Map<string, Entry>, leafId: string | null): Entry[] {
  const branch: Entry[] = [];
  const seen = new Set<string>();
  let cursor = leafId;
  while (cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    const entry = entries.get(cursor);
    if (entry === undefined) break;
    branch.push(entry);
    cursor = entry.parentId;
  }
  return branch.reverse();
}

function blocks(content: unknown): JsonObject[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content.filter(isRecord) : [];
}

function dataUrl(block: JsonObject): string | null {
  const { data, mimeType } = block;
  return typeof data === "string" && typeof mimeType === "string" ? `data:${mimeType};base64,${data}` : null;
}

function userContent(content: unknown): UserInput[] {
  const result: UserInput[] = [];
  for (const block of blocks(content)) {
    if (block["type"] === "text" && typeof block["text"] === "string") {
      result.push({ type: "text", text: block["text"], text_elements: [] });
    } else if (block["type"] === "image") {
      const url = dataUrl(block);
      if (url !== null) result.push({ type: "image", url });
    }
  }
  return result;
}

function resultContent(content: unknown): DynamicToolCallContentItem[] {
  const result: DynamicToolCallContentItem[] = [];
  for (const block of blocks(content)) {
    if (block["type"] === "text" && typeof block["text"] === "string") {
      result.push({ type: "inputText", text: block["text"] });
    } else if (block["type"] === "image") {
      const imageUrl = dataUrl(block);
      if (imageUrl !== null) result.push({ type: "inputImage", imageUrl });
    }
  }
  return result;
}

function startTurn(entry: Entry): TurnBuilder {
  return {
    id: entry.id,
    startedAt: entry.timestamp,
    lastTimestamp: entry.timestamp,
    items: [],
    tools: new Map(),
    hasAssistant: false,
    stopReason: null,
    error: null,
  };
}

function addAssistant(turn: TurnBuilder, entry: Entry, message: JsonObject): void {
  turn.hasAssistant = true;
  turn.stopReason = typeof message["stopReason"] === "string" ? message["stopReason"] : null;
  turn.error =
    turn.stopReason === "error" && typeof message["errorMessage"] === "string" ? { message: message["errorMessage"] } : null;
  blocks(message["content"]).forEach((block, index) => {
    const id = `${entry.id}:${index}`;
    if (block["type"] === "text" && typeof block["text"] === "string") {
      turn.items.push({ type: "agentMessage", id, text: block["text"], phase: null });
    } else if (block["type"] === "thinking" && typeof block["thinking"] === "string" && block["thinking"] !== "") {
      turn.items.push({ type: "reasoning", id, summary: [], content: [block["thinking"]] });
    } else if (block["type"] === "toolCall" && typeof block["id"] === "string" && typeof block["name"] === "string") {
      const call: DynamicToolCallItem = {
        type: "dynamicToolCall",
        id: block["id"],
        namespace: null,
        tool: block["name"],
        arguments: block["arguments"],
        status: "inProgress",
        contentItems: null,
        success: null,
        durationMs: null,
      };
      turn.items.push(call);
      turn.tools.set(call.id, call);
    }
  });
}

function completeTool(turn: TurnBuilder, message: JsonObject): void {
  const toolCallId = message["toolCallId"];
  const call = typeof toolCallId === "string" ? turn.tools.get(toolCallId) : undefined;
  if (call === undefined) return;
  const failed = message["isError"] === true;
  const details = message["details"];
  call.status = failed ? "failed" : "completed";
  call.success = !failed;
  call.contentItems = resultContent(message["content"]);
  if (isRecord(details) && typeof details["durationMs"] === "number") call.durationMs = details["durationMs"];
}

const NOTICE_TEXT_LIMIT = 8_000;

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Reads `details.writeNotice` of a memory tool result; null when it is missing or malformed. */
export function memoryWriteNotice(details: unknown): MemoryWriteNotice | null {
  const notice = isRecord(details) ? details["writeNotice"] : undefined;
  if (!isRecord(notice) || typeof notice["sha"] !== "string") return null;
  const affected = Array.isArray(notice["affected"])
    ? notice["affected"].filter(isRecord).flatMap((entry) => typeof entry["path"] === "string"
      ? [{ path: entry["path"], insertions: num(entry["insertions"]) ?? 0, deletions: num(entry["deletions"]) ?? 0 }] : [])
    : [];
  const size = notice["size"];
  const timeline = isRecord(notice["timeline"]) ? notice["timeline"] : {};
  const sized = isRecord(size) && num(size["systemBytes"]) !== null && num(size["totalBytes"]) !== null && num(size["fileCount"]) !== null;
  const iso = (value: unknown): string | null => (typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null);
  return {
    sha: notice["sha"],
    subject: typeof notice["subject"] === "string" ? notice["subject"] : "",
    affected,
    size: sized ? { systemBytes: size["systemBytes"] as number, totalBytes: size["totalBytes"] as number, fileCount: size["fileCount"] as number } : null,
    entriesToday: num(timeline["entriesToday"]),
    previousEntryAt: iso(timeline["previousEntryAtISO"]),
    lastConsolidationAt: iso(timeline["lastConsolidationAtISO"]),
  };
}

function noticeText(content: unknown): string {
  const text = blocks(content).flatMap((block) => (block["type"] === "text" && typeof block["text"] === "string" ? [block["text"]] : [])).join("\n");
  return text.length > NOTICE_TEXT_LIMIT ? `${text.slice(0, NOTICE_TEXT_LIMIT)}…` : text;
}

function finishTurn(turn: TurnBuilder, isFinal: boolean): HistoryTurn {
  const last = turn.items.at(-1);
  const status =
    turn.stopReason === "aborted"
      ? "interrupted"
      : turn.stopReason === "error"
        ? "failed"
        : isFinal && (!turn.hasAssistant || (last?.type === "dynamicToolCall" && last.status === "inProgress"))
          ? "inProgress"
          : "completed";
  return {
    id: turn.id,
    status,
    error: turn.error,
    items: turn.items,
    startedAt: turn.startedAt,
    completedAt: status === "inProgress" ? null : turn.lastTimestamp,
  };
}

/**
 * Rebuilds the turns of the active branch (last entry back to the root through parentId)
 * of an omo session JSONL file. Malformed lines and non-rendered entry types are skipped.
 */
export function parseSessionJsonl(text: string): HistoryResult {
  const entries = new Map<string, Entry>();
  let leafId: string | null = null;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const entry = parseEntry(line);
    if (entry === null) continue;
    entries.set(entry.id, entry);
    leafId = entry.id;
  }

  const builders: TurnBuilder[] = [];
  let todo: HistoryResult["todo"] = null;
  const tasks = new Map<string, HistoricalTask>();
  const completions = new Map<string, HistoricalTask>();
  const taskOrder = new Set<string>();
  let turn: TurnBuilder | null = null;
  const memoryWrites: Record<string, MemoryWriteNotice> = {};
  const notices: SessionNotice[] = [];
  // Notices before the first turn wait for it and sit at its top.
  const leading: SessionNotice[] = [];
  for (const entry of activeBranch(entries, leafId)) {
    if (entry.type === "custom_message" && typeof entry.raw["customType"] === "string") {
      const notice: SessionNotice = {
        id: entry.id,
        customType: entry.raw["customType"],
        display: entry.raw["display"] === true,
        text: noticeText(entry.raw["content"]),
        timestamp: entry.timestamp,
        turnIndex: builders.length - 1,
        afterItems: turn?.items.length ?? 0,
      };
      if (turn === null) leading.push(notice);
      else notices.push(notice);
    }
    if (entry.type === "message" && isRecord(entry.raw["message"]) && entry.raw["message"]["role"] === "toolResult"
      && entry.raw["message"]["toolName"] === "memory" && typeof entry.raw["message"]["toolCallId"] === "string") {
      const write = memoryWriteNotice(entry.raw["message"]["details"]);
      if (write !== null) memoryWrites[entry.raw["message"]["toolCallId"]] = write;
    }
    if (entry.type === "custom" && entry.raw["customType"] === "senpi.todo-state") {
      const parsed = parseTodo(entry.raw["data"]);
      if (parsed !== null) todo = parsed;
    }
    if (entry.type === "message" && isRecord(entry.raw["message"])) {
      const message = entry.raw["message"];
      if (message["role"] === "toolResult" && message["toolName"] === "task") {
        const task = historicalTask(message["details"], true);
        if (task !== null) {
          taskOrder.add(task.task_id);
          tasks.set(task.task_id, task);
        }
      }
    }
    if (entry.type === "custom_message" && entry.raw["customType"] === "omo-senpi:wake" && Array.isArray(entry.raw["details"])) {
      for (const wake of entry.raw["details"]) {
        if (!isRecord(wake) || wake["customType"] !== "senpi-task.completion" || !Array.isArray(wake["details"])) continue;
        for (const record of wake["details"]) {
          const task = historicalTask(record, false);
          if (task !== null) {
            taskOrder.add(task.task_id);
            completions.set(task.task_id, task);
          }
        }
      }
    }
    if (entry.type === "compaction") {
      turn ??= startTurn(entry);
      if (builders.at(-1) !== turn) builders.push(turn);
      turn.items.push({ type: "contextCompaction", id: entry.id });
    } else if (entry.type === "message" && isRecord(entry.raw["message"])) {
      const message = entry.raw["message"];
      const role = message["role"];
      if (role === "user") {
        turn = startTurn(entry);
        builders.push(turn);
        turn.items.push({ type: "userMessage", id: entry.id, clientId: null, content: userContent(message["content"]) });
      } else if (role === "assistant") {
        turn ??= startTurn(entry);
        if (builders.at(-1) !== turn) builders.push(turn);
        addAssistant(turn, entry, message);
      } else if (role === "toolResult" && turn !== null) {
        completeTool(turn, message);
      } else {
        continue;
      }
    } else {
      continue;
    }
    if (turn !== null && entry.timestamp !== null) turn.lastTimestamp = entry.timestamp;
  }
  notices.unshift(...leading.map((notice) => ({ ...notice, turnIndex: 0, afterItems: 0 })));
  return { turns: builders.map((builder, index) => finishTurn(builder, index === builders.length - 1)), todo,
    ...(Object.keys(memoryWrites).length === 0 ? {} : { memoryWrites }),
    ...(notices.length === 0 ? {} : { notices }),
    tasks: [...taskOrder].flatMap((id) => {
      const receipt = tasks.get(id);
      const completion = completions.get(id);
      return completion === undefined ? receipt === undefined ? [] : [receipt] : [{ ...receipt, ...completion }];
    }) };
}

function historicalTask(value: unknown, receipt: boolean): HistoricalTask | null {
  if (!isRecord(value) || typeof value["task_id"] !== "string" || typeof value["status"] !== "string") return null;
  if (receipt && (typeof value["mode"] !== "string" || typeof value["execution_mode"] !== "string")) return null;
  const result: HistoricalTask = { task_id: value["task_id"], status: value["status"], source: "history" };
  const keys = ["mode", "task_summary", "name", "category", "agent_type", "execution_mode", "model", "final_response", "error_message"] as const;
  for (const key of keys) {
    if (value[key] !== undefined && typeof value[key] !== "string") return null;
    if (typeof value[key] === "string") result[key] = value[key];
  }
  if (value["subagent_type"] !== undefined) {
    if (typeof value["subagent_type"] !== "string") return null;
    result.agent_type = value["subagent_type"];
  }
  if (value["resolved_model"] !== undefined) {
    if (!isRecord(value["resolved_model"]) || typeof value["resolved_model"]["display"] !== "string") return null;
    result.model = value["resolved_model"]["display"];
  }
  for (const key of ["final_response_truncated", "error_message_truncated"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") return null;
    if (typeof value[key] === "boolean") result[key] = value[key];
  }
  return result;
}
