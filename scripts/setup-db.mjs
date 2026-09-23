/**
 * Cross-platform database setup. Works on Windows, macOS and Linux — it talks to
 * PostgreSQL over the network instead of shelling out to `sudo -u postgres psql`,
 * which only exists on Debian-style Linux.
 *
 *   node scripts/setup-db.mjs              # rebuild the database in .env, then seed an empty factory
 *   node scripts/setup-db.mjs --demo       # rebuild and seed the full worked example
 *   node scripts/setup-db.mjs --clean      # rebuild, example catalogue and stock, no orders
 *   node scripts/setup-db.mjs --test       # rebuild mes_test, no seed (for the suite)
 *   node scripts/setup-db.mjs --no-seed    # rebuild, leave it empty
 *
 * Steps: create .env if missing -> drop and recreate the database -> push the Drizzle
 * schema -> apply src/db/constraints.sql -> seed.
 */
import { Client } from "pg";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const args = process.argv.slice(2);
const isTest = args.includes("--test");
const noSeed = args.includes("--no-seed") || isTest;
/**
 * Managed Postgres (Neon, Railway, Supabase, RDS) gives you one database and no
 * rights over the cluster, so the local drop-and-recreate is not available. In
 * that case the equivalent is TRUNCATE across every table. Auto-detected from the
 * host, and forceable with --remote for anything unusual.
 */
const localHosts = new Set(["localhost", "127.0.0.1", "::1", "host.docker.internal"]);

// --- .env ------------------------------------------------------------------
// First run on a new machine: write one rather than failing with an unhelpful error.
const envPath = path.join(root, ".env");
if (!fs.existsSync(envPath)) {
  const secret = randomBytes(32).toString("base64");
  fs.writeFileSync(
    envPath,
    `DATABASE_URL="postgresql://postgres:postgres@localhost:5432/mes_dev"\n` +
      `AUTH_SECRET="${secret}"\n`
  );
  console.log("created .env with a generated AUTH_SECRET");
  console.log("  if your Postgres password is not 'postgres', edit DATABASE_URL in .env now");
}
const dotenv = await import("dotenv");
dotenv.config({ path: envPath, quiet: true });

// --- Work out which database ----------------------------------------------
const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL is not set (check .env)");
  process.exit(1);
}

const url = new URL(baseUrl);
const dbName = isTest ? "mes_test" : decodeURIComponent(url.pathname.replace(/^\//, ""));
if (!dbName) {
  console.error(`DATABASE_URL has no database name: ${baseUrl}`);
  process.exit(1);
}
if (/prod/i.test(dbName)) {
  console.error(`refusing to drop a database named "${dbName}"`);
  process.exit(1);
}

const remote = args.includes("--remote") || !localHosts.has(url.hostname);

const targetUrl = new URL(baseUrl);
targetUrl.pathname = `/${dbName}`;
const adminUrl = new URL(baseUrl);
adminUrl.pathname = "/postgres";

const dbUrlString = targetUrl.toString();

function unreachable(err) {
  console.error(`\ncannot reach PostgreSQL at ${url.host}`);
  console.error(`  ${err.message}`);
  if (remote) {
    console.error("\nCheck the connection string from your database provider.");
    console.error("  Most managed providers require ?sslmode=require on the URL.");
  } else {
    console.error("\nIs the server running, and is the password in .env correct?");
    console.error("  Windows: check the postgresql-x64-16 service in services.msc");
    console.error("  macOS:   brew services start postgresql@16");
    console.error("  Linux:   sudo pg_ctlcluster 16 main start");
    console.error("  Docker:  docker run -d --name mes-pg -e POSTGRES_PASSWORD=postgres \\");
    console.error("             -p 5432:5432 postgres:16");
  }
  process.exit(1);
}

if (remote) {
  // Empty the tables rather than the database. Runs before the schema push so a
  // brand-new database (no tables yet) is simply a no-op.
  console.log(`clearing data in ${dbName} at ${url.hostname}`);
  const client = new Client({ connectionString: dbUrlString });
  try {
    await client.connect();
  } catch (err) {
    unreachable(err);
  }
  const { rows } = await client.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`
  );
  if (rows.length > 0) {
    const list = rows.map((r) => `"public"."${r.tablename}"`).join(", ");
    await client.query(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
    console.log(`  cleared ${rows.length} tables`);
  }
  await client.end();
} else {
  const admin = new Client({ connectionString: adminUrl.toString() });
  try {
    await admin.connect();
  } catch (err) {
    unreachable(err);
  }

  console.log(`resetting ${dbName}`);
  // Existing sessions (a dev server, a psql window) would block the DROP.
  await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [dbName]
  );
  await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
  await admin.query(`CREATE DATABASE "${dbName}"`);
  await admin.end();
}

// --- Schema ----------------------------------------------------------------
const childEnv = { ...process.env, DATABASE_URL: dbUrlString };

function run(command, label) {
  console.log(label);
  // shell:true so this works with npx.cmd on Windows.
  const res = spawnSync(command, { stdio: "inherit", shell: true, env: childEnv });
  if (res.status !== 0) {
    console.error(`\n${label} failed`);
    process.exit(res.status ?? 1);
  }
}

run("npx drizzle-kit push --force", "pushing schema");

// --- Constraints -----------------------------------------------------------
// These are NOT in the Drizzle schema, so a push alone leaves the database without
// its invariant backstops (on_hand >= 0 and the rest).
console.log("applying constraints");
const target = new Client({ connectionString: dbUrlString });
await target.connect();
await target.query(fs.readFileSync(path.join(root, "src/db/constraints.sql"), "utf8"));
await target.end();

// --- Seed ------------------------------------------------------------------
if (!noSeed) {
  /*
    Empty by default: people, stations, reason codes and stores, but no products
    and no orders. A factory types in its own catalogue, and shipping demo part
    numbers as the starting state teaches them ours.

    --demo  the full worked example, mid-build, for showing the system.
    --clean the example catalogue and stock, but no work in progress.
  */
  const mode = args.includes("--demo")
    ? { flag: "", label: "seeding the worked example" }
    : args.includes("--clean")
      ? { flag: " -- --no-orders", label: "seeding a clean floor" }
      : { flag: " -- --bare", label: "seeding an empty factory" };
  run(`npx tsx src/db/seed.ts${mode.flag}`, mode.label);
}

console.log("");
console.log(`${dbName} ready`);
if (!noSeed) {
  console.log("  npm run dev   ->  http://localhost:3000");
  console.log("  logins: admin@ | supervisor@ | worker1@..worker4@thermal-corp.com");
  console.log("  password: password123");
}
