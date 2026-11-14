import { ForbiddenError } from "@opsengine/kernel";

// APP_ENV=test (exactly) skips ONLY the Origin/Referer match, because test web addresses
// change on every deploy. Anything else, including a missing or misspelled value, is
// treated as production and fully checked. The other checks always run: no job token,
// a signed-in session cookie, and (in the service) the owner role.
export function originCheckSkipped(appEnv: string | undefined) {
  return (appEnv ?? "").trim().toLowerCase() === "test";
}

export function assertBrowserConfirm(
  headers: Record<string, unknown>,
  cookie: string | undefined,
  webOrigin: string,
  appEnv: string | undefined = undefined,
) {
  if (header(headers, "x-job-token")) {
    throw new ForbiddenError("Stock confirm is only from the owner's browser.");
  }
  if (header(headers, "authorization") && !cookie) {
    throw new ForbiddenError("Stock confirm is only from the owner's browser.");
  }
  if (!cookie) throw new ForbiddenError("Sign in to continue.");
  if (originCheckSkipped(appEnv)) return;

  const origin = header(headers, "origin");
  const referer = header(headers, "referer");
  const expected = webOrigin.replace(/\/$/, "");
  if (origin) {
    if (origin.replace(/\/$/, "") !== expected) throw new ForbiddenError("Stock confirm is only from the owner's browser.");
    return;
  }
  if (!referer || !referer.startsWith(expected)) {
    throw new ForbiddenError("Stock confirm is only from the owner's browser.");
  }
}

function header(headers: Record<string, unknown>, name: string) {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.length > 0 ? value : "";
}
