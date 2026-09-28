/**
 * Transcript support tests. All people, places and numbers are fictitious.
 */

import { describe, expect, it } from 'vitest';
import { Crypto } from '@peculiar/webcrypto';
import { detect } from '@/engine/detect';
import { replaceSpans } from '@/engine/replace';
import { generateSessionSecret } from '@/engine/crypto';
import {
  analyseTranscript,
  contextualFlags,
  detectTranscript,
  dropStructural,
  hasRealQuestion,
  relabelSpeakers,
  isSpeakerVariant,
  nameMentionSpans,
  nameParts,
  properNounCandidates,
  passageSpan,
  relationshipNames,
  speakerSpans,
  spokenIdentifierSpans,
  transcriptLabeller,
  REMOVED_PASSAGE,
} from '@/engine/transcript';

if (typeof globalThis.crypto?.subtle === 'undefined') {
  (globalThis as { crypto: Crypto }).crypto = new Crypto();
}

const VTT = `WEBVTT

1
00:00:01.000 --> 00:00:04.000
<v Sarah Okafor>Thanks for joining. How have things been since the discharge?

2
00:00:04.500 --> 00:00:09.000
<v Helen Carter>Honestly hard. My number is oh seven seven double oh, nine double oh one two three.

3
00:00:09.500 --> 00:00:12.000
<v Sarah Okafor>Did anyone support you at home?

4
00:00:12.500 --> 00:00:18.000
<v Helen Carter>My daughter, she works at the Co-op in Harehills. I'm the only Somali nurse on the ward.
`;

const TEAMS = `Sarah Okafor   0:03
Can you tell me about your diagnosis?

Helen Carter   0:09
I was diagnosed on the fifth of March twenty twenty two. helen carter is what the letters say.

Sarah Okafor   0:21
And how old are you now?

Helen Carter   0:25
I'm ninety three next month.
`;

const LABELLED = `Interview date: 2024-05-01
Interviewer: What matters most to you in your care?
P01: Being listened to. Dr Patel was brilliant.
Interviewer: Can you say more?
P01: He always remembered my grandson James.
`;

describe('structure detection', () => {
  it('parses WebVTT voice tags and cue timings', () => {
    const info = analyseTranscript(VTT)!;
    expect(info.kind).toBe('VTT');
    expect(info.speakers.map((s) => s.label)).toEqual(['Sarah Okafor', 'Helen Carter']);
    expect(info.speakers[0]).toMatchObject({ role: 'INTERVIEWER', display: 'Interviewer', isName: true });
    expect(info.speakers[1]).toMatchObject({ role: 'PARTICIPANT', display: 'Participant 1' });
    expect(info.structuralSpans.length).toBeGreaterThanOrEqual(4);
  });

  it('parses Teams/Otter "Name   0:03" headers', () => {
    const info = analyseTranscript(TEAMS)!;
    expect(info.kind).toBe('TIMESTAMPED');
    expect(info.speakers).toHaveLength(2);
    expect(info.speakers.find((s) => s.label === 'Sarah Okafor')!.role).toBe('INTERVIEWER');
  });

  it('parses "Label:" transcripts, ignores headings, keeps generic labels', () => {
    const info = analyseTranscript(LABELLED)!;
    expect(info.kind).toBe('LABELLED');
    expect(info.speakers.map((s) => s.label)).toEqual(['Interviewer', 'P01']);
    expect(info.speakers.every((s) => !s.isName)).toBe(true);
  });

  it('does not treat a clinical letter as a transcript', () => {
    const letter = 'Date: 01/02/2024\nRe: John Smith\nDear Dr Jones,\nThank you for seeing this patient.\nNote: allergy to penicillin.';
    expect(analyseTranscript(letter)).toBeNull();
  });

  it('keeps timestamps out of detection', () => {
    const info = analyseTranscript(VTT)!;
    const spans = dropStructural(detect(VTT).spans, info);
    for (const s of spans) expect(s.text).not.toMatch(/^\d{2}:\d{2}/);
  });
});

describe('speaker names', () => {
  it('finds every mention, including lowercase speech-to-text', () => {
    const info = analyseTranscript(TEAMS)!;
    const spans = speakerSpans(TEAMS, info).map((s) => s.text);
    expect(spans).toContain('Helen Carter');
    expect(spans).toContain('helen carter');
  });
});

