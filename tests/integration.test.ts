import { describe, expect, it, vi } from "vitest";
import { AmplienceClient, AmplienceApiError } from "@/lib/adapters/amplience-client";
import { createLiveAdapter } from "@/lib/adapters/live-adapter";
import { applyReviewedProposal } from "@/lib/adapters/live-writer";
import { createDemoAdapter } from "@/lib/adapters/demo-adapter";
import { runScan } from "@/lib/scan/scan";
import { fingerprint } from "@/lib/domain/fingerprint";
import { LOCALIZED_VALUE, localesPresent, normalizeContentType, projectLocale } from "@/lib/domain/normalizer";
import { getLocalizedText, removeLocalizedText, setLocalizedText } from "@/lib/domain/path";
import { evaluateWritePolicy } from "@/lib/security/write-policy";
import { probeModel, requestTranslation, AiError } from "@/lib/ai/provider";
import type { Env } from "@/lib/security/env";
import type { TranslationProposal } from "@/lib/domain/types";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const client = (f: typeof fetch) => new AmplienceClient({ token: "t", fetchImpl: f, baseDelayMs: 1 });

describe("Management API client", () => {
  it("retries 429 then succeeds, and never leaks credentials in errors", async () => {
    const f = vi.fn<typeof fetch>().mockResolvedValueOnce(json({}, 429, { "retry-after": "0" })).mockResolvedValueOnce(json({ ok: 1 }));
    expect(await client(f).get("/x")).toEqual({ ok: 1 });
    expect(f).toHaveBeenCalledTimes(2);
    expect(String(f.mock.calls[0]![0])).toBe("https://api.amplience.net/v2/content/x");
    const bad = vi.fn<typeof fetch>().mockResolvedValue(json({ errors: [{ code: "FORBIDDEN", message: "nope" }] }, 403));
    const err = await client(bad).get("/x").catch((e: AmplienceApiError) => e);
    expect(err).toBeInstanceOf(AmplienceApiError);
    expect((err as AmplienceApiError).kind).toBe("forbidden");
    expect((err as Error).message).toMatch(/FORBIDDEN nope/);
    expect((err as Error).message).not.toMatch(/Bearer|authorization/i);
  });

  it("does not retry writes, and maps 409 to a conflict", async () => {
    const f = vi.fn<typeof fetch>().mockResolvedValue(json({}, 500));
    await expect(client(f).patch("/x", {})).rejects.toBeInstanceOf(AmplienceApiError);
    expect(f).toHaveBeenCalledTimes(1);
    const c = vi.fn<typeof fetch>().mockResolvedValue(json({}, 409));
    await expect(client(c).patch("/x", {})).rejects.toMatchObject({ kind: "conflict" });
  });

  it("follows HAL pages", async () => {
    const f = vi.fn<typeof fetch>(async (u) => {
      const page = Number(new URL(String(u)).searchParams.get("page"));
      return json({ _embedded: { things: [{ n: page }] }, page: { size: 100, totalElements: 3, totalPages: 3, number: page } });
    });
    expect(await client(f).all("/things", "things")).toEqual([{ n: 0 }, { n: 1 }, { n: 2 }]);
  });
});

// ---------- a fake hub ----------

const L = (values: Record<string, string>) => ({ _meta: { schema: LOCALIZED_VALUE }, values: Object.entries(values).map(([locale, value]) => ({ locale, value })) });
const PAGE_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#", $id: "https://content.example.com/page", title: "Page", type: "object",
  allOf: [{ $ref: "http://bigcontent.io/cms/schema/v1/core#/definitions/content" }],
  required: ["title"],
  properties: {
    _meta: { type: "object", properties: { deliveryKey: { type: "string" } } },
    title: { title: "Title", allOf: [{ $ref: LOCALIZED_VALUE }], properties: { values: { items: { properties: { value: { type: "string" } } } } } },
    body: { title: "Body", allOf: [{ $ref: LOCALIZED_VALUE }], properties: { values: { items: { properties: { value: { type: "string", format: "markdown" } } } } } },
    steps: { type: "array", items: { type: "object", properties: { label: { allOf: [{ $ref: LOCALIZED_VALUE }] } } } },
    account: { type: "string" },
    related: { type: "array", items: { allOf: [{ $ref: "http://bigcontent.io/cms/schema/v1/core#/definitions/content-link" }, { properties: { contentType: { enum: ["https://content.example.com/page"] } } }] } },
  },
};

