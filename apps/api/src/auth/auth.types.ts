import type { Principal } from "@opsengine/kernel";

export const SESSION_COOKIE = "oe_tracking";

export type AuthedRequest = {
  cookies?: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  user?: Principal;
};
