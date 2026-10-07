#!/usr/bin/env node
// Deterministic stand-in for the omo CLI: `--version` and `app-server --listen stdio://`.
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { runDagScenario } from "./dag-scenario.mjs";
import { runDagWavesScenario } from "./dag-waves-scenario.mjs";

const VERSION_LINE = "omo 5.1.4-fake (engine: fake)";
const USAGE = "usage: fake-omo --version | fake-omo app-server --listen stdio://\n";
const MAX_SLOW_TICKS = 300;

const NOT_FOUND = -32601;
const INVALID_REQUEST = -32600;
const INVALID_PARAMS = -32602;
const SERVER_ERROR = -32000;
// FAKE_OMO_DEMO names a JSON file with scripted presentation content for scripts/readme-media.mjs:
// { session?: { model, modelProvider }, models?: [...], scenes: [{ match, steps }], sideAnswers?: [{ match, reply, chunks?, chunkMs? }] }.
// A turn whose text contains a scene's `match` plays its steps (runDemoScene); tests never set the variable.
const DEMO = process.env.FAKE_OMO_DEMO === undefined ? null : JSON.parse(readFileSync(process.env.FAKE_OMO_DEMO, "utf8"));

const threads = new Map();
const pendingResponses = new Map();
const timers = new Set();
let home = "";
let sessionsDir = "";
let logPath;
let initialized = false;

class RpcFailure extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

class Interrupted extends Error {}

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const nowSec = () => Date.now() / 1000;
const sessionPath = (id) => join(sessionsDir, `${id}.jsonl`);

function write(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function notify(method, params) {
  write({ method, params, emittedAtMs: Date.now() });
}

function respond(id, result) {
  write({ id, result });
}

function fail(id, code, message) {
  write({ id, error: { code, message } });
}

function requireString(params, key) {
  const value = params[key];
  if (typeof value !== "string") throw new RpcFailure(INVALID_PARAMS, `Invalid params: ${key}`);
  return value;
}

function firstText(input) {
  for (const entry of input) {
    if (isRecord(entry) && entry.type === "text" && typeof entry.text === "string") return entry.text;
  }
  return "";
}

function splitInto(text, count) {
  const chunks = [];
  for (let i = 0; i < count; i += 1) {
    chunks.push(text.slice(Math.floor((i * text.length) / count), Math.floor(((i + 1) * text.length) / count)));
  }
  return chunks;
}

// ---- threads and session files ------------------------------------------------------------

function defaultThread(id) {
  const now = nowSec();
  return {
    id,
    sessionId: id,
    preview: "",
    ephemeral: false,
    modelProvider: "fake",
    createdAt: now,
    updatedAt: now,
    status: { type: "idle" },
    path: sessionPath(id),
    cwd: home,
    cliVersion: "5.1.4-fake",
    source: "appServer",
    name: null,
    turns: [],
  };
}

function addThread(thread, extra = {}) {
  const record = { thread, loaded: false, archived: false, lastEntryId: null, activeTurn: null, ...extra };
  threads.set(thread.id, record);
  return record;
}

function recordEntry(record, entry) {
  const file = record.thread.path ?? sessionPath(record.thread.id);
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    const header = {
      type: "session",
      version: 3,
      id: record.thread.id,
      timestamp: new Date(record.thread.createdAt * 1000).toISOString(),
      cwd: record.thread.cwd,
    };
    writeFileSync(file, `${JSON.stringify(header)}\n`);
  }
  const id = randomUUID().slice(0, 8);
  const line = { ...entry, id, parentId: record.lastEntryId, timestamp: new Date().toISOString() };
  appendFileSync(file, `${JSON.stringify(line)}\n`);
  record.lastEntryId = id;
}

const zeroUsage = () => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const userEntry = (text) => ({
  type: "message",
  message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
});

function expandSkills(text) {
  const blocks = new Map();
  let rest = text;
  while (rest.startsWith("/skill:")) {
    const token = /^\/skill:([\w-]+)(?:\s+|$)/.exec(rest);
    if (token === null || !DEFAULT_SKILLS.some((skill) => skill.name === token[1])) break;
    const name = token[1];
    if (!blocks.has(name)) {
      if (blocks.size === 5) break;
      const body = name === "ulw-loop" ? "Run the loop." : name === "mass-ulw" ? "Dispatch the workflow." : `Run ${name}.`;
      blocks.set(name, `<skill name="${name}" location="/fake/skills/${name}/SKILL.md">\nReferences are relative to /fake/skills/${name}.\n\n${body}\n</skill>`);
    }
    rest = rest.slice(token[0].length);
  }
  return blocks.size === 0 ? text : [...blocks.values(), ...(rest === "" ? [] : [rest])].join("\n\n");
}

const assistantEntry = (content, stopReason) => ({
  type: "message",
  message: {
    role: "assistant",
    content,
    api: "fake",
    provider: "fake",
    model: "alpha",
    usage: zeroUsage(),
    stopReason,
    timestamp: Date.now(),
  },
});

const toolResultEntry = (toolCallId, toolName, text, isError, details) => ({
  type: "message",
  message: {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    ...(details === undefined ? {} : { details }),
    isError,
    timestamp: Date.now(),
  },
});

function loadSessionFile(file) {
  const lines = [];
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    if (raw.length === 0) continue;
    try {
      lines.push(JSON.parse(raw));
    } catch (error) {
      process.stderr.write(`fake-omo: skipping unparseable session line in ${file}: ${error.message}\n`);
    }
  }
  const header = lines[0];
  if (!isRecord(header) || header.type !== "session" || typeof header.id !== "string") return;
  const thread = {
    ...defaultThread(header.id),
    path: file,
    cwd: typeof header.cwd === "string" ? header.cwd : home,
    createdAt: Date.parse(String(header.timestamp)) / 1000,
    updatedAt: statSync(file).mtimeMs / 1000,
  };
  let lastEntryId = null;
  let archived = false;
  for (const entry of lines.slice(1)) {
    if (!isRecord(entry)) continue;
    if (typeof entry.id === "string") lastEntryId = entry.id;
    if (entry.type === "session_info" && typeof entry.name === "string") thread.name = entry.name;
    if (entry.type === "custom" && entry.customType === "fake-omo.archived") archived = true;
    if (entry.type === "message" && isRecord(entry.message) && entry.message.role === "user" && thread.preview === "") {
      thread.preview = firstText(Array.isArray(entry.message.content) ? entry.message.content : []);
    }
  }
  addThread(thread, { archived, lastEntryId });
}

