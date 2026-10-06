import { describe, expect, it } from "vitest";
import { memoryWriteNotice, parseSessionJsonl } from "../../electron/history/session-jsonl";

const at = (second: number): string => new Date(Date.UTC(2026, 9, 7, 0, 0, second)).toISOString();
const jsonl = (...lines: object[]): string => lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
const header = { type: "session", version: 3, id: "s", timestamp: at(0), cwd: "/w" };
const writeNotice = {
  sha: "abc123",
  subject: "Record the QA harness",
  affected: [{ path: "reference/qa.md", insertions: 33, deletions: 0 }],
  size: { systemBytes: 16_384, totalBytes: 701_440, fileCount: 134 },
  timeline: { entriesToday: 8, previousEntryAtISO: at(1), lastConsolidationAtISO: at(2) },
};

describe("memoryWriteNotice", () => {
  it("reads omo's write notice from a memory tool result", () => {
    expect(memoryWriteNotice({ writeNotice })).toEqual({
      sha: "abc123",
      subject: "Record the QA harness",
      affected: [{ path: "reference/qa.md", insertions: 33, deletions: 0 }],
      size: { systemBytes: 16_384, totalBytes: 701_440, fileCount: 134 },
      entriesToday: 8,
      previousEntryAt: at(1),
      lastConsolidationAt: at(2),
    });
  });

  it("returns null without a sha and drops malformed parts", () => {
    expect(memoryWriteNotice({ writeNotice: { subject: "x" } })).toBeNull();
    expect(memoryWriteNotice(null)).toBeNull();
    expect(memoryWriteNotice({ writeNotice: { sha: "s", affected: [{ insertions: 1 }], size: { systemBytes: "1" }, timeline: { previousEntryAtISO: "nope" } } }))
      .toMatchObject({ affected: [], size: null, entriesToday: null, previousEntryAt: null });
  });
});

describe("parseSessionJsonl notices", () => {
  const session = jsonl(
    header,
    { type: "custom_message", id: "n0", parentId: null, timestamp: at(1), customType: "environment-context", display: false, content: "<environment_context>cwd</environment_context>" },
    { type: "message", id: "u1", parentId: "n0", timestamp: at(2), message: { role: "user", content: [{ type: "text", text: "remember this" }] } },
    { type: "message", id: "a1", parentId: "u1", timestamp: at(3), message: { role: "assistant", content: [
      { type: "text", text: "Saving." },
      { type: "toolCall", id: "call-1", name: "memory", arguments: { command: "create" } },
    ] } },
    { type: "message", id: "r1", parentId: "a1", timestamp: at(4), message: { role: "toolResult", toolCallId: "call-1", toolName: "memory", content: [{ type: "text", text: "committed" }], details: { writeNotice } } },
    { type: "custom_message", id: "n1", parentId: "r1", timestamp: at(5), customType: "omo-model-profile:applied", display: true, content: "profile applied" },
  );

  it("keys memory writes by tool call and places each notice after the items before it", () => {
    const result = parseSessionJsonl(session);
    expect(Object.keys(result.memoryWrites ?? {})).toEqual(["call-1"]);
    expect(result.notices?.map((notice) => [notice.id, notice.turnIndex, notice.afterItems, notice.display])).toEqual([
      ["n0", 0, 0, false],
      ["n1", 0, 3, true],
    ]);
    expect(result.turns[0]?.items.map((item) => item.type)).toEqual(["userMessage", "agentMessage", "dynamicToolCall"]);
  });

  it("omits both fields when a session has none", () => {
    const result = parseSessionJsonl(jsonl(header, { type: "message", id: "u1", parentId: null, timestamp: at(1), message: { role: "user", content: "hi" } }));
    expect(result).not.toHaveProperty("memoryWrites");
    expect(result).not.toHaveProperty("notices");
  });
});
