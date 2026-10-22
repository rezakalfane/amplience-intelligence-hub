// Shared helpers for the maintenance scripts (scan / audits / backup / degrade / restore). Never prints secrets.
import { AmplienceClient } from "../lib/adapters/amplience-client";
import { createLiveAdapter } from "../lib/adapters/live-adapter";

process.loadEnvFile(".env.local");
const e = process.env;
if (!e.AMPLIENCE_PAT || (!e.AMPLIENCE_HUB_ID && !e.AMPLIENCE_HUB_NAME)) throw new Error("Missing AMPLIENCE_PAT and AMPLIENCE_HUB_ID (or AMPLIENCE_HUB_NAME) in .env.local");

const list = (v?: string) => (v ?? "").split(",").map((x) => x.trim()).filter(Boolean);

export const client = new AmplienceClient({ token: e.AMPLIENCE_PAT });
export const adapter = createLiveAdapter({
  client, hubId: e.AMPLIENCE_HUB_ID, hubName: e.AMPLIENCE_HUB_NAME, masterLocale: e.AMPLIENCE_MASTER_LOCALE,
  locales: list(e.AMPLIENCE_LOCALES), repositories: list(e.AMPLIENCE_REPOSITORIES),
});
/** Locale degraded/restored by the demo scripts (default fr-FR). */
export const TARGET = e.DEGRADE_LOCALE ?? "fr-FR";
/** Writes use the separate write token when present (the scan token otherwise, with a warning). */
export const writeClient = (() => {
  if (!e.AMPLIENCE_WRITE_PAT) console.warn("AMPLIENCE_WRITE_PAT not set: writes would use AMPLIENCE_PAT.");
  return new AmplienceClient({ token: e.AMPLIENCE_WRITE_PAT ?? e.AMPLIENCE_PAT });
})();

export const flag = (n: string) => process.argv.includes(`--${n}`);
export const arg = (i: number) => process.argv.slice(2).filter((a) => !a.startsWith("--"))[i];