/**
 * FAKE_OMO_LONG_SESSION is JSON { id, cwd, turns, toolCalls }. Before the threads are listed the fake records that
 * session once: every turn holds a user message, `toolCalls` eval calls with their results and a markdown answer, so a
 * test can open a conversation with tens of thousands of DOM nodes.
 */
function writeLongSession() {
  const raw = process.env.FAKE_OMO_LONG_SESSION;
  if (raw === undefined) return;
  const spec = JSON.parse(raw);
  if (!isRecord(spec) || typeof spec.id !== "string" || typeof spec.cwd !== "string" || !Number.isInteger(spec.turns) || !Number.isInteger(spec.toolCalls)) {
    throw new Error("FAKE_OMO_LONG_SESSION must be JSON { id, cwd, turns, toolCalls }");
  }
  const path = join(sessionsDir, `${spec.id}.jsonl`);
  if (existsSync(path)) return;
  const record = { thread: { id: spec.id, path, cwd: spec.cwd, createdAt: nowSec() - 3600 }, lastEntryId: null };
  for (let turn = 1; turn <= spec.turns; turn += 1) {
    recordEntry(record, userEntry(`Step ${turn}: check how the cart totals are computed.`));
    for (let call = 1; call <= spec.toolCalls; call += 1) {
      const id = `long-${turn}-${call}`;
      recordEntry(record, assistantEntry([{ type: "toolCall", id, name: "eval", arguments: { language: "js", code: `print(await run("grep -n total${call} src/lib/cart.ts"))` } }], "toolUse"));
      recordEntry(record, toolResultEntry(id, "eval", `src/lib/cart.ts:${call}: export const total${call} = subtotal + tax;`, false));
    }
    recordEntry(record, assistantEntry([{ type: "text", text: FLOOD_TEXT }], "stop"));
  }
}

function loadPersistedThreads() {
  for (const name of readdirSync(sessionsDir)) {
    if (name.endsWith(".jsonl")) loadSessionFile(join(sessionsDir, name));
  }
  const seedFile = process.env.FAKE_OMO_SEED_THREADS;
  if (seedFile === undefined) return;
  const seeds = JSON.parse(readFileSync(seedFile, "utf8"));
  if (!Array.isArray(seeds)) throw new Error("FAKE_OMO_SEED_THREADS must hold a JSON array");
  for (const seed of seeds) {
    if (!isRecord(seed) || typeof seed.id !== "string") throw new Error("seed thread needs a string id");
    if (!threads.has(seed.id)) addThread({ ...defaultThread(seed.id), ...seed });
  }
}

// Like omo, a session file another process wrote into the sessions directory (a branch) can be resumed by its id.
function loadSessionById(threadId) {
  for (const name of readdirSync(sessionsDir)) {
    if (!name.endsWith(".jsonl")) continue;
    const file = join(sessionsDir, name);
    const header = readFileSync(file, "utf8").split("\n", 1)[0];
    if (header.includes(`"id":"${threadId}"`)) loadSessionFile(file);
  }
}

function getThread(threadId) {
  if (!threads.has(threadId)) loadSessionById(threadId);
  const record = threads.get(threadId);
  if (record === undefined) throw new RpcFailure(INVALID_REQUEST, `Thread not found: ${threadId}`);
  return record;
}

const threadView = (record, includeTurns) => ({ ...record.thread, turns: includeTurns ? record.thread.turns : [] });

const sessionResult = (record) => ({
  thread: threadView(record, true),
  model: DEMO?.session?.model ?? "alpha",
  modelProvider: DEMO?.session?.modelProvider ?? "fake",
  cwd: record.thread.cwd,
  reasoningEffort: "medium",
});

// ---- turns --------------------------------------------------------------------------------

function guard(turn, promise) {
  return Promise.race([
    promise,
    turn.interruptSignal.then(() => {
      throw new Interrupted();
    }),
  ]);
}

function sleep(turn, ms) {
  return guard(
    turn,
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        resolve();
      }, ms);
      timers.add(timer);
    }),
  );
}

async function askClient(turn, id, method, params) {
  const answer = new Promise((resolve) => pendingResponses.set(id, resolve));
  write({ id, method, params });
  try {
    return await guard(turn, answer);
  } finally {
    pendingResponses.delete(id);
    notify("serverRequest/resolved", { threadId: turn.threadId, requestId: id });
  }
}

const nextItemId = (turn) => `item-${++turn.itemSeq}`;

function startItem(turn, item) {
  turn.wire.items.push(item);
  notify("item/started", { threadId: turn.threadId, turnId: turn.wire.id, item, startedAtMs: Date.now() });
}

function finishItem(turn, item) {
  notify("item/completed", { threadId: turn.threadId, turnId: turn.wire.id, item, completedAtMs: Date.now() });
}

function openAgentMessage(turn) {
  const item = { type: "agentMessage", id: nextItemId(turn), text: "", phase: null };
  startItem(turn, item);
  return item;
}

function appendAgentDelta(turn, item, delta) {
  item.text += delta;
  notify("item/agentMessage/delta", { threadId: turn.threadId, turnId: turn.wire.id, itemId: item.id, delta });
}

function closeAgentMessage(record, turn, item, stopReason) {
  finishItem(turn, item);
  recordEntry(record, assistantEntry([{ type: "text", text: item.text }], stopReason));
}

async function runEcho(record, turn, text) {
  const reply = text.includes("pong") ? "pong" : `echo: ${text}`;
  const item = openAgentMessage(turn);
  const [head, tail] = splitInto(reply, 2);
  appendAgentDelta(turn, item, head);
  await sleep(turn, 50);
  appendAgentDelta(turn, item, tail);
  closeAgentMessage(record, turn, item, "stop");
}

async function runSlow(record, turn) {
  const item = openAgentMessage(turn);
  try {
    for (let tick = 1; tick <= MAX_SLOW_TICKS; tick += 1) {
      await sleep(turn, 200);
      appendAgentDelta(turn, item, `tick ${tick} `);
    }
  } catch (error) {
    if (!(error instanceof Interrupted)) throw error;
  }
  closeAgentMessage(record, turn, item, turn.interrupted ? "aborted" : "stop");
}

function firstAnswer(response) {
  const q1 = isRecord(response) && isRecord(response.answers) ? response.answers.q1 : undefined;
  const answers = isRecord(q1) && Array.isArray(q1.answers) ? q1.answers : [];
  return answers.find((answer) => typeof answer === "string") ?? "(none)";
}

