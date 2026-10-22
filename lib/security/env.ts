import "server-only";
import { z } from "zod";
import type { LinkBase } from "@/lib/domain/amp-links";

export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** Values pasted with their .env quotes (`"live"`) are unwrapped instead of failing validation. */
const unquote = (v: string) => (/^(["'])[\s\S]*\1$/.test(v.trim()) ? v.trim().slice(1, -1) : v);
const blank = (v: unknown) => (typeof v !== "string" ? v : unquote(v).trim() === "" ? undefined : unquote(v));
const str = z.preprocess(blank, z.string().optional());
const bool = z.preprocess((v) => (typeof v === "string" ? unquote(v).trim().toLowerCase() === "true" : v), z.boolean().default(false));
const num = z.preprocess((v) => (blank(v) === undefined ? undefined : Number(blank(v))), z.number().positive().optional());

const EnvSchema = z.object({
  DATA_MODE: z.preprocess(blank, z.enum(["live", "demo"]).default("demo")),
  /** Personal access token used for every read (scan). Sent only to api.amplience.net. */
  AMPLIENCE_PAT: str,
  /** Hub id (preferred) or hub name: at least one is required. */
  AMPLIENCE_HUB_ID: str,
  AMPLIENCE_HUB_NAME: str,
  /** Source locale; default = first scanned locale. */
  AMPLIENCE_MASTER_LOCALE: str,
  /** Comma-separated subset of the hub's locales to scan; default = all hub locales. */
  AMPLIENCE_LOCALES: str,
  /** Comma-separated repository names to scan; default = repositories with content types and no item-level locale other than the master. */
  AMPLIENCE_REPOSITORIES: str,
  /** Separate token for writes (ideally a user limited to a test repository). Never used for reads. */
  AMPLIENCE_WRITE_PAT: str,
  ENABLE_CMS_WRITES: bool,
  ENABLE_CMS_PUBLISH: bool,
  /** Comma-separated content item ids the writer may touch (a safe test item). Empty = nothing writable. */
  CMS_WRITE_ALLOWED_ITEM_IDS: str,
  OPENAI_API_KEY: str,
  OPENAI_MODEL: z.preprocess(blank, z.string().default("gpt-6-luna")),
  OPENAI_REASONING_EFFORT: z.preprocess(blank, z.enum(REASONING_EFFORTS).optional()),
  OPENAI_PRICE_INPUT_PER_MTOK: num,
  OPENAI_PRICE_OUTPUT_PER_MTOK: num,
  AI_MAX_USD_PER_BATCH: z.preprocess((v) => (blank(v) === undefined ? 2 : Number(blank(v))), z.number().positive()),
  AI_SEND_CONTENT_TO_OPENAI: bool,
  SCAN_MAX_ITEMS_PER_TYPE: z.preprocess((v) => (blank(v) === undefined ? 200 : Number(blank(v))), z.number().int().positive().max(2000)),
  CRITICAL_LOCALES: str,
  HUB_ACTOR_ID: z.preprocess(blank, z.string().default("reviewer@local")),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;
export function getEnv(): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    // Names of invalid keys only; never echo values.
    const keys = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Invalid environment configuration: ${keys}`);
  }
  cached = parsed.data;
  return cached;
}

const list = (v?: string) => (v ?? "").split(",").map((x) => x.trim()).filter(Boolean);

export function amplienceLocales(env: Env): string[] {
  return list(env.AMPLIENCE_LOCALES);
}

export function amplienceRepositories(env: Env): string[] {
  return list(env.AMPLIENCE_REPOSITORIES);
}

/** The hub name is what app URLs need; without it (id only) deep links are off. */
export function amplienceLinkBase(env: Env, hubName?: string): LinkBase | null {
  const hub = hubName ?? env.AMPLIENCE_HUB_NAME;
  return hub ? { hub } : null;
}

export function criticalLocales(env: Env, fallback: string[]): string[] {
  // Locale codes are compared as the hub spells them (e.g. fr-FR).
  return env.CRITICAL_LOCALES ? list(env.CRITICAL_LOCALES) : fallback;
}

/** Booleans/labels only — safe to serialize to the browser. */
export function publicIntegrationStatus(env: Env) {
  return {
    dataModeDefault: env.DATA_MODE,
    amplience: {
      configured: Boolean(env.AMPLIENCE_PAT && (env.AMPLIENCE_HUB_ID || env.AMPLIENCE_HUB_NAME)),
      hub: env.AMPLIENCE_HUB_NAME ?? null,
      // A hub id is an identifier, not a secret.
      hubId: env.AMPLIENCE_HUB_ID ?? null,
      locales: amplienceLocales(env),
      repositories: amplienceRepositories(env),
      configError: env.AMPLIENCE_PAT && !env.AMPLIENCE_HUB_ID && !env.AMPLIENCE_HUB_NAME ? "Set AMPLIENCE_HUB_ID or AMPLIENCE_HUB_NAME" : null,
    },
    openai: {
      configured: Boolean(env.OPENAI_API_KEY),
      model: env.OPENAI_MODEL,
      reasoningEffort: env.OPENAI_REASONING_EFFORT ?? null,
      contentTransferAllowed: env.AI_SEND_CONTENT_TO_OPENAI,
      priced: Boolean(env.OPENAI_PRICE_INPUT_PER_MTOK && env.OPENAI_PRICE_OUTPUT_PER_MTOK),
    },
    writes: {
      enabled: env.ENABLE_CMS_WRITES,
      publishEnabled: false,
      writeTokenConfigured: Boolean(env.AMPLIENCE_WRITE_PAT),
      // Content item ids are identifiers, not secrets.
      allowedItemIds: (env.CMS_WRITE_ALLOWED_ITEM_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    },
  };
}
