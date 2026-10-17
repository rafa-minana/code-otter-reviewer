const DEFAULT_PORT = 3000;

export interface Config {
  webhookSecret: string;
  databaseUrl: string;
  port: number;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const webhookSecret = env.GITHUB_WEBHOOK_SECRET;
  const databaseUrl = env.DATABASE_URL;
  if (!webhookSecret) throw new Error("GITHUB_WEBHOOK_SECRET is required");
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  return { webhookSecret, databaseUrl, port: Number(env.PORT ?? DEFAULT_PORT) };
}
