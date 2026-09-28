/**
 * Interview / focus-group transcript support.
 *
 * Transcripts differ from clinical notes in four ways this module handles:
 *
 *  1. STRUCTURE  — speaker labels and timestamps (WebVTT, SRT, Teams, Otter,
 *                  Zoom, "Name: …" lines). Timestamps are not identifiers and
 *                  must be kept out of detection; speaker labels that are
 *                  real names must be replaced everywhere, consistently.
 *  2. SPEECH     — identifiers are said, not written: "oh seven seven double
 *                  oh…", "the fifth of March", "I'm ninety-three".
 *  3. READABILITY — qualitative analysis needs "[Person 2]" and "[Participant
 *                  1]", not "[NAME-3F7A91B2]". Numbering is consistent within
 *                  the file.
 *  4. CONTEXT    — "I'm the only Somali nurse on the ward" identifies without
 *                  a single name or number in it. No model catches this
 *                  reliably, so such sentences are FLAGGED for a person to
 *                  decide — never silently passed as anonymous.
 *
 * Everything here produces ordinary spans / a replacement labeller, so the
 * existing pipeline (replace, validate, DOCX in-place rebuild) is reused.
 */

import { detect, type DetectionResult, type Span } from '@/engine/detect';
import type { IdentifierLabel } from '@/lib/identifiers';

// ─── Types ──────────────────────────────────────────────────────────────────

export type TranscriptKind = 'VTT' | 'SRT' | 'CHAT' | 'TIMESTAMPED' | 'LABELLED';

export type SpeakerRole = 'INTERVIEWER' | 'PARTICIPANT';

export interface Speaker {
  /** Label exactly as written in the transcript. */
  label: string;
  turns: number;
  questions: number;
  /** True when the label looks like a real name (needs replacing). */
  isName: boolean;
  role: SpeakerRole;
  /** What the label becomes in the output, e.g. "Participant 1". */
  display: string;
}

export interface TranscriptInfo {
  kind: TranscriptKind;
  kindLabel: string;
  speakers: Speaker[];
  turnCount: number;
  /** Speaker-label positions: [start, end, speaker label]. */
  labelSpans: Array<{ start: number; end: number; speaker: string }>;
  /** Timestamps, cue numbers and cue IDs — excluded from detection. */
  structuralSpans: Array<{ start: number; end: number }>;
  /** Main language, from common-word counts. Detection is tuned for 'en'. */
  language: TranscriptLanguage;
}

export type TranscriptLanguage = 'en' | 'es' | 'other';

const EN_WORDS = new Set(['the', 'and', 'to', 'of', 'is', 'that', 'it', 'you', 'in', 'for', 'with', 'but', 'so', 'this', 'was', 'have', 'we', 'they', 'what', 'yeah']);
const ES_WORDS = new Set(['de', 'que', 'la', 'el', 'y', 'en', 'los', 'se', 'no', 'por', 'con', 'para', 'una', 'es', 'lo', 'pero', 'muy', 'más', 'las', 'también']);

/** Rough main-language guess from very common words (no network, no model). */
export function detectLanguage(text: string): TranscriptLanguage {
  let en = 0;
  let es = 0;
  let total = 0;
  for (const w of text.toLowerCase().match(/[a-záéíóúñü]+/g) ?? []) {
    total++;
    if (EN_WORDS.has(w)) en++;
    if (ES_WORDS.has(w)) es++;
  }
  if (total < 20) return 'en';
  if (es > en * 1.5 && es / total > 0.08) return 'es';
  if (en / total > 0.06) return 'en';
  return es / total > 0.06 ? 'es' : 'other';
}

export interface ContextFlag {
  id: number;
  start: number;
  end: number;
  /** The sentence, for display. */
  text: string;
  reason: string;
}

export interface TranscriptState {
  info: TranscriptInfo;
  /** Replace names/places with "[Person 1]"-style labels instead of codes. */
  readable: boolean;
  flags: ContextFlag[];
  /** flag id → decision. Missing = undecided. */
  flagDecisions: Record<number, 'keep' | 'remove'>;
  confirmed: boolean;
}

export const REMOVED_PASSAGE = '[identifying detail removed]';

// ─── Structure detection ────────────────────────────────────────────────────

const TS = String.raw`\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?`;
const CUE_TIMING_RE = new RegExp(String.raw`^[ \t]*${TS}[ \t]*-->[ \t]*${TS}.*$`, 'gm');
const TIMESTAMP_RE = new RegExp(String.raw`[\[(]?\b${TS}\b[\])]?`, 'g');

/** "Helen Carter   0:03" / "Speaker 1  00:01:05" (Teams, Otter). */
const TIMESTAMPED_LABEL_RE = new RegExp(
  String.raw`^[ \t]*([^\n\d:][^\n:]{0,39}?)[ \t]+(?:[\[(])?${TS}(?:[\])])?[ \t]*$`,
  'gm'
);
/**
 * Zoom / Teams meeting chat: "10:02:33 From Helen Carter to Everyone:" or
 * "10:02:33	 From  Helen Carter : message". The recipient of a direct
 * message is a person too, so it is captured as a label.
 */
