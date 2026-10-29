import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), "../../.env") });

const API = process.env.API_UPSTREAM ?? "http://localhost:3011";
const TOKEN = process.env.JOB_TOKEN ?? "";
const INTERVAL_MS = Number(process.env.WORKER_INTERVAL_MS ?? 60_000);

async function tick() {
  if (!TOKEN) {
    console.log("Worker idle — set JOB_TOKEN to close tasks left open after clock-out.");
    return;
  }
  try {
    const res = await fetch(`${API}/internal/tick`, {
      method: "POST",
      headers: { "x-job-token": TOKEN },
    });
    if (!res.ok) {
      console.log(`Tick failed (${res.status}).`);
      return;
    }
    const body = (await res.json()) as { closed?: number };
    console.log(`Tick ok · closed ${body.closed ?? 0} leftover task segments`);
  } catch (err) {
    console.log(err instanceof Error ? err.message : "Tick failed.");
  }
}

await tick();
setInterval(() => {
  void tick();
}, INTERVAL_MS);
