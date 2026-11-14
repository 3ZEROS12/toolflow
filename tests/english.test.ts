import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import toolflowExtension from "../src/index.js";

const SOURCE_ROOT = path.resolve(process.cwd(), "src");
const HAN_PATTERN = /[\u4e00-\u9fa5]/;

function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

test("english gate: no Han characters leak into src/**, including comments", () => {
  const offenders: string[] = [];

  for (const file of listSourceFiles(SOURCE_ROOT)) {
    const lines = fs.readFileSync(file, "utf-8").split(/\r?\n/);
    lines.forEach((line, index) => {
      if (HAN_PATTERN.test(line)) {
        offenders.push(`${path.relative(SOURCE_ROOT, file)}:${index + 1}`);
      }
    });
  }

  assert.deepEqual(offenders, [], `Han characters found in: ${offenders.join(", ")}`);
});

test("english gate: extension entrypoint exports a default function", () => {
  assert.equal(typeof toolflowExtension, "function");
});

test("english gate: no leftover monolithic modules in src/", () => {
  const legacy = [
    "engine.ts",
    "ui.ts",
    "state.ts",
    "dehydrator.ts",
    "taxonomy.ts",
    "read_cache.ts",
    "ecosystem_taxonomy.json",
  ];
  for (const name of legacy) {
    assert.equal(fs.existsSync(path.join(SOURCE_ROOT, name)), false, `${name} should be removed`);
  }
});
