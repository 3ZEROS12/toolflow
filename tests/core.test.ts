import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  atomicWriteFileSync,
  cleanupStaleTempFiles,
  normalizeWorkspaceKey,
  sleepSync,
} from "../src/core/atomic-fs.js";
import { extractValidJsonObject } from "../src/core/json-extract.js";
import { clearAllWorkspaceStores, getWorkspaceStore } from "../src/core/workspace-store.js";
import { t } from "../src/core/messages.js";

function makeWorkspace(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `toolflow-core-${prefix}-`));
}

test("atomic-fs: normalizeWorkspaceKey resolves relative paths to stable keys", () => {
  const workspace = makeWorkspace("key");
  const mixed = path.join(workspace, "Sub", "Dir");
  const key = normalizeWorkspaceKey(mixed);

  assert.equal(path.isAbsolute(key), true);
  assert.equal(normalizeWorkspaceKey(mixed), normalizeWorkspaceKey(path.resolve(mixed)));
  assert.equal(normalizeWorkspaceKey(mixed), normalizeWorkspaceKey(mixed));

  fs.rmSync(workspace, { recursive: true, force: true });
});

test("atomic-fs: writes through nested directories and leaves no temp files", () => {
  const workspace = makeWorkspace("write");
  const target = path.join(workspace, "nested", "deep", "state.json");

  assert.equal(atomicWriteFileSync(target, JSON.stringify({ ok: true })), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf-8")), { ok: true });

  cleanupStaleTempFiles(path.dirname(target), ["state.json.tmp."]);
  const leftovers = fs.readdirSync(path.dirname(target)).filter((n) => n.includes(".tmp."));
  assert.deepEqual(leftovers, []);

  fs.rmSync(workspace, { recursive: true, force: true });
});

test("atomic-fs: sleepSync returns promptly for non-positive durations", () => {
  const startedAt = Date.now();
  sleepSync(0);
  assert.ok(Date.now() - startedAt < 50);
});

test("json-extract: reads fenced blocks, nested braces, and rejects unbalanced input", () => {
  assert.deepEqual(extractValidJsonObject('```json\n{"a":1,"b":{"c":[1,2]}}\n```'), {
    a: 1,
    b: { c: [1, 2] },
  });

  assert.deepEqual(extractValidJsonObject('prefix {"text":"brace } inside","n":2} suffix'), {
    text: "brace } inside",
    n: 2,
  });

  assert.throws(() => extractValidJsonObject("no object here"), /No JSON object/i);
  assert.throws(() => extractValidJsonObject('{"unterminated": 1'), /Unbalanced braces/i);
});

test("workspace-store: state is isolated per workspace and never touched on cold start", () => {
  clearAllWorkspaceStores();
  const first = makeWorkspace("iso-a");
  const second = makeWorkspace("iso-b");

  const firstStore = getWorkspaceStore(first);
  const secondStore = getWorkspaceStore(second);

  assert.equal(firstStore.load(), null);
  assert.equal(fs.existsSync(path.join(first, ".pi")), false);

  firstStore.updateState((state) => {
    state.status = "in_progress";
  });
  assert.equal(firstStore.getState().status, "in_progress");
  assert.equal(secondStore.getState().status, "idle");

  fs.rmSync(first, { recursive: true, force: true });
  fs.rmSync(second, { recursive: true, force: true });
  clearAllWorkspaceStores();
});

test("workspace-store: reset clears memory and persisted artifacts", () => {
  clearAllWorkspaceStores();
  const workspace = makeWorkspace("reset");
  const store = getWorkspaceStore(workspace);

  store.updateState((state) => {
    state.status = "completed";
  });
  assert.equal(store.save(), true);
  assert.equal(fs.existsSync(path.join(workspace, ".pi", "blueprint_state.json")), true);

  store.reset();
  assert.equal(store.getState().status, "idle");
  assert.equal(fs.existsSync(path.join(workspace, ".pi", "blueprint_state.json")), false);

  fs.rmSync(workspace, { recursive: true, force: true });
  clearAllWorkspaceStores();
});

test("messages: chrome dictionary stays English-only", () => {
  const chrome = [
    t.cancelled,
    t.noDecision,
    t.resetSuccess,
    t.exportNoBlueprint,
    t.helpBanner,
    t.analyzingTask("build a parser"),
    t.stageVerified(1, "src/index.ts", "abc12345"),
  ].join("\n");

  assert.equal(/[\u4e00-\u9fa5]/.test(chrome), false);
  assert.match(t.analyzingTask("x"), /build|x/);
});

test("store: a corrupt persisted status hydrates as idle instead of falling through every branch", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "toolflow-corrupt-status-"));
  const stateFile = path.join(workspace, ".pi", "blueprint_state.json");
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(
    stateFile,
    JSON.stringify({
      currentBlueprint: { blueprintId: "bp", task: "t", stages: [] },
      currentStageIndex: 0,
      status: "exploded",
    }),
    "utf-8"
  );

  const store = getWorkspaceStore(workspace);
  store.load();
  assert.equal(store.getState().status, "idle");

  fs.rmSync(workspace, { recursive: true, force: true });
  clearAllWorkspaceStores();
});