async function runFull(record, turn) {
  const reasoning = { type: "reasoning", id: nextItemId(turn), summary: [], content: [] };
  startItem(turn, reasoning);
  for (const delta of ["Planning the ", "demo ", "answer."]) {
    notify("item/reasoning/textDelta", {
      threadId: turn.threadId,
      turnId: turn.wire.id,
      itemId: reasoning.id,
      delta,
      contentIndex: 0,
    });
  }
  reasoning.content = ["Planning the demo answer."];
  finishItem(turn, reasoning);

  const tool = {
    type: "dynamicToolCall",
    id: nextItemId(turn),
    namespace: null,
    tool: "eval",
    arguments: { language: "js", code: "1+1", summary: "Add numbers" },
    status: "inProgress",
    contentItems: null,
    success: null,
    durationMs: null,
  };
  const toolStartedAtMs = Date.now();
  startItem(turn, tool);
  recordEntry(
    record,
    assistantEntry(
      [
        { type: "thinking", thinking: reasoning.content.join("\n") },
        { type: "toolCall", id: tool.id, name: tool.tool, arguments: tool.arguments },
      ],
      "toolUse",
    ),
  );

  const approval = await askClient(turn, "approval-1", "item/commandExecution/requestApproval", {
    threadId: turn.threadId,
    turnId: turn.wire.id,
    itemId: tool.id,
    startedAtMs: toolStartedAtMs,
    reason: "Permission required: bash",
    command: "rm -rf /tmp/fake-demo",
    cwd: record.thread.cwd,
    availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
  });
  const decision = isRecord(approval) ? approval.decision : undefined;
  const accepted = decision === "accept" || decision === "acceptForSession";
  const resultText = accepted ? '{"text":"2"}' : "declined by user";
  tool.status = accepted ? "completed" : "failed";
  tool.success = accepted;
  tool.contentItems = [{ type: "inputText", text: resultText }];
  tool.durationMs = Date.now() - toolStartedAtMs;
  finishItem(turn, tool);
  recordEntry(record, toolResultEntry(tool.id, tool.tool, resultText, !accepted));

  const response = await askClient(turn, "user-input-1", "item/tool/requestUserInput", {
    threadId: turn.threadId,
    turnId: turn.wire.id,
    itemId: "question-1",
    questions: [
      {
        id: "q1",
        header: "Pick",
        question: "Which option?",
        isOther: true,
        isSecret: false,
        options: [
          { label: "A", description: "first" },
          { label: "B", description: "second" },
        ],
        multiSelect: false,
      },
    ],
    waitForAnswer: true,
    timeoutMs: 600000,
    autoResolutionMs: null,
  });

  const reply = `# Demo\n\n- one\n- two\n\n\`\`\`ts\nconst answer: number = 42;\n\`\`\`\n\nYou picked **${firstAnswer(response)}**.`;
  const item = openAgentMessage(turn);
  for (const chunk of splitInto(reply, 6)) appendAgentDelta(turn, item, chunk);
  closeAgentMessage(record, turn, item, "stop");
}

/** Asks one multi-select question and confirms the first chosen option. */
async function runMultiQuestion(record, turn) {
  const response = await askClient(turn, `user-input-${turn.itemSeq}`, "item/tool/requestUserInput", {
    threadId: turn.threadId,
    turnId: turn.wire.id,
    itemId: `question-${turn.itemSeq}`,
    questions: [
      {
        id: "q1",
        header: "Checks",
        question: "Which checks should run?",
        isOther: false,
        isSecret: false,
        options: [
          { label: "Unit", description: "vitest" },
          { label: "E2E", description: "Playwright" },
        ],
        multiSelect: true,
      },
    ],
    waitForAnswer: true,
    timeoutMs: 600000,
    autoResolutionMs: null,
  });
  const item = openAgentMessage(turn);
  appendAgentDelta(turn, item, `Running **${firstAnswer(response)}**.`);
  closeAgentMessage(record, turn, item, "stop");
}

const FLOOD_TEXT = [
  "## Checking the cart totals\n\n",
  "Totals come from `cartTotals` in `src/lib/cart.ts`: each line adds `price * quantity` in integer cents, ",
  "and tax is rounded once on the subtotal, so three items at 1006 cents give 241 cents of tax.\n\n",
  "| Case | Subtotal | Tax | Total |\n|---|---|---|---|\n| one item | 5000 | 400 | 5400 |\n| three items | 3018 | 241 | 3259 |\n\n",
  "```ts\nexport function cartTotals(items: CartItem[]): Totals {\n  const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);\n",
  "  const tax = Math.round(subtotal * 0.08);\n  return { subtotal, tax, total: subtotal + tax };\n}\n```\n\n",
].join("");
const FLOOD_CHUNKS = FLOOD_TEXT.match(/[\s\S]{1,12}/g);

/**
 * Streams a long markdown answer as many small deltas, the way a busy turn does:
 * SCENARIO:flood[:<chunks>[:<intervalMs>]], 1500 chunks every 10 ms by default. Every 25th chunk ends with a
 * ⟦<index>@<send time in ms>⟧ marker, so a test can tell how far the rendered text lags behind the stream.
 */
async function runFlood(record, turn, text) {
  const [, chunks = "1500", intervalMs = "10"] = /SCENARIO:flood(?::(\d+))?(?::(\d+))?/.exec(text) ?? [];
  const item = openAgentMessage(turn);
  try {
    for (let index = 0; index < Number(chunks); index += 1) {
      await sleep(turn, Number(intervalMs));
      const chunk = FLOOD_CHUNKS[index % FLOOD_CHUNKS.length];
      appendAgentDelta(turn, item, index % 25 === 24 ? `${chunk}⟦${index}@${Date.now()}⟧` : chunk);
    }
  } catch (error) {
    if (!(error instanceof Interrupted)) throw error;
  }
  closeAgentMessage(record, turn, item, turn.interrupted ? "aborted" : "stop");
}

const SIDE_MARKER = "[OmO UI side chat background]";

/** Answers an OmO UI side chat's first message, naming its question and how much main context it carried. */
async function runSide(record, turn, text) {
  const question = (/\nSide question: ([\s\S]*)$/.exec(text)?.[1] ?? "").trim();
  const users = [...text.matchAll(/<user>\n([\s\S]*?)\n<\/user>/g)].map((match) => match[1]);
  const assistants = [...text.matchAll(/<assistant>\n/g)].length;
  const demo = DEMO?.sideAnswers?.find((entry) => question.includes(entry.match));
  const reply = demo !== undefined
    ? demo.reply
    : users.length === 0
      ? `Side answer to "${question}" without main context.`
      : `Side answer to "${question}" from ${users.length + assistants} main messages; the first main request was "${users[0]}".`;
  const item = openAgentMessage(turn);
  for (const chunk of splitInto(reply, demo?.chunks ?? 3)) {
    appendAgentDelta(turn, item, chunk);
    await sleep(turn, demo?.chunkMs ?? 40);
  }
  closeAgentMessage(record, turn, item, "stop");
}