interface FakeItem { id: string; label: string; version: number; status: string; lastPublishedVersion?: number; publishingStatus: string; locale?: string; body: Record<string, unknown> }

function fakeHub(opts: { failVersionsFor?: string; n?: number } = {}) {
  const items: FakeItem[] = Array.from({ length: opts.n ?? 150 }, (_, i) => ({
    id: `e${i}`, label: `Item ${i}`, version: 3, status: "ACTIVE", lastPublishedVersion: i === 0 ? 2 : 3, publishingStatus: i === 0 ? "EARLY" : "LATEST",
    body: {
      _meta: { schema: "https://content.example.com/page", name: `Item ${i}`, deliveryKey: `p/${i}` },
      title: L(i === 0 ? { "en-US": `T${i}`, "fr-FR": "Bonjour" } : { "en-US": `T${i}` }),
      account: "Demo",
    },
  }));
  // A French localization stored as a separate item (item-level localization): ignored.
  items.push({ id: "fr-copy", label: "fr", version: 1, status: "ACTIVE", publishingStatus: "NONE", locale: "fr-FR", body: { _meta: { schema: "https://content.example.com/page", name: "fr" }, title: L({ "fr-FR": "x" }) } });
  const writes: { path: string; body: unknown }[] = [];
  const f = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    const p = url.pathname.replace("/v2/content", "");
    const page = Number(url.searchParams.get("page") ?? 0);
    const size = Number(url.searchParams.get("size") ?? 20);
    const hal = (key: string, all: unknown[]) => json({ _embedded: { [key]: all.slice(page * size, page * size + size) }, page: { size, totalElements: all.length, totalPages: Math.max(1, Math.ceil(all.length / size)), number: page } });
    if (p === "/hubs/hub1") return json({ id: "hub1", name: "demohub", settings: { localization: { locales: ["en-US", "fr-FR"] } } });
    if (p === "/hubs/hub1/content-repositories") return hal("content-repositories", [
      { id: "r1", name: "content", status: "ACTIVE", itemLocales: ["en-US"], contentTypes: [{ hubContentTypeId: "t1", contentTypeUri: "https://content.example.com/page" }] },
      { id: "r2", name: "contentfr", status: "ACTIVE", itemLocales: ["fr-FR"], contentTypes: [{ hubContentTypeId: "t1", contentTypeUri: "https://content.example.com/page" }] },
    ]);
    if (p === "/hubs/hub1/content-type-schemas") return hal("content-type-schemas", [{ id: "s1", schemaId: "https://content.example.com/page", body: JSON.stringify(PAGE_SCHEMA), status: "ACTIVE" }]);
    if (p === "/hubs/hub1/content-types") return hal("content-types", [{ id: "t1", contentTypeUri: "https://content.example.com/page", status: "ACTIVE", settings: { label: "Page" } }]);
    if (p === "/content-repositories/r1/content-items") return hal("content-items", items);
    if (p === "/content-repositories/r2/content-items") return hal("content-items", []);
    const ver = /^\/content-items\/([^/]+)\/versions\/(\d+)$/.exec(p);
    if (ver) {
      if (ver[1] === opts.failVersionsFor) return json({ errors: [{ message: "boom" }] }, 400);
      const it = items.find((x) => x.id === ver[1])!;
      // The published version (v2) of e0 predates its French values.
      return json({ ...it, version: Number(ver[2]), body: { ...it.body, title: L({ "en-US": "T0" }) } });
    }
    const one = /^\/content-items\/([^/]+)$/.exec(p);
    if (one && init?.method === "PATCH") { writes.push({ path: p, body: JSON.parse(String(init.body)) }); return json({}); }
    if (one) return json(items.find((x) => x.id === one[1]) ?? {}, items.some((x) => x.id === one[1]) ? 200 : 404);
    return json({}, 404);
  });
  return Object.assign(f, { items, writes });
}

