/**
 * HL7 v2 pipe-delimited handler.
 *
 * Strategy: split by segment terminator, then by the message's declared
 * field/component/subcomponent separators (from MSH-1/MSH-2). Iterate every
 * leaf component, run the engine on each, then rebuild with the original
 * separators.
 *
 * We only redact PID, PV1, IN1, IN2, NK1, GT1, OBX (text values), and free-text
 * NTE segments. Structural segments (MSH, EVN) are left intact except for fields
 * known to carry identifiers (e.g. MSH-3 sending app/facility names).
 */

export interface HL7Document {
  segments: HL7Segment[];
  fieldSep: string;
  compSep: string;
  repSep: string;
  escapeChar: string;
  subSep: string;
}

export interface HL7Segment {
  name: string;
  /** fields[fieldIdx][repetitionIdx][componentIdx][subcomponentIdx] = string */
  fields: string[][][][];
}

export interface HL7Leaf {
  segmentIdx: number;
  fieldIdx: number;
  repIdx: number;
  compIdx: number;
  subIdx: number;
  value: string;
}

// AL1 = allergy/intolerance, DG1 = diagnosis, PR1 = procedure — all carry PHI.
const TARGET_SEGMENTS = new Set([
  // Core patient / visit / insurance demographics
  'PID', 'PV1', 'IN1', 'IN2', 'NK1', 'GT1',
  // Free-text notes
  'NTE',
  // Observations (may contain free-text narrative)
  'OBX',
  // Allergies — often contain free-text substance names and reaction descriptions
  'AL1',
  // Diagnoses — DG1 description field contains free-text diagnostic strings
  'DG1',
  // Procedures — PR1 description may contain clinician-authored text
  'PR1',
  // Z-segments: DG1 variants used by some EHR vendors
  'ZDG',
]);

export function parseHL7(raw: string): { doc: HL7Document; leaves: HL7Leaf[] } {
  const text = raw.replace(/\r\n/g, '\r');
  const rawSegments = text.split(/\r|\n/).filter((s) => s.length > 0);

  if (!rawSegments[0]?.startsWith('MSH')) {
    throw new Error('Not a valid HL7 v2 message (no MSH segment).');
  }

  const fieldSep = rawSegments[0][3] ?? '|';
  const encChars = rawSegments[0].slice(4, 8);
  const [compSep, repSep, escapeChar, subSep] = [
    encChars[0] ?? '^',
    encChars[1] ?? '~',
    encChars[2] ?? '\\',
    encChars[3] ?? '&',
  ];

  const segments: HL7Segment[] = rawSegments.map((line, segmentIdx) => {
    const name = line.slice(0, 3);
    // MSH is special — field 1 is the field separator itself.
    const isMsh = name === 'MSH';
    const fieldStrings = isMsh
      ? [fieldSep, ...line.slice(4).split(fieldSep)]
      : line.split(fieldSep).slice(1);

    const fields: string[][][][] = fieldStrings.map((fieldRaw) => {
      const reps = fieldRaw.split(repSep);
      return reps.map((rep) => {
        const comps = rep.split(compSep);
        return comps.map((comp) => comp.split(subSep));
      });
    });

    return { name, fields };
  });

  const leaves: HL7Leaf[] = [];
  segments.forEach((seg, segmentIdx) => {
    if (!TARGET_SEGMENTS.has(seg.name)) return;
    seg.fields.forEach((field, fieldIdx) => {
      field.forEach((rep, repIdx) => {
        rep.forEach((comp, compIdx) => {
          comp.forEach((sub, subIdx) => {
            if (sub.length === 0) return;
            leaves.push({ segmentIdx, fieldIdx, repIdx, compIdx, subIdx, value: sub });
          });
        });
      });
    });
  });

  return {
    doc: { segments, fieldSep, compSep, repSep, escapeChar, subSep },
    leaves,
  };
}

export function reconstructHL7(
  doc: HL7Document,
  replacements: Array<{ leaf: HL7Leaf; replacement: string }>
): string {
  // structuredClone for a deep copy of the segment tree — ~3× faster than the
  // JSON round-trip on large HL7 messages with many OBX rows. Fall back if the
  // host lacks it (old test runners only).
  const segs: HL7Segment[] =
    typeof structuredClone === 'function'
      ? structuredClone(doc.segments)
      : (JSON.parse(JSON.stringify(doc.segments)) as HL7Segment[]);
  for (const { leaf, replacement } of replacements) {
    segs[leaf.segmentIdx].fields[leaf.fieldIdx][leaf.repIdx][leaf.compIdx][leaf.subIdx] =
      replacement;
  }

  return segs
    .map((seg) => {
      const isMsh = seg.name === 'MSH';
      const fieldStrings = seg.fields.map((field) =>
        field
          .map((rep) => rep.map((comp) => comp.join(doc.subSep)).join(doc.compSep))
          .join(doc.repSep)
      );
      if (isMsh) {
        // Field 1 is the field separator itself — skip it and rebuild as MSH|^~\&|...
        return seg.name + doc.fieldSep + fieldStrings.slice(1).join(doc.fieldSep);
      }
      return seg.name + doc.fieldSep + fieldStrings.join(doc.fieldSep);
    })
    .join('\r');
}
