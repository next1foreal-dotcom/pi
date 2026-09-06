/** Human-facing embed status. Pure: no DOM, no fetch. */

export type EmbedProbeData = {
  reachable: boolean;
  xFrameOptions?: string | null;
  csp?: string | null;
};

export type EmbedStatus = {
  ok: boolean;
  /** Chinese, always includes the address when not ok. Null when the page can be shown. */
  text: string | null;
};

export function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Tokens of a CSP `frame-ancestors` directive, or null if the header has none. */
export function frameAncestors(csp: string | null | undefined): string[] | null {
  if (!csp) return null;
  for (const part of csp.split(";")) {
    const trimmed = part.trim();
    const match = /^frame-ancestors\s+(.+)$/i.exec(trimmed);
    if (match?.[1]) return match[1].split(/\s+/).filter(Boolean);
  }
  return null;
}

export function xfoBlocks(
  xfo: string,
  targetUrl: string,
  embedderOrigin: string,
): boolean {
  const v = xfo.trim();
  const upper = v.toUpperCase();
  if (upper === "DENY") return true;
  if (upper === "SAMEORIGIN") return originOf(targetUrl) !== embedderOrigin;
  if (upper.startsWith("ALLOW-FROM")) {
    const from = v.slice("ALLOW-FROM".length).trim();
    return from.replace(/\/$/, "") !== embedderOrigin;
  }
  return false;
}

export function ancestorsAllow(
  tokens: string[],
  targetUrl: string,
  embedderOrigin: string,
): boolean {
  if (tokens.length === 0) return false;
  const lower = tokens.map((t) => t.toLowerCase());
  if (lower.includes("'none'") || lower.includes("none")) return false;
  if (tokens.includes("*")) return true;
  for (const raw of tokens) {
    const t = raw.toLowerCase();
    if (t === "'self'" || t === "self") {
      if (originOf(targetUrl) === embedderOrigin) return true;
      continue;
    }
    if (t === embedderOrigin.toLowerCase()) return true;
    try {
      const asUrl = raw.includes("://") ? new URL(raw) : null;
      if (asUrl && asUrl.origin === embedderOrigin) return true;
    } catch {
      // not a URL
    }
  }
  return false;
}

/**
 * Why this URL cannot be shown inside the lab. `embedderOrigin` is the lab
 * page (e.g. http://localhost:5180), not the previewed app.
 *
 * CSP `frame-ancestors`, when present, is the governing header (it overrides
 * X-Frame-Options). X-Frame-Options is still listed when it would also deny,
 * because that is what an operator needs to go and change.
 */
export function formatEmbedStatus(
  url: string,
  probe: EmbedProbeData,
  embedderOrigin: string,
): EmbedStatus {
  if (!probe.reachable) {
    return { ok: false, text: `这个地址没人应答\n${url}` };
  }
  const reasons: string[] = [];
  const ancestors = frameAncestors(probe.csp);
  const xfo = probe.xFrameOptions?.trim() || "";
  const xfoDenies = xfo.length > 0 && xfoBlocks(xfo, url, embedderOrigin);
  if (ancestors) {
    if (!ancestorsAllow(ancestors, url, embedderOrigin)) {
      reasons.push(
        `Content-Security-Policy: frame-ancestors ${ancestors.join(" ")}`,
      );
      if (xfoDenies) reasons.push(`X-Frame-Options: ${xfo}`);
    }
  } else if (xfoDenies) {
    reasons.push(`X-Frame-Options: ${xfo}`);
  }
  if (reasons.length === 0) return { ok: true, text: null };
  return {
    ok: false,
    text: `这个页面拒绝被嵌入（${reasons.join("；")}）\n${url}`,
  };
}
