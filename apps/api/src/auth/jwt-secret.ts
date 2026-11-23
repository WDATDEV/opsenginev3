export const DEV_JWT_SECRET = "dev-only-change-me";

// A known secret would let anyone forge a login, so production refuses to start without a real one.
export function jwtSecret(env: Record<string, string | undefined> = process.env) {
  const secret = env.JWT_SECRET?.trim();
  if (env.NODE_ENV === "production" && (!secret || secret === DEV_JWT_SECRET)) {
    throw new Error("JWT_SECRET must be set to a long random value in production.");
  }
  return secret || DEV_JWT_SECRET;
}