describe("scan against a mocked Management API", () => {
  const adapterFor = (f: typeof fetch) => createLiveAdapter({ client: client(f), hubId: "hub1" });
  const base = { baselines: new Map(), maxItemsPerType: 1000, concurrency: 4, criticalLocales: [], provenance: "LIVE · Amplience" };

  it("lists items once, keeps master-locale items, and detects locales from localized values", async () => {
    const snap = await runScan(adapterFor(fakeHub()), base);
    expect(snap.hub).toBe("demohub");
    expect(snap.repositories).toEqual(["content"]);
    expect(snap.contentTypes).toEqual([{ uid: "page", title: "Page", items: 150 }]);
    expect(snap.sourceItemCount).toBe(150);
    expect(snap.status).toBe("complete");
    expect(snap.itemLocales.filter((e) => e.existence === "exists")).toHaveLength(1);
    expect(snap.itemLocales.filter((e) => e.existence === "not_localized")).toHaveLength(149);
    expect(snap.units.find((u) => u.pointer.itemId === "e0" && u.pointer.fieldPath === "title")).toMatchObject({ targetText: "Bonjour", completeness: "complete" });
  });

  it("checks publication against the last published version (PUB-001 data)", async () => {
    const snap = await runScan(adapterFor(fakeHub()), base);
    const e0 = snap.itemLocales.find((e) => e.itemId === "e0")!;
    expect(e0).toMatchObject({ sourcePublished: "published", publication: "unpublished" });
  });

  it("discloses partial failures instead of counting them complete", async () => {
    const snap = await runScan(adapterFor(fakeHub({ failVersionsFor: "e0" })), base);
    expect(snap.itemLocales.find((e) => e.itemId === "e0")?.publication).toBe("unknown");
  });

  it("applies and discloses the per-type item limit", async () => {
    const snap = await runScan(adapterFor(fakeHub()), { ...base, maxItemsPerType: 120 });
    expect(snap.sourceItemCount).toBe(120);
    expect(snap.limits.join()).toMatch(/120/);
  });

  it("rejects locales the hub does not have", async () => {
    const adapter = createLiveAdapter({ client: client(fakeHub()), hubId: "hub1", locales: ["en-US", "de-DE"] });
    await expect(runScan(adapter, base)).rejects.toThrow(/de-DE/);
  });

  it("can be cancelled", async () => {
    const c = new AbortController();
    c.abort();
    await expect(runScan(adapterFor(fakeHub()), { ...base, signal: c.signal })).rejects.toThrow(/cancel/i);
  });

  it("demo fixtures satisfy the acceptance size: ≥5 locales, ≥4 types, ≥50 items", async () => {
    const snap = await runScan(createDemoAdapter(), base);
    expect(snap.locales.length).toBeGreaterThanOrEqual(5);
    expect(snap.contentTypes.length).toBeGreaterThanOrEqual(4);
    expect(snap.sourceItemCount).toBeGreaterThanOrEqual(50);
    expect(snap.units.some((u) => u.pointer.locale === "it-IT" && u.completeness === "missing")).toBe(true);
  });
});