const CHAT_LINE_RE = new RegExp(
  String.raw`^[ \t]*${TS}[ \t]+From[ \t]+(.+?)(?:[ \t]+to[ \t]+(.+?))?[ \t]*:`,
  'gm'
);
const CHAT_NON_PERSON_RE = /^(?:everyone|me|all panelists|all participants|waiting room)$/i;

/** WebVTT voice tag: <v Helen Carter> or <v.loud Helen>. */
const VOICE_TAG_RE = /<v(?:\.[^\s>]+)*\s+([^>]{1,60})>/g;
/** "Helen: …", "[00:01:02] P01: …", "INT: …" at line start. */
const LINE_LABEL_RE = new RegExp(
  String.raw`^[ \t]*(?:[\[(]?${TS}[\])]?[ \t]*)?(?:[-–][ \t]*)?([A-Z][A-Za-z'’.\-]*(?:[ \t]+[A-Za-z][A-Za-z'’.\-]*){0,3}|[A-Z]{1,4}\d{0,3})[ \t]*:[ \t]+(?=\S)`,
  'gm'
);

/** Words that start "Label:" lines but are headings, not speakers. */
const NOT_A_SPEAKER = new Set([
  'date', 'time', 'location', 'place', 'venue', 'note', 'notes', 'subject', 're', 'title',
  'transcript', 'duration', 'project', 'study', 'age', 'gender', 'sex', 'ethnicity', 'occupation',
  'setting', 'mode', 'file', 'recording', 'attendees', 'present', 'summary', 'topic', 'question',
  'answer', 'comment', 'comments', 'webvtt', 'kind', 'language', 'style', 'region', 'context',
  'interview date', 'interview', 'focus group', 'consent', 'dob', 'nhs', 'email', 'phone', 'tel',
  'address', 'postcode', 'name',
]);

