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

/* ----------------------------------------------------------------------------
 * Names: titles, field labels, family words
 * --------------------------------------------------------------------------*/

const NAME_WORD = String.raw`(?:(?:van|von|der|den|de|del|della|di|da|dos|das|du|le|la|ter|ten|zu)[-' ]){0,2}(?:\p{Lu}\.|\p{Lu}[\p{L}\-']{1,30})`;

// Titles, case-sensitive: "Sra. García", "Herr Müller", "Mevr. de Vries".
const EU_HONORIFIC_PATTERN = new RegExp(
  String.raw`(?<![\p{L}])(?:Sr\.?|Sra\.?|Srta\.?|Dra\.?|Dña\.?|Doña|Don|Herr|Frau|Hr\.|Fr\.|Dr\.\s?med\.|Prof\.\s?Dr\.|Dhr\.?|Mevr\.?|Mw\.|Mme\.?|Mlle\.?|M\.|Pr\.?|Sig\.(?:ra)?|Sig\.na|Dott\.(?:ssa)?|Prof\.(?:ssa)?|Enf\.?|Enfª)[ \t]+(${NAME_WORD}(?:[ \t]+${NAME_WORD}){0,3})`,
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
    String.raw`[ \t]*:[ \t]*(?:(?:Dr\.?|Dra\.?|Prof\.?)[ \t]+)?(${NAME_WORD}(?:,?[ \t]+${NAME_WORD}){0,3})`,
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
    String.raw`Fallnummer|Fall-?Nr\.?|Patientennummer|Patienten-?(?:ID|Nr\.?)|Aufnahmenummer|Aufnahme-?Nr\.?|` +
    String.raw`num[eé]ro\s+de\s+dossier|n[°º]\s*(?:de\s+)?dossier|IPP|NIP|` +
    String.raw`num(?:ero)?\.?\s+(?:di\s+)?cartella(?:\s+clinica)?|n\.\s*cartella|nosologico|` +
    String.raw`pati[eë]ntnummer|pati[eë]ntnr\.?|ziekenhuisnummer|registratienummer|` +
    String.raw`n[uú]mero\s+(?:de\s+)?processo|n\.?[º°]\s*(?:de\s+)?processo|n[uú]mero\s+(?:de\s+)?utente|n\.?[º°]\s*(?:de\s+)?utente)` +
    String.raw`\s*[:.#\-]?\s*([A-Z0-9][A-Z0-9\-\/]{3,19})`,
  'giu'
);

const EU_INSURANCE_PATTERN = new RegExp(
  String.raw`(?<![\p{L}])(?:Krankenversichertennummer|KVNR|Versichertennummer|Versicherten-?Nr\.?|Versicherungsnummer|` +
    String.raw`tarjeta\s+sanitaria(?:\s+individual)?|CIP(?:-SNS)?|TSI|NUSS|n[º°]?\s*(?:de\s+)?afiliaci[oó]n|` +
    String.raw`num[eé]ro\s+de\s+s[eé]curit[eé]\s+sociale|carte\s+vitale|NIR|` +
    String.raw`tessera\s+sanitaria|codice\s+sanitario|n\.\s*tessera|` +
    String.raw`polisnummer|verzekerdennummer|zorgverzekeringsnummer|` +
    String.raw`n[uú]mero\s+(?:de\s+)?benefici[aá]rio|n[uú]mero\s+(?:de\s+)?seguran[cç]a\s+social|NISS|NSS|SVNR|SV-?Nummer|Sozialversicherungsnummer)` +
    String.raw`\s*[:.#\-]?\s*([A-Z0-9][A-Z0-9\-\/]{3,19}(?:[ \t]\d{2,6}){0,4})`,
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
const ID_CARD_PATTERN = /(?<![\p{L}])(?:Personalausweis(?:nummer)?|Ausweisnummer|carte\s+d'identit[eé]|CNI|carta\s+d'identit[àa]|identiteitskaart|cart[aã]o\s+de\s+cidad[aã]o|CC|documento\s+de\s+identidad)\s*(?:n[º°r.]*)?\s*[:.#\-]?\s*([A-Z0-9][A-Z0-9 ]{5,14}[A-Z0-9])(?![A-Z0-9])/giu;
// Mexico
const MX_CURP_PATTERN = /(?<![A-Z0-9])[A-Z][AEIOUX][A-Z]{2}\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])[HMX](?:AS|BC|BS|CC|CL|CM|CS|CH|DF|DG|GT|GR|HG|JC|MC|MN|MS|NT|NL|OC|PL|QT|QR|SP|SL|SR|TC|TS|TL|VZ|YN|ZS|NE)[B-DF-HJ-NP-TV-Z]{3}[A-Z\d]\d(?![A-Z0-9])/g;
const MX_RFC_PATTERN = /(?<![A-Z0-9])[A-ZÑ&]{3,4}\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])[A-Z\d]{2}[A\d](?![A-Z0-9])/g;

