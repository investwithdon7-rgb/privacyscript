import { describe, expect, it } from 'vitest';
import { detect, runRules } from '@/engine/detect';
import { replaceSpans } from '@/engine/replace';
import { generateSessionSecret } from '@/engine/crypto';
import { detectLanguage } from '@/engine/language';
import { suggestOrigin } from '@/engine/jurisdiction';

/**
 * Synthetic records in the six EU languages and Mexican Spanish. Every
 * identifier listed must be found by the RULES alone (no name model), and
 * must not survive anonymisation. People, numbers and places are invented.
 */
const RECORDS: Array<{ lang: string; country: string; text: string; ids: string[] }> = [
  {
    lang: 'es',
    country: 'ES',
    text: `Paciente: María García López
NHC: 4471902
DNI: 12345678Z
Fecha de nacimiento: 12 de marzo de 1951
Dirección: Calle Mayor 12, 28013 Madrid
Teléfono: +34 612 34 56 78
La Sra. García, de 92 años, acudió a la consulta con su hija Lucía. Médico: Dr. Javier Ruiz.
Se le pautó tratamiento y fue dada de alta en el Hospital Universitario La Paz.`,
    ids: ['María García López', '4471902', '12345678Z', '12 de marzo de 1951', 'Calle Mayor 12', '28013', '+34 612 34 56 78', 'García', '92', 'Lucía', 'Javier Ruiz'],
  },
  {
    lang: 'de',
    country: 'DE',
    text: `Patientin: Anna Müller
Fallnummer: 2024-88412
Krankenversichertennummer: A123456780
Geburtsdatum: 3. Mai 1930
Anschrift: Hauptstraße 5, 80331 München
Telefon: +49 89 1234567
Frau Müller (93 Jahre) wurde von ihrer Tochter Lena begleitet. Hausarzt: Dr. med. Klaus Weber.
Die Patientin wurde nach drei Tagen in gutem Zustand aus dem Klinikum Rechts der Isar entlassen.`,
    ids: ['Anna Müller', '2024-88412', 'A123456780', '3. Mai 1930', 'Hauptstraße 5', '80331', '+49 89 1234567', 'Müller', '93', 'Lena', 'Klaus Weber'],
  },
  {
    lang: 'fr',
    country: 'FR',
    text: `Nom : Dupont
Prénom : Jean
N° IPP : 7781234
NIR : 1 84 02 76 451 089 80
Né le 1er mars 1931
Adresse : 12 rue de la Paix, 75002 Paris
Tél : 06 12 34 56 78
M. Dupont, 91 ans, est venu avec sa fille Claire. Médecin traitant : Dr Sophie Martin.
Le patient est sorti de l'Hôpital Saint-Louis avec un traitement pour une semaine.`,
    ids: ['Dupont', 'Jean', '7781234', '1 84 02 76 451 089 80', '1er mars 1931', 'rue de la Paix', '75002', '06 12 34 56 78', '91', 'Claire', 'Sophie Martin'],
  },
  {
    lang: 'it',
    country: 'IT',
    text: `Paziente: Giuseppe Rossi
Codice fiscale: RSSMRA85T10A562S
Numero cartella clinica: 2024/5531
Nato il 15 aprile 1931
Indirizzo: Via Roma 10, 00184 Roma
Tel. +39 06 1234 5678
Il Sig. Rossi, 93 anni, è accompagnato da sua figlia Francesca. Medico: Dott.ssa Laura Bianchi.
Il paziente è stato dimesso dall'Ospedale San Raffaele e non ha avuto complicanze.`,
    ids: ['Giuseppe Rossi', 'RSSMRA85T10A562S', '2024/5531', '15 aprile 1931', 'Via Roma 10', '00184', '+39 06 1234 5678', 'Rossi', '93', 'Francesca', 'Laura Bianchi'],
  },
  {
    lang: 'nl',
    country: 'NL',
    text: `Patiënt: Jan de Vries
BSN: 111222333
Patiëntnummer: 8812345
Geboortedatum: 12 maart 1932
Adres: Kerkstraat 1, 1012 AB Amsterdam
Telefoon: +31 6 12345678
Dhr. de Vries (91 jaar) kwam met zijn dochter Sanne. Huisarts: Dr. Pieter Bakker.
De patiënt werd na twee dagen ontslagen uit Ziekenhuis Rijnstate en is niet meer opgenomen.`,
    ids: ['Jan de Vries', '111222333', '8812345', '12 maart 1932', 'Kerkstraat 1', '1012 AB', '+31 6 12345678', 'de Vries', '91', 'Sanne', 'Pieter Bakker'],
  },
  {
    lang: 'pt',
    country: 'PT',
    text: `Utente: João Silva
Número de utente: 987654321
NIF: 123456789
Data de nascimento: 5 de junho de 1933
Morada: Rua Augusta 100, 1100-053 Lisboa
Telefone: +351 912 345 678
O Sr. Silva, 90 anos, veio com a sua filha Ana. Médico de família: Dra. Inês Costa.
O doente teve alta do Hospital de Santa Maria e também foi visto pela equipa.`,
    ids: ['João Silva', '987654321', '123456789', '5 de junho de 1933', 'Rua Augusta 100', '1100-053', '+351 912 345 678', 'Silva', '90', 'Ana', 'Inês Costa'],
  },
  {
    lang: 'es',
    country: 'MX',
    text: `Paciente: José Hernández Pérez
CURP: GODE561231HDFRRN09
Teléfono: +52 55 1234 5678
Fecha de nacimiento: 31 de diciembre de 1956
El Sr. Hernández acudió con su esposa Rosa. Fue valorado y se le dio de alta.`,
    ids: ['José Hernández Pérez', 'GODE561231HDFRRN09', '+52 55 1234 5678', '31 de diciembre de 1956', 'Hernández', 'Rosa'],
  },
];

