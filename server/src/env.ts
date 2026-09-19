export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  WEBAPP_URL: string;
  DEV_USER_ID?: string;
}
