/**
 * EU language pack: German, French, Spanish, Italian, Dutch and Portuguese
 * records (the six languages the name model was trained on), national ID
 * numbers of the main EU countries, and Mexico (Spanish-language records).
 *
 * Unlabelled national IDs are only accepted when their checksum holds, so a
 * random number of the same length is not redacted as an ID. Labelled
 * fields ("Fallnummer: …", "NHC: …") need no checksum.
 */

import type { IdentifierRule } from '@/lib/identifiers';

/* ----------------------------------------------------------------------------
 * Month names (dates are found and shifted / reduced to the year)
 * --------------------------------------------------------------------------*/

export type EuLang = 'de' | 'fr' | 'es' | 'it' | 'nl' | 'pt';

const MONTHS: Record<EuLang, { full: string[]; abbr: string[] }> = {
  de: {
    full: ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'],
    abbr: ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'],
  },
  fr: {
    full: ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'],
    abbr: ['janv', 'févr', 'mars', 'avr', 'mai', 'juin', 'juil', 'août', 'sept', 'oct', 'nov', 'déc'],
  },
  es: {
    full: ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'],
    abbr: ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'],
  },
  it: {
    full: ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'],
    abbr: ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'],
  },
  nl: {
    full: ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'],
    abbr: ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'],
  },
  pt: {
    full: ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'],
    abbr: ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'],
  },
};
// Spellings in use beside the main ones.
const EXTRA: Array<[string, number]> = [['Jänner', 1], ['Maerz', 3], ['Marz', 3], ['setiembre', 9], ['fevrier', 2], ['aout', 8], ['decembre', 12], ['marco', 3]];

export interface MonthWord {
  month: number;
  lang: EuLang;
  abbr: boolean;
}

// A word can be a month in several languages ("Mai": German, French,
// Portuguese); every reading is kept and the date's shape picks one.
const MONTH_WORDS = new Map<string, MonthWord[]>();
const addWord = (w: string, v: MonthWord) => {
  const k = w.toLowerCase();
  MONTH_WORDS.set(k, [...(MONTH_WORDS.get(k) ?? []), v]);
};
for (const lang of Object.keys(MONTHS) as EuLang[]) {
  MONTHS[lang].full.forEach((w, i) => addWord(w, { month: i + 1, lang, abbr: false }));
  MONTHS[lang].abbr.forEach((w, i) => {
    if (w.toLowerCase() !== MONTHS[lang].full[i].toLowerCase()) addWord(w, { month: i + 1, lang, abbr: true });
  });
}
for (const [w, m] of EXTRA) addWord(w, { month: m, lang: 'de', abbr: false });

/**
 * The month a word names. With the whole date as context the language is
 * chosen from its shape: "3. Mai" is German, "1er mai" French, "de maio"
 * Portuguese, "de mayo" Spanish.
 */
export function euMonth(word: string, date = ''): MonthWord | null {
  const options = MONTH_WORDS.get(word.toLowerCase().replace(/\.$/, '')) ?? [];
  if (options.length <= 1) return options[0] ?? null;
  const prefer: EuLang[] = /\d\.\s/.test(date)
    ? ['de']
    : /\d(?:er)\s/.test(date)
    ? ['fr']
    : /\sde\s/.test(date)
    ? ['pt', 'es']
    : ['fr', 'de', 'it', 'nl', 'es', 'pt'];
  return prefer.map((l) => options.find((o) => o.lang === l)).find(Boolean) ?? options[0];
}

