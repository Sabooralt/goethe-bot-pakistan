import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { firefox, type BrowserContext } from 'playwright';

const PY = ".venv/bin/python";

let cachedPath: string | undefined;

export function enginePath(): string {
  if (!cachedPath) {
    const out = execFileSync(PY, ["-m", "invisible_playwright", "fetch"], {
      encoding: "utf8",
    });
    cachedPath = out.trim().split("\n").pop()!; // path is the last line
  }
  return cachedPath;
}

export function stealthPrefs(
  seed: number,
): Record<string, string | number | boolean> {
  const code =
    "import json,sys;" +
    "from invisible_playwright import get_default_stealth_prefs as g;" +
    "print(json.dumps(g(seed=int(sys.argv[1]), humanize=True)))";
  return JSON.parse(
    execFileSync(PY, ["-c", code, String(seed)], { encoding: "utf8" }),
  );
}


type LaunchOpts = NonNullable<Parameters<typeof firefox.launchPersistentContext>[1]>;

export function writeProfile(seed: number): string {
  const dir = path.resolve('.profiles', `seed-${seed}`);
  mkdirSync(dir, { recursive: true });

  const lines = Object.entries(stealthPrefs(seed)).map(
    ([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`,
  );
  writeFileSync(path.join(dir, 'user.js'), lines.join('\n') + '\n');
  return dir;
}

export function launchStealthContext(
  seed: number,
  options: LaunchOpts = {},
): Promise<BrowserContext> {
  return firefox.launchPersistentContext(writeProfile(seed), {
    executablePath: enginePath(),
    headless: false,
    ...options,
  });
}