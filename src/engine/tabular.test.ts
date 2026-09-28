/**
 * Survey / tabular engine tests against a synthetic Qualtrics-style export.
 * All people, emails and postcodes below are fictitious.
 */

import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { Crypto } from '@peculiar/webcrypto';
import { parseCsv } from '@/formats/csv';
import { readXlsxGrid, xlsxToCsv } from '@/formats/xlsx';
import { generateSessionSecret } from '@/engine/crypto';
import {
  applyPlans,
  autoFix,
  detectPlatform,
  generaliseValue,
  measureRisk,
  parseDate,
  shiftDateValue,
  suggestPlans,
  type ColumnPlan,
} from '@/engine/tabular';

if (typeof globalThis.crypto?.subtle === 'undefined') {
  (globalThis as { crypto: Crypto }).crypto = new Crypto();
}

const GENDERS = ['Female', 'Male'];
const POSTCODES = ['LS6 3AB', 'LS6 1QT', 'LS2 9JT', 'M14 5RW'];

function qualtricsCsv(n: number): string {
  const header =
    'StartDate,EndDate,IPAddress,ResponseId,RecipientEmail,LocationLatitude,LocationLongitude,Q1_Age,Q2_Gender,Q3_Postcode,Q4_Satisfaction,Q5_Comments';
  const question =
    'Start Date,End Date,IP Address,Response ID,Recipient Email,Location Latitude,Location Longitude,What is your age?,What is your gender?,What is your postcode?,How satisfied are you?,Any other comments?';
  const importIds = Array.from({ length: 12 }, (_, i) => `"{""ImportId"":""QID${i}""}"`).join(',');
  const rows: string[] = [];
  for (let i = 0; i < n; i++) {
    const age = 22 + ((i * 7) % 60);
    const comment =
      i === 3
        ? 'My GP Dr Helen Carter was great, call me on 07700 900123'
        : 'The clinic staff were helpful and the waiting room was clean.';
    rows.push(
      [
        `2024-03-${String((i % 27) + 1).padStart(2, '0')} 10:${String(i % 60).padStart(2, '0')}:00`,
        `2024-03-${String((i % 27) + 1).padStart(2, '0')} 10:${String((i + 5) % 60).padStart(2, '0')}:00`,
        `81.2.${i % 250}.${(i * 3) % 250}`,
        `R_${(1000 + i).toString(36)}Xy${i}`,
        `person${i}@example.org`,
        '53.8' + (i % 9),
        '-1.5' + (i % 9),
        String(age),
        GENDERS[i % 2],
        POSTCODES[i % POSTCODES.length],
        String((i % 5) + 1),
        `"${comment}"`,
      ].join(',')
    );
  }
  return [header, question, importIds, ...rows].join('\n');
}

describe('platform detection and column suggestions', () => {
  const csv = parseCsv(qualtricsCsv(60));
  const platform = detectPlatform(csv.headers, csv.rows);
  const data = csv.rows.slice(platform.metaRowCount);
  const plans = suggestPlans(csv.headers, data, 'ANONYMISE');
  const role = (c: string) => plans.find((p) => p.column === c)!;

  it('recognises a Qualtrics export and its two meta header rows', () => {
    expect(platform.id).toBe('QUALTRICS');
    expect(platform.metaRowCount).toBe(2);
    expect(data).toHaveLength(60);
  });

  it('marks platform identifiers as identifying', () => {
    for (const c of ['IPAddress', 'ResponseId', 'RecipientEmail', 'LocationLatitude', 'LocationLongitude']) {
      expect(role(c).role).toBe('DIRECT');
    }
  });

  it('treats demographics as quasi-identifiers with the right kind', () => {
    expect(role('Q1_Age')).toMatchObject({ role: 'QUASI', kind: 'age', generaliser: 'age_5' });
    expect(role('Q2_Gender')).toMatchObject({ role: 'QUASI', kind: 'category' });
    expect(role('Q3_Postcode')).toMatchObject({ role: 'QUASI', kind: 'postcode' });
    expect(role('StartDate')).toMatchObject({ role: 'QUASI', kind: 'date', generaliser: 'year' });
  });

  it('keeps scale answers and scans long comments as written text', () => {
    expect(role('Q4_Satisfaction').role).toBe('KEEP');
    expect(role('Q5_Comments').role).toBe('FREE_TEXT');
  });

  it('does not treat "preference" as a reference ID or "time" questions as dates', () => {
    const p = suggestPlans(
      ['Preference for contact', 'How much time do you spend outdoors?'],
      [{ 'Preference for contact': 'Email', 'How much time do you spend outdoors?': '1-2 hours' }],
      'ANONYMISE'
    );
    expect(p[0].role).not.toBe('DIRECT');
    expect(p[1].role).not.toBe('QUASI');
  });
});