const GENERIC_SPEAKER_RE =
  /^(?:interviewer|moderator|facilitator|researcher|respondent|participant|interviewee|speaker|unknown(?: speaker)?|int|iv|ie|mod|fac|res|resp|r|i|p|q|a|pt|fg\d*)(?:[ \t]*#?\d{1,3}[a-z]?)?$|^[A-Z]{1,3}\d{1,3}$/i;
const INTERVIEWER_LABEL_RE = /^(?:interviewer|moderator|facilitator|researcher|int|iv|mod|fac|i|q)\b/i;

function sniffKind(text: string): TranscriptKind | null {
  const head = text.slice(0, 2000);
  if (/^﻿?WEBVTT/.test(head)) return 'VTT';
  if (/^\s*\d+\s*\r?\n\d{2}:\d{2}:\d{2},\d{3}\s*-->/.test(head)) return 'SRT';
  return null;
}

/**
 * Recognise a transcript and its speakers. Returns null for ordinary
 * documents (a clinical letter with "Date:" and "Re:" lines is not a
 * transcript).
 */
export function analyseTranscript(text: string): TranscriptInfo | null {
  let kind = sniffKind(text);
  const structuralSpans: TranscriptInfo['structuralSpans'] = [];
  const labelSpans: TranscriptInfo['labelSpans'] = [];

  // WebVTT file header ("WEBVTT - Zoom recording") — not a name.
  const header = /^﻿?WEBVTT[^\n]*/.exec(text);
  if (header) structuralSpans.push({ start: 0, end: header[0].length });

  // Cue timing lines (VTT/SRT) + the cue identifier line above each one.
  let m: RegExpExecArray | null;
  CUE_TIMING_RE.lastIndex = 0;
  while ((m = CUE_TIMING_RE.exec(text))) {
    structuralSpans.push({ start: m.index, end: m.index + m[0].length });
    const before = text.lastIndexOf('\n', m.index - 2);
    const prevLine = text.slice(before + 1, m.index).replace(/\r?\n$/, '');
    if (prevLine.trim() && !prevLine.includes(' ') && prevLine.length <= 64) {
      structuralSpans.push({ start: before + 1, end: before + 1 + prevLine.length });
    }
  }

  const addLabel = (start: number, raw: string) => {
    const label = raw.trim().replace(/\s+/g, ' ');
    if (!label || NOT_A_SPEAKER.has(label.toLowerCase())) return;
    const offset = raw.indexOf(raw.trim());
    labelSpans.push({ start: start + offset, end: start + offset + raw.trim().length, speaker: label });
  };

  let chatCount = 0;
  const chatLines: Array<{ start: number; end: number }> = [];
  CHAT_LINE_RE.lastIndex = 0;
  while ((m = CHAT_LINE_RE.exec(text))) {
    chatCount++;
    chatLines.push({ start: m.index, end: m.index + m[0].length });
    const line = m[0];
    const strip = (v: string) => v.replace(/\s*\((?:privately|direct message|privately to [^)]*)\)\s*$/i, '');
    const sender = strip(m[1]);
    addLabel(m.index + line.indexOf(m[1]), sender);
    if (m[2]) {
      const to = strip(m[2]);
      if (!CHAT_NON_PERSON_RE.test(to.trim())) addLabel(m.index + line.lastIndexOf(m[2]), to);
    }
  }

  VOICE_TAG_RE.lastIndex = 0;
  while ((m = VOICE_TAG_RE.exec(text))) addLabel(m.index + m[0].indexOf(m[1]), m[1]);

  let timestampedCount = 0;
  TIMESTAMPED_LABEL_RE.lastIndex = 0;
  while ((m = TIMESTAMPED_LABEL_RE.exec(text))) {
    addLabel(m.index + m[0].indexOf(m[1]), m[1]);
    timestampedCount++;
  }

  LINE_LABEL_RE.lastIndex = 0;
  while ((m = LINE_LABEL_RE.exec(text))) {
    const start = m.index + m[0].lastIndexOf(m[1], m[0].length - 1);
    if (labelSpans.some((l) => l.start <= start && start < l.end)) continue;
    if (chatLines.some((c) => c.start <= start && start < c.end)) continue;
    addLabel(start, m[1]);
  }

  // Timestamps anywhere (speaker lines, "[00:01:02]" prefixes) are structure.
  TIMESTAMP_RE.lastIndex = 0;
  while ((m = TIMESTAMP_RE.exec(text))) {
    if (!structuralSpans.some((s) => s.start <= m!.index && m!.index < s.end)) {
      structuralSpans.push({ start: m.index, end: m.index + m[0].length });
    }
  }

  labelSpans.sort((a, b) => a.start - b.start);

  // Is this really a transcript? Need repeated labels from ≥ 2 speakers.
  const counts = new Map<string, number>();
  for (const l of labelSpans) counts.set(l.speaker, (counts.get(l.speaker) ?? 0) + 1);
  const repeated = Array.from(counts.values()).filter((c) => c >= 2).length;
  if (!kind) {
    if (labelSpans.length < 4 || counts.size < 2 || repeated < 2) return null;
    kind =
      chatCount >= labelSpans.length / 2
        ? 'CHAT'
        : timestampedCount >= labelSpans.length / 2 ? 'TIMESTAMPED' : 'LABELLED';
  }
  if (labelSpans.length > 0 && counts.size >= 1) {
    // Drop labels seen once in a long transcript — usually a "Note:" line.
    if (labelSpans.length >= 8) {
      for (let i = labelSpans.length - 1; i >= 0; i--) {
        if ((counts.get(labelSpans[i].speaker) ?? 0) < 2) labelSpans.splice(i, 1);
      }
    }
  }

  // Turns and questions per speaker. Captioning splits one spoken turn into
  // many short cues, so consecutive cues from the same speaker are ONE turn;
  // otherwise the interviewer's questions are diluted below any threshold.
  const stats = new Map<string, { turns: number; questions: number; first: number }>();
  let runSpeaker: string | null = null;
  let runText = '';
  const closeRun = () => {
    if (runSpeaker === null) return;
    const st = stats.get(runSpeaker)!;
    st.turns++;
    if (hasRealQuestion(runText)) st.questions++;
  };
  labelSpans.forEach((l, i) => {
    const turnEnd = labelSpans[i + 1]?.start ?? text.length;
    if (l.speaker !== runSpeaker) {
      closeRun();
      runSpeaker = l.speaker;
      runText = '';
      if (!stats.has(l.speaker)) stats.set(l.speaker, { turns: 0, questions: 0, first: l.start });
    }
    runText += ' ' + text.slice(l.end, turnEnd);
  });
  closeRun();

  const ordered = Array.from(stats.entries()).sort((a, b) => a[1].first - b[1].first);
  // Interviewer: a label that says so, else the named speaker who asks the
  // highest share of questions (if clearly the questioner).
  const explicit = ordered.filter(([label]) => INTERVIEWER_LABEL_RE.test(label));
  let interviewers = new Set(explicit.map(([label]) => label));
  if (interviewers.size === 0 && ordered.length >= 2) {
    const best = ordered
      .map(([label, s]) => ({ label, ratio: s.questions / s.turns, turns: s.turns }))
      .sort((a, b) => b.ratio - a.ratio)[0];
    const second = ordered
      .map(([, s]) => s.questions / s.turns)
      .sort((a, b) => b - a)[1];
    // Clear questioner: a high share of question turns, or (in long real
    // interviews full of "vale"/"yes" turns) several real questions at twice
    // anyone else's rate. Anything less is left for the user to set.
    const bestQuestions = stats.get(best.label)!.questions;
    const clear =
      best.ratio >= 2 * (second ?? 0) &&
      (best.ratio >= 0.3 || (bestQuestions >= 5 && best.ratio >= 0.08));
    if (clear) interviewers = new Set([best.label]);
  }

  let p = 0;
  let iv = 0;
  const multipleInterviewers = interviewers.size > 1;
  const speakers: Speaker[] = ordered.map(([label, s]) => {
    const role: SpeakerRole = interviewers.has(label) ? 'INTERVIEWER' : 'PARTICIPANT';
    const isName = !GENERIC_SPEAKER_RE.test(label);
    const display =
      role === 'INTERVIEWER'
        ? multipleInterviewers ? `Interviewer ${++iv}` : 'Interviewer'
        : `Participant ${++p}`;
    return { label, turns: s.turns, questions: s.questions, isName, role, display };
  });

  const kindLabel = {
    VTT: 'WebVTT captions (Zoom, Teams, YouTube)',
    SRT: 'SRT subtitles',
    TIMESTAMPED: 'Timestamped transcript (Teams, Otter)',
    CHAT: 'Meeting chat log (Zoom, Teams)',
    LABELLED: 'Speaker-labelled transcript',
  }[kind];

  return {
    kind, kindLabel, speakers, turnCount: labelSpans.length, labelSpans, structuralSpans,
    language: detectLanguage(text),
  };
}

