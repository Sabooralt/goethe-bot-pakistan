import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

async function browse() {
    const url = "https://goethe.de"
  const { stdout } = await run(
    ".venv/bin/python",
    ["browse.py", JSON.stringify({ url })],
    {
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, DISPLAY: process.env.DISPLAY ?? ":2" },
    },
  );
  console.log(JSON.parse(stdout));
 
}

browse();
