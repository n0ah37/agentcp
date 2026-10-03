import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CLAUDE_DIR, CODEX_DIR, HOME } from "../engine/lib/paths.ts";
import { fileSession, fileSessions, forgetTranscripts, usageView } from "../engine/lib/transcripts.ts";

const P = path.join(HOME, "Dev", "cart");
const put = (p: string, rows: object[]) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
};
const at = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

beforeAll(() => {
  const base = { cwd: P, sessionId: "c1", gitBranch: "fix/coupon", entrypoint: "cli" };
  const usage = { input_tokens: 10, output_tokens: 50, cache_read_input_tokens: 900, cache_creation_input_tokens: 100 };
  put(path.join(CLAUDE_DIR, "projects", "-Dev-cart", "c1.jsonl"), [
    { ...base, type: "user", isMeta: true, timestamp: at(30), message: { role: "user", content: "<local-command-caveat>x</local-command-caveat>" } },
    { ...base, type: "user", timestamp: at(29), message: { role: "user", content: "<system-reminder>hidden</system-reminder>The coupon applies twice" } },
    { ...base, type: "assistant", timestamp: at(28), message: { id: "m1", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "Looking at the cart." }], usage } },
    // The same response streamed again: its usage must count once.
    { ...base, type: "assistant", timestamp: at(28), message: { id: "m1", role: "assistant", model: "claude-opus-5-5", content: [{ type: "tool_use", name: "Edit", input: { file_path: path.join(P, "src/cart.ts"), old_string: "a", new_string: "b" } }], usage } },
    { ...base, type: "user", timestamp: at(27), message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } },
    { ...base, type: "assistant", timestamp: at(26), message: { id: "m2", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "Fixed: it was applied in two places." }], usage } },
    { type: "custom-title", sessionId: "c1", customTitle: "Fix the double coupon" },
  ]);
  const codex = path.join(CODEX_DIR, "sessions", "2026", "10", "01", "rollout-2026-10-01T09-00-00-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b.jsonl");
  const id = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
  put(codex, [
    { timestamp: at(20), type: "session_meta", payload: { id, cwd: P, originator: "codex_cli_rs", git: { branch: "main" } } },
    { timestamp: at(20), type: "turn_context", payload: { model: "gpt-5-codex", cwd: P } },
    { timestamp: at(20), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>cwd</environment_context>" }] } },
    { timestamp: at(19), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Add a test for the coupon" }] } },
    { timestamp: at(18), type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "pnpm test" }) } },
    { timestamp: at(18), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 40 } } } },
    { timestamp: at(17), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Added cart.test.ts." }] } },
    { timestamp: at(17), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1500, cached_input_tokens: 1200, output_tokens: 90 } } } },
  ]);
  fs.writeFileSync(path.join(CODEX_DIR, "session_index.jsonl"), JSON.stringify({ id, thread_name: "Coupon test", updated_at: at(17) }) + "\n");
  forgetTranscripts();
});

// The test home is shared; other tests count every transcript in it.
afterAll(() => {
  fs.rmSync(path.join(CLAUDE_DIR, "projects", "-Dev-cart"), { recursive: true, force: true });
  fs.rmSync(path.join(CODEX_DIR, "sessions"), { recursive: true, force: true });
  fs.rmSync(path.join(CODEX_DIR, "session_index.jsonl"), { force: true });
  forgetTranscripts();
});

describe("sessions from the agents' own files", () => {
  it("lists both agents' sessions for a project, titled, counting only what you typed", async () => {
    const { sessions } = await fileSessions({ project: P, q: null, sources: ["claude_code", "codex"] });
    expect(sessions.map((s) => [s.source, s.title, s.prompts])).toEqual([
      ["codex", "Coupon test", 1],
      ["claude_code", "Fix the double coupon", 1],
    ]);
    expect(sessions[1].preview).toBe("The coupon applies twice");
    expect((await fileSessions({ project: P, q: null, sources: ["codex"] })).sessions).toHaveLength(1);
    expect((await fileSessions({ project: P, q: "double", sources: ["claude_code", "codex"] })).sessions.map((s) => s.source)).toEqual(["claude_code"]);
  });

  it("reads a session as prompt, work and answer, with the files it changed", () => {
    const v = fileSession("claude_code:c1")!;
    expect(v.turns).toHaveLength(1);
    expect(v.turns[0].prompt?.text).toBe("The coupon applies twice");
    expect(v.turns[0].answer?.text).toBe("Fixed: it was applied in two places.");
    expect(v.files).toEqual([{ path: path.join(P, "src/cart.ts"), display: "src/cart.ts", edits: 1 }]);
    expect(v.branch).toBe("fix/coupon");
    expect(v.resume).toBe("cd ~/Dev/cart && claude --resume c1");
    const c = fileSession("codex:0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b")!;
    expect(c.commands).toEqual([{ command: "pnpm test", count: 1 }]);
    expect(c.resume).toContain("codex resume 0199a1b2");
  });

  it("counts tokens once per response, and splits Codex's cached input out", async () => {
    const u = await usageView({ days: 7, sources: ["claude_code", "codex"], project: P });
    // Claude: two responses (m1 once, m2), each 10 fresh input, 50 output, 900 read, 100 written.
    // Codex: 1500 input of which 1200 cached, 90 output.
    expect(u.totals).toMatchObject({ input: 20 + 300, output: 100 + 90, cacheRead: 1800 + 1200, cacheWrite: 200, sessions: 2 });
    expect(u.byModel.map((m) => m.label).sort()).toEqual(["claude-opus-5-5", "gpt-5-codex"]);
    expect(u.byDay).toHaveLength(7);
    expect((await usageView({ days: 7, sources: ["codex"], project: P })).totals.output).toBe(90);
  });
});
