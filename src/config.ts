/**
 * Server-wide configuration, read once from the environment.
 *
 * ELS_API_BASE_URL currently points at a Vercel branch preview of the `api-improvements`
 * branch of ONSdigital/explore-local-statistics-app (not the production ELS API) — see
 * CLAUDE.md. It must become a config change, not a code edit, once that branch merges.
 */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. Set it in .env (local) or the Vercel ` +
        `project's environment variables (deployed). See .env.example.`,
    );
  }
  return value;
}

export const ELS_API_BASE_URL = requireEnv("ELS_API_BASE_URL").replace(/\/+$/, "");