describe('generalisers', () => {
  const plan = (column: string, generaliser: ColumnPlan['generaliser'], kind: ColumnPlan['kind']): ColumnPlan => ({
    column, role: 'QUASI', kind, generaliser, reason: '',
  });
  const now = new Date('2026-09-28');

  it('bands ages and always renders 90+ for over 89', () => {
    expect(generaliseValue('34', plan('age', 'age_5', 'age'), now)).toBe('30-34');
    expect(generaliseValue('34', plan('age', 'age_10', 'age'), now)).toBe('30-39');
    expect(generaliseValue('87', plan('age', 'age_10', 'age'), now)).toBe('80-89');
    expect(generaliseValue('93', plan('age', 'age_5', 'age'), now)).toBe('90+');
    expect(generaliseValue('Prefer not to say', plan('age', 'age_5', 'age'), now)).toBeNull();
  });

  it('generalises dates and caps birth years for the over-89s', () => {
    expect(generaliseValue('2024-03-05 10:22:11', plan('StartDate', 'year_month', 'date'), now)).toBe('2024-03');
    expect(generaliseValue('05/03/2024', plan('StartDate', 'year', 'date'), now)).toBe('2024');
    expect(generaliseValue('1931-01-01', plan('Date of birth', 'year', 'date'), now)).toBe('1936 or earlier');
    expect(parseDate('13/04/2024')).toEqual({ year: 2024, month: 4 });
    expect(parseDate('04/05/2024')).toEqual({ year: 2024, month: null });
  });

  it('cuts postcodes to district/area and zeroes restricted ZIP3s', () => {
    expect(generaliseValue('LS6 3AB', plan('pc', 'postcode_district', 'postcode'), now)).toBe('LS6');
    expect(generaliseValue('ls6 3ab', plan('pc', 'postcode_area', 'postcode'), now)).toBe('LS');
    expect(generaliseValue('90210', plan('zip', 'postcode_district', 'postcode'), now)).toBe('902xx');
    expect(generaliseValue('03601', plan('zip', 'postcode_district', 'postcode'), now)).toBe('000xx');
  });
});

describe('k-anonymity and auto-fix', () => {
  const csv = parseCsv(qualtricsCsv(60));
  const platform = detectPlatform(csv.headers, csv.rows);
  const data = csv.rows.slice(platform.metaRowCount);

  it('measures real k across rows — exact ages make people unique', () => {
    const plans = suggestPlans(csv.headers, data, 'ANONYMISE').map((p) =>
      p.kind === 'age' ? { ...p, generaliser: 'none' as const } : p
    );
    const risk = measureRisk(data, plans, 5);
    expect(risk.k).toBeLessThan(5);
    expect(risk.rowsAtRisk).toBeGreaterThan(0);
    expect(risk.quasiColumns).toContain('Q1_Age');
  });

  it('auto-fix reaches k ≥ 5 without silently removing columns', () => {
    const plans = suggestPlans(csv.headers, data, 'ANONYMISE').map((p) =>
      p.kind === 'age' ? { ...p, generaliser: 'none' as const } : p
    );
    const fixed = autoFix(data, plans, 5, 'ANONYMISE');
    expect(fixed.risk.k).toBeGreaterThanOrEqual(5);
    expect(fixed.plans.some((p) => p.role === 'QUASI' && p.generaliser === 'suppress')).toBe(false);
    expect(fixed.notes.length).toBeGreaterThan(0);
  });

  it('reports l-diversity when a sensitive column is uniform within a group', () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ sex: i < 5 ? 'F' : 'M', dx: i < 5 ? 'Asthma' : String(i) }));
    const plans: ColumnPlan[] = [
      { column: 'sex', role: 'QUASI', kind: 'category', generaliser: 'none', reason: '' },
      { column: 'dx', role: 'SENSITIVE', kind: 'category', generaliser: 'none', reason: '' },
    ];
    expect(measureRisk(rows, plans, 5).l).toBe(1);
  });
});