/** A DAG run in the omo.dag.updated fields; counts, edges and waves are derived from the scripted nodes. */
function demoRun(dag, at) {
  const counts = { total: dag.nodes.length, pending: 0, blocked: 0, scheduled: 0, running: 0, completed: 0, failed: 0, cancelled: 0, skipped: 0 };
  for (const node of dag.nodes) counts[node.state] += 1;
  const byId = new Map(dag.nodes.map((node) => [node.id, node]));
  const depth = (node) => Math.max(-1, ...(node.depends_on ?? []).map((id) => depth(byId.get(id)))) + 1;
  const waves = [];
  for (const node of dag.nodes) (waves[depth(node)] ??= []).push(node.id);
  const started = (state) => state === "running" || state === "completed" || state === "failed";
  return {
    run_id: dag.run_id ?? "demo-run", run_key: dag.run_key ?? "demo", name: dag.name, status: dag.status ?? "running",
    created_at: at, updated_at: at, counts,
    nodes: dag.nodes.map((node) => ({
      depends_on: [], attempt: 1, created_at: at,
      ...(started(node.state) ? { started_at: at } : {}),
      ...(node.state === "completed" || node.state === "failed" ? { completed_at: at } : {}),
      ...node,
    })),
    edges: dag.nodes.flatMap((node) => (node.depends_on ?? []).map((from) => ({ from, to: node.id }))),
    waves: waves.map((nodeIds, index) => ({ index, node_ids: nodeIds })),
  };
}

/** A child task in the omo.task.updated fields; `live_progress.elapsedMs` backdates its start. */
function demoTask(task, at) {
  const { live_progress: progress, ...rest } = task;
  return {
    execution_mode: "in-process", depth: 1, created_at: at, updated_at: at,
    residency_state: task.status === "running" ? "resident" : "disposed",
    ...rest,
    ...(progress === undefined ? {} : { live_progress: { ...progress, started_at: Date.now() - (progress.elapsedMs ?? 0) } }),
  };
}

/**
 * Plays one FAKE_OMO_DEMO scene. Steps: { wait }, { reasoning }, { item, done?, ms? } (any wire item, completed
 * with `done`), { command: { command, output, exitCode, ms?, approval?, cwd? } }, { question }, { todo: phases, durationMs? },
 * { goal }, { dag }, { dagActivity }, { tasks }, { say, chunks?, chunkMs? } ("{{answer}}" becomes the last
 * question's answer) and { hold } (waits for fake.advance or an interrupt).
 */
async function runDemoScene(record, turn, scene) {
  const threadId = record.thread.id;
  const extension = (name, data) => notify("extension_event", { type: "extension_event", threadId, name, data });
  let answer = "";
  for (const step of scene.steps) {
    const at = new Date().toISOString();
    if ("wait" in step) await sleep(turn, step.wait);
    else if ("reasoning" in step) {
      const item = { type: "reasoning", id: nextItemId(turn), summary: [], content: [] };
      startItem(turn, item);
      for (const delta of splitInto(step.reasoning, 4)) {
        notify("item/reasoning/textDelta", { threadId, turnId: turn.wire.id, itemId: item.id, delta, contentIndex: 0 });
        await sleep(turn, 60);
      }
      item.content = [step.reasoning];
      finishItem(turn, item);
    } else if ("item" in step) {
      const item = { id: nextItemId(turn), ...step.item };
      startItem(turn, item);
      await sleep(turn, step.ms ?? 0);
      Object.assign(item, step.done ?? {});
      finishItem(turn, item);
    } else if ("command" in step) {
      const { command, output, exitCode, ms, approval, cwd = record.thread.cwd } = step.command;
      const item = { type: "commandExecution", id: nextItemId(turn), command, cwd, status: "inProgress", aggregatedOutput: null, exitCode: null, durationMs: null };
      startItem(turn, item);
      const startedAtMs = Date.now();
      let accepted = true;
      if (approval !== undefined) {
        const response = await askClient(turn, `approval-${item.id}`, "item/commandExecution/requestApproval", {
          threadId, turnId: turn.wire.id, itemId: item.id, startedAtMs, command, cwd,
          availableDecisions: ["accept", "acceptForSession", "decline", "cancel"], ...approval,
        });
        accepted = isRecord(response) && (response.decision === "accept" || response.decision === "acceptForSession");
      }
      await sleep(turn, accepted ? ms ?? 0 : 0);
      Object.assign(item, accepted
        ? { status: "completed", aggregatedOutput: output, exitCode, durationMs: Date.now() - startedAtMs }
        : { status: "declined", durationMs: Date.now() - startedAtMs });
      finishItem(turn, item);
    } else if ("question" in step) {
      const response = await askClient(turn, `user-input-${turn.itemSeq}`, "item/tool/requestUserInput", {
        threadId, turnId: turn.wire.id, itemId: `question-${turn.itemSeq}`,
        questions: [{ id: "q1", isOther: true, isSecret: false, multiSelect: false, ...step.question }],
        waitForAnswer: true, timeoutMs: 600000, autoResolutionMs: null,
      });
      answer = firstAnswer(response);
    } else if ("todo" in step) {
      const tool = { type: "dynamicToolCall", id: nextItemId(turn), namespace: null, tool: "todo", arguments: { op: "init" }, status: "inProgress", contentItems: null, success: null, durationMs: null };
      startItem(turn, tool);
      recordEntry(record, assistantEntry([{ type: "toolCall", id: tool.id, name: "todo", arguments: tool.arguments }], "toolUse"));
      recordEntry(record, { type: "custom", customType: "senpi.todo-state", data: { schema: "v2", phases: step.todo } });
      recordEntry(record, toolResultEntry(tool.id, "todo", "Todo saved", false));
      Object.assign(tool, { status: "completed", success: true, contentItems: [{ type: "inputText", text: "Todo saved" }], durationMs: step.durationMs ?? 0 });
      finishItem(turn, tool);
    } else if ("goal" in step) {
      record.goal = { threadId, tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: nowSec(), updatedAt: nowSec(), ...step.goal };
      notify("thread/goal/updated", { threadId, turnId: null, goal: record.goal });
    } else if ("dag" in step) extension("omo.dag.updated", { parent_session_id: threadId, runs: [demoRun(step.dag, at)] });
    else if ("dagActivity" in step) extension("omo.dag.activity", { schemaVersion: 1, at, ...step.dagActivity });
    else if ("tasks" in step) extension("omo.task.updated", { parent_session_id: threadId, tasks: step.tasks.map((task) => demoTask(task, at)) });
    else if ("say" in step) {
      const item = openAgentMessage(turn);
      for (const chunk of splitInto(step.say.replaceAll("{{answer}}", answer), step.chunks ?? 8)) {
        appendAgentDelta(turn, item, chunk);
        await sleep(turn, step.chunkMs ?? 60);
      }
      closeAgentMessage(record, turn, item, "stop");
    } else if ("hold" in step) {
      await guard(turn, new Promise((resolve) => {
        record.advanceLive = () => {
          record.advanceLive = null;
          resolve();
        };
      }));
    } else throw new Error(`unknown demo step ${JSON.stringify(step)}`);
  }
}