describe("schema normalization and locale projection", () => {
  const ct = normalizeContentType({ schemaId: "https://content.example.com/page", body: JSON.stringify(PAGE_SCHEMA), label: "Page" });
  it("maps localized values, markdown, objects, links and the delivery key", () => {
    const by = Object.fromEntries(ct.schema.map((f) => [f.uid, f]));
    expect(ct.uid).toBe("page");
    expect(by.deliveryKey).toMatchObject({ dataType: "text", localized: false });
    expect(by.title).toMatchObject({ dataType: "text", localized: true, mandatory: true });
    expect(by.body).toMatchObject({ dataType: "markdown", localized: true });
    expect(by.steps).toMatchObject({ dataType: "object", multiple: true });
    expect(by.steps!.schema![0]).toMatchObject({ uid: "label", dataType: "text", localized: true });
    expect(by.account).toMatchObject({ dataType: "text", localized: false });
    expect(by.related).toMatchObject({ dataType: "reference", multiple: true, referenceTo: ["page"] });
  });
  it("projects a locale without fallback and lists the locales present", () => {
    const body = { _meta: { schema: "x", deliveryKey: "a/b" }, title: L({ "en-US": "Hi", "fr-FR": "Salut" }), body: L({ "en-US": "# H" }), steps: [{ label: L({ "en-US": "One" }) }] };
    expect(projectLocale(body, "fr-FR")).toEqual({ title: "Salut", body: undefined, steps: [{ label: undefined }], deliveryKey: "a/b" });
    expect(projectLocale(body, "en-US")).toMatchObject({ title: "Hi", body: "# H", steps: [{ label: "One" }] });
    expect([...localesPresent(body)].sort()).toEqual(["en-US", "fr-FR"]);
    expect([...localesPresent({ title: L({ "fr-FR": "  " }) })]).toEqual([]);
  });
});

describe("localized value paths", () => {
  it("sets, reads and removes one locale's value, creating the localized value when absent", () => {
    const body: Record<string, unknown> = { title: L({ "en-US": "Hi" }), steps: [{ label: L({ "en-US": "One" }) }, { label: L({ "en-US": "Two", "fr-FR": "Deux" }) }], cta: {} };
    expect(setLocalizedText(body, "title", "fr-FR", "Salut")).toBe(true);
    expect(getLocalizedText(body, "title", "fr-FR")).toBe("Salut");
    expect(getLocalizedText(body, "title", "en-US")).toBe("Hi");
    expect(setLocalizedText(body, "steps[1].label", "fr-FR", "DEUX")).toBe(true);
    expect(getLocalizedText(body, "steps[1].label", "fr-FR")).toBe("DEUX");
    expect(getLocalizedText(body, "steps[0].label", "fr-FR")).toBeUndefined();
    expect(setLocalizedText(body, "cta.label", "fr-FR", "Go")).toBe(true);
    expect(body.cta).toEqual({ label: { _meta: { schema: LOCALIZED_VALUE }, values: [{ locale: "fr-FR", value: "Go" }] } });
    expect(setLocalizedText(body, "steps[5].label", "fr-FR", "x")).toBe(false);
    expect(removeLocalizedText(body, "title", "fr-FR")).toBe("Salut");
    expect(getLocalizedText(body, "title", "fr-FR")).toBeUndefined();
  });
  it("never writes a field that is not localized", () => {
    const body: Record<string, unknown> = { account: "Demo" };
    expect(setLocalizedText(body, "account", "fr-FR", "x")).toBe(false);
    expect(body.account).toBe("Demo");
  });
});