describe('spoken identifiers', () => {
  it('catches phone numbers read aloud, spoken dates and ages over 89', () => {
    const labels = (t: string) => spokenIdentifierSpans(t).map((s) => [s.label, s.text]);
    expect(labels('it is oh seven seven double oh, nine double oh one two three')[0][0]).toBe('PHONE');
    expect(labels('diagnosed on the fifth of March twenty twenty two')).toContainEqual([
      'DATE', 'the fifth of March twenty twenty two',
    ]);
    expect(labels("I'm ninety three next month")).toContainEqual(['AGE_OVER_89', 'ninety three']);
  });

  it('does not flag short counts or ordinary speech', () => {
    expect(spokenIdentifierSpans('I have two or three good days a week, maybe one.')).toHaveLength(0);
    expect(spokenIdentifierSpans("I'm fifty two and she's nine")).toHaveLength(0);
  });
});

describe('contextual identifiers', () => {
  it('flags unique descriptions and workplaces, without the speaker label', () => {
    const info = analyseTranscript(VTT)!;
    const flags = contextualFlags(VTT, info);
    const reasons = flags.map((f) => f.reason);
    expect(reasons).toContain('Says something unique about a person');
    expect(reasons.some((r) => /works|family/.test(r))).toBe(true);
    for (const f of flags) expect(f.text).not.toContain('Helen Carter');
  });
});

describe('end to end with readable labels', () => {
  async function run(text: string, mode: 'ANONYMISE' | 'PSEUDONYMISE', readable: boolean, removeFlags = false) {
    const info = analyseTranscript(text)!;
    const flags = contextualFlags(text, info);
    const extra = [...speakerSpans(text, info), ...spokenIdentifierSpans(text)];
    const removed = removeFlags ? flags : [];
    const det = detect(text, extra);
    const spans = [...dropStructural(det.spans, info), ...removed.map((f) => passageSpan(text, f))];
    return replaceSpans(text, spans, [], {
      mode,
      secret: mode === 'PSEUDONYMISE' ? await generateSessionSecret() : undefined,
      quasiToRedact: new Set(),
      labeller: transcriptLabeller(info, readable, removed.map((f) => f.text)),
    });
  }

  it('anonymise: speakers become roles, the spoken phone number is removed', async () => {
    const out = await run(VTT, 'ANONYMISE', true);
    expect(out.text).toContain('<v [Interviewer]>Thanks for joining.');
    expect(out.text).toContain('<v [Participant 1]>');
    expect(out.text).not.toMatch(/Helen|Okafor|Carter/);
    expect(out.text).not.toContain('double oh');
    expect(out.text).toContain('00:00:01.000 --> 00:00:04.000');
  });

  it('pseudonymise: lowercase name mentions map to the same participant label', async () => {
    const out = await run(TEAMS, 'PSEUDONYMISE', true);
    expect(out.text).not.toMatch(/helen|carter/i);
    expect(out.text).toContain('[Participant 1] is what the letters say');
    expect(out.mapping['Helen Carter']).toBe('[Participant 1]');
    expect(out.text).toContain('0:03');
  });

  it('numbers third parties as [Person n] and removes passages the user chose', async () => {
    const out = await run(VTT, 'ANONYMISE', true, true);
    expect(out.text).toContain(REMOVED_PASSAGE);
    expect(out.text).not.toContain('only Somali nurse');
  });

  it('keeps generic speaker labels untouched', async () => {
    const out = await run(LABELLED, 'ANONYMISE', true);
    expect(out.text).toContain('Interviewer: What matters');
    expect(out.text).toContain('P01: Being listened to.');
    expect(out.text).not.toContain('Patel');
  });
});

describe('passage boundaries', () => {
  it('starts flagged passages after the speaker label, including VTT voice tags', () => {
    const info = analyseTranscript(VTT)!;
    const flags = contextualFlags(VTT, info);
    expect(flags.map((f) => f.text)).toContain('My daughter, she works at the Co-op in Harehills.');
    for (const f of flags) expect(f.text).not.toMatch(/^[>:\s]/);
  });
});