// Postcode and the town after it ("28013 Madrid", "1012 AB Amsterdam",
// "1000-001 Lisboa", "00-950 Warszawa").
const EU_POSTCODE_TOWN_PATTERN = /(?<![\d\-])(?:\d{5}|\d{4}\s?[A-Z]{2}|\d{4}-\d{3}|\d{2}-\d{3})[ \t]+\p{Lu}\p{Ll}+(?:[ \t\-](?:am|an|de|del|la|le|sur|sous|im|bei|aan|\p{Lu}\p{Ll}+)){0,3}/gu;

// French-style pairs "06 12 34 56 78", "+33 6 12 34 56 78"; "+49 (0)30 1234567".
const EU_PHONE_PATTERN = /(?<![\d+])(?:(?:\+33|0033)\s?[1-9]|0[1-9])(?:[\s.\-]?\d{2}){4}(?!\d)|(?<![\d+])\+(?:3\d|4\d|35\d|42\d)\s?(?:\(0\)\s?)?\d{1,4}(?:[\s.\-\/]?\d{2,4}){2,4}(?!\d)/g;

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
    String.raw`\p{Lu}[\p{L}'\-]+(?:\s+\p{Lu}[\p{L}'\-]+){0,3}(?:,?\s*(?:n\.?[º°]?\s*)?\d{1,4}[a-zA-Z]?(?!\d))?` +
    String.raw`|\p{Lu}[\p{L}\-]*(?:straße|strasse|str\.|weg|gasse|platz|allee|ring|damm|ufer|laan|straat|plein|gracht|kade|dijk|singel|steeg)\s+\d{1,4}[a-zA-Z]?)`,
  'gu'
);

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

  { label: 'NAME', category: 'EU', description: 'Name (title: Sr., Frau, Mme, Dott., Dhr.…)', pattern: EU_HONORIFIC_PATTERN, priority: 86 },
  { label: 'NAME', category: 'EU', description: 'Name (field: Paciente:, Nachname:, Nom:…)', pattern: EU_NAME_FIELD_PATTERN, priority: 85 },
  { label: 'NAME', category: 'EU', description: 'Name (field: Patient: First Last)', pattern: PATIENT_FIELD_PATTERN, priority: 85 },
  { label: 'NAME', category: 'EU', description: 'Name (family: su hija, seine Tochter, sa fille…)', pattern: EU_RELATION_PATTERN, priority: 83 },

  { label: 'INSTITUTION', category: 'QUASI', description: 'Treating institution (DE/FR/ES/IT/NL/PT)', pattern: EU_INSTITUTION_PATTERN, priority: 50 },
  { label: 'AGE_OVER_89', category: 'EU', description: 'Age that may exceed 89 (DE/FR/ES/IT/NL/PT)', pattern: EU_AGE_PATTERN, priority: 30 },
];
