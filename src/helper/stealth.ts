import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { firefox, type BrowserContext } from "playwright";

const run = promisify(execFile);

const PY = ".venv/bin/python";
const PATH_FILE = path.resolve(".browser-path");

let cachedPath: string | undefined;

// Runs `fetch` once ever, then reads the cached path from disk.
// Delete .browser-path after upgrading the package or re-fetching the engine.
export function enginePath(): string {
  if (cachedPath) return cachedPath;

  if (!existsSync(PATH_FILE)) {
    const out = execFileSync(PY, ["-m", "invisible_playwright", "fetch"], {
      encoding: "utf8",
    });
    writeFileSync(PATH_FILE, out.trim().split("\n").pop()!); // path is the last line
  }

  cachedPath = readFileSync(PATH_FILE, "utf8").trim();
  return cachedPath;
}

export async function stealthPrefs(
  seed: number,
): Promise<Record<string, string | number | boolean>> {
  const code =
    "import json,sys;" +
    "from invisible_playwright import get_default_stealth_prefs as g;" +
    "print(json.dumps(g(seed=int(sys.argv[1]), humanize=True)))";

  const { stdout } = await run(PY, ["-c", code, String(seed)], {
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

type LaunchOpts = NonNullable<
  Parameters<typeof firefox.launchPersistentContext>[1]
>;
const launchMeta = new WeakMap<
  BrowserContext,
  { seed: number; options: LaunchOpts }
>();

export function getLaunchMeta(context: BrowserContext) {
  return launchMeta.get(context);
}

export async function writeProfile(seed: number): Promise<string> {
  const dir = path.resolve(".profiles", `seed-${seed}`);
  mkdirSync(dir, { recursive: true });

  const prefs = await stealthPrefs(seed);
  const lines = Object.entries(prefs).map(
    ([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`,
  );
  writeFileSync(path.join(dir, "user.js"), lines.join("\n") + "\n");
  return dir;
}

// Optional: call after context.close() so old profiles don't pile up.
export function removeProfile(seed: number): void {
  rmSync(path.resolve(".profiles", `seed-${seed}`), {
    recursive: true,
    force: true,
  });
}

export async function launchStealthContext(
  seed: number,
  options: LaunchOpts = {},
): Promise<BrowserContext> {
  const t0 = Date.now();
  const dir = await writeProfile(seed);
  console.log(`[seed ${seed}] prefs+profile: ${Date.now() - t0}ms`);

  const t1 = Date.now();
  const context = await firefox.launchPersistentContext(dir, {
    executablePath: enginePath(),
    headless: false,
    timeout: 120_000,
    ...options,
  });
  console.log(`[seed ${seed}] firefox launch: ${Date.now() - t1}ms`);

  launchMeta.set(context, { seed, options });
  return context;
}