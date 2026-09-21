/**
 * Cross-platform test runner (the bash version only ran on Linux/macOS).
 *
 * Every test file truncates every table, so files cannot share a process or run
 * concurrently — each gets its own process, one at a time, and the results are
 * aggregated.
 *
 * DATABASE_URL is forced to mes_test here. That is the safety guard: pointing the
 * suite at a development database would wipe it.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const dotenv = await import("dotenv");
dotenv.config({ path: path.join(root, ".env"), quiet: true });

// Same server and credentials as the dev database, but always the mes_test database.
const base = process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/mes_dev";
const testUrl = new URL(base);
testUrl.pathname = "/mes_test";

const files = fs
  .readdirSync(path.join(root, "tests"))
  .filter((f) => f.endsWith(".test.ts") || f.endsWith(".test.mts"))
  .sort()
  .map((f) => path.join("tests", f));

if (files.length === 0) {
  console.error("no test files found in tests/");
  process.exit(1);
}

let total = 0;
let passed = 0;
let failed = 0;

for (const file of files) {
  const res = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--experimental-test-module-mocks",
      "--test",
      // Pinned: Node 22 changed the default reporter from tap to spec, and the
      // counts below are parsed out of TAP. Without this the suite reports
      // 0 tests, 0 failures and exits 0 -- green while verifying nothing.
      "--test-reporter=tap",
      file,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: testUrl.toString() },
      shell: false,
    }
  );

  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;

  for (const line of out.split("\n")) {
    if (/^(ok|not ok) /.test(line)) console.log(line);
  }

  const num = (label) => {
    const m = [...out.matchAll(new RegExp(`^# ${label} (\\d+)`, "gm"))].pop();
    return m ? Number(m[1]) : 0;
  };

  total += num("tests");
  passed += num("pass");
  failed += num("fail");

  // Per-file totals. Without these the only number anyone sees is the grand
  // total, so a file that crashed before reporting anything looks the same as a
  // file that simply has few tests.
  const mark = num("fail") > 0 ? "\x1b[31m✗\x1b[0m" : "\x1b[32m✓\x1b[0m";
  console.log(`${mark} ${file.padEnd(30)} ${num("pass")}/${num("tests")}`);

  if (num("fail") > 0 || res.status !== 0) {
    // Show the failure detail rather than making the reader re-run it alone.
    const start = out.indexOf("not ok");
    console.log(out.slice(start >= 0 ? start : 0).split("\n").slice(0, 40).join("\n"));
    if (num("tests") === 0) failed += 1; // crashed before reporting anything
  }
}

console.log("");
console.log(`total ${total}  pass ${passed}  fail ${failed}`);
process.exit(failed === 0 ? 0 : 1);
