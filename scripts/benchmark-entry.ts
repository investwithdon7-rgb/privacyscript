/**
 * Bundled entry for scripts/benchmark.mjs: runs the app's rule engine on one
 * document and scores it against gold identifier spans.
 */
import { detect } from '@/engine/detect';

export type GoldClass = 'direct' | 'quasi' | 'clinical' | 'ignore';

export interface Gold {
  start: number;
  end: number;
  label: string;
  cls: GoldClass;
}

export interface DocScore {
  gold: Array<Gold & { status: 'hidden' | 'partial' | 'missed'; text: string }>;
  /** Detected spans that touch no gold identifier at all. */
  extra: Array<{ label: string; text: string }>;
  /** Detected spans that cover gold clinical content (diagnosis, drug…). */
  clinicalHit: Array<{ label: string; text: string; goldLabel: string }>;
  /** Possible names offered for review (not hidden). */
  offered: number;
  ms: number;
}

const ALNUM = /[\p{L}\p{N}]/u;

export function scoreDoc(text: string, gold: Gold[]): DocScore {
  const t0 = performance.now();
  const det = detect(text, []);
  const ms = performance.now() - t0;
  const found = [...det.spans, ...det.quasiSpans];
  const covered = new Uint8Array(text.length);
  for (const s of found) covered.fill(1, Math.max(0, s.start), Math.min(text.length, s.end));

  const scored = gold.map((g) => {
    let need = 0;
    let got = 0;
    for (let i = g.start; i < g.end; i++) {
      if (!ALNUM.test(text[i])) continue;
      need++;
      if (covered[i]) got++;
    }
    const status: 'hidden' | 'partial' | 'missed' =
      need === 0 || got === need ? 'hidden' : got > 0 ? 'partial' : 'missed';
    return { ...g, status, text: text.slice(g.start, g.end) };
  });

  const ids = gold.filter((g) => g.cls === 'direct' || g.cls === 'quasi');
  const clinical = gold.filter((g) => g.cls === 'clinical');
  const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) =>
    a.start < b.end && b.start < a.end;
  const extra: DocScore['extra'] = [];
  const clinicalHit: DocScore['clinicalHit'] = [];
  for (const s of found) {
    if (ids.some((g) => overlaps(s, g)) || gold.some((g) => g.cls === 'ignore' && overlaps(s, g))) continue;
    const c = clinical.find((g) => overlaps(s, g));
    if (c) clinicalHit.push({ label: s.label, text: text.slice(s.start, s.end), goldLabel: c.label });
    else extra.push({ label: s.label, text: text.slice(s.start, s.end) });
  }
  return { gold: scored, extra, clinicalHit, offered: det.uncertainSpans?.length ?? 0, ms };
}
