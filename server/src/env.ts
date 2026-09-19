export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** Optional: without the R2 binding voice metadata still syncs, but blobs cannot be stored (PUT → 503, GET → 404). */
  VOICE?: R2Bucket;
  BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  WEBAPP_URL: string;
  DEV_USER_ID?: string;
}
