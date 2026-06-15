import type { SyncHub } from "./sync-hub";

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  SYNC: DurableObjectNamespace<SyncHub>;
  CONTROL_PASSWORD: string;
  FLY_API_TOKEN: string;
  FLY_APP_NAME: string;
  FLY_MACHINE_ID?: string; // optional override; normally resolved by listing the app's machines
  FLY_ORG_SLUG?: string;
  FLY_BASE_URL: string;
  FLY_UPSTREAM_AUTHORIZATION?: string;
  IDLE_STOP_SECONDS?: string;
  NOTIFY_WEBHOOK_URL?: string;
  SETTINGS_ENC_KEY?: string;
  SESSION_SECRET?: string;
}