describe('applying the plan', () => {
  const csv = parseCsv(qualtricsCsv(20));
  const platform = detectPlatform(csv.headers, csv.rows);
  const data = csv.rows.slice(platform.metaRowCount);

  async function run(mode: 'ANONYMISE' | 'PSEUDONYMISE') {
    const plans = suggestPlans(csv.headers, data, mode);
    const secret = mode === 'PSEUDONYMISE' ? await generateSessionSecret() : undefined;
    return applyPlans({
      headers: csv.headers,
      originalRows: csv.rows,
      engineRows: csv.rows, // engine output stand-in
      metaRowCount: platform.metaRowCount,
      plans,
      suppressedRows: [],
      mode,
      secret,
      kThreshold: 5,
    });
  }

  it('anonymise: drops identifying columns and generalises quasi columns', async () => {
    const out = await run('ANONYMISE');
    expect(out.headers).not.toContain('IPAddress');
    expect(out.headers).not.toContain('RecipientEmail');
    expect(out.removedColumns).toContain('LocationLatitude');
    const first = out.rows[platform.metaRowCount];
    expect(first.Q1_Age).toMatch(/^\d+-\d+$|^90\+$/);
    expect(first.Q3_Postcode).toMatch(/^[A-Z]{1,2}\d{1,2}$/);
    expect(first.StartDate).toBe('2024');
    expect(first.Q4_Satisfaction).toMatch(/^[1-5]$/);
    // Meta rows (question text) preserved.
    expect(out.rows[0].Q1_Age).toBe('What is your age?');
    expect(out.directOriginals).toContain('person0@example.org');
    expect(Object.keys(out.mapping)).toHaveLength(0);
  });

  it('pseudonymise: replaces identifiers with consistent codes kept in the key mapping', async () => {
    const out = await run('PSEUDONYMISE');
    expect(out.headers).toContain('RecipientEmail');
    const email = out.rows[platform.metaRowCount].RecipientEmail;
    expect(email).toMatch(/^\[EMAIL-[0-9A-F]{8}\]$/);
    expect(out.mapping['person0@example.org']).toBe(email);
    expect(JSON.stringify(out.rows)).not.toContain('person0@example.org');
  });

  it('hides quasi values of suppressed rows', async () => {
    const plans = suggestPlans(csv.headers, data, 'ANONYMISE');
    const out = await applyPlans({
      headers: csv.headers, originalRows: csv.rows, engineRows: csv.rows,
      metaRowCount: platform.metaRowCount, plans, suppressedRows: [0],
      mode: 'ANONYMISE', kThreshold: 5,
    });
    const row = out.rows[platform.metaRowCount];
    expect(row.Q1_Age).toBe('*');
    expect(row.Q2_Gender).toBe('*');
    expect(row.Q4_Satisfaction).not.toBe('*');
  });
});

describe('xlsx reader', () => {
  async function buildXlsx(): Promise<ArrayBuffer> {
    const zip = new JSZip();
    zip.file('xl/workbook.xml', '<workbook xmlns:r="r"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>');
    zip.file('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/></Relationships>');
    zip.file('xl/sharedStrings.xml', '<sst><si><t>Name</t></si><si><t>Age</t></si><si><t>Seen</t></si><si><r><t>Ada </t></r><r><t>Lovelace &amp; co</t></r></si></sst>');
    zip.file('xl/styles.xml', '<styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>');
    zip.file(
      'xl/worksheets/sheet1.xml',
      '<worksheet><sheetData>' +
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>' +
        '<row r="2" spans="1:3"><c r="A2" t="s"><v>3</v></c><c r="B2"><v>36</v></c><c r="C2" s="1"><v>45356</v></c></row>' +
        '<row r="3"/>' +
        '<row r="4"><c r="C4" t="inlineStr"><is><t>later</t></is></c></row>' +
      '</sheetData></worksheet>'
    );
    return zip.generateAsync({ type: 'arraybuffer' });
  }

  it('reads shared/inline strings, numbers, dates and sparse cells', async () => {
    const grid = await readXlsxGrid(await buildXlsx());
    expect(grid[0]).toEqual(['Name', 'Age', 'Seen']);
    expect(grid[1]).toEqual(['Ada Lovelace & co', '36', '2024-03-05']);
    expect(grid[3][2]).toBe('later');
  });

  it('converts to CSV the CSV parser accepts', async () => {
    const csv = parseCsv(await xlsxToCsv(await buildXlsx()));
    expect(csv.headers).toEqual(['Name', 'Age', 'Seen']);
    expect(csv.rows[0].Name).toBe('Ada Lovelace & co');
  });
});

describe('date shifting (pseudonymise)', () => {
  it('shifts ISO timestamps and keeps the time of day', () => {
    expect(shiftDateValue('2024-03-01 10:00:00', -18)).toBe('2024-02-12 10:00:00');
    expect(shiftDateValue('2024-03-01', 1)).toBe('2024-03-02');
  });

  it('keeps day/month order and uses the column order when ambiguous', () => {
    expect(shiftDateValue('13/04/2024', 1)).toBe('14/04/2024');
    expect(shiftDateValue('04/13/2024', 1)).toBe('04/14/2024');
    expect(shiftDateValue('04/05/2024', 1)).toBeNull();
    expect(shiftDateValue('04/05/2024', 1, 'DMY')).toBe('05/05/2024');
    expect(shiftDateValue('31/02/2024', 1)).toBeNull();
  });
});
