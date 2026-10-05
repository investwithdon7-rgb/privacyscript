/**
 * Realistic replacements ("surrogates"): a name becomes a believable fake
 * name, a phone number keeps its format with other digits, and so on.
 * AI tools and readers handle the text naturally, and a name the detectors
 * missed no longer stands out among codes ("hiding in plain sight").
 *
 * - Consistent: the same original always gets the same surrogate within a
 *   session (all files), and two originals never share one.
 * - Names are mapped word by word, so "Karoline Stenberg", "Mrs Stenberg"
 *   and "STENBERG^KAROLINE" stay one fake person. Titles and case are kept.
 * - Numbers use ranges reserved for fiction where they exist (NHS 999…,
 *   UK drama phone numbers 07700 900…, example.org, 192.0.2.x), so a
 *   surrogate is never someone's real number.
 * - Pseudonymise: surrogates go into the key file like codes. Anonymise:
 *   the seed is thrown away with the tab.
 *
 * Dates, ages over 89, postcodes and quasi-identifiers return null: their
 * usual handling (shift, 90+, generalise) stays.
 */

import type { IdentifierLabel } from '@/lib/identifiers';

const FIRST = (
  'Laura James Priya Tomasz Fiona Amira Kevin Elena Siobhan Daniel Grace Omar Hannah Lucas Maya Samuel Chloe Arjun ' +
  'Isla Mateo Zara Ethan Nadia Felix Leah Ravi Sofia Owen Imogen Kwame Alice Diego Ruth Hamza Ella Viktor Naomi ' +
  'Callum Aisha Hugo Freya Jonah Mei Rory Anya Theo Leila Patrick Ines Marcus Yara Simon Esme Tariq Rosa Adam ' +
  'Bethan Nikhil Clara Joel Fatima Ewan Lina Max Harriet Andrei Molly Kofi Julia Noah Sana Robin Erin Tobias ' +
  'Abigail Kenji Megan Luca Aoife Ibrahim Holly Stefan Asha Declan Nora Yusuf Poppy Mikael Ruby Dev Iris Conor'
).split(' ');
const LAST = (
  'Bennett Holloway Marsh Okonjo Lindqvist Carver Ashworth Pemberton Delgado Fairbairn Quinlan Rasmussen Thornley ' +
  'Abernathy Kowalczyk Mensah Varga Whitlock Castellano Haldane Nakamura Prescott Oyelaran Brennan Lowther ' +
  'Sandoval Ingram Faulkner Hargreaves Tremaine Okafor Vasquez Ellery Dunmore Petrovic Calloway Ashdown ' +
  'Blackwood Kirkland Moreau Sheridan Oduya Lockhart Fenwick Barlow Sutcliffe Iyer Novak Ridley Marchetti ' +
  'Gallagher Whitmore Osei Lambert Carrick Halvorsen Penrose Tanaka Wexford Dalgleish Romero Hollis Kendrick ' +
  'Ainsworth Mbeki Langley Ferreira Cartwright Kerrigan Holm Babatunde Merriman Sorensen Driscoll Achebe Winslow'
).split(' ');
const TOWNS = (
  'Ashbury Bramwell Caldmoor Dunholme Elderwick Farrowby Glenmarsh Hollinsford Ivybridge Kestrel Lowmere ' +
  'Marrowfield Northcote Oakhurst Pennington Queensbridge Redmarsh Saltham Thornbury Upwell Westerby Yarrowdale ' +
  'Brackenridge Corrowmoor Fennick Galloway Harrowgate Ketterby Linthorpe Morwenna Netherby Penhallow'
).split(' ');
const STREETS = ['Elm Road', 'Station Street', 'Mill Lane', 'Church Walk', 'Orchard Close', 'Victoria Avenue', 'Park Row', 'Willow Drive', 'Quarry Lane', 'Harbour View'];
const TITLES = /^(?:dr|mr|mrs|ms|miss|mx|prof|professor|sir|dame|nurse|sister|rev|herr|frau|sr|sra|dra)\.?$/i;

