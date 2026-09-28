/**
 * Script coverage analysis.
 *
 * The identifier catalogue and both NER models are Latin-script; the name
 * patterns in `identifiers.ts` are built on `\p{Lu}` and cannot fire on a
 * unicameral script at all. A Sinhala or Tamil record therefore produces zero
 * spans — indistinguishable, downstream, from a genuinely clean document.
 *
 * That silence is the dangerous case: `assessCompliance` would report SAFE for
 * a fully identifiable record, and stage 5 VALIDATE cannot catch it because it
 * re-runs the same blind detector.
 *
 * This module measures how much of a document sits in scripts the engine
 * cannot read, so the compliance layer can refuse to certify it.
 */

export type ScriptSeverity =
  /** Dominant unreadable script — the engine cannot assess the document. */
  | 'UNREADABLE'
  /** Latin-dominant, but a meaningful unreadable passage is present. */
  | 'PARTIAL';

export interface ScriptWarning {
  severity: ScriptSeverity;
  /** Human-readable script names found, most frequent first. e.g. ['Tamil']. */
  scripts: string[];
  /** Letters in scripts the engine cannot read. */
  unreadableLetters: number;
  /** Total letters considered. */
  totalLetters: number;
  /** unreadableLetters / totalLetters, 0..1. */
  unreadableRatio: number;
  message: string;
}

/**
 * Scripts we can name in a user-facing message. Any letter that is neither
 * Latin nor one of these still counts as unreadable — the list only improves
 * the wording, it does not limit detection.
 */
const NAMED_SCRIPTS: Array<[string, RegExp]> = [
  ['Sinhala', /\p{Script=Sinhala}/gu],
  ['Tamil', /\p{Script=Tamil}/gu],
  ['Devanagari', /\p{Script=Devanagari}/gu],
  ['Bengali', /\p{Script=Bengali}/gu],
  ['Arabic', /\p{Script=Arabic}/gu],
  ['Hebrew', /\p{Script=Hebrew}/gu],
  ['Thai', /\p{Script=Thai}/gu],
  ['Han', /\p{Script=Han}/gu],
  ['Hiragana', /\p{Script=Hiragana}/gu],
  ['Katakana', /\p{Script=Katakana}/gu],
  ['Hangul', /\p{Script=Hangul}/gu],
  ['Cyrillic', /\p{Script=Cyrillic}/gu],
  ['Greek', /\p{Script=Greek}/gu],
];

/**
 * At or above this share of unreadable letters the document is treated as
 * fundamentally unassessable rather than merely suspect.
 */
const UNREADABLE_RATIO = 0.15;

/**
 * Below UNREADABLE_RATIO, this many unreadable letters is still enough to
 * block a SAFE verdict — roughly a name and an identifier embedded in an
 * otherwise English document.
 */
const PARTIAL_LETTER_FLOOR = 20;

function countMatches(text: string, re: RegExp): number {
  re.lastIndex = 0;
  let n = 0;
  while (re.exec(text) !== null) n++;
  return n;
}

/**
 * Returns null when the document is Latin-script enough for the engine to
 * assess normally.
 */
export function assessScriptCoverage(text: string): ScriptWarning | null {
  const totalLetters = countMatches(text, /\p{L}/gu);
  if (totalLetters === 0) return null;

  const latinLetters = countMatches(text, /\p{Script=Latin}/gu);
  const unreadableLetters = totalLetters - latinLetters;
  if (unreadableLetters <= 0) return null;

  const unreadableRatio = unreadableLetters / totalLetters;
  const dominant = unreadableRatio >= UNREADABLE_RATIO;
  if (!dominant && unreadableLetters < PARTIAL_LETTER_FLOOR) return null;

  const scripts = NAMED_SCRIPTS.map(
    ([name, re]) => [name, countMatches(text, re)] as const
  )
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name);

  const severity: ScriptSeverity = dominant ? 'UNREADABLE' : 'PARTIAL';
  return {
    severity,
    scripts,
    unreadableLetters,
    totalLetters,
    unreadableRatio,
    message: buildMessage(severity, scripts),
  };
}

function buildMessage(severity: ScriptSeverity, scripts: string[]): string {
  const named =
    scripts.length === 0
      ? 'a script'
      : scripts.length === 1
        ? scripts[0]
        : `${scripts.slice(0, -1).join(', ')} and ${scripts[scripts.length - 1]}`;

  if (severity === 'UNREADABLE') {
    return (
      `This document is largely written in ${named}. PrivacyScript's identifier ` +
      `rules and name models only read Latin script, so it cannot tell whether ` +
      `personal data is present. Treat this document as unscreened and review it ` +
      `manually. Automated de-identification will not reliably remove identifiers ` +
      `from it.`
    );
  }
  return (
    `Part of this document is written in ${named}, which PrivacyScript cannot ` +
    `read. Identifiers inside that text will not have been detected. Review ` +
    `those passages manually before sharing.`
  );
}
