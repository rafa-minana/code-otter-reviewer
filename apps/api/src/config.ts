const DEFAULT_PORT = 3000;
const DEFAULT_ADMIN_PORT = 3001;
const ADMIN_TOKEN_MIN_LENGTH = 32;

export interface Config {
  webhookSecret: string;
  databaseUrl: string;
  port: number;
  adminPort: number;
  /** Unset: /admin is disabled. */
  adminToken?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const webhookSecret = env.GITHUB_WEBHOOK_SECRET;
  const databaseUrl = env.DATABASE_URL;
  if (!webhookSecret) throw new Error("GITHUB_WEBHOOK_SECRET is required");
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  return {
    webhookSecret,
    databaseUrl,
    port: Number(env.PORT ?? DEFAULT_PORT),
    adminPort: Number(env.ADMIN_PORT ?? DEFAULT_ADMIN_PORT),
    adminToken: adminToken(env.ADMIN_TOKEN),
  };
}

/** Optional: unset disables /admin; set, it must be long enough to resist guessing. */
function adminToken(value: string | undefined): string | undefined {
  if (value && value.length < ADMIN_TOKEN_MIN_LENGTH)
    throw new Error(
      `ADMIN_TOKEN must be at least ${ADMIN_TOKEN_MIN_LENGTH} characters (generate one with \`openssl rand -hex 32\`)`,
    );
  return value || undefined;
}
