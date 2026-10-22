// Markdown helpers. Amplience stores rich text as markdown strings (`format: "markdown"`), so a
// translation is the whole string with its markup kept; these helpers only measure structure.

export interface MarkdownBlock {
  kind: "paragraph" | "heading" | "list" | "code" | "quote" | "image";
  /** Heading level 1–6. */
  level?: number;
  /** Plain text of the block (markup stripped). */
  text: string;
}

/** Inline markup to plain text: links keep their label, images and emphasis markers are dropped. */
export function inlineToPlain(s: string): string {
  return s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/(\*\*|__|\*|_|`|~~)/g, "")
    .trim();
}

/** Split markdown into top-level blocks (blank-line separated, headings and list runs recognised). */
export function markdownBlocks(md: string): MarkdownBlock[] {
  const out: MarkdownBlock[] = [];
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  let para: string[] = [];
  let list: string[] = [];
  let code: string[] | null = null;
  const flushPara = () => {
    if (para.length) {
      const joined = para.join(" ");
      const onlyImage = /^!\[[^\]]*\]\([^)]*\)$/.test(joined.trim());
      out.push({ kind: onlyImage ? "image" : joined.trim().startsWith(">") ? "quote" : "paragraph", text: inlineToPlain(joined.replace(/^>\s?/, "")) });
    }
    para = [];
  };
  const flushList = () => {
    if (list.length) out.push({ kind: "list", text: list.map(inlineToPlain).join("\n") });
    list = [];
  };
  for (const line of lines) {
    if (code) {
      if (/^```/.test(line.trim())) { out.push({ kind: "code", text: code.join("\n") }); code = null; } else code.push(line);
      continue;
    }
    if (/^```/.test(line.trim())) { flushPara(); flushList(); code = []; continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(line.trim());
    if (h) { flushPara(); flushList(); out.push({ kind: "heading", level: h[1]!.length, text: inlineToPlain(h[2]!) }); continue; }
    const li = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) { flushPara(); list.push(li[1]!); continue; }
    if (!line.trim()) { flushPara(); flushList(); continue; }
    if (list.length && /^\s+/.test(line)) { list[list.length - 1] += ` ${line.trim()}`; continue; }
    flushList();
    para.push(line.trim());
  }
  if (code) out.push({ kind: "code", text: code.join("\n") });
  flushPara();
  flushList();
  return out;
}

/** Number of top-level blocks (used to spot a translation that dropped paragraphs). */
export function markdownBlockCount(md: string): number {
  return markdownBlocks(md).length;
}

/** Anchor texts of every link (`[label](url)`), images excluded. */
export function markdownLinks(md: string): string[] {
  return [...md.matchAll(/(?<!!)\[([^\]]*)\]\(([^)]*)\)/g)].map((m) => inlineToPlain(m[1] ?? ""));
}

/** Plain text, one line per block. */
export function markdownToPlain(md: string): string {
  return markdownBlocks(md).map((b) => b.text).filter((t) => t.trim()).join("\n");
}