const covered = (text: string, spans: Array<{ start: number; end: number; captureStart?: number; captureEnd?: number }>, needle: string) => {
  let from = 0;
  for (let i = text.indexOf(needle, from); i >= 0; i = text.indexOf(needle, from)) {
    if (spans.some((s) => (s.captureStart ?? s.start) <= i && (s.captureEnd ?? s.end) >= i + needle.length)) return true;
    from = i + 1;
  }
  return false;
};

describe('EU language records (rules only)', () => {
  for (const r of RECORDS) {
    it(`${r.country}: every identifier found, none left after anonymising`, async () => {
      const det = detect(r.text, []);
      const all = [...det.spans, ...det.quasiSpans];
      const missed = r.ids.filter((id) => !covered(r.text, all, id));
      expect(missed, `missed in ${r.country}`).toEqual([]);

      const out = await replaceSpans(r.text, det.spans, det.quasiSpans, {
        mode: 'ANONYMISE',
        quasiToRedact: new Set(det.quasiSpans.map((q) => q.label)),
      });
      for (const id of r.ids.filter((x) => x.length > 3 && !/^\d{2}$/.test(x))) {
        expect(out.text, `${r.country} output`).not.toContain(id);
      }
    });

    it(`${r.country}: language and origin`, () => {
      expect(detectLanguage(r.text).lang).toBe(r.lang);
      const origin = suggestOrigin(r.text, runRules(r.text));
      expect(origin?.country).toBe(r.country);
      expect(origin?.confident).toBe(true);
    });
  }

  it('keeps the year of a month-and-year date when anonymising', async () => {
    for (const [text, out] of [
      ['Erstdiagnose im Juni 2020.', 'Erstdiagnose im 2020.'],
      ['Diagnosticado en octubre de 2016.', 'Diagnosticado en 2016.'],
      ['Rezidiv 03/2019.', 'Rezidiv 2019.'],
    ] as const) {
      const det = detect(text, []);
      const res = await replaceSpans(text, det.spans, det.quasiSpans, { mode: 'ANONYMISE', quasiToRedact: new Set() });
      expect(res.text, text).toBe(out);
    }
  });

  it('shifts month-name dates in their own language and style', async () => {
    const secret = await generateSessionSecret();
    for (const [text, re] of [
      ['Ingreso el 12 de marzo de 2024.', /^Ingreso el \d{2} de [a-z]+ de \d{4}\.$/],
      ['Aufnahme am 3. Mai 2024.', /^Aufnahme am \d{1,2}\. [A-ZÄÖÜ][a-zäöü]+ \d{4}\.$/],
      ['Opname op 12 maart 2024.', /^Opname op \d{2} [a-z]+ \d{4}\.$/],
      ['Aufnahme am 12.03.2024.', /^Aufnahme am \d{2}\.\d{2}\.\d{4}\.$/],
    ] as const) {
      const det = detect(text, []);
      const out = await replaceSpans(text, det.spans, det.quasiSpans, { mode: 'PSEUDONYMISE', secret, quasiToRedact: new Set() });
      expect(out.text, text).toMatch(re);
      expect(out.text).not.toBe(text);
    }
  });

  it('does not read insurance or ID-card keywords inside ordinary words or names', () => {
    // "NIR", "CC", "CNI" are case-insensitive keywords: they must end a word
    // and be followed by a value with a digit.
    const text = 'Ich bin die Nirina. Nirgends war es besser. Accident and Cnidaria. Nir called.';
    const labels = runRules(text).map((s) => s.label);
    expect(labels).not.toContain('INSURANCE_ID');
    expect(labels).not.toContain('NATIONAL_ID');
    expect(runRules('Versichertennummer: A123456780').some((s) => s.label === 'INSURANCE_ID')).toBe(true);
    expect(runRules('NIR : 1 84 02 76 451 089 80').some((s) => s.text === '1 84 02 76 451 089 80')).toBe(true);
  });

  it('does not take ordinary numbers or English phrases for identifiers', () => {
    const text = 'The meeting took place Monday. Dose 10000 units daily. Order 123456789 was shipped. Call ext 4471.';
    const labels = runRules(text).map((s) => `${s.label}:${s.text}`);
    expect(labels.filter((l) => /NATIONAL_ID|ADDRESS_LINE|POSTCODE_EU/.test(l))).toEqual([]);
  });
});

