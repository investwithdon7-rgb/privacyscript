/**
 * Which language a record is written in, from its most common short words.
 * Fast (first 20,000 characters) and dependency-free; good enough to choose
 * the name model and to suggest where a record comes from. It never decides
 * how a record is de-identified on its own.
 */

export type Lang = 'en' | 'de' | 'fr' | 'es' | 'it' | 'nl' | 'pt';

export const LANGUAGE_NAMES: Record<Lang, string> = {
  en: 'English',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
  it: 'Italian',
  nl: 'Dutch',
  pt: 'Portuguese',
};

// The most common words of each language. A word shared by several
// languages ("de", "la", "a") counts for each of them in equal parts, so
// short notes are decided by the words only one language uses.
const WORDS: Record<Lang, string> = {
  en: 'the and of to a in is was for on with she he her his patient had has be are this that at by from were not no which an as it',
  de: 'der die und das ist nicht mit sie ich ein eine einen den von zu auf für dem des sich auch wurde wird bei nach keine im am zum zur wir patientin patient jahre',
  fr: 'le la les et des de du est une un pour que dans pas qui sur avec il elle au aux ce été sont son ses à en patiente patient ans',
  es: 'el la los las de del y en que por con una un para es se su sus al lo como más pero fue muy sin hay a paciente años',
  it: 'il la lo gli le di che e è non per una un sono con della anche ma nel alla dei delle stato ha da in paziente anni',
  nl: 'de het een en van is dat niet ik zijn op te met voor ze die er ook maar werd bij naar geen in patiënt patiënte jaar',
  pt: 'o a os as de do da dos das em um uma não no na ao pelo pela também foi ele ela com para que e é doente utente anos',
};
const SETS = Object.fromEntries(Object.entries(WORDS).map(([l, w]) => [l, new Set(w.split(' '))])) as Record<Lang, Set<string>>;
const SHARED = new Map<string, number>();
for (const set of Object.values(SETS)) for (const w of Array.from(set)) SHARED.set(w, (SHARED.get(w) ?? 0) + 1);

export interface LanguageGuess {
  /** null when there are too few words to tell (a header, a code list). */
  lang: Lang | null;
  /** Share of the counted words that point to the winning language. */
  confidence: number;
}

export function detectLanguage(text: string): LanguageGuess {
  const words = text.slice(0, 20000).toLowerCase().match(/\p{L}+/gu) ?? [];
  const score = Object.fromEntries((Object.keys(SETS) as Lang[]).map((l) => [l, 0])) as Record<Lang, number>;
  let counted = 0;
  for (const w of words) {
    const share = SHARED.get(w);
    if (!share) continue;
    counted++;
    for (const l of Object.keys(SETS) as Lang[]) if (SETS[l].has(w)) score[l] += 1 / share;
  }
  const ranked = (Object.entries(score) as Array<[Lang, number]>).sort((a, b) => b[1] - a[1]);
  const [best, second] = ranked;
  if (counted < 5 || best[1] < 2) return { lang: null, confidence: 0 };
  return { lang: best[0], confidence: best[1] / (best[1] + second[1]) };
}