function runScenario(record, turn, text) {
  if (text.startsWith(SIDE_MARKER)) return runSide(record, turn, text);
  const scene = DEMO?.scenes?.find((candidate) => text.includes(candidate.match));
  if (scene !== undefined) return runDemoScene(record, turn, scene);
  if (text.includes("SCENARIO:omo-live")) return runLive(record, turn);
  if (text.includes("SCENARIO:dag-waves")) return runDagWavesScenario(record, turn, { notify, guard, sleep: (ms) => sleep(turn, ms) });
  if (text.includes("SCENARIO:dag")) return runDagScenario(record, turn, { home, notify, guard });
  if (text === "SCENARIO:skills-history") {
    const item = openAgentMessage(turn);
    appendAgentDelta(turn, item, "Built the thing.");
    closeAgentMessage(record, turn, item, "stop");
    recordEntry(record, {
      type: "custom_message",
      customType: "omo-mass-ulw:skill-pointer",
      content: "<omo-mass-ulw-pointer>Hidden skill pointer.</omo-mass-ulw-pointer>",
      display: false,
    });
    return;
  }
  if (text.includes("SCENARIO:silent-error")) {
    const entry = assistantEntry([{ type: "text", text: "" }], "error");
    entry.message.errorMessage = "402: Insufficient Balance";
    entry.message.model = "fake-model";
    recordEntry(record, entry);
    return;
  }
  if (text.includes("SCENARIO:full")) return runFull(record, turn);
  // SCENARIO:quiet[:ms] streams nothing for ms (default 3000) before echoing, like a long model call with hidden thinking.
  if (text.includes("SCENARIO:quiet")) {
    return sleep(turn, Number(/SCENARIO:quiet:(\d+)/.exec(text)?.[1] ?? 3000)).then(() => runEcho(record, turn, text));
  }
  if (text.includes("SCENARIO:slow")) return runSlow(record, turn);
  if (text.includes("SCENARIO:multi-question")) return runMultiQuestion(record, turn);
  if (text.includes("SCENARIO:flood")) return runFlood(record, turn, text);
  return runEcho(record, turn, text);
}

/** Records a background task spawn the way omo does: a task tool call whose result details carry the spawn receipt. */
function recordTaskSpawn(record, turn, id) {
  const receipt = {
    task_id: `task-${id}`, run_epoch: 0, status: "running", mode: "spawn", task_summary: `Execute ${id}`, name: `Lane ${id}`,
    category: "quick", execution_mode: "in-process", run_in_background: true,
    resolved_model: { source: "category", provider: "fake", model_id: "alpha", display: "fake/alpha" },
  };
  const text = `Started task Lane ${id} (task-${id}, running).`;
  const tool = { type: "dynamicToolCall", id: nextItemId(turn), namespace: null, tool: "task", arguments: { category: "quick", prompt: `Execute ${id}`, run_in_background: true }, status: "inProgress", contentItems: null, success: null, durationMs: null };
  startItem(turn, tool);
  recordEntry(record, assistantEntry([{ type: "toolCall", id: tool.id, name: "task", arguments: tool.arguments }], "toolUse"));
  recordEntry(record, toolResultEntry(tool.id, "task", text, false, receipt));
  Object.assign(tool, { status: "completed", success: true, contentItems: [{ type: "inputText", text }], durationMs: 0 });
  finishItem(turn, tool);
}

/** Records the wake message omo appends when a background task settles; its details carry the completion record. */
function recordTaskCompletion(record, completion) {
  recordEntry(record, {
    type: "custom_message", customType: "omo-senpi:wake", content: `Task ${completion.task_id} ${completion.status}`, display: false,
    details: [{ customType: "senpi-task.completion", details: [completion] }],
  });
}