describe('language detection on short notes', () => {
  it.each([
    ['es', 'La Sra. García, de 92 años, acudió a la consulta con su hija Lucía. Fue dada de alta en el hospital.'],
    ['pt', 'O Sr. Silva, de 90 anos, veio com a sua filha Ana e teve alta do hospital no mesmo dia.'],
    ['it', 'Il Sig. Rossi, di 93 anni, è stato dimesso con la figlia Francesca dopo la visita.'],
    ['fr', 'M. Dupont, 91 ans, est venu avec sa fille Claire pour la consultation de suivi.'],
    ['de', 'Frau Müller wurde von ihrer Tochter Lena zur Kontrolle in die Klinik begleitet.'],
    ['nl', 'Dhr. de Vries kwam met zijn dochter Sanne naar het ziekenhuis voor controle.'],
    ['en', 'Mrs Smith came to the clinic with her daughter and was discharged on the same day.'],
  ])('%s', (lang, text) => {
    expect(detectLanguage(text).lang).toBe(lang);
  });
});

// Rules added from the public benchmark datasets (scripts/benchmark.mjs).
// Every value here is made up.
describe('benchmark-driven rules', () => {
  const hidden = (text: string, needle: string) => {
    const det = detect(text, []);
    return covered(text, [...det.spans, ...det.quasiSpans], needle);
  };

  it.each([
    ['Ingreso el 24 November, revisión el 5 apr.', '24 November'],
    ['Controle op vrijdag 30 mei in de polikliniek.', '30 mei'],
    ['Erstdiagnose im Juni 2020, Rezidiv 03/2019.', 'Juni 2020'],
    ['Erstdiagnose im Juni 2020, Rezidiv 03/2019.', '03/2019'],
    ['Diagnosticado en octubre de 2016.', 'octubre de 2016'],
    ['Dr. Anna Beispiel, LANR: 123456789', '123456789'],
    ['N.º de colegiada: 28/40/21424', '28/40/21424'],
    ['RPPS : 10123456789', '10123456789'],
    ['Arts: RIZIV 1-23456-78-901', '1-23456-78-901'],
    ['Praktijk BTW BE 0123.456.789', 'BE 0123.456.789'],
    ['Rekening NL91 ABNA 0417 1643 00 op naam van de patiënt.', 'NL91 ABNA 0417 1643 00'],
    ['Betaald met creditcard 4111 1111 1111 1111.', '4111 1111 1111 1111'],
    ['Tel. 038372/5704-2, Fax (035201) 8644-4', '038372/5704-2'],
    ['Tel. 038372/5704-2, Fax (035201) 8644-4', '(035201) 8644-4'],
    ['Adres: Lindedreef 12, 8540 Deerlijk', 'Lindedreef 12'],
    ['Adres: Lindedreef 12, 8540 Deerlijk', '8540 Deerlijk'],
    ['Wohnhaft Kevin-Muster-Allee 134, 01705 Freital', 'Kevin-Muster-Allee 134'],
    ['Domicilio: c/ del Abedul 5-7, 2º dcha', 'c/ del Abedul 5-7, 2º dcha'],
    ['Seattle, WA 98101', 'Seattle'],
    ['Opgehaald op GPS-coördinaten 52.3667, 4.8945.', '52.3667, 4.8945'],
    ['Station: G7, Zimmer 72', 'G7'],
    ['Fallkennung: D79011228', 'D79011228'],
    ['Número de episodio: D44573494', 'D44573494'],
    ['Toestel IMEI 490154203237518, MAC 00:1A:2B:3C:4D:5E', '490154203237518'],
    ['Toestel IMEI 490154203237518, MAC 00:1A:2B:3C:4D:5E', '00:1A:2B:3C:4D:5E'],
    ['Het kenteken NL-AB1234 stond op de parkeerplaats.', 'NL-AB1234'],
    ['Website: helios-beispielklinikum.de', 'helios-beispielklinikum.de'],
    ['Oberärztin\nek/pf', 'ek/pf'],
  ])('hides it: %s', (text, needle) => {
    expect(hidden(text, needle), needle).toBe(true);
  });

  it.each([
    ['Schmerz 3.0/10, Schema 40-0-40, Ratio 9/40/10.', ['3.0/10', '40-0-40']],
    ['Sehr geehrte Frau Kollegin, sehr geehrter Herr Doktor,', ['Kollegin', 'Doktor']],
    ['The patient identity was confirmed; GMC registration pending.', ['identity', 'registration']],
    ['Care for professionnels de santé and occupational therapy.', ['professionnels', 'occupational']],
    ['Paciente: No, no me duele. Médico: Bueno.', ['No', 'Bueno']],
    ['Vía oral 2 comprimidos; en la calle hace 3 días.', ['oral 2', 'calle hace 3']],
    ['Insulin 1000 IE subkutan; result 1/2000 dilution.', ['1000 IE']],
    ['Werte in mg/dl\nmg/dl', ['mg/dl']],
    ['Standard ISO-27001 and code ICD-10 applied.', ['ISO-27001']],
    ['Nirgends war es besser, Nirina.', ['Nirgends']],
  ])('leaves ordinary text alone: %s', (text, words) => {
    const det = detect(text, []);
    for (const w of words) expect(covered(text, [...det.spans, ...det.quasiSpans], w), w).toBe(false);
  });
});
