import { ForbiddenError } from "@opsengine/kernel";

export function assertBrowserConfirm(headers: Record<string, unknown>, cookie: string | undefined, webOrigin: string) {
  if (header(headers, "x-job-token")) {
    throw new ForbiddenError("Stock confirm is only from the owner's browser.");
  }
  if (header(headers, "authorization") && !cookie) {
    throw new ForbiddenError("Stock confirm is only from the owner's browser.");
  }
  if (!cookie) throw new ForbiddenError("Sign in to continue.");
  const origin = header(headers, "origin");
  const referer = header(headers, "referer");
  if (origin) {
    if (origin !== webOrigin) throw new ForbiddenError("Stock confirm is only from the owner's browser.");
    return;
  }
  if (!referer || !referer.startsWith(webOrigin)) {
    throw new ForbiddenError("Stock confirm is only from the owner's browser.");
  }
}

function header(headers: Record<string, unknown>, name: string) {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.length > 0 ? value : "";
}