function emitLiveStage(record, turn, stage) {
  const threadId = record.thread.id;
  const at = new Date().toISOString();
  const states = stage === 1 ? ["running", "blocked", "blocked"] : stage === 2 ? ["completed", "running", "scheduled"] : ["completed", "failed", "skipped"];
  const nodes = ["A", "B", "C"].map((id, index) => ({
    id, label: `Lane ${id}`, prompt: `Execute ${id}`, depends_on: id === "A" ? [] : ["A"],
    state: states[index], attempt: 1, created_at: at,
    ...(states[index] === "running" || states[index] === "completed" || states[index] === "failed" ? { task_id: `task-${id}`, started_at: at } : {}),
    ...(states[index] === "completed" || states[index] === "failed" ? { completed_at: at } : {}),
    ...(states[index] === "failed" ? { last_error: { code: "provider_error", message: "402: Insufficient Balance" } } : {}),
  }));
  const counts = { total: 3, pending: 0, blocked: 0, scheduled: 0, running: 0, completed: 0, failed: 0, cancelled: 0, skipped: 0 };
  for (const state of states) counts[state] += 1;
  const extension = (name, data) => notify("extension_event", { type: "extension_event", threadId, name, data });
  extension("omo.dag.updated", { parent_session_id: threadId, runs: [{
    run_id: "mass-ulw-display", run_key: "display", name: "mass-ulw display", status: stage === 3 ? "failed" : "running",
    created_at: at, updated_at: at, ...(stage === 3 ? { completed_at: at } : {}), counts, nodes,
    edges: [{ from: "A", to: "B" }, { from: "A", to: "C" }], waves: [{ index: 0, node_ids: ["A"] }, { index: 1, node_ids: ["B", "C"] }],
  }] });
  const task = (id, status) => ({
    task_id: `task-${id}`, name: `Lane ${id}`, task_summary: `Execute ${id}`, status,
    execution_mode: "in-process", model: "fake/alpha", residency_state: status === "running" ? "resident" : "disposed",
    depth: 1, created_at: at, updated_at: at,
    ...(status === "running" ? { live_progress: { activity: "working", started_at: Date.now(), current_tool: "read", turns: 1, tool_calls: 1 } } : {}),
    ...(status === "completed" ? { final_response: "A completed", run_stats: { runtime_ms: 10, turns: 1, tool_calls: 1 } } : {}),
    ...(status === "error" ? { error_message: "402: Insufficient Balance", failure_kind: "provider_error" } : {}),
  });
  extension("omo.task.updated", { parent_session_id: threadId, tasks: stage === 1 ? [task("A", "running")] : [task("A", "completed"), task("B", stage === 2 ? "running" : "error")] });
  if (stage === 1) {
    record.goal = { threadId, objective: "Ship the OmO UI app", status: "active", tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: nowSec(), updatedAt: nowSec() };
    notify("thread/goal/updated", { threadId, turnId: null, goal: record.goal });
    recordTaskSpawn(record, turn, "A");
  }
  if (stage === 2) {
    extension("omo.dag.activity", { schemaVersion: 1, runId: "mass-ulw-display", nodeId: "B", taskId: "task-B", at, activity: "implementing", currentTool: "edit", turns: 2, toolCalls: 3 });
    recordTaskCompletion(record, { task_id: "task-A", status: "completed", name: "Lane A", model: "fake/alpha", final_response: "A completed" });
    recordTaskSpawn(record, turn, "B");
    const tool = { type: "dynamicToolCall", id: nextItemId(turn), namespace: null, tool: "todo", arguments: { op: "init" }, status: "inProgress", contentItems: null, success: null, durationMs: null };
    startItem(turn, tool);
    recordEntry(record, assistantEntry([{ type: "toolCall", id: tool.id, name: "todo", arguments: tool.arguments }], "toolUse"));
    recordEntry(record, { type: "custom", customType: "senpi.todo-state", data: { schema: "v2", phases: [
      { name: "Implementation", tasks: [{ content: "Implement A", status: "completed" }] },
      { name: "Verification", tasks: [{ content: "Verify B", status: "abandoned" }, { content: "Report results", status: "pending" }] },
    ] } });
    recordEntry(record, toolResultEntry(tool.id, "todo", "Todo saved", false));
    tool.status = "completed";
    tool.success = true;
    tool.contentItems = [{ type: "inputText", text: "Todo saved" }];
    tool.durationMs = 0;
    finishItem(turn, tool);
  }
  if (stage === 3) {
    recordTaskCompletion(record, { task_id: "task-B", status: "error", name: "Lane B", model: "fake/alpha", error_message: "402: Insufficient Balance" });
    record.goal = null;
    notify("thread/goal/cleared", { threadId });
  }
}

function runLive(record, turn) {
  let stage = 1;
  emitLiveStage(record, turn, stage);
  return guard(turn, new Promise((resolve) => {
    record.advanceLive = () => {
      if (stage >= 3) return;
      stage += 1;
      emitLiveStage(record, turn, stage);
      if (stage === 3) {
        record.advanceLive = null;
        resolve();
      }
    };
  }));
}

function createTurn(threadId) {
  let interrupt = () => {};
  const interruptSignal = new Promise((resolve) => {
    interrupt = resolve;
  });
  return {
    threadId,
    itemSeq: 0,
    interrupted: false,
    interruptSignal,
    interrupt() {
      this.interrupted = true;
      interrupt();
    },
    startMs: Date.now(),
    wire: {
      id: randomUUID(),
      items: [],
      itemsView: "full",
      status: "inProgress",
      error: null,
      startedAt: Math.floor(nowSec()),
      completedAt: null,
      durationMs: null,
    },
  };
}

async function runTurn(record, turn, input, clientId) {
  const threadId = record.thread.id;
  record.activeTurn = turn;
  record.thread.turns.push(turn.wire);
  record.thread.status = { type: "active", activeFlags: [] };
  notify("thread/status/changed", { threadId, status: record.thread.status });
  notify("turn/started", { threadId, turn: { ...turn.wire, items: [] } });

  const text = firstText(input);
  startItem(turn, { type: "userMessage", id: nextItemId(turn), clientId: clientId ?? null, content: input });
  finishItem(turn, turn.wire.items[0]);
  if (record.thread.preview === "") record.thread.preview = text;
  const storedText = text === "SCENARIO:skills-history"
    ? 'The user explicitly invoked the "ulw-loop" and "mass-ulw" skills. Follow the instructions in <skill-instruction> as binding for this request, while respecting higher-priority instructions.\n\n'
      + '<skill-instruction name="ulw-loop" location="/fake/skills/ulw-loop/SKILL.md">Run the loop. Literal <skill-instruction example> stays text.</skill-instruction>\n\n'
      + '<skill-instruction name="mass-ulw" location="/fake/skills/mass-ulw/SKILL.md">Dispatch the workflow.</skill-instruction>\n\n'
      + '<user-request>build the thing</user-request>\n'
      + '<omo-ulw-loop-pointer>Follow the synthetic loop. Literal <omo-example stays text.</omo-ulw-loop-pointer>\n'
      + '<system-reminder>Keep the synthetic context.</system-reminder>'
    : expandSkills(text);
  recordEntry(record, userEntry(storedText));

  try {
    await runScenario(record, turn, text);
    turn.wire.status = turn.interrupted ? "interrupted" : "completed";
  } catch (error) {
    if (error instanceof Interrupted) {
      turn.wire.status = "interrupted";
    } else {
      turn.wire.status = "failed";
      turn.wire.error = { message: error instanceof Error ? error.message : String(error) };
    }
  }

  turn.wire.completedAt = Math.floor(nowSec());
  turn.wire.durationMs = Date.now() - turn.startMs;
  record.thread.updatedAt = nowSec();
  record.thread.status = { type: "idle" };
  record.activeTurn = null;
  // SCENARIO:lost-completion ends the turn like omo does when its turn/completed never reaches this client: only the
  // broadcast thread/status/changed to idle arrives. SCENARIO:silent-end sends neither, so the client still believes
  // the turn runs and its next steer is rejected.
  const silent = text.includes("SCENARIO:silent-end");
  if (!silent && !text.includes("SCENARIO:lost-completion")) notify("turn/completed", { threadId, turn: turn.wire });
  if (!silent) notify("thread/status/changed", { threadId, status: { type: "idle" } });
}