describe("write policy and guarded writer", () => {
  const env = { ENABLE_CMS_WRITES: false, AMPLIENCE_WRITE_PAT: undefined, CMS_WRITE_ALLOWED_ITEM_IDS: undefined };
  it("is disabled by default and never allowed in demo", () => {
    expect(evaluateWritePolicy(env, "live", { itemId: "e1" }, true).allowed).toBe(false);
    expect(evaluateWritePolicy({ ...env, ENABLE_CMS_WRITES: true, AMPLIENCE_WRITE_PAT: "w", CMS_WRITE_ALLOWED_ITEM_IDS: "e1" }, "demo", { itemId: "e1" }, true).allowed).toBe(false);
  });
  it("requires an allowlisted item and explicit confirmation", () => {
    const on = { ...env, ENABLE_CMS_WRITES: true, AMPLIENCE_WRITE_PAT: "w", CMS_WRITE_ALLOWED_ITEM_IDS: "e1" };
    expect(evaluateWritePolicy(on, "live", { itemId: "e2" }, true).allowed).toBe(false);
    expect(evaluateWritePolicy(on, "live", { itemId: "e1" }, false).allowed).toBe(false);
    expect(evaluateWritePolicy(on, "live", { itemId: "e1" }, true).allowed).toBe(true);
  });

  const proposal = (over: Partial<TranslationProposal> = {}): TranslationProposal => ({
    id: "p", issueId: "d", unitKey: "k", status: "approved", provenance: "openai",
    pointer: { hubId: "hub1", contentTypeUid: "page", itemId: "e1", locale: "fr-FR", fieldPath: "title" },
    sourceText: "T1", suggestedText: "Nouveau", model: "m", promptVersion: "v", sourceFingerprint: fingerprint("T1"),
    cmsVersionAtProposal: 3, glossaryWarnings: [], placeholderWarnings: [], notes: [], updatedAt: "", ...over,
  });
  const wenv = { ENABLE_CMS_WRITES: true, AMPLIENCE_WRITE_PAT: "w", CMS_WRITE_ALLOWED_ITEM_IDS: "e1" };
  const deps = (hub: ReturnType<typeof fakeHub>, writeFetch: typeof fetch = hub) => ({ env: wenv, mode: "live" as const, hubId: "hub1", masterLocale: "en-US", readClient: client(hub), writeClient: client(writeFetch) });

  it("refuses with a conflict when the item version moved, and does not save", async () => {
    const hub = fakeHub({ n: 3 });
    const r = await applyReviewedProposal(deps(hub), proposal({ cmsVersionAtProposal: 2 }), true);
    expect(r).toMatchObject({ ok: false, code: "conflict" });
    expect(hub.writes).toHaveLength(0);
  });

  it("refuses when the source changed since the proposal", async () => {
    const hub = fakeHub({ n: 3 });
    const r = await applyReviewedProposal(deps(hub), proposal({ sourceFingerprint: "stale" }), true);
    expect(r).toMatchObject({ ok: false, code: "conflict" });
    expect(hub.writes).toHaveLength(0);
  });

  it("saves only the target locale's value, with the version as an optimistic lock", async () => {
    const hub = fakeHub({ n: 3 });
    await applyReviewedProposal(deps(hub), proposal(), true);
    expect(hub.writes).toHaveLength(1);
    const sent = hub.writes[0]!.body as { version: number; body: { title: { values: { locale: string; value: string }[] }; account: string } };
    expect(sent.version).toBe(3);
    expect(sent.body.title.values).toEqual([{ locale: "en-US", value: "T1" }, { locale: "fr-FR", value: "Nouveau" }]);
    expect(sent.body.account).toBe("Demo");
  });

  it("fails when read-back does not match (the mock keeps the old body)", async () => {
    const hub = fakeHub({ n: 3 });
    const r = await applyReviewedProposal(deps(hub), proposal(), true);
    expect(r).toMatchObject({ ok: false, code: "failed" });
    expect((r as { message: string }).message).toMatch(/read-back/);
  });

  it("reports Amplience's own version conflict (409) as a conflict", async () => {
    const hub = fakeHub({ n: 3 });
    const conflict = vi.fn<typeof fetch>(async () => json({ errors: [{ code: "CONTENT_ITEM_VERSION_CONFLICT" }] }, 409));
    const r = await applyReviewedProposal(deps(hub, conflict), proposal(), true);
    expect(r).toMatchObject({ ok: false, code: "conflict" });
  });
});