/** FNV-1a: fast, stable hash. Only picks list entries; the seed keeps it unguessable. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function matchCase(original: string, surrogate: string): string {
  if (original.length > 1 && original === original.toUpperCase() && /\p{L}/u.test(original)) return surrogate.toUpperCase();
  if (original === original.toLowerCase() && /\p{L}/u.test(original)) return surrogate.toLowerCase();
  return surrogate;
}

export class SurrogateRegistry {
  private byKey = new Map<string, string>();
  private used = new Map<string, Set<string>>();

  constructor(private seed: string) {}

  /** Pick from a list, never reusing an entry for another original in this pool. */
  private pick(pool: string, list: string[], key: string): string {
    const k = `${pool}\0${key}`;
    const known = this.byKey.get(k);
    if (known) return known;
    const used = this.used.get(pool) ?? new Set<string>();
    this.used.set(pool, used);
    const start = hash(`${this.seed}|${pool}|${key}`);
    let value = '';
    for (let i = 0; i < list.length * 4; i++) {
      // Past the list's size, add a numeral rather than reuse a value.
      const base = list[(start + i) % list.length];
      const round = Math.floor(i / list.length);
      value = round === 0 ? base : `${base}${round + 1}`;
      if (!used.has(value)) break;
    }
    used.add(value);
    this.byKey.set(k, value);
    return value;
  }

  private nameWord(word: string, role: 'first' | 'last'): string {
    const key = word.toLowerCase();
    // A word already seen in the other role keeps that surrogate (one person).
    const other = this.byKey.get(`${role === 'first' ? 'last' : 'first'}\0${key}`);
    const fake = other ?? this.pick(role, role === 'first' ? FIRST : LAST, key);
    return matchCase(word, fake);
  }

  private name(original: string): string {
    if (original.includes('^')) {
      // DICOM person name: Family^Given^Middle^Prefix^Suffix
      return original
        .split('^')
        .map((part, i) => (!part || i >= 3 ? part : part.split(/\s+/).map((w) => this.nameWord(w, i === 0 ? 'last' : 'first')).join(' ')))
        .join('^');
    }
    const words = original.split(/(\s+)/);
    const real = words.map((w, i) => ({ w, i })).filter(({ w }) => /\p{L}/u.test(w) && !TITLES.test(w));
    const titled = words.some((w) => TITLES.test(w));
    return words
      .map((w, i) => {
        if (!/\p{L}/u.test(w) || TITLES.test(w)) return w;
        const isLast = real.length > 1 ? i === real[real.length - 1].i : titled;
        const lead = w.match(/^[^\p{L}]*/u)![0];
        const tail = w.match(/[^\p{L}'’-]*$/u)![0];
        const core = w.slice(lead.length, w.length - tail.length);
        return lead + this.nameWord(core, isLast ? 'last' : 'first') + tail;
      })
      .join('');
  }

  /** Same shape, other characters: digits stay digits, letters stay letters. */
  private shape(original: string, salt: string, prefix = ''): string {
    let h = hash(`${this.seed}|${salt}|${original}`);
    let out = '';
    let digitsDone = 0;
    for (const c of original) {
      h = Math.imul(h ^ (h >>> 13), 0x5bd1e995) >>> 0;
      if (/\d/.test(c)) {
        out += digitsDone < prefix.length ? prefix[digitsDone] : String(h % 10);
        digitsDone++;
      } else if (/[a-z]/.test(c)) out += String.fromCharCode(97 + (h % 26));
      else if (/[A-Z]/.test(c)) out += String.fromCharCode(65 + (h % 26));
      else out += c;
    }
    return out;
  }

  private unique(pool: string, make: (attempt: number) => string, key: string): string {
    const k = `${pool}\0${key}`;
    const known = this.byKey.get(k);
    if (known) return known;
    const used = this.used.get(pool) ?? new Set<string>();
    this.used.set(pool, used);
    let value = make(0);
    for (let a = 1; used.has(value) && a < 50; a++) value = make(a);
    used.add(value);
    this.byKey.set(k, value);
    return value;
  }

  get(label: IdentifierLabel, original: string): string | null {
    const o = original.trim();
    if (!o) return null;
    switch (label) {
      case 'NAME':
        return this.name(o);
      case 'ADDRESS_LINE': {
        if (/\d/.test(o)) {
          return this.unique('street', (a) => `${this.shape(o.match(/\d+/)![0], `street${a}`)} ${STREETS[hash(`${this.seed}${o}${a}`) % STREETS.length]}`, o.toLowerCase());
        }
        return matchCase(o, this.pick('town', TOWNS, o.toLowerCase()));
      }
      case 'INSTITUTION': {
        const town = this.pick('town', TOWNS, `inst:${o.toLowerCase()}`);
        const kind = /clinic|surgery|practice|cent(re|er)|health/i.test(o) ? 'Medical Centre' : /university/i.test(o) ? 'University' : 'General Hospital';
        return matchCase(o, `${town} ${kind}`);
      }
      case 'EMAIL': {
        const first = this.pick('first', FIRST, `email:${o.toLowerCase()}`).toLowerCase();
        const last = this.pick('last', LAST, `email:${o.toLowerCase()}`).toLowerCase();
        return `${first}.${last}@example.org`;
      }
      case 'PHONE':
      case 'FAX': {
        const digits = o.replace(/\D/g, '');
        // UK mobile: Ofcom drama range 07700 900000-900999.
        if (/^(?:07|447)/.test(digits) && digits.length >= 11) {
          return this.unique('phone', (a) => this.shape(o, `phone${a}`, digits.startsWith('44') ? '447700900' : '07700900'), o);
        }
        return this.unique('phone', (a) => this.shape(o, `phone${a}`), o);
      }
      case 'NHS_NUMBER':
        return this.unique('nhs', (a) => this.shape(o, `nhs${a}`, '999'), o); // 999… = NHS test range
      case 'SSN':
        return this.unique('ssn', (a) => this.shape(o, `ssn${a}`, '9'), o); // 9xx is never issued
      case 'IP':
        return this.unique('ip', (a) => `192.0.2.${(hash(`${this.seed}${o}${a}`) % 254) + 1}`, o); // RFC 5737
      case 'URL':
        return this.unique('url', (a) => `https://example.org/${this.shape('page0000', `url${a}`).slice(4)}`, o);
      case 'MRN':
      case 'INSURANCE_ID':
      case 'ACCOUNT_NUMBER':
      case 'LICENSE':
      case 'VEHICLE_VIN':
      case 'DEVICE_ID':
      case 'REFERENCE_ID':
      case 'PASSPORT':
      case 'UK_NINO':
      case 'IBAN':
      case 'NATIONAL_ID_DK_CPR':
      case 'NATIONAL_ID_NL_BSN':
      case 'NATIONAL_ID_ES':
      case 'NATIONAL_ID_IT_CF':
      case 'NATIONAL_ID_CH_AHV':
        return this.unique(label, (a) => this.shape(o, `${label}${a}`), o);
      default:
        return null; // dates, ages, postcodes, quasi-identifiers: usual handling
    }
  }
}

const registries = new Map<string, SurrogateRegistry>();
let anonSeed: string | null = null;

/**
 * The session's registry. Pseudonymise passes the session secret, so the
 * same person keeps the same surrogate in every file; anonymise uses a
 * random seed that lives only as long as the tab.
 */
export function surrogateRegistry(secretBytes?: Uint8Array): SurrogateRegistry {
  let seed: string;
  if (secretBytes) seed = Array.from(secretBytes, (b) => b.toString(16).padStart(2, '0')).join('');
  else {
    if (!anonSeed) {
      const r = new Uint8Array(16);
      crypto.getRandomValues(r);
      anonSeed = Array.from(r, (b) => b.toString(16).padStart(2, '0')).join('');
    }
    seed = anonSeed;
  }
  let reg = registries.get(seed);
  if (!reg) {
    reg = new SurrogateRegistry(seed);
    registries.set(seed, reg);
  }
  return reg;
}