/** The name of month `m` in the language and style of `like`, with its case. */
export function euMonthName(m: number, like: MonthWord, original: string): string {
  const list = like.abbr ? MONTHS[like.lang].abbr : MONTHS[like.lang].full;
  const name = list[m - 1];
  if (original[0] === original[0].toUpperCase()) return name[0].toUpperCase() + name.slice(1);
  return name.toLowerCase();
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MONTH_ALT = Array.from(MONTH_WORDS.keys())
  .sort((a, b) => b.length - a.length)
  .map(escape)
  .join('|');

/**
 * "12 de marzo de 2024", "12. März 2024", "12 maart 2024", "1er mars 2024",
 * "12 marzo 2024", "12 de março de 2024".
 */
export const EU_DATE_SHAPE = String.raw`(\d{1,2})(\.|º|°|er|ª)?\s+(?:de\s+)?(${MONTH_ALT})\.?\s+(?:de\s+)?(\d{4})`;
// Detection uses no capture groups: the engine redacts the first capture.
const EU_DATE_PATTERN = new RegExp(
  String.raw`(?<![\p{L}\d])${EU_DATE_SHAPE.replace(/\((?!\?)/g, '(?:')}(?![\p{L}\d])`,
  'giu'
);

// "24 November", "5 apr", "vrijdag 30 mei", "le 3 mars": a day and month
// with no year is still a date element (HIPAA keeps only the year). English
// month names are included; "may" (English modal verb) needs a capital.
const DAY_MONTH_WORDS = [
  ...Array.from(MONTH_WORDS.keys()).filter((w) => w !== 'may'),
  ...'january february march april june july august september october november december jan feb mar apr jun jul aug sept sep oct nov dec'.split(' '),
]
  .filter((w, i, all) => all.indexOf(w) === i)
  .sort((a, b) => b.length - a.length)
  .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');
const EU_DAY_MONTH_PATTERN = new RegExp(
  String.raw`(?<![\p{L}\d.,/:-])\d{1,2}(?:\.|º|°|er|ª)?\s+(?:de\s+)?(?:${DAY_MONTH_WORDS}|may)\.?(?![\p{L}\d])(?!\s*,?\s*\d)`,
  'giu'
);

/* ----------------------------------------------------------------------------
 * Names: titles, field labels, family words
 * --------------------------------------------------------------------------*/

const NAME_WORD = String.raw`(?:(?:van|von|der|den|de|del|della|di|da|dos|das|du|le|la|ter|ten|zu)[-' ]){0,2}(?:\p{Lu}\.|\p{Lu}[\p{L}\-']{1,30})`;

// Titles, case-sensitive: "Sra. García", "Herr Müller", "Mevr. de Vries".
const EU_HONORIFIC_PATTERN = new RegExp(
  String.raw`(?<![\p{L}])(?:Sr\.?|Sra\.?|Srta\.?|Dra\.?|Dña\.?|Doña|Don|Herr|Frau|Hr\.|Fr\.|Dr\.\s?med\.|Prof\.\s?Dr\.|Dhr\.?|Mevr\.?|Mw\.|Mme\.?|Mlle\.?|M\.|Pr\.?|Sig\.(?:ra)?|Sig\.na|Dott\.(?:ssa)?|Prof\.(?:ssa)?|Enf\.?|Enfª)[ \t]+` +
    // "Sehr geehrte Frau Kollegin", "Herr Doktor": a role, not a name.
    String.raw`(?!(?:Kolleg(?:e|in|en|innen)|Doktor(?:in)?|Professor(?:in)?|Patient(?:in)?|Chef(?:arzt|ärztin)|Ober(?:arzt|ärztin)|Assistenz(?:arzt|ärztin)|Stations(?:arzt|ärztin)|Pfleger(?:in)?|Schwester|Collega|Colega|Collègue|Confrère|Consœur|Docteur|Doctor(?:a)?)(?![\p{L}]))` +
    String.raw`(${NAME_WORD}(?:[ \t]+${NAME_WORD}){0,3})`,
  'gu'
);

// Labelled name fields (a colon is required): "Paciente: …", "Nachname: …".
const EU_NAME_FIELD_PATTERN = new RegExp(
  String.raw`(?<![\p{L}])(?:nombre(?:\s+y\s+apellidos)?|apellidos?|paciente|nombre\s+del\s+paciente|` +
    String.raw`name|vorname|nachname|familienname|patientin|name\s+des\s+patienten|patientenname|` +
    String.raw`nom(?:\s+de\s+naissance|\s+d'usage)?|prénom|patiente|nom\s+du\s+patient|` +
    String.raw`nome|cognome|paziente|nome\s+del\s+paziente|` +
    String.raw`naam|voornaam|achternaam|voorletters|patiënt|patiëntnaam|` +
    String.raw`utente|nome\s+do\s+(?:utente|doente|paciente)|doente|` +
    String.raw`m[eé]dico|médecin|arzt|ärztin|medico|arts|huisarts|hausarzt|médico\s+de\s+família)` +
    String.raw`[ \t]*:[ \t]*(?:(?:Dr\.?|Dra\.?|Prof\.?)[ \t]+)?` +
    // Dialogue lines ("Paciente: No, …", "Médico: Bueno") are not names.
    String.raw`(?!(?:No|Sí|Si|Yes|Oui|Non|Nein|Ja|Nee|Neen|Ok|Okay|Vale|Bueno|Pues|Bien|Gut|Genau|Also|Me|Mi|Yo|El|La|Lo|Los|Las|Un|Una|En|De|Que|Le|Je|Il|Elle|Ich|Er|Sie|Es|Das|Die|Der|Ik|Het|De|Een|Wat|Hoe|Ja|I|It|The|We|My)(?![\p{L}]))` +
    String.raw`(${NAME_WORD}(?:,?[ \t]+${NAME_WORD}){0,3})`,
  'giu'
);

// Bare "Patient:" (English, German, French, Dutch) is often followed by a
// description ("Patient: Asian male"), so it needs two capitalised names.
const PATIENT_FIELD_PATTERN = new RegExp(
  String.raw`(?<![\p{L}])Patient[ \t]*:[ \t]*(\p{Lu}[\p{L}'\-]+(?:[ \t]+(?:(?:van|von|de|der|den|du|le|la)[ \t]+)?\p{Lu}[\p{L}'\-]+){1,3})`,
  'gu'
);

// Family words before a name: "su hija Amira", "seine Tochter Lena".
const EU_RELATION_PATTERN = new RegExp(
  String.raw`(?<![\p{L}])(?:` +
    String.raw`(?:su|sus)\s+(?:hija|hijo|esposa|esposo|marido|mujer|madre|padre|hermana|hermano|pareja|nieta|nieto)|` +
    String.raw`(?:seine|ihre|sein|ihr|seiner|ihrer|seinem|ihrem|seinen|ihren)\s+(?:Tochter|Sohn|Frau|Ehefrau|Mann|Ehemann|Mutter|Vater|Schwester|Bruder|Partnerin|Partner|Enkelin|Enkel)|` +
    String.raw`(?:sa|son|ses)\s+(?:fille|fils|femme|épouse|mari|époux|mère|père|sœur|soeur|frère|compagne|compagnon|petite-fille|petit-fils)|` +
    String.raw`(?:sua|suo|la\s+sua|il\s+suo)\s+(?:figlia|figlio|moglie|marito|madre|padre|sorella|fratello|compagna|compagno|nipote)|` +
    String.raw`(?:zijn|haar)\s+(?:dochter|zoon|vrouw|echtgenote|man|echtgenoot|moeder|vader|zus|zuster|broer|partner|kleindochter|kleinzoon)|` +
    String.raw`(?:a\s+sua|o\s+seu|sua|seu)\s+(?:filha|filho|esposa|mulher|marido|mãe|pai|irmã|irmão|neta|neto)` +
    String.raw`)[ \t]*,?[ \t]+(${NAME_WORD}(?:[ \t]+${NAME_WORD}){0,2})`,
  'giu'
);

/* ----------------------------------------------------------------------------
 * Record, insurance numbers (labelled)
 * --------------------------------------------------------------------------*/

const EU_MRN_PATTERN = new RegExp(
  String.raw`(?<![\p{L}])(?:NHC|n\.?[º°]?\s*(?:de\s+)?historia(?:\s+cl[ií]nica)?|historia\s+cl[ií]nica|n[uú]mero\s+de\s+historia|` +
    String.raw`Fallnummer|Fall-?Nr\.?|Fall-?ID|Patientennummer|Patienten-?(?:ID|Nr\.?)|PID|Aufnahmenummer|Aufnahme-?Nr\.?|` +
    String.raw`Aktenzeichen|Aktennummer|Patientenaktennummer|Patientenakte|Fallkennung|Auftragsnummer|Befundnummer|Eingangsnummer(?:\s+Pathologie)?|Probennummer|Labornummer|Labor-?Nr\.?|` +
    String.raw`num[eé]ro\s+de\s+dossier(?:\s+patient)?|n[°º]\s*(?:de\s+)?dossier(?:\s+patient)?|dossier(?:\s+patient)?(?=\s*[:#])|` +
    String.raw`identifiant\s+(?:du\s+)?patient|num[eé]ro\s+(?:de\s+)?patient|n[°º]\s*patient|IPP|NIP|` +
    String.raw`num(?:ero)?\.?\s+(?:di\s+)?cartella(?:\s+clinica)?|n\.\s*cartella|nosologico|` +
    String.raw`pati[eë]ntnummer|pati[eë]ntnr\.?|pati[eë]nt-?ID|dossiernummer|dossiernr\.?|EPD-?nummer|ziekenhuisnummer|registratienummer|` +
    String.raw`n\.?[º°]?\s*(?:de\s+)?episodio|n[uú]mero\s+de\s+episodio|expediente|n\.?[º°]?\s*(?:de\s+)?expediente|id\s+(?:del\s+)?paciente|` +
    String.raw`unit\s+record|(?:patient|hospital)\s+(?:reference|ref\.?|file\s+(?:no|number)|identifier)|` +
    String.raw`n[uú]mero\s+(?:de\s+)?processo|n\.?[º°]\s*(?:de\s+)?processo|n[uú]mero\s+(?:de\s+)?utente|n\.?[º°]\s*(?:de\s+)?utente)` +
    // Keyword ends the word; value holds a digit (the flag is case-insensitive).
    String.raw`(?![\p{L}])\s*[:.#\-]?\s*(?=[A-Z\-\/]*\d)([A-Z0-9][A-Z0-9\-\/]{3,19})`,
  'giu'
);

// Clinicians' registration numbers: "LANR: 579791332", "N.º de colegiada:
// 15/97/60251", "RPPS : 10559160295", "RIZIV 1-24658-92-290", "BIG-nummer".
// Case-sensitive: "big", "npi" and "agb" are ordinary words in some languages.
const CLINICIAN_REG_PATTERN = new RegExp(
  String.raw`(?<![\p{L}])(?:LANR|BSNR|RPPS|ADELI|RIZIV(?:-?(?:nummer|nr\.?))?|INAMI|BIG(?:-?(?:nummer|nr\.?|registratie))?|AGB(?:-?code)?|` +
    String.raw`[Nn]\.?\s?[º°]\s*(?:de\s+)?[Cc]olegiad[oa]|[Nn][uú]mero\s+de\s+[Cc]olegiad[oa]|[Cc]olegiad[oa]|COLEGIAD[OA]|[Cc]ol\.)` +
    String.raw`(?![\p{L}])\s*(?:[Nn][º°r.]+\s*)?[:.#\-]?\s*(?=[A-Z\-\/.]*\d)([A-Z0-9][A-Z0-9\-\/.]{3,19}\d)`,
  'gu'
);
// Belgian RIZIV/INAMI shape on its own: 1-23456-78-901.
const BE_RIZIV_PATTERN = /(?<![\d\-\/])\d[-\/]\d{5}[-\/]\d{2}[-\/]\d{3}(?![\d\-\/])/g;
// Belgian VAT (a practice's number identifies a sole practitioner).
const BE_VAT_PATTERN = /(?<![\p{L}\d])BE[ \t]?(?:[01]\d{3}|\d{3})[. ]?\d{3}[. ]?\d{3}(?!\d)/gu;

// IBAN written in groups of four ("NL91 ABNA 0417 1643 00"); the plain IBAN
// rule only matches it unbroken. Mod-97 checked.
const IBAN_SPACED_PATTERN = /(?<![A-Z0-9])[A-Z]{2}\d{2}(?: [A-Z0-9]{4}){2,7}(?: [A-Z0-9]{1,3})?(?![A-Z0-9])/g;
export function validIban(s: string): boolean {
  const v = s.replace(/\s+/g, '').toUpperCase();
  if (v.length < 15 || v.length > 34) return false;
  const moved = v.slice(4) + v.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const n = ch >= 'A' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of n) rem = (rem * 10 + +d) % 97;
  }
  return rem === 1;
}