describe('name mentions', () => {
  it('finds relationship names and every later mention in any case', () => {
    const t = 'A: How is home?\nB: My daughter Amira helps.\nA: Good?\nB: amira says I do too much.\n';
    const info = analyseTranscript(t)!;
    expect(relationshipNames(t)).toEqual(['Amira']);
    const found = nameMentionSpans(t, relationshipNames(t), info, []).map((s) => s.text);
    expect(found).toEqual(['Amira', 'amira']);
  });

  it('treats the WEBVTT header as structure', () => {
    const info = analyseTranscript(VTT)!;
    expect(info.structuralSpans.some((s) => s.start === 0 && VTT.slice(s.start, s.end) === 'WEBVTT')).toBe(true);
  });
});

describe('meeting chat logs', () => {
  const CHAT = `10:02:33 From Sarah Okafor to Everyone:
\tWelcome everyone, please say hello.
10:02:51 From Helen Carter to Everyone:
\tHi, I'm joining from the ward.
10:03:10 From Mo Rahman to Sarah Okafor(Direct Message):
\tCan I leave early?
10:03:40\t From  Helen Carter : sorry, my camera is off
`;

  it('reads senders and direct-message recipients, not "Everyone"', () => {
    const info = analyseTranscript(CHAT)!;
    expect(info.kind).toBe('CHAT');
    expect(info.speakers.map((s) => s.label).sort()).toEqual(['Helen Carter', 'Mo Rahman', 'Sarah Okafor']);
    expect(info.labelSpans.some((l) => l.speaker === 'Everyone')).toBe(false);
  });

  it('replaces every sender and recipient', async () => {
    const info = analyseTranscript(CHAT)!;
    const det = detect(CHAT, speakerSpans(CHAT, info));
    const out = await replaceSpans(CHAT, dropStructural(det.spans, info), [], {
      mode: 'ANONYMISE',
      quasiToRedact: new Set(),
      labeller: transcriptLabeller(info, true, []),
    });
    expect(out.text).not.toMatch(/Okafor|Carter|Rahman/);
    expect(out.text).toContain('to Everyone:');
    expect(out.text).toContain('10:02:33 From [');
  });
});

describe('real-transcript safeguards', () => {
  it('treats a misheard spelling of a speaker as that speaker', async () => {
    const t = `Lena Moretti: Thanks.\nMarcos Delgado: Okay.\nLena Moretti: Thank you for everything, Marcus. Bye-bye.\nMarcos Delgado: Bye.\n`;
    const info = analyseTranscript(t)!;
    const det = detectTranscript(t, info, []);
    const out = await replaceSpans(t, det.spans, [], {
      mode: 'ANONYMISE', quasiToRedact: new Set(), labeller: transcriptLabeller(info, true, []),
    });
    expect(out.text).toContain('Thank you for everything, [Participant 2].');
    // Ordinary words close to a name are not touched.
    expect(isSpeakerVariant('Hello', 'Helen')).toBe(false);
    expect(isSpeakerVariant('Marcus', 'Marcos')).toBe(true);
    const t2 = `Helen Carter: hello there.\nSam Lee: Hello Helen.\nHelen Carter: yes.\nSam Lee: ok.\n`;
    const i2 = analyseTranscript(t2)!;
    expect(speakerSpans(t2, i2).map((s) => s.text)).not.toContain('Hello');
  });

  it('does not spread a mis-tagged common word to every mention', () => {
    const t = `A: But why?\nB: but it works, and it is fine.\nA: But ok.\nB: fine.\n`;
    const info = analyseTranscript(t)!;
    const fakeNer = [{ start: 3, end: 6, text: 'But', label: 'NAME' as const, category: 'HIPAA' as const, source: 'ner' as const, confidence: 0.99 }];
    const det = detectTranscript(t, info, fakeNer);
    expect(det.spans.filter((s) => s.text.toLowerCase() === 'but')).toHaveLength(1);
  });
});

