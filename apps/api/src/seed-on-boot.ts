import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

function repoRoot() {
  const candidates = [process.cwd(), resolve(process.cwd(), "../.."), "/app"];
  return candidates.find((dir) => existsSync(resolve(dir, "pnpm-workspace.yaml")));
}

export function runSeed() {
  const root = repoRoot();
  if (!root) throw new Error("Could not find the repo root to run the seed.");

  return new Promise<void>((resolvePromise, reject) => {
    const child = spawn("pnpm", ["db:seed"], {
      cwd: root,
      stdio: "inherit",
      shell: process.platform === "win32",
      env: { ...process.env, SEED_DEMO: process.env.SEED_DEMO === "1" ? "1" : "0" },
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`Database seed failed (${code ?? "unknown"}).`));
    });
  });
}