/**
 * Recompute display labels from roles: "Interviewer" (numbered only when
 * there are several) and "Participant n" in order of first appearance.
 * Generic labels (P01, Interviewer) are left untouched.
 */
export function relabelSpeakers(speakers: Speaker[]): Speaker[] {
  const named = speakers.filter((s) => s.isName);
  const nInterviewers = named.filter((s) => s.role === 'INTERVIEWER').length;
  let iv = 0;
  let p = 0;
  return speakers.map((s) => {
    if (!s.isName) return s;
    const display =
      s.role === 'INTERVIEWER'
        ? nInterviewers > 1 ? `Interviewer ${++iv}` : 'Interviewer'
        : `Participant ${++p}`;
    return { ...s, display };
  });
}

/**
 * Does this turn ask a real question? Tag questions ("right?", "¿no?",
 * "you know?") don't count: a question needs at least three words.
 * Spanish "¿…?" is supported.
 */
export function hasRealQuestion(turn: string): boolean {
  return turn
    .split(/(?<=[.!?…])\s+|\n+/)
    .some((s) => {
      let q = s.trim();
      if (!q.endsWith('?')) return false;
      const count = (t: string) => t.replace(/[¿?¡!.,…"“”]/g, ' ').trim().split(/\s+/).filter(Boolean).length;
      // Spanish marks where the question starts: "Es así, ¿no?" asks "no".
      const inverted = q.lastIndexOf('¿');
      if (inverted >= 0) q = q.slice(inverted);
      // English tag question: "It was fine, right?" asks only "right".
      else if (q.includes(',') && count(q.slice(q.lastIndexOf(',') + 1)) <= 2) return false;
      return count(q) >= 3;
    });
}

// ─── Speaker spans ──────────────────────────────────────────────────────────

const TITLES = new Set(['dr', 'mr', 'mrs', 'ms', 'miss', 'prof', 'professor', 'sir', 'dame', 'nurse', 'rev']);

/** The searchable parts of a speaker name: full name + each name part. */
export function nameParts(label: string): string[] {
  const words = label
    .split(/\s+/)
    .map((w) => w.replace(/[.,'’]+$/g, ''))
    .filter((w) => w.length >= 3 && !TITLES.has(w.toLowerCase()));
  return Array.from(new Set([label, ...words]));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const overlaps = (s: { start: number; end: number }, list: Array<{ start: number; end: number }>) =>
  list.some((x) => s.start < x.end && x.start < s.end);

/**
 * Forced NAME spans for speakers whose label is a real name: every label
 * position, plus every mention of the full name or a name part anywhere in
 * the text, case-insensitively (speech-to-text output is often lowercase,
 * which the cased NER model misses).
 */
export function speakerSpans(text: string, info: TranscriptInfo): Span[] {
  const named = info.speakers.filter((s) => s.isName);
  if (named.length === 0) return [];
  const spans: Span[] = [];
  const push = (start: number, end: number) => {
    if (overlaps({ start, end }, info.structuralSpans)) return;
    if (spans.some((s) => s.start < end && start < s.end)) return;
    spans.push({
      start, end, text: text.slice(start, end), label: 'NAME',
      category: 'HIPAA', source: 'rule', confidence: 1,
    });
  };
  const namedSet = new Set(named.map((s) => s.label));
  for (const l of info.labelSpans) if (namedSet.has(l.speaker)) push(l.start, l.end);

  // Longest first so "Helen Carter" wins over "Helen".
  const parts = Array.from(new Set(named.flatMap((s) => nameParts(s.label)))).sort(
    (a, b) => b.length - a.length
  );
  for (const part of parts) {
    const re = new RegExp(`(?<![\\w'’])${escapeRegExp(part).replace(/\s+/g, '\\s+')}(?![\\w'’])`, 'gi');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) push(m.index, m.index + m[0].length);
  }

  // Speech-to-text often mishears a speaker's own name ("Marcus" for
  // "Marcos"). Catch close spellings of a speaker's name parts.
  const single = parts.filter((p) => !/\s/.test(p));
  const lowercaseWords = new Set(text.match(/\b[a-z][a-z'’]+\b/g) ?? []);
  const wordRe = /(?<![\w'’])[A-Z][a-z]{3,}(?![\w'’])/g;
  let w: RegExpExecArray | null;
  while ((w = wordRe.exec(text))) {
    // A word also used in lower case ("hello") is ordinary vocabulary.
    if (lowercaseWords.has(w[0].toLowerCase())) continue;
    if (single.some((p) => isSpeakerVariant(w![0], p))) push(w.index, w.index + w[0].length);
  }
  return spans.sort((a, b) => a.start - b.start);
}

/**
 * Is `word` a plausible mis-transcription of the speaker name part `name`?
 * Same first two letters, length within one, and at most one edit (5-letter
 * names) or two edits (6+). Shorter names are never fuzzy-matched.
 */
export function isSpeakerVariant(word: string, name: string): boolean {
  const a = word.toLowerCase();
  const b = name.toLowerCase();
  if (a === b || b.length < 5) return false;
  if (a.slice(0, 2) !== b.slice(0, 2) || Math.abs(a.length - b.length) > 1) return false;
  return editDistance(a, b) <= (b.length >= 6 ? 2 : 1);
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

const RELATION_NAME_RE =
  /\b[Mm]y\s+(?:husband|wife|partner|son|daughter|mum|mom|mother|dad|father|brother|sister|grandson|granddaughter|grandma|grandad|nan|nana|aunt|auntie|uncle|cousin|friend|neighbour|neighbor|carer|boss|manager|colleague|niece|nephew)\s*,?\s+([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})?)\b/g;

const RELATION_NAME_ES_RE =
  /(?<![\p{L}])[Mm]i\s+(?:hij[oa]|mujer|marido|esposa|esposo|madre|padre|mam[aá]|pap[aá]|herman[oa]|pareja|niet[oa]|amig[oa]|jef[ea]|vecin[oa]|prim[oa]|t[ií][oa]|suegr[oa]|cu[ñn]ad[oa])\s*,?\s+(\p{Lu}\p{Ll}{2,}(?:\s+\p{Lu}\p{Ll}{2,})?)/gu;

/** Names introduced by a relationship: "my daughter Amira", "mi hija Amira". */
export function relationshipNames(text: string): string[] {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  for (const re of [RELATION_NAME_RE, RELATION_NAME_ES_RE]) {
    re.lastIndex = 0;
    while ((m = re.exec(text))) out.add(m[1]);
  }
  return Array.from(out);
}

/**
 * NAME spans for every further mention of already-found names, matched
 * case-insensitively (speech-to-text often writes "amira"), skipping
 * positions already covered by `existing` spans and structural spans.
 */
export function nameMentionSpans(
  text: string,
  names: string[],
  info: TranscriptInfo,
  existing: Array<{ start: number; end: number }>
): Span[] {
  const covered = [...existing, ...info.structuralSpans];
  const spans: Span[] = [];
  const parts = Array.from(new Set(names.flatMap(nameParts))).sort((a, b) => b.length - a.length);
  for (const part of parts) {
    if (part.length < 3) continue;
    const re = new RegExp(`(?<![\\w'’])${escapeRegExp(part).replace(/\s+/g, '\\s+')}(?![\\w'’])`, 'gi');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const s = { start: m.index, end: m.index + m[0].length };
      if (overlaps(s, covered) || overlaps(s, spans)) continue;
      spans.push({ ...s, text: m[0], label: 'NAME', category: 'HIPAA', source: 'rule', confidence: 1 });
    }
  }
  return spans;
}

// ─── Spoken identifiers ─────────────────────────────────────────────────────

const DIGIT_WORDS: Record<string, number> = {
  zero: 1, oh: 1, o: 1, nought: 1, one: 1, two: 1, three: 1, four: 1, five: 1,
  six: 1, seven: 1, eight: 1, nine: 1,
};
const MULTIPLIERS: Record<string, number> = { double: 2, triple: 3, treble: 3 };
const SPOKEN_DIGITS_RE =
  /\b(?:(?:zero|oh|o|nought|one|two|three|four|five|six|seven|eight|nine|double|triple|treble|\d)(?:[ \t,-]+|(?=[.?!;\n])|$)){5,}/gi;

const ORDINALS =
  'first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|twenty[\\s-](?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth)|thirtieth|thirty[\\s-]first|\\d{1,2}(?:st|nd|rd|th)';
const MONTHS = 'january|february|march|april|may|june|july|august|september|october|november|december';
const SPOKEN_YEAR = '(?:,?\\s+(?:nineteen|twenty|two\\s+thousand)(?:[\\s-]+(?:and\\s+)?[a-z]+){0,3}|,?\\s+\\d{4})?';
const SPOKEN_DATE_RE = new RegExp(
  `\\b(?:(?:the\\s+)?(?:${ORDINALS})\\s+of\\s+(?:${MONTHS})|(?:${MONTHS})\\s+the\\s+(?:${ORDINALS}))${SPOKEN_YEAR}`,
  'gi'
);
const TENS_OVER_89 = '(?:ninety|a\\s+hundred|one\\s+hundred)';
const SPOKEN_AGE_RE = new RegExp(
  `\\b(?:i'?m|i\\s+am|she'?s|he'?s|they'?re|was|aged?|turned|turning)\\s+(?:now\\s+)?(${TENS_OVER_89}(?:[\\s-](?:and\\s+)?(?:one|two|three|four|five|six|seven|eight|nine))?)\\b`,
  'gi'
);

function spokenDigitCount(phrase: string): number {
  let n = 0;
  let mult = 1;
  for (const w of phrase.toLowerCase().split(/[\s,.-]+/).filter(Boolean)) {
    if (MULTIPLIERS[w]) { mult = MULTIPLIERS[w]; continue; }
    if (/^\d$/.test(w) || DIGIT_WORDS[w]) { n += mult; mult = 1; continue; }
  }
  return n;
}

/** Phone numbers read aloud, spoken dates, spoken ages over 89. */
export function spokenIdentifierSpans(text: string): Span[] {
  const spans: Span[] = [];
  const make = (start: number, end: number, label: IdentifierLabel): Span => ({
    start, end, text: text.slice(start, end), label,
    category: 'HIPAA', source: 'rule', confidence: 1,
  });
  let m: RegExpExecArray | null;
  SPOKEN_DIGITS_RE.lastIndex = 0;
  while ((m = SPOKEN_DIGITS_RE.exec(text))) {
    const phrase = m[0].replace(/[ \t,-]+$/, '');
    // Must contain at least one spoken digit word and 7+ digits in total.
    if (!/[a-z]/i.test(phrase) || spokenDigitCount(phrase) < 7) continue;
    spans.push(make(m.index, m.index + phrase.length, 'PHONE'));
  }
  SPOKEN_DATE_RE.lastIndex = 0;
  while ((m = SPOKEN_DATE_RE.exec(text))) spans.push(make(m.index, m.index + m[0].length, 'DATE'));
  SPOKEN_AGE_RE.lastIndex = 0;
  while ((m = SPOKEN_AGE_RE.exec(text))) {
    const start = m.index + m[0].lastIndexOf(m[1]);
    spans.push(make(start, start + m[1].length, 'AGE_OVER_89'));
  }
  return spans;
}

// ─── Contextual identifiers (flag for human review) ─────────────────────────

interface Cue {
  re: RegExp;
  reason: string;
}

// Accented letters are not \w, so Spanish cues use explicit letter-class
// lookarounds instead of \b.
const NL = '(?<![\\p{L}])';
const NR = '(?![\\p{L}])';
const es = (body: string) => new RegExp(NL + '(?:' + body + ')' + NR, 'iu');

const CUES_ES: Cue[] = [
  {
    re: es('soy (?:el|la) [uú]nic[oa]|el [uú]nico|la [uú]nica|todo el mundo me conoce|me conoce todo el mundo|sal[ií] en (?:la tele|el peri[oó]dico|las noticias|la radio)'),
    reason: 'Says something unique about a person',
  },
  {
    re: es('trabaj(?:o|aba|a|an|amos|é) (?:de|como|en|para)|soy (?:enfermer[oa]|m[eé]dic[oa]|profesor[a]?|maestr[oa]|polic[ií]a|abogad[oa]|administrativ[oa]|ingenier[oa]|farmac[eé]utic[oa])'),
    reason: 'Mentions where someone works',
  },
  {
    re: es('viv(?:o|[ií]a|imos|e|en) en|soy de|nac[ií] en|me mud[eé] a|me cri[eé] en'),
    reason: 'Mentions where someone lives or comes from',
  },
  {
    re: es('mi (?:mujer|marido|esposa|esposo|hij[oa]|madre|padre|herman[oa]|pareja|jef[ea])[^.?!]{0,60}(?:trabaja|vive|estudia|es (?:un|una))'),
    reason: 'Describes a family member or colleague in detail',
  },
];

const CUES: Cue[] = [
  {
    re: /\b(?:the only|only one|one of the only|one of (?:very )?few|the first (?:person|woman|man|nurse|doctor)|everyone (?:here |round here |there )?knows (?:me|him|her|us)|you'?d know (?:me|who)|well[\s-]known|famous)\b/i,
    reason: 'Says something unique about a person',
  },
  {
    re: /\b(?:i|we|she|he|they|my \w+)\s+(?:work|works|worked|am working|was working|used to work)\s+(?:as|at|for|in|on)\b|\bon (?:the )?\w+ ward\b|\bi'?m (?:a|an|the) [\w-]+ (?:at|in|on|for)\b/i,
    reason: 'Mentions where someone works',
  },
  {
    re: /\b(?:i|we|she|he|they|my \w+)\s+(?:live|lives|lived|grew up|moved|am from|was born)\s+(?:in|on|at|near|to|round|from)\b|\b(?:round the corner|down the road|next door) (?:from|to)\b/i,
    reason: 'Mentions where someone lives or comes from',
  },
  {
    re: /\b(?:in the (?:news|paper|papers)|on (?:tv|the telly|the radio|facebook|social media)|court case|tribunal|inquest|the (?:accident|crash|fire|incident) (?:at|on|in))\b/i,
    reason: 'Mentions an event that could be looked up',
  },
  {
    re: /\bmy (?:husband|wife|partner|son|daughter|mum|mother|dad|father|brother|sister|grandson|granddaughter|boss|manager|colleague|neighbour)\b[^.?!]{0,60}\b(?:works?|lives?|is a|is an|goes to|at the|in \w+ ward)\b/i,
    reason: 'Describes a family member or colleague in detail',
  },
];

/** Sentences (or turn fragments) that may identify someone by context. */
export function contextualFlags(text: string, info: TranscriptInfo | null): ContextFlag[] {
  const flags: ContextFlag[] = [];
  const sentenceRe = /[^.?!\n]+[.?!]*/g;
  let m: RegExpExecArray | null;
  let id = 0;
  while ((m = sentenceRe.exec(text))) {
    let start = m.index;
    let end = m.index + m[0].length;
    // Never include the speaker label in a flagged passage.
    const label = info?.labelSpans.find((l) => l.start >= start && l.start < end);
    if (label) {
      // Skip the label and whatever closes it: "Helen:", "<v Helen>", "Helen  0:03".
      const tail = /^[^\S\n]*(?:[>:\])]|[-–]|\d{1,2}:\d{2}(?::\d{2})?)*[^\S\n]*/.exec(text.slice(label.end, end));
      start = label.end + (tail?.[0].length ?? 0);
    }
    const sentence = text.slice(start, end);
    const lead = sentence.length - sentence.trimStart().length;
    start += lead;
    end = start + sentence.trim().length;
    if (end - start < 12) continue;
    const cue = [...CUES, ...CUES_ES].find((c) => c.re.test(text.slice(start, end)));
    if (cue) flags.push({ id: id++, start, end, text: text.slice(start, end), reason: cue.reason });
  }
  return flags;
}

/** A removal span for a flagged passage the user chose to remove. */
export function passageSpan(text: string, flag: ContextFlag): Span {
  return {
    start: flag.start,
    end: flag.end,
    text: text.slice(flag.start, flag.end),
    // HIPAA #18: "any other unique identifying number, characteristic or code".
    label: 'REFERENCE_ID',
    category: 'HIPAA',
    source: 'rule',
    confidence: 1,
  };
}

// ─── Replacement labels ─────────────────────────────────────────────────────

const READABLE_LABELS: Partial<Record<IdentifierLabel, string>> = {
  NAME: 'Person',
  INSTITUTION: 'Organisation',
  ADDRESS_LINE: 'Address',
  EMAIL: 'Email',
  PHONE: 'Phone number',
  URL: 'Link',
};

/**
 * Build the replacement labeller for a transcript run. Returns a replacement
 * for (label, original), or null to fall back to the engine default.
 *
 *  - Speaker names (and their parts) → "[Participant 1]" / "[Interviewer]",
 *    in every mode.
 *  - Passages the user removed → "[identifying detail removed]".
 *  - With `readable`, other names/places → "[Person 2]", "[Organisation 1]",
 *    numbered by first appearance; "Helen" joins "Helen Carter" when it is a
 *    part of that already-numbered name.
 *
 * Stateful (numbering), so build a fresh one per replace run.
 */
export function transcriptLabeller(
  info: TranscriptInfo,
  readable: boolean,
  removedPassages: string[],
  /** Share across files so "[Person 3]" means the same person study-wide. */
  registry: LabelRegistry = createLabelRegistry()
): (label: IdentifierLabel, original: string) => string | null {
  const speakerOf = new Map<string, string>();
  for (const s of info.speakers) {
    if (!s.isName) continue;
    for (const part of nameParts(s.label)) speakerOf.set(norm(part), `[${s.display}]`);
  }
  const removed = new Set(removedPassages.map(norm));
  const { counters, assigned } = registry;

  return (label, original) => {
    const key = norm(original);
    if (label === 'REFERENCE_ID' && removed.has(key)) return REMOVED_PASSAGE;
    if (label === 'NAME') {
      const sp = speakerOf.get(key) ?? speakerOf.get(norm(stripTitle(original)));
      if (sp) return sp;
      // A misheard spelling of a speaker's name is that speaker.
      const words = stripTitle(original).trim().split(/\s+/);
      if (words.length === 1) {
        for (const [part, out] of Array.from(speakerOf.entries())) {
          if (!/\s/.test(part) && isSpeakerVariant(words[0], part)) return out;
        }
      }
    }
    if (!readable) return null;
    const noun = READABLE_LABELS[label];
    if (!noun) return null;

    const words = new Set(key.split(/\s+/).filter((w) => w.length >= 3 && !TITLES.has(w)));
    const exact = assigned.find((a) => a.label === label && a.key === key);
    if (exact) return exact.out;
    if (label === 'NAME' && words.size > 0) {
      // Link a partial mention to a fuller name it is part of (or vice versa).
      const linked = assigned.find(
        (a) =>
          a.label === 'NAME' &&
          a.words.size > 0 &&
          (isSubset(words, a.words) || isSubset(a.words, words))
      );
      if (linked) {
        assigned.push({ label, key, words, out: linked.out });
        return linked.out;
      }
    }
    const n = (counters.get(noun) ?? 0) + 1;
    counters.set(noun, n);
    const out = `[${noun} ${n}]`;
    assigned.push({ label, key, words, out });
    return out;
  };
}

/** Numbering state for readable labels; one per file, or one per study. */
export interface LabelRegistry {
  counters: Map<string, number>;
  assigned: Array<{ label: IdentifierLabel; key: string; words: Set<string>; out: string }>;
}

export function createLabelRegistry(): LabelRegistry {
  return { counters: new Map(), assigned: [] };
}

/**
 * Give named speakers study-wide labels across several transcripts: the same
 * name is the same "[Participant n]" in every file, participants are numbered
 * in order of first appearance, and interviewers are numbered only when the
 * study has more than one. Mutates each speaker's `display`.
 */
export function assignStudySpeakers(infos: TranscriptInfo[]): void {
  const roleOf = new Map<string, SpeakerRole>();
  const order: string[] = [];
  for (const info of infos) {
    for (const s of info.speakers) {
      if (!s.isName) continue;
      const key = norm(s.label);
      if (!roleOf.has(key)) {
        roleOf.set(key, s.role);
        order.push(key);
      }
    }
  }
  const interviewers = order.filter((k) => roleOf.get(k) === 'INTERVIEWER');
  const participants = order.filter((k) => roleOf.get(k) === 'PARTICIPANT');
  const display = new Map<string, string>();
  interviewers.forEach((k, i) => display.set(k, interviewers.length > 1 ? `Interviewer ${i + 1}` : 'Interviewer'));
  participants.forEach((k, i) => display.set(k, `Participant ${i + 1}`));
  for (const info of infos) {
    for (const s of info.speakers) {
      if (!s.isName) continue;
      const key = norm(s.label);
      s.role = roleOf.get(key)!;
      s.display = display.get(key)!;
    }
  }
}

/**
 * Transcript-aware detection: speaker names and spoken identifiers are forced
 * in, timestamps are kept out, and every name found once is replaced at each
 * later mention in any case.
 */
export function detectTranscript(
  text: string,
  info: TranscriptInfo,
  nerSpans: Span[],
  extraForced: Span[] = []
): DetectionResult {
  const forced = [...extraForced, ...speakerSpans(text, info), ...spokenIdentifierSpans(text)];
  const detection = detect(text, [...nerSpans, ...forced]);
  let spans = dropStructural(detection.spans, info);
  const quasiSpans = dropStructural(detection.quasiSpans, info);
  // A single word that also appears in lower case ("but", "perfect") is
  // ordinary vocabulary, even if the model tagged one occurrence as a name;
  // spreading it to every mention would wreck the transcript.
  const lowercaseWords = new Set(text.match(/\b[a-z][a-z'’]+\b/g) ?? []);
  const knownNames = [
    ...relationshipNames(text),
    ...spans
      .filter((sp) => sp.label === 'NAME' && (sp.source === 'rule' || (sp.confidence ?? 1) >= 0.9))
      .map((sp) => text.slice(sp.captureStart ?? sp.start, sp.captureEnd ?? sp.end)),
  ].filter((n) => /\s/.test(n.trim()) || !lowercaseWords.has(n.trim().toLowerCase()));
  spans = [...spans, ...nameMentionSpans(text, knownNames, info, [...spans, ...quasiSpans])].sort(
    (a, b) => a.start - b.start
  );
  const counts: Record<string, number> = {};
  for (const sp of [...spans, ...quasiSpans]) counts[sp.label] = (counts[sp.label] ?? 0) + 1;
  return {
    ...detection,
    spans,
    quasiSpans,
    counts,
    uncertainSpans: dropStructural(detection.uncertainSpans ?? [], info),
  };
}

function norm(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

function stripTitle(s: string): string {
  return s.replace(/^(?:dr|mr|mrs|ms|miss|prof|professor|sir|dame|nurse|rev)\.?\s+/i, '');
}

function isSubset(a: Set<string>, b: Set<string>): boolean {
  for (const x of Array.from(a)) if (!b.has(x)) return false;
  return true;
}

/** Remove detections that fall on timestamps / cue IDs. */
export function dropStructural<T extends { start: number; end: number }>(
  spans: T[],
  info: TranscriptInfo
): T[] {
  return spans.filter((s) => !overlaps(s, info.structuralSpans));
}