// German landline/fax with area code and extension: "038372/5704-2",
// "(035201) 8644-4", "02421 / 2531 17", "030/8743-228".
const DE_PHONE_PATTERN =
  /(?<![\d\w.,\/])(?:\+49[ \t]?\(0\)[ \t]?\d{2,5}|\(0\d{2,5}\)|0\d{2,5})[ \t]?(?:\/[ \t]?|-[ \t]?|\.)?\d{2,8}(?:[ \t]?-[ \t]?\d{1,5}|[ \t]\d{2,5}|\.\d{1,5}){0,2}(?![\d\w\/.,]\d)/g;
const phoneDigits = (s: string) => {
  const n = s.replace(/\D/g, '').length;
  return n >= 7 && n <= 15;
};

// Postcode + town where the postcode is 4 digits (BE, AT, CH, DK, LU):
// "8540 Deerlijk", "B-3000 Leuven". Four digits alone are often a year, so
// a comma, line start or "B-" must come before, and the town must end the
// line or be followed by a comma or bracket.
const POSTCODE4_TOWN_PATTERN =
  /(?:(?<=,[ \t]?)|(?<=^[ \t]*)|(?<=\b(?:B|BE|A|AT|CH|L|LU|DK)-))[1-9]\d{3}[ \t]+\p{Lu}[\p{L}'\-]+(?:[ \t\-](?:sur|sous|lez|lès|en|aan|de|la|le|am|an|\(?\p{Lu}[\p{L}'\-]+\)?)){0,3}(?=[ \t]*(?:$|[,;)\n]))/gmu;

// US "City, ST 12345": the city right before a state and ZIP.
const US_CITY_PATTERN =
  /(?<![\p{L}])\p{Lu}[\p{L}.'\-]+(?:[ \t]\p{Lu}[\p{L}.'\-]+){0,2}(?=,[ \t]*(?:A[KLRZ]|C[AOT]|D[CE]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[AT]|W[AIVY])[ \t]+\d{5}(?:-\d{4})?\b)/gu;

// Month and year with no day: "Juni 2020", "octubre de 2016", "March 2019",
// "03/2019". The month is a date element; only the year may stay.
const MONTH_YEAR_PATTERN = new RegExp(
  String.raw`(?<![\p{L}\d.\/])(?:(?:${DAY_MONTH_WORDS})\.?\s+(?:de\s+|del\s+)?(?:19|20)\d{2}|(?:0[1-9]|1[0-2])\/(?:19|20)\d{2})(?![\p{L}\d\/])`,
  'giu'
);

// Ward, room and bed codes next to admission details: "Station: G7",
// "Zimmer 72", "Zi: 301", "kamer 214", "chambre 12", "habitación 305".
const WARD_ROOM_PATTERN =
  /(?<![\p{L}])(?:Station|Zimmer|Zi\.?|Bett|[Kk]amer|[Cc]hambre|[Hh]abitaci[oó]n|[Rr]oom|[Bb]ed|[Ww]ard)(?![\p{L}])[ \t]*[:.]?[ \t]*(?=[A-Z\-]*\d)([A-Z]{0,5}-?\d{1,4}[A-Z]?(?:[ \t](?:Ost|West|Nord|Süd|Mitte))?)(?![\p{L}\d])/gu;

