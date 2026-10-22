"use client";

import { Loader2, Plug, Sparkles } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Note } from "@/components/ui/card";
import { api } from "@/lib/utils/api";

interface Diagnose {
  state: "connected" | "forbidden" | "wrong_hub_or_token" | "network_error" | "no_content_types" | "not_configured";
  message: string;
  hub?: string;
  repositories?: string[];
  contentTypes?: number;
  latencyMs?: number;
  locales?: { code: string; master: boolean }[] | null;
  hint?: string;
}
interface Probe { ok: boolean; model: string; message: string; checkedAt: string }

const LABEL: Record<Diagnose["state"], string> = {
  connected: "Connected", forbidden: "Forbidden", wrong_hub_or_token: "Wrong hub or token", network_error: "Network error",
  no_content_types: "No content types", not_configured: "Not configured",
};

export function DiagnosePanel() {
  const [d, setD] = useState<Diagnose | null>(null);
  const [probe, setProbe] = useState<Probe | null>(null);
  const [busy, setBusy] = useState<"amp" | "ai" | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const run = async <T,>(which: "amp" | "ai", url: string, set: (v: T) => void) => {
    setBusy(which);
    setErr(null);
    try {
      set(await api<T>(url, "POST"));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={!!busy} onClick={() => run<Diagnose>("amp", "/api/diagnose", setD)}>
          {busy === "amp" ? <Loader2 size={14} className="animate-spin" /> : <Plug size={14} />} Connect &amp; diagnose Amplience
        </Button>
        <Button disabled={!!busy} onClick={() => run<Probe>("ai", "/api/ai/probe", setProbe)}>
          {busy === "ai" ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} Check OpenAI model access
        </Button>
      </div>
      {err && <div role="alert"><Note tone="danger">{err}</Note></div>}
      {d && (
        <div role="status" className="space-y-2 rounded-lg border border-line p-4 text-xs">
          <div className="flex items-center gap-2"><Badge tone={d.state === "connected" ? "live" : d.state === "no_content_types" ? "high" : "critical"}>{LABEL[d.state]}</Badge><span>{d.message}</span></div>
          {d.state === "connected" && <p className="text-muted">Hub {d.hub} · repositories {d.repositories?.join(", ")} · {d.contentTypes} content type(s) · {d.latencyMs} ms · read-only calls</p>}
          {d.locales && <p className="text-muted">Locales: {d.locales.map((l) => `${l.code}${l.master ? " (master)" : ""}`).join(", ")}</p>}
          {d.hint && <Note tone="warn">{d.hint}</Note>}
        </div>
      )}
      {probe && (
        <div role="status" className="rounded-lg border border-line p-4 text-xs">
          <div className="flex items-center gap-2"><Badge tone={probe.ok ? "live" : "critical"}>{probe.ok ? "Model accessible" : "Model unavailable"}</Badge><span>{probe.message}</span></div>
          <p className="mt-1 text-muted">Checked {new Date(probe.checkedAt).toLocaleTimeString()}. This check sends no CMS content.</p>
        </div>
      )}
    </div>
  );
}