describe('Spanish transcripts', () => {
  const ES = `Carmen Ortega: ¿Podrías describir tus síntomas?\nDiego Salas: Sí. Trabajo de administrativo y me cuesta concentrarme.\nCarmen Ortega: ¿Y en casa?\nDiego Salas: Mi hija Lucía me ayuda. Soy el único con esta enfermedad en el pueblo. lucía es muy buena.\n`;

  it('detects the language and flags Spanish context cues', () => {
    const info = analyseTranscript(ES)!;
    expect(info.language).toBe('es');
    const reasons = contextualFlags(ES, info).map((f) => f.reason);
    expect(reasons).toContain('Mentions where someone works');
    expect(reasons).toContain('Says something unique about a person');
  });

  it('finds relationship names in Spanish and every later mention', () => {
    const info = analyseTranscript(ES)!;
    expect(relationshipNames(ES)).toEqual(['Lucía']);
    const found = nameMentionSpans(ES, relationshipNames(ES), info, []).map((s) => s.text);
    expect(found).toEqual(['Lucía', 'lucía']);
  });

  it('counts only real questions, including ¿…?', () => {
    expect(hasRealQuestion('¿Podrías describir tus síntomas?')).toBe(true);
    expect(hasRealQuestion('Es así, ¿no?')).toBe(false);
    expect(hasRealQuestion('It was fine, right?')).toBe(false);
  });

  it('renumbers speakers when a role is changed', () => {
    const info = analyseTranscript(ES)!;
    const changed = relabelSpeakers(info.speakers.map((s) => (s.label === 'Carmen Ortega' ? { ...s, role: 'INTERVIEWER' as const } : { ...s, role: 'PARTICIPANT' as const })));
    expect(changed.map((s) => s.display)).toEqual(['Interviewer', 'Participant 1']);
  });
});

describe('Dutch and German transcripts', () => {
  const NL = `Interviewer: Hoe gaat het nu met u?\nP01: Het gaat wel. Ik werk bij het ziekenhuis in Utrecht en mijn dochter Anna helpt mij. anna is heel lief. Mijn nummer is nul zes een twee drie vier vijf zes zeven acht.\nInterviewer: Dank u.\nP01: Graag gedaan, ik heb het ook gewoon niet makkelijk.\n`;
  const DE = `Interviewer: Wie geht es Ihnen?\nP01: Es geht. Ich arbeite bei der Stadt und meine Tochter Lena hilft mir. Ich bin die einzige mit dieser Krankheit im Dorf, das ist nicht einfach.\nInterviewer: Danke.\nP01: Gern, aber ich habe auch sehr viel Zeit.\n`;

  it('detects Dutch, its cues, relationship names and a spoken phone number', () => {
    const info = analyseTranscript(NL)!;
    expect(info.language).toBe('nl');
    expect(contextualFlags(NL, info).map((f) => f.reason)).toContain('Mentions where someone works');
    expect(relationshipNames(NL)).toEqual(['Anna']);
    expect(nameMentionSpans(NL, ['Anna'], info, []).map((s) => s.text)).toEqual(['Anna', 'anna']);
    expect(spokenIdentifierSpans(NL).some((s) => s.label === 'PHONE')).toBe(true);
  });

  it('detects German, its cues and relationship names', () => {
    const info = analyseTranscript(DE)!;
    expect(info.language).toBe('de');
    const reasons = contextualFlags(DE, info).map((f) => f.reason);
    expect(reasons).toContain('Mentions where someone works');
    expect(reasons).toContain('Says something unique about a person');
    expect(relationshipNames(DE)).toEqual(['Lena']);
  });

  it('strips Dutch, German and Spanish titles from names', () => {
    expect(nameParts('Dhr. Jansen')).toEqual(['Dhr. Jansen', 'Jansen']);
    expect(nameParts('Frau Müller')).toEqual(['Frau Müller', 'Müller']);
  });
});

describe('proper-noun safety net', () => {
  it('offers unusual names the model missed, once each, but not tools or calendar words', () => {
    const t = `Ana Ruiz: I discussed it with Oriol last week, and Oriol agreed.\nBen Cole: Did Toby use Zoom or PowerPoint in September?\nAna Ruiz: Only Excel, but Toby liked it.\nBen Cole: ok.\n`;
    const info = analyseTranscript(t)!;
    const det = detectTranscript(t, info, []);
    const offered = (det.uncertainSpans ?? []).map((s) => s.text);
    expect(offered).toEqual(['Oriol', 'Toby']);
  });

  it('skips words also used in lower case', () => {
    const t = `A: We saw the Garden, a garden center.\nB: Nice.\nA: The Garden again.\nB: ok.\n`;
    const info = analyseTranscript(t)!;
    expect(properNounCandidates(t, info, []).map((s) => s.text)).not.toContain('Garden');
  });
});