describe("OpenAI provider (mocked)", () => {
  const env = { OPENAI_API_KEY: "sk", OPENAI_MODEL: "m1", OPENAI_REASONING_EFFORT: "low" } as unknown as Env;
  const req = { sourceLocale: "en-US", targetLocale: "fr-FR", contentType: "Page", fieldLabel: "Title", sourceText: "Hello {{name}}" };
  const out = { translatedText: "Bonjour {{name}}", glossaryWarnings: [], placeholderWarnings: [], notes: [], confidenceLabel: "high" };

  it("fails closed when the model is unavailable, without calling /responses", async () => {
    const f = vi.fn<typeof fetch>(async (u) => (String(u).includes("/models/") ? json({}, 404) : json({ data: [{ id: "gpt-x" }] })));
    await expect(requestTranslation({ ...env, OPENAI_MODEL: "nope" } as Env, req, f)).rejects.toMatchObject({ code: "model_unavailable" });
    expect(f.mock.calls.some(([u]) => String(u).endsWith("/responses"))).toBe(false);
  });

  it("parses structured output and reports usage", async () => {
    const f = vi.fn<typeof fetch>(async (u) => (String(u).includes("/models/") ? json({ id: "m2" }) : json({ output_text: JSON.stringify(out), usage: { input_tokens: 40, output_tokens: 9 } })));
    const r = await requestTranslation({ ...env, OPENAI_MODEL: "m2" } as Env, req, f);
    expect(r).toMatchObject({ model: "m2", inputTokens: 40, outputTokens: 9 });
    const body = JSON.parse(String((f.mock.calls.at(-1)?.[1] as RequestInit).body));
    expect(body.reasoning).toEqual({ effort: "low" });
    expect(body.store).toBe(false);
  });

  it("sends the env effort and reports it with reasoning tokens", async () => {
    const f = vi.fn<typeof fetch>(async (u) => (String(u).includes("/models/") ? json({}) : json({ output_text: JSON.stringify(out), usage: { input_tokens: 5, output_tokens: 50, output_tokens_details: { reasoning_tokens: 30 } } })));
    const r = await requestTranslation({ ...env, OPENAI_MODEL: "m5", OPENAI_REASONING_EFFORT: "high" } as Env, req, f);
    expect(JSON.parse(String((f.mock.calls.at(-1)?.[1] as RequestInit).body)).reasoning).toEqual({ effort: "high" });
    expect(r).toMatchObject({ reasoningEffort: "high", reasoningTokens: 30 });
    const none = vi.fn<typeof fetch>(async (u) => (String(u).includes("/models/") ? json({}) : json({ output_text: JSON.stringify(out) })));
    await requestTranslation({ ...env, OPENAI_MODEL: "m6", OPENAI_REASONING_EFFORT: undefined } as Env, req, none);
    expect(JSON.parse(String((none.mock.calls.at(-1)?.[1] as RequestInit).body)).reasoning).toBeUndefined();
  });

  it("rejects schema-invalid output and unsupported reasoning params without silent fallback", async () => {
    const bad = vi.fn<typeof fetch>(async (u) => (String(u).includes("/models/") ? json({}) : json({ output_text: JSON.stringify({ translatedText: 1 }) })));
    await expect(requestTranslation({ ...env, OPENAI_MODEL: "m3" } as Env, req, bad)).rejects.toMatchObject({ code: "invalid_output" });
    const unsupported = vi.fn<typeof fetch>(async (u) => (String(u).includes("/models/") ? json({}) : json({ error: { message: "Unsupported parameter: reasoning.effort" } }, 400)));
    const e = await requestTranslation({ ...env, OPENAI_MODEL: "m4" } as Env, req, unsupported).catch((x: AiError) => x);
    expect(e).toMatchObject({ code: "unsupported_parameter" });
  });

  it("probe reports a missing key without any network call", async () => {
    const f = vi.fn<typeof fetch>();
    expect((await probeModel({ ...env, OPENAI_API_KEY: undefined } as Env, f)).ok).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });
});


describe("environment parsing", () => {
  it("unwraps values that kept their .env quotes", async () => {
    vi.resetModules();
    vi.stubEnv("DATA_MODE", '"live"');
    vi.stubEnv("OPENAI_REASONING_EFFORT", '"low"');
    vi.stubEnv("OPENAI_PRICE_INPUT_PER_MTOK", '"0.10"');
    vi.stubEnv("ENABLE_CMS_WRITES", '"false"');
    const { getEnv } = await import("@/lib/security/env");
    expect(getEnv()).toMatchObject({ DATA_MODE: "live", OPENAI_REASONING_EFFORT: "low", OPENAI_PRICE_INPUT_PER_MTOK: 0.1, ENABLE_CMS_WRITES: false });
    vi.unstubAllEnvs();
  });
});