// ---- request handlers ---------------------------------------------------------------------

const MODELS = (DEMO?.models ?? [
  { id: "fake/alpha", model: "alpha", displayName: "Fake Alpha", isDefault: true },
  { id: "fake/beta", model: "beta", displayName: "Fake Beta", isDefault: false },
  ...[ ["claude-opus-5-5", "Claude Opus 5.5"], ["claude-fable-5-1", "Claude Fable 5.1"], ["gpt-6-astra", "GPT-6 Astra"], ["gpt-6-sol-fast", "GPT-6 Sol Fast"] ].map(([id, displayName]) => ({ id, model: id, displayName, isDefault: false })) ,
]).map((model) => ({
  ...model,
  description: "",
  hidden: false,
  defaultReasoningEffort: "medium",
  supportedReasoningEfforts: ["low", "medium", "high", "xhigh"].map((reasoningEffort) => ({ reasoningEffort, description: "" })),
}));

// Secret-free descriptors like omo's account/providerAccounts/read; pin and remove change them in memory.
const providerAccounts = {
  "anthropic-subscription": [
    { name: "work", source: "login", blocked: false, pinned: false },
    { name: "old", source: "login", blocked: true, pinned: false },
  ],
};

const DEFAULT_SKILLS = [
  { name: "ulw-loop", description: "Run a goal-driven loop.", scope: "system", enabled: true },
  { name: "mass-ulw", description: "Run dependency-ordered workflows.", scope: "system", enabled: true },
  { name: "plan", description: "Plan the requested work.", scope: "user", enabled: true },
  { name: "user-only-skill", description: "Invoke explicitly as a user.", scope: "user", enabled: false },
  { name: "long-description-skill", description: "L".repeat(400), scope: "user", enabled: true },
].map((skill) => ({ ...skill, path: `/fake/skills/${skill.name}/SKILL.md` }));

// FAKE_OMO_SKILLS uses the wire response fields: { data: [{ cwd, skills, errors }] }.
function listSkills(params) {
  if (
    (params.cwds !== undefined && (!Array.isArray(params.cwds) || params.cwds.some((cwd) => typeof cwd !== "string"))) ||
    (params.forceReload !== undefined && typeof params.forceReload !== "boolean")
  ) throw new RpcFailure(INVALID_PARAMS, "Invalid params: skills/list");
  const cwds = params.cwds?.length > 0 ? params.cwds : [process.cwd()];
  const configured = process.env.FAKE_OMO_SKILLS === undefined ? null : JSON.parse(process.env.FAKE_OMO_SKILLS);
  return {
    data: cwds.map((cwd) => {
      const loaded = [...threads.values()].some((record) => record.loaded && record.thread.cwd === cwd);
      if (!loaded) {
        return { cwd, skills: DEFAULT_SKILLS.filter((skill) => skill.name === "plan" || skill.name === "long-description-skill"), errors: [] };
      }
      return configured?.data.find((entry) => entry.cwd === cwd) ?? { cwd, skills: DEFAULT_SKILLS, errors: [] };
    }),
  };
}

function listThreads(params) {
  const cwdFilter = typeof params.cwd === "string" ? [params.cwd] : Array.isArray(params.cwd) ? params.cwd : null;
  const term = typeof params.searchTerm === "string" ? params.searchTerm.toLowerCase() : "";
  const wantArchived = params.archived === true;
  let data = [...threads.values()]
    .filter((record) => record.archived === wantArchived)
    .filter((record) => cwdFilter === null || cwdFilter.includes(record.thread.cwd))
    .filter((record) => `${record.thread.name ?? ""} ${record.thread.preview}`.toLowerCase().includes(term))
    .map((record) => threadView(record, false))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  if (typeof params.limit === "number") data = data.slice(0, params.limit);
  return { data, nextCursor: null };
}

function startTurn(id, params) {
  const record = getThread(requireString(params, "threadId"));
  if (record.activeTurn !== null) {
    throw new RpcFailure(INVALID_REQUEST, `Thread already has an active turn: ${record.thread.id}`);
  }
  const input = Array.isArray(params.input) ? params.input : [];
  // omo 5.1.4's app-server rejects these input item types; attachments must travel as paths in the text.
  const unsupported = input.find((item) => isRecord(item) && ["skill", "image", "localImage", "mention"].includes(String(item.type)));
  if (unsupported !== undefined) {
    throw new RpcFailure(INVALID_PARAMS, `Invalid params: unsupported input item type ${unsupported.type}`);
  }
  const clientId = typeof params.clientUserMessageId === "string" ? params.clientUserMessageId : null;
  const turn = createTurn(record.thread.id);
  respond(id, { turn: { ...turn.wire, items: [] } });
  runTurn(record, turn, input, clientId).catch((error) => {
    process.stderr.write(`fake-omo: turn crashed: ${error instanceof Error ? error.stack : String(error)}\n`);
  });
}

function steerTurn(id, params) {
  const threadId = requireString(params, "threadId");
  const turn = threads.get(threadId)?.activeTurn ?? null;
  if (turn === null || turn.wire.id !== params.expectedTurnId) {
    throw new RpcFailure(INVALID_REQUEST, `No active turn for thread ${threadId}`);
  }
  const input = Array.isArray(params.input) ? params.input : [];
  const unsupported = input.find((item) => isRecord(item) && ["skill", "image", "localImage", "mention"].includes(String(item.type)));
  if (unsupported !== undefined) {
    throw new RpcFailure(INVALID_PARAMS, `Invalid params: unsupported input item type ${unsupported.type}`);
  }
  respond(id, { turnId: turn.wire.id });
  const item = { type: "userMessage", id: nextItemId(turn), clientId: null, content: input };
  startItem(turn, item);
  finishItem(turn, item);
  recordEntry(threads.get(threadId), userEntry(firstText(input)));
}

function waitForFile(file, done) {
  if (existsSync(file)) {
    done();
    return;
  }
  const timer = setTimeout(() => {
    timers.delete(timer);
    waitForFile(file, done);
  }, 50);
  timers.add(timer);
}

let mcpVersion = "1.0.0";