// Dictation initials under a letter's signature: "ek/pf", "Kürzel: bo/ek".
// Alone on a line, unless labelled; lab units ("mg/dl") are excluded.
const DICTATION_INITIALS_PATTERN =
  /(?:^[ \t]*|(?<=K[üu]rzel:?[ \t]*|Diktat:?[ \t]*))(?!(?:mg|ml|dl|ug|µg|ng|pg|mm|cm|kg|g|l|h|d|u|iu|ie|min|s)\/)([A-Za-z]{2,3}\/[A-Za-z]{2,3})(?![\p{L}\/])(?=[ \t]*$)/gmu;

// Device identifiers with an obvious shape (HIPAA #13).
const MAC_PATTERN = /(?<![0-9A-F:])(?:[0-9A-F]{2}[:\-]){5}[0-9A-F]{2}(?![0-9A-F:])/gi;
const IMEI_PATTERN = /(?<![\p{L}])IMEI(?:-?(?:nummer|nr\.?|number))?(?![\p{L}])\s*[:.#\-]?\s*(\d{15}|\d{2}[- ]\d{6}[- ]\d{6}[- ]\d)(?!\d)/giu;
// Card security code, only when labelled.
const CVV_PATTERN = /(?<![\p{L}])(?:CVV2?|CVC2?|CID|beveiligingscode|veiligheidscode|security\s+code|Prüfnummer|cryptogramme|code\s+de\s+s[ée]curit[ée])(?:-?code)?(?![\p{L}])\s*[:.#\-]?\s*(\d{3,4})(?!\d)/giu;
// Licence plates, only when labelled (NL sidecodes, DE, FR SIV, ES, BE).
const PLATE_PATTERN =
  /(?<![\p{L}])(?:[Kk]enteken|[Nn]ummerplaat|Kennzeichen|Kfz-Kennzeichen|[Pp]laque(?:\s+d'immatriculation)?|[Ii]mmatriculation|[Mm]atr[ií]cula|[Tt]arga|[Ll]icen[cs]e\s+plate|[Rr]egistration\s+plate)(?![\p{L}])\s*[:.#\-]?\s*(?=[A-Z\- ]*\d)([A-Z0-9]{1,4}(?:[- ][A-Z0-9]{1,6}){1,3})(?![A-Z0-9])/gu;
// GPS coordinates "52.3667, 4.8945" / "52.3667° N, 4.8945° E".
const GPS_PATTERN =
  /(?<![\d.])-?\d{1,2}\.\d{3,7}°?(?:[ \t]?[NS])?,[ \t]?-?\d{1,3}\.\d{3,7}°?(?:[ \t]?[EOW])?(?!\d)(?!\.\d)/g;

// Payment card numbers: 13–19 digits, optionally in groups, Luhn checked.
const CARD_PATTERN = /(?<![\d\-])(?:\d{4}[ \-]?){3}\d{1,7}(?![\d\-])/g;
export function validLuhn(s: string): boolean {
  const d = s.replace(/\D/g, '');
  if (d.length < 13 || d.length > 19 || /^(\d)\1+$/.test(d.slice(1))) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let v = +d[d.length - 1 - i];
    if (i % 2 === 1) v = v * 2 > 9 ? v * 2 - 9 : v * 2;
    sum += v;
  }
  return sum % 10 === 0;
}

// Bare web domains of hospitals and practices: "helios-hanseklinikum-str.de".
const BARE_DOMAIN_PATTERN =
  /(?<![\p{L}\d@.\-\/])[a-z0-9](?:[a-z0-9\-]{0,61}[a-z0-9])?(?:\.[a-z0-9\-]{2,63})*\.(?:de|at|ch|nl|be|fr|es|it|pt|lu|eu|com|org|net|info|health|co\.uk|org\.uk|nhs\.uk|ac\.uk)(?:\/[^\s<>"]*)?(?![\p{L}\d\-])/gu;
// A domain needs a hyphen, a digit or two dots to be told apart from words
// that happen to end in ".de" or ".it" after a full stop.
const domainLooksReal = (s: string) => /[-\d]/.test(s.split('/')[0]) || (s.split('/')[0].match(/\./g) ?? []).length >= 2 || s.split('.')[0].length >= 6;

// Spanish phone numbers: nine digits starting 6–9, optional +34.
const ES_PHONE_PATTERN = /(?<![\d\-\/.])(?:\+?34[ \t\-]{0,2})?[6-9]\d{2}[ \t.]?\d{3}[ \t.]?\d{3}(?![\d\-\/])/g;

// Dutch postcode on its own: "3512 KL", "3011BH" (letters SA, SD, SS are
// never issued; IE, KG, MG, ML… are units, as in "1000 IE").
const NL_POSTCODE_PATTERN =
  /(?<![\p{L}\d])[1-9]\d{3}[ ]?(?!SA|SD|SS|IE|KG|MG|ML|MM|CM|KM|GR|IU|UI|ME|EH|HZ|KB|MB|GB)[A-Z]{2}(?![\p{L}\d])/gu;

// Codes such as "LAB-460507", "DR-126782", "VRN-737768", "LOT-88257":
// letters, a hyphen, five or more digits. Standards ("ISO-27001") excluded.
const PREFIXED_CODE_PATTERN = /(?<![\p{L}\d\-])(?!(?:ISO|IEC|DIN|EN|NEN|ASTM|BS|NF|UNE|ICD|DSM)-)[A-Z]{2,5}-\d{5,10}(?:-[A-Z0-9]{1,6})?(?![\p{L}\d])/gu;

const EU_INSURANCE_PATTERN = new RegExp(
  String.raw`(?<![\p{L}])(?:Krankenversichertennummer|KVNR|Versichertennummer|Versicherten-?Nr\.?|Versicherungsnummer|` +
    String.raw`tarjeta\s+sanitaria(?:\s+individual)?|CIP(?:-SNS)?|TSI|NUSS|n[º°]?\s*(?:de\s+)?afiliaci[oó]n|` +
    String.raw`num[eé]ro\s+de\s+s[eé]curit[eé]\s+sociale|carte\s+vitale|NIR|` +
    String.raw`tessera\s+sanitaria|codice\s+sanitario|n\.\s*tessera|` +
    String.raw`polisnummer|verzekerdennummer|zorgverzekeringsnummer|zorgpolis(?:nummer)?|` +
    String.raw`n[uú]mero\s+(?:de\s+)?benefici[aá]rio|n[uú]mero\s+(?:de\s+)?seguran[cç]a\s+social|NISS|NSS|SVNR|SV-?Nummer|Sozialversicherungsnummer)` +
    // The keyword must end the word ("NIR", not "Nirina" or "nirgends") and
    // the value must hold a digit: the flag is case-insensitive, so a
    // letters-only capture would be whatever word comes next.
    String.raw`(?![\p{L}])\s*[:.#\-]?\s*(?=[A-Z\-\/]*\d)([A-Z0-9][A-Z0-9\-\/]{3,19}(?:[ \t]\d{2,6}){0,4})`,
  'giu'
);

/* ----------------------------------------------------------------------------
 * National IDs: checksum validators
 * --------------------------------------------------------------------------*/

const digits = (s: string) => s.replace(/\D/g, '');

/** Poland PESEL (11 digits). */
export function validPesel(s: string): boolean {
  const d = digits(s);
  if (d.length !== 11) return false;
  const w = [1, 3, 7, 9, 1, 3, 7, 9, 1, 3];
  const sum = w.reduce((n, wi, i) => n + wi * +d[i], 0);
  return (10 - (sum % 10)) % 10 === +d[10];
}

/** Belgium national register number (11 digits, mod 97; born 2000+ prefix 2). */
export function validBeNiss(s: string): boolean {
  const d = digits(s);
  if (d.length !== 11) return false;
  const base = d.slice(0, 9);
  const check = +d.slice(9);
  return 97 - (Number(base) % 97) === check || 97 - (Number('2' + base) % 97) === check;
}

/** France NIR / social security number (13 + 2-digit key; Corsica 2A/2B). */
export function validFrNir(s: string): boolean {
  const c = s.replace(/[\s.]/g, '').toUpperCase();
  if (!/^[12]\d{2}(?:0[1-9]|1[0-2]|[2-9]\d)(?:\d{2}|2A|2B)\d{6}\d{2}$/.test(c)) return false;
  const body = c.slice(0, 13).replace('2A', '19').replace('2B', '18');
  return 97 - (Number(BigInt(body) % 97n)) === +c.slice(13);
}

/** Netherlands BSN (9 digits, "11-proof"). */
export function validBsn(s: string): boolean {
  const d = digits(s);
  if (d.length !== 9 || /^0+$/.test(d)) return false;
  let sum = 0;
  for (let i = 0; i < 8; i++) sum += (9 - i) * +d[i];
  sum -= +d[8];
  return sum % 11 === 0;
}

/** Sweden personnummer (YYMMDD-XXXX, Luhn). */
export function validSePnr(s: string): boolean {
  let d = digits(s);
  if (d.length === 12) d = d.slice(2);
  if (d.length !== 10) return false;
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    let v = +d[i] * (i % 2 === 0 ? 2 : 1);
    if (v > 9) v -= 9;
    sum += v;
  }
  return sum % 10 === 0;
}

/** Finland henkilötunnus (DDMMYY[-+A]NNN + check character). */
export function validFiHetu(s: string): boolean {
  const m = s.toUpperCase().match(/^(\d{6})[-+A-FU-Y](\d{3})([0-9A-Y])$/);
  if (!m) return false;
  return '0123456789ABCDEFHJKLMNPRSTUVWXY'[Number(m[1] + m[2]) % 31] === m[3];
}

/** Ireland PPSN (7 digits + check letter [+ letter]). */
export function validIePpsn(s: string): boolean {
  const m = s.toUpperCase().match(/^(\d{7})([A-W])([A-IW]?)$/);
  if (!m) return false;
  let sum = 0;
  for (let i = 0; i < 7; i++) sum += +m[1][i] * (8 - i);
  if (m[3]) sum += (m[3] === 'W' ? 0 : m[3].charCodeAt(0) - 64) * 9;
  const r = sum % 23;
  return (r === 0 ? 'W' : String.fromCharCode(64 + r)) === m[2];
}

/** Germany Krankenversichertennummer (letter + 9 digits). */
export function validKvnr(s: string): boolean {
  const m = s.toUpperCase().match(/^([A-Z])(\d{9})$/);
  if (!m) return false;
  const all = String(m[1].charCodeAt(0) - 64).padStart(2, '0') + m[2].slice(0, 8);
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    let v = +all[i] * (i % 2 === 0 ? 1 : 2);
    if (v > 9) v = Math.floor(v / 10) + (v % 10);
    sum += v;
  }
  return sum % 10 === +m[2][8];
}

/** Portugal NIF (9 digits, mod 11). */
export function validPtNif(s: string): boolean {
  const d = digits(s);
  if (d.length !== 9) return false;
  let sum = 0;
  for (let i = 0; i < 8; i++) sum += +d[i] * (9 - i);
  const c = 11 - (sum % 11);
  return (c >= 10 ? 0 : c) === +d[8];
}

/** Austria social insurance number (10 digits, 4th is the check digit). */
export function validAtSvnr(s: string): boolean {
  const d = digits(s);
  if (d.length !== 10) return false;
  const w = [3, 7, 9, 0, 5, 8, 4, 2, 1, 6];
  const sum = w.reduce((n, wi, i) => n + wi * +d[i], 0);
  return sum % 11 === +d[3];
}

/* ----------------------------------------------------------------------------
 * Patterns
 * --------------------------------------------------------------------------*/

const PESEL_PATTERN = /(?<!\d)\d{11}(?!\d)/g;
const BE_NISS_PATTERN = /(?<!\d)\d{2}\.?\d{2}\.?\d{2}[-.]?\d{3}\.?\d{2}(?!\d)/g;
const FR_NIR_PATTERN = /(?<![\dA-Z])[12][\s.]?\d{2}[\s.]?\d{2}[\s.]?(?:\d{2}|2A|2B)[\s.]?\d{3}[\s.]?\d{3}[\s.]?\d{2}(?![\dA-Z])/gi;
const NL_BSN_PATTERN = /(?<!\d)\d{4}\.?\d{2}\.?\d{3}(?!\d)|(?<!\d)\d{9}(?!\d)/g;
const SE_PNR_PATTERN = /(?<!\d)(?:\d{2})?\d{6}[-+]\d{4}(?!\d)/g;
const FI_HETU_PATTERN = /(?<![\dA-Z])\d{6}[-+A-FU-Y]\d{3}[0-9A-Y](?![\dA-Z])/g;
const IE_PPSN_PATTERN = /(?<![\dA-Z])\d{7}[A-W][A-IW]?(?![\dA-Z])/g;
const DE_KVNR_PATTERN = /(?<![\dA-Z])[A-Z]\d{9}(?![\dA-Z])/g;
const PT_NIF_PATTERN = /(?<![\p{L}])(?:NIF|contribuinte|n\.?[º°]\s*fiscal)\s*[:.#\-]?\s*(\d{9})(?!\d)/giu;
const AT_SVNR_PATTERN = /(?<![\p{L}])(?:SVNR|SV-?Nummer|Sozialversicherungsnummer|Versicherungsnummer)\s*[:.#\-]?\s*(\d{4}\s?\d{6})(?!\d)/giu;
const DE_TAX_ID_PATTERN = /(?<![\p{L}])(?:Steuer-?ID|Steuer-?IdNr\.?|IdNr\.?|Steueridentifikationsnummer)\s*[:.#\-]?\s*(\d{2}\s?\d{3}\s?\d{3}\s?\d{3})(?!\d)/giu;
const ID_CARD_PATTERN = /(?<![\p{L}])(?:Personalausweis(?:nummer)?|Ausweisnummer|carte\s+d'identit[eé]|CNI|carta\s+d'identit[àa]|identiteitskaart|cart[aã]o\s+de\s+cidad[aã]o|CC|documento\s+de\s+identidad)(?![\p{L}])\s*(?:n[º°r.]*)?\s*[:.#\-]?\s*(?=[A-Z ]*\d)([A-Z0-9][A-Z0-9 ]{5,14}[A-Z0-9])(?![A-Z0-9])/giu;
// Mexico
const MX_CURP_PATTERN = /(?<![A-Z0-9])[A-Z][AEIOUX][A-Z]{2}\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])[HMX](?:AS|BC|BS|CC|CL|CM|CS|CH|DF|DG|GT|GR|HG|JC|MC|MN|MS|NT|NL|OC|PL|QT|QR|SP|SL|SR|TC|TS|TL|VZ|YN|ZS|NE)[B-DF-HJ-NP-TV-Z]{3}[A-Z\d]\d(?![A-Z0-9])/g;
const MX_RFC_PATTERN = /(?<![A-Z0-9])[A-ZÑ&]{3,4}\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])[A-Z\d]{2}[A\d](?![A-Z0-9])/g;

// Postcode and the town after it ("28013 Madrid", "1012 AB Amsterdam",
// "1000-001 Lisboa", "00-950 Warszawa").
const EU_POSTCODE_TOWN_PATTERN = /(?<![\d\-])(?:\d{5}|\d{4}\s?[A-Z]{2}|\d{4}-\d{3}|\d{2}-\d{3})[ \t]+\p{Lu}\p{Ll}+(?:[ \t\-](?:am|an|de|del|la|le|sur|sous|im|bei|aan|\p{Lu}\p{Ll}+)){0,3}/gu;

// French-style pairs "06 12 34 56 78", "+33 6 12 34 56 78"; "+49 (0)30 1234567".
const EU_PHONE_PATTERN = /(?<![\d+])(?:(?:\+33|0033)\s?[1-9]|0[1-9])(?:[\s.\-]?\d{2}){4}(?!\d)|(?<![\d+])\+(?:3\d|4\d|35\d|42\d)\s?(?:\(0\)\s?)?\d{1,4}(?:[\s.\-\/]?\d{2,4}){2,4}(?!\d)/g;

// Endings of one-word street names (German, Dutch, Flemish), either case
// after a hyphen: "Hauptstraße", "Kerkstraat", "Jannedreef", "Lodehof".
const STREET_SUFFIXES = [
  'straße', 'strasse', 'str\\.', 'weg', 'gasse', 'platz', 'allee', 'ring', 'damm', 'ufer', 'steig', 'pfad', 'chaussee', 'markt',
  'laan', 'straat', 'plein', 'gracht', 'kade', 'dijk', 'singel', 'steeg', 'dreef', 'hof', 'pad', 'baan', 'lei', 'kaai', 'dok', 'wal', 'steenweg', 'square', 'boulevard',
]
  .flatMap((s) => [`[${s[0]}${s[0].toUpperCase()}]${s.slice(1)}`, s.toUpperCase().replace('STR\\.', 'STR\\.')])
  .join('|');
// House number, with ranges and letters: "3-6", "90/96", "104a", "12 bus 3".
const HOUSE_NO = String.raw`\d{1,4}[a-zA-Z]?(?:[\/\-]\d{1,4}[a-zA-Z]?)?(?:\s?bus\s?\d{1,4})?`;
// Spanish floor/door after the house number: ", 2º dcha", ", 11A", ", 3 C", ", 2, B".
const ES_FLOOR_TAIL = String.raw`(?:,?\s?\d{1,2}\s?[º°ª]?(?:\s?(?:[A-H]|dcha\.?|izda\.?|izq\.?|pta\.?\s?\d{1,2}))?(?![\p{L}\d])){0,2}(?:,\s?[A-H](?![\p{L}\d]))?`;

// Street addresses: "Calle Mayor 12", "C/ Alcalá 45", "rue de la Paix",
// "Via Roma 10", "Rua Augusta 100", "Hauptstraße 5", "Kerkstraat 1".
const EU_ADDRESS_PATTERN = new RegExp(
  String.raw`(?<![\p{L}])(?:(?:Calle|C\/|Avenida|Avda\.|Av\.|Plaza|Pza\.|Paseo|Pº|Carrer|Camino|Ronda|Travesía|` +
    // French street words are only taken capitalised, or after a house
    // number ("12 rue de la Paix"): "took place Monday" is not an address.
    String.raw`Rue|Avenue|Boulevard|Place|Chemin|Impasse|Allée|Quai|` +
    String.raw`(?<=\d{1,4}(?:\s?(?:bis|ter))?,?\s)(?:rue|avenue|av\.|boulevard|bd|place|chemin|impasse|allée|quai)|` +
    String.raw`Via|Viale|Piazza|Corso|Vicolo|Largo|` +
    String.raw`Rua|Travessa|Praça|Largo|Estrada)\s+(?:(?:de|del|de\s+la|de\s+los|des|du|de\s+l'|della|dei|delle|da|do|dos|das)\s+)?` +
    String.raw`\p{Lu}[\p{L}'\-]+(?:\s+\p{Lu}[\p{L}'\-]+){0,3}(?:,?\s*(?:n\.?[º°]?\s*)?\d{1,4}[a-zA-Z]?(?!\d)${ES_FLOOR_TAIL})?` +
    // Compound street names, including hyphenated ones written with a
    // capital after the hyphen ("Kevin-Heidrich-Allee 134").
    String.raw`|\p{Lu}[\p{L}\-]*(?:${STREET_SUFFIXES})\s+${HOUSE_NO}(?![\p{L}\d]))`,
  'gu'
);

// Any street right before ", postcode Town" ("Mergel 135, 9840 De Pinte",
// "Avenue de l'Yser 76, 5024 Gelbressée"): the postcode and town that follow
// make it an address line whatever the street is called.
const STREET_BEFORE_POSTCODE_PATTERN = new RegExp(
  String.raw`(?<![\p{L}\d])\p{Lu}[\p{L}'’.\-]*(?:\s+[\p{L}'’.\-]+){0,5}?\s+${HOUSE_NO}(?=,?\s*(?:[A-Z]{1,2}-)?\d{4,5}(?:\s?[A-Z]{2})?\s+\p{Lu})`,
  'gu'
);

// Spanish address in any case with a house number and floor/door:
// "calle monforte de lemos 129, 8C", "c/ del Abedul 5-7, 2º dcha".
const ES_STREET_PATTERN = new RegExp(
  String.raw`(?<![\p{L}])(?:` +
    // Capitalised street types: any words, then a number.
    String.raw`(?:Calle|C\/|Avenid[ao]|Avda\.|Av\.?|Plaza|Pza\.|Paseo|Pº|Carrer|Camino|Ronda|Carretera|Travesía|` +
    // Not "Vía", "Acceso", "Cuesta", "Partida": they open clinical sentences
    // ("Vía oral 2 comprimidos", "Acceso venoso 2").
    String.raw`Pasaje|Urbanización|Callejón|Glorieta|Rambla|Bulevar|Polígono|Barrio|Plazuela)` +
    String.raw`\s+(?:[\p{L}'´.\-]+\s+){0,5}?[\p{L}'´.\-]+,?\s*(?:n\.?[º°]?\s*)?(?:\d{1,4}[a-zA-Z]?(?:-\d{1,4})?|s\/n)` +
    // Lower case ("en la calle hace 3 días" is not an address): the number
    // must end the address (comma, ordinal or line end follows).
    String.raw`|(?:calle|c\/|avenida|avda\.|plaza|paseo)\s+(?:[\p{L}'´.\-]+\s+){0,4}?[\p{L}'´.\-]+,?\s*\d{1,4}[a-zA-Z]?(?:-\d{1,4})?(?=\s*(?:[,º°ª]|$)|\s+\d{1,2}\s?[º°ª]))` +
    String.raw`${ES_FLOOR_TAIL}(?:\s?(?:Apt\.?|Puerta|[Pp]iso|Esc\.?|Escalera|Bloque|Portal)\s?\d{1,3}[A-Z]?)?(?![\p{L}\d])`,
  'gmu'
);
// Spanish colegiado shape on its own: "28/40/21424" (province/year/number).
const ES_COLEGIADO_SHAPE_PATTERN = /(?<![\d\/])\d{2}\/\d{2}\/\d{5}(?![\d\/])/g;

// Ages: "92 años", "92 Jahre alt", "92 ans", "92 anni", "92 jaar", "edad: 92".
const EU_AGE_PATTERN = /(?<![\p{L}])(?:edad|alter|âge|età|leeftijd|idade)\s*[:.\-]?\s*(\d{2,3})|(?<!\d)(\d{2,3})\s*(?:años|Jahre|Jahren|ans|anni|jaar|anos)(?![\p{L}])/giu;

// Institutions: "Hospital Universitario La Paz", "Klinikum Rechts der Isar",
// "Centre hospitalier de …", "Ospedale San Raffaele", "Ziekenhuis Rijnstate".
const EU_INSTITUTION_PATTERN = /(?:Hospital(?:\s+(?:Universitario|Universitari|General|Clínico|Clinico|Regional|de|del|da|do|dos|das))*|Klinikum|Krankenhaus|Universitätsklinikum|Klinik|Centre\s+hospitalier(?:\s+universitaire)?|CHU|CHR|Clinique|Hôpital|Ospedale|Policlinico|Azienda\s+Ospedaliera|Presidio\s+Ospedaliero|Ziekenhuis|Centro\s+(?:de\s+Salud|de\s+Saúde|Hospitalar)|Unidade\s+(?:Local\s+)?de\s+Saúde)(?:\s+(?:\p{Lu}[\p{L}'\-]+|de|del|der|di|da|do|la|le|y|e|und|et)){1,5}/gu;

/* ----------------------------------------------------------------------------
 * Rules
 * --------------------------------------------------------------------------*/

export const EU_RULES: IdentifierRule[] = [
  { label: 'NATIONAL_ID', category: 'EU', description: 'France NIR (social security)', pattern: FR_NIR_PATTERN, priority: 99, validate: validFrNir, country: 'FR' },
  { label: 'NATIONAL_ID', category: 'EU', description: 'Poland PESEL', pattern: PESEL_PATTERN, priority: 97, validate: validPesel, country: 'PL' },
  { label: 'NATIONAL_ID', category: 'EU', description: 'Belgium national register number', pattern: BE_NISS_PATTERN, priority: 97, validate: validBeNiss, country: 'BE' },
  { label: 'NATIONAL_ID_NL_BSN', category: 'EU', description: 'Netherlands BSN (checksum)', pattern: NL_BSN_PATTERN, priority: 94, validate: validBsn, country: 'NL' },
  { label: 'NATIONAL_ID', category: 'EU', description: 'Sweden personnummer', pattern: SE_PNR_PATTERN, priority: 99, validate: validSePnr, country: 'SE' },
  { label: 'NATIONAL_ID', category: 'EU', description: 'Finland henkilötunnus', pattern: FI_HETU_PATTERN, priority: 99, validate: validFiHetu, country: 'FI' },
  { label: 'NATIONAL_ID', category: 'EU', description: 'Ireland PPSN', pattern: IE_PPSN_PATTERN, priority: 96, validate: validIePpsn, country: 'IE' },
  { label: 'INSURANCE_ID', category: 'EU', description: 'Germany health insurance number (KVNR)', pattern: DE_KVNR_PATTERN, priority: 96, validate: validKvnr, country: 'DE' },
  { label: 'NATIONAL_ID', category: 'EU', description: 'Germany tax ID', pattern: DE_TAX_ID_PATTERN, priority: 96, country: 'DE' },
  { label: 'NATIONAL_ID', category: 'EU', description: 'Austria social insurance number', pattern: AT_SVNR_PATTERN, priority: 96, validate: validAtSvnr, country: 'AT' },
  { label: 'NATIONAL_ID', category: 'EU', description: 'Portugal NIF', pattern: PT_NIF_PATTERN, priority: 96, validate: validPtNif, country: 'PT' },
  { label: 'NATIONAL_ID', category: 'EU', description: 'Identity card number (labelled)', pattern: ID_CARD_PATTERN, priority: 93 },
  { label: 'NATIONAL_ID', category: 'EU', description: 'Mexico CURP', pattern: MX_CURP_PATTERN, priority: 99, country: 'MX' },
  { label: 'NATIONAL_ID', category: 'EU', description: 'Mexico RFC', pattern: MX_RFC_PATTERN, priority: 94, country: 'MX' },

  { label: 'MRN', category: 'EU', description: 'Record number (DE/FR/ES/IT/NL/PT label)', pattern: EU_MRN_PATTERN, priority: 92 },
  { label: 'INSURANCE_ID', category: 'EU', description: 'Health insurance number (DE/FR/ES/IT/NL/PT label)', pattern: EU_INSURANCE_PATTERN, priority: 92 },
  { label: 'PHONE', category: 'EU', description: 'Phone number (EU formats)', pattern: EU_PHONE_PATTERN, priority: 71 },
  { label: 'ADDRESS_LINE', category: 'EU', description: 'Street address (DE/FR/ES/IT/NL/PT)', pattern: EU_ADDRESS_PATTERN, priority: 79 },
  { label: 'POSTCODE_EU', category: 'EU', description: 'Postcode followed by a town', pattern: EU_POSTCODE_TOWN_PATTERN, priority: 82 },
  { label: 'DATE', category: 'EU', description: 'Date with a month name (DE/FR/ES/IT/NL/PT)', pattern: EU_DATE_PATTERN, priority: 83 },
  { label: 'DATE', category: 'EU', description: 'Day and month without a year', pattern: EU_DAY_MONTH_PATTERN, priority: 81, validate: (v) => !/\bmay\.?$/.test(v) },
  { label: 'DATE', category: 'EU', description: 'Month and year without a day', pattern: MONTH_YEAR_PATTERN, priority: 81 },
  { label: 'LICENSE', category: 'EU', description: 'Clinician registration number (LANR, RPPS, RIZIV, colegiado, BIG…)', pattern: CLINICIAN_REG_PATTERN, priority: 93 },
  { label: 'LICENSE', category: 'EU', description: 'Belgium RIZIV/INAMI number', pattern: BE_RIZIV_PATTERN, priority: 91, country: 'BE' },
  { label: 'REFERENCE_ID', category: 'EU', description: 'Belgium VAT number', pattern: BE_VAT_PATTERN, priority: 90, country: 'BE' },
  { label: 'IBAN', category: 'EU', description: 'IBAN in groups of four (mod-97)', pattern: IBAN_SPACED_PATTERN, priority: 95, validate: validIban },
  { label: 'PHONE', category: 'EU', description: 'German phone with area code and extension', pattern: DE_PHONE_PATTERN, priority: 72, validate: phoneDigits },
  { label: 'POSTCODE_EU', category: 'EU', description: '4-digit postcode followed by a town (BE/AT/CH/DK/LU)', pattern: POSTCODE4_TOWN_PATTERN, priority: 82 },
  { label: 'ADDRESS_LINE', category: 'EU', description: 'Spanish street with number and floor', pattern: ES_STREET_PATTERN, priority: 80 },
  { label: 'ADDRESS_LINE', category: 'HIPAA', description: 'US city before state and ZIP', pattern: US_CITY_PATTERN, priority: 77 },
  { label: 'ADDRESS_LINE', category: 'HIPAA', description: 'GPS coordinates', pattern: GPS_PATTERN, priority: 88 },
  { label: 'REFERENCE_ID', category: 'EU', description: 'Ward, room or bed code', pattern: WARD_ROOM_PATTERN, priority: 60 },
  { label: 'NAME', category: 'EU', description: 'Dictation initials (ek/pf)', pattern: DICTATION_INITIALS_PATTERN, priority: 84 },
  { label: 'DEVICE_ID', category: 'HIPAA', description: 'MAC address', pattern: MAC_PATTERN, priority: 90 },
  { label: 'DEVICE_ID', category: 'HIPAA', description: 'IMEI (labelled)', pattern: IMEI_PATTERN, priority: 92 },
  { label: 'ACCOUNT_NUMBER', category: 'HIPAA', description: 'Card security code (labelled)', pattern: CVV_PATTERN, priority: 90 },
  { label: 'VEHICLE_VIN', category: 'HIPAA', description: 'Licence plate (labelled)', pattern: PLATE_PATTERN, priority: 90 },
  { label: 'ACCOUNT_NUMBER', category: 'HIPAA', description: 'Payment card number (Luhn)', pattern: CARD_PATTERN, priority: 93, validate: validLuhn },
  { label: 'URL', category: 'HIPAA', description: 'Web domain without http/www', pattern: BARE_DOMAIN_PATTERN, priority: 68, validate: domainLooksReal },
  { label: 'PHONE', category: 'EU', description: 'Spanish phone number (9 digits)', pattern: ES_PHONE_PATTERN, priority: 64 },
  { label: 'POSTCODE_EU', category: 'EU', description: 'Dutch postcode (1234 AB)', pattern: NL_POSTCODE_PATTERN, priority: 81 },
  { label: 'REFERENCE_ID', category: 'EU', description: 'Prefixed code (LAB-460507, DR-126782)', pattern: PREFIXED_CODE_PATTERN, priority: 62 },
  { label: 'LICENSE', category: 'EU', description: 'Spain colegiado number shape (28/40/21424)', pattern: ES_COLEGIADO_SHAPE_PATTERN, priority: 89, country: 'ES' },
  { label: 'ADDRESS_LINE', category: 'EU', description: 'Street before a postcode and town', pattern: STREET_BEFORE_POSTCODE_PATTERN, priority: 78 },

  { label: 'NAME', category: 'EU', description: 'Name (title: Sr., Frau, Mme, Dott., Dhr.…)', pattern: EU_HONORIFIC_PATTERN, priority: 86 },
  { label: 'NAME', category: 'EU', description: 'Name (field: Paciente:, Nachname:, Nom:…)', pattern: EU_NAME_FIELD_PATTERN, priority: 85 },
  { label: 'NAME', category: 'EU', description: 'Name (field: Patient: First Last)', pattern: PATIENT_FIELD_PATTERN, priority: 85 },
  { label: 'NAME', category: 'EU', description: 'Name (family: su hija, seine Tochter, sa fille…)', pattern: EU_RELATION_PATTERN, priority: 83 },

  { label: 'INSTITUTION', category: 'QUASI', description: 'Treating institution (DE/FR/ES/IT/NL/PT)', pattern: EU_INSTITUTION_PATTERN, priority: 50 },
  { label: 'AGE_OVER_89', category: 'EU', description: 'Age that may exceed 89 (DE/FR/ES/IT/NL/PT)', pattern: EU_AGE_PATTERN, priority: 30 },
];
