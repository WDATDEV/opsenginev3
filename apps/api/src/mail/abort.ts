export const STOPPED = "Stopped. Ask again if you still need this.";

export class CancelledError extends Error {
  constructor() {
    super(STOPPED);
    this.name = "CancelledError";
  }
}

export function isCancelled(err: unknown) {
  if (!err || typeof err !== "object") return false;
  const name = "name" in err ? String(err.name) : "";
  const message = "message" in err ? String(err.message) : "";
  return name === "AbortError" || name === "CancelledError" || message === STOPPED;
}

export function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new CancelledError();
}

export function timedSignal(ms: number, extra?: AbortSignal) {
  const timeout = AbortSignal.timeout(ms);
  if (!extra) return timeout;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([timeout, extra]);
  const ctrl = new AbortController();
  const stop = () => ctrl.abort();
  if (extra.aborted || timeout.aborted) {
    ctrl.abort();
    return ctrl.signal;
  }
  extra.addEventListener("abort", stop, { once: true });
  timeout.addEventListener("abort", stop, { once: true });
  return ctrl.signal;
}