function handleRequest(id, method, params) {
  if (method === "initialize") {
    if (initialized) throw new RpcFailure(SERVER_ERROR, "Already initialized");
    initialized = true;
    const result = { userAgent: "fake-omo/5.1.4", codexHome: home, platformFamily: "unix", platformOs: "macos" };
    const gate = process.env.FAKE_OMO_INIT_GATE;
    if (gate) waitForFile(gate, () => respond(id, result));
    else respond(id, result);
    return;
  }
  if (!initialized) throw new RpcFailure(SERVER_ERROR, "Not initialized");

  switch (method) {
    case "thread/goal/get":
      respond(id, { goal: getThread(requireString(params, "threadId")).goal ?? null });
      return;
    case "extension_request": {
      const record = getThread(requireString(params, "threadId"));
      if (params.name !== "fake.advance") throw new RpcFailure(NOT_FOUND, "Extension not found");
      record.advanceLive?.();
      respond(id, {});
      return;
    }
    case "account/providerAccounts/read": {
      const provider = requireString(params, "provider");
      respond(id, { provider, accounts: providerAccounts[provider] ?? [] });
      return;
    }
    case "account/providerAccounts/pin": {
      const accounts = providerAccounts[requireString(params, "provider")] ?? [];
      for (const account of accounts) account.pinned = account.name === params.name;
      respond(id, {});
      return;
    }
    case "account/providerAccounts/remove": {
      const provider = requireString(params, "provider");
      providerAccounts[provider] = (providerAccounts[provider] ?? []).filter((account) => account.name !== params.name);
      // Like omo, removal also drops the stored credential from auth.json.
      const authFile = join(home, "auth.json");
      if (existsSync(authFile)) {
        const auth = JSON.parse(readFileSync(authFile, "utf8"));
        const pool = auth[provider]?.accounts;
        if (Array.isArray(pool)) auth[provider].accounts = pool.filter((account) => account?.name !== params.name);
        writeFileSync(authFile, JSON.stringify(auth));
      }
      respond(id, {});
      return;
    }
    case "mcpServerStatus/list":
      respond(id, { data: process.env.FAKE_OMO_MCP_EMPTY === "1" ? [] : [
        { name: "demo-tools", serverInfo: { name: "demo-tools", version: mcpVersion },
          tools: {
            search: { name: "search", description: "Search the demo knowledge base." },
            read_document: { name: "read_document", description: "Read a demo document by ID." },
            list_projects: { name: "list_projects", description: "List available demo projects." },
          }, resources: [], resourceTemplates: [], authStatus: "unsupported" },
        { name: "pganalyze", serverInfo: null, tools: {}, resources: [], resourceTemplates: [], authStatus: "notLoggedIn" },
      ], nextCursor: null });
      return;
    case "model/list":
      respond(id, { data: MODELS, nextCursor: null });
      return;
    case "skills/list":
      respond(id, listSkills(params));
      return;
    case "thread/list":
      respond(id, listThreads(params));
      return;
    case "thread/start": {
      const thread = { ...defaultThread(randomUUID()), cwd: requireString(params, "cwd") };
      const record = addThread(thread, { loaded: true });
      recordEntry(record, { type: "model_change", provider: "fake", modelId: "alpha" });
      notify("thread/started", { thread: threadView(record, false) });
      respond(id, sessionResult(record));
      mcpVersion = "1.1.0";
      notify("mcpServer/startupStatus/updated", { threadId: thread.id, name: "demo-tools", status: "connected" });
      return;
    }
    case "thread/resume": {
      const record = getThread(requireString(params, "threadId"));
      record.loaded = true;
      respond(id, sessionResult(record));
      return;
    }
    case "thread/read":
      respond(id, { thread: threadView(getThread(requireString(params, "threadId")), params.includeTurns === true) });
      return;
    case "thread/name/set": {
      const record = getThread(requireString(params, "threadId"));
      const name = requireString(params, "name");
      record.thread.name = name;
      recordEntry(record, { type: "session_info", name });
      notify("thread/name/updated", { threadId: record.thread.id, threadName: name });
      respond(id, {});
      return;
    }
    case "thread/archive": {
      const record = getThread(requireString(params, "threadId"));
      record.archived = true;
      recordEntry(record, { type: "custom", customType: "fake-omo.archived", data: {} });
      notify("thread/archived", { threadId: record.thread.id });
      respond(id, {});
      return;
    }
    case "thread/delete": {
      const record = getThread(requireString(params, "threadId"));
      threads.delete(record.thread.id);
      rmSync(record.thread.path ?? sessionPath(record.thread.id), { force: true });
      notify("thread/deleted", { threadId: record.thread.id });
      respond(id, {});
      return;
    }
    case "turn/start":
      if (firstText(Array.isArray(params.input) ? params.input : []).includes("SCENARIO:fail")) {
        throw new RpcFailure(SERVER_ERROR, "Simulated turn failure");
      }
      startTurn(id, params);
      return;
    case "turn/steer":
      steerTurn(id, params);
      return;
    case "turn/interrupt": {
      const turn = threads.get(requireString(params, "threadId"))?.activeTurn ?? null;
      if (turn !== null && turn.wire.id === params.turnId) turn.interrupt();
      respond(id, {});
      return;
    }
    default:
      throw new RpcFailure(NOT_FOUND, "Method not found");
  }
}

function onLine(line) {
  if (line.trim() === "") return;
  let frame;
  try {
    frame = JSON.parse(line);
  } catch (error) {
    write({ id: null, error: { code: -32700, message: `Parse error: ${error.message}` } });
    return;
  }
  if (logPath !== undefined) appendFileSync(logPath, `${JSON.stringify(frame)}\n`);
  if (!isRecord(frame) || !("id" in frame)) return;

  if (typeof frame.method !== "string") {
    pendingResponses.get(frame.id)?.(frame.result);
    return;
  }
  try {
    handleRequest(frame.id, frame.method, isRecord(frame.params) ? frame.params : {});
  } catch (error) {
    if (!(error instanceof RpcFailure)) throw error;
    fail(frame.id, error.code, error.message);
  }
}

function serve() {
  home = process.env.FAKE_OMO_HOME ?? mkdtempSync(join(tmpdir(), "fake-omo-"));
  sessionsDir = join(home, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  logPath = process.env.FAKE_OMO_LOG;
  writeLongSession();
  loadPersistedThreads();
  process.stderr.write("fake app-server listening on stdio://\n");
  const lines = createInterface({ input: process.stdin });
  lines.on("line", onLine);
  lines.on("close", () => {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    process.exitCode = 0;
  });
}

const argv = process.argv.slice(2);
if (argv.length === 1 && argv[0] === "--version") {
  process.stdout.write(`${VERSION_LINE}\n`);
} else if (argv.length === 3 && argv[0] === "app-server" && argv[1] === "--listen" && argv[2] === "stdio://") {
  serve();
} else {
  process.stderr.write(USAGE);
  process.exitCode = 2;
}
