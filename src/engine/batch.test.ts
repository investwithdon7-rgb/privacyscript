/**
 * Batch engine tests: study-wide labels across interviews, honest skipping,
 * and holding back output that fails a non-negotiable check.
 * All people are fictitious.
 */

import { describe, expect, it } from 'vitest';
import { Crypto } from '@peculiar/webcrypto';
import { finaliseFile, prepareFile, type PreparedFile } from '@/engine/batch';
import { assignStudySpeakers, createLabelRegistry } from '@/engine/transcript';
import { generateSessionSecret } from '@/engine/crypto';

if (typeof globalThis.crypto?.subtle === 'undefined') {
  (globalThis as { crypto: Crypto }).crypto = new Crypto();
}

const noNer = async () => [];

const INTERVIEW_1 = `Sarah Okafor: How has your recovery been?
Helen Carter: Slow. Dr Patel at the surgery has been great.
Sarah Okafor: Who else helps?
Helen Carter: My son Tom visits on Sundays.
`;
const INTERVIEW_2 = `Sarah Okafor: How has your recovery been?
Mo Rahman: Better now. I see Dr Patel every month.
Sarah Okafor: Anything else?
Mo Rahman: I'm the only Somali nurse on the ward, so people know me.
`;

const file = (name: string, text: string) => new File([text], name, { type: 'text/plain' });

async function prepareStudy() {
  const prepared: PreparedFile[] = [];
  for (const [i, f] of [
    file('interview_01.txt', INTERVIEW_1),
    file('interview_02.txt', INTERVIEW_2),
    file('survey.csv', 'name,age\nA,1\n'),
  ].entries()) {
    prepared.push(await prepareFile(f, String(i), noNer));
  }
  assignStudySpeakers(prepared.flatMap((p) => (p.transcript ? [p.transcript.info] : [])));
  return prepared;
}

describe('batch preparation', () => {
  it('skips surveys with a plain reason instead of faking output', async () => {
    const [, , survey] = await prepareStudy();
    expect(survey.skipReason).toMatch(/column review/);
    expect(survey.detection).toBeUndefined();
  });

  it('labels speakers once across the study', async () => {
    const [a, b] = await prepareStudy();
    const display = (p: PreparedFile, label: string) =>
      p.transcript!.info.speakers.find((s) => s.label === label)!.display;
    expect(display(a, 'Sarah Okafor')).toBe('Interviewer');
    expect(display(b, 'Sarah Okafor')).toBe('Interviewer');
    expect(display(a, 'Helen Carter')).toBe('Participant 1');
    expect(display(b, 'Mo Rahman')).toBe('Participant 2');
  });
});

describe('batch finalisation', () => {
  it('uses study-wide readable labels and a single shared registry', async () => {
    const [a, b] = await prepareStudy();
    const registry = createLabelRegistry();
    const secret = await generateSessionSecret();
    const common = { mode: 'PSEUDONYMISE' as const, profileId: 'GDPR_PSEUDO' as const, secret, readable: true, registry };
    const outA = await finaliseFile(a, { ...common, decisions: {} });
    const outB = await finaliseFile(b, {
      ...common,
      decisions: Object.fromEntries(b.transcript!.flags.map((f) => [f.id, 'remove' as const])),
    });
    const textA = outA.output as string;
    const textB = outB.output as string;
    expect(textA).toContain('[Interviewer]: How has your recovery been?');
    expect(textB).toContain('[Participant 2]: Better now.');
    // Dr Patel is the same numbered person in both interviews.
    const patelA = /Dr (\[Person \d+\])/.exec(textA)![1];
    expect(textB).toContain(`Dr ${patelA}`);
    expect(textB).toContain('[identifying detail removed]');
    expect(outA.heldBack).toBeUndefined();
    expect(outA.outputName).toBe('interview_01.deidentified.txt');
    for (const name of ['Helen', 'Carter', 'Okafor', 'Rahman', 'Patel', 'Tom']) {
      expect(textA + textB).not.toContain(name);
    }
  });
});
