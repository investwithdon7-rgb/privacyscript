import Link from 'next/link';
import { Brand } from '@/components/Brand';

export const metadata = {
  title: 'User guide: how to de-identify health data, transcripts and surveys',
  description:
    'How to use PrivacyScript to anonymise or pseudonymise patient records, interview transcripts and survey data in your browser before sharing or using AI tools.',
  alternates: { canonical: 'https://tekdruid.com/privacyscript/guide/' },
};

/** Visible FAQ, also published as FAQPage structured data (same text). */
const FAQ: Array<[string, string]> = [
  ['Is my data uploaded anywhere?', 'No. PrivacyScript runs entirely in your browser. Files are read and processed on your device and never sent to a server. Only the name-detection model is downloaded once, and it is then stored by your browser.'],
  ['What is the difference between anonymising and pseudonymising?', 'Anonymising removes identities for good and cannot be reversed, so the output can be used with AI tools or shared publicly. Pseudonymising replaces identities with codes that you can reverse with an encrypted key file; the data is still personal data under GDPR.'],
  ['Can I de-identify interview transcripts before using ChatGPT or other AI tools?', 'Yes. PrivacyScript reads TXT, Word, VTT and SRT transcripts, including Zoom and Teams exports. Speaker names become Interviewer or Participant labels everywhere, other names become [Person 1]-style labels, and sentences that could identify someone by context are flagged for you to keep or remove.'],
  ['Which survey formats are supported?', 'CSV, Excel (.xlsx) and SPSS (.sav) files, including Qualtrics, REDCap, SurveyMonkey and Microsoft Forms exports. PrivacyScript measures whether any respondent can be singled out (k-anonymity) and can widen groups automatically, for example exact ages to age bands.'],
  ['Which languages does it support?', 'Name detection works in English, Dutch, German, Spanish, French, Italian and Portuguese. Transcript rules for context and family names cover English, Dutch, German and Spanish.'],
  ['Is it compliant with GDPR and HIPAA?', 'PrivacyScript supports GDPR pseudonymisation (Article 4(5)) and anonymisation (Recital 26), HIPAA Safe Harbor, UK GDPR and the European Health Data Space. It produces an audit log for every run. Automated checks can miss context, so review the output before sharing and follow your ethics approval.'],
  ['Is PrivacyScript free?', 'Yes. It is free to use in any modern browser, with no account and no tracking.'],
];

const FAQ_LD = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: FAQ.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })),
};

const h2 = 'text-2xl font-bold mt-12';
const card = 'surface rounded-2xl p-6 mt-4';
const muted = 'text-[color:var(--color-muted)]';

function Steps({ items }: { items: string[] }) {
  return (
    <ol className="mt-3 space-y-2">
      {items.map((t, i) => (
        <li key={i} className="flex gap-3 text-sm">
          <span className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0" style={{ background: '#4F46E5' }}>
            {i + 1}
          </span>
          <span className="pt-0.5">{t}</span>
        </li>
      ))}
    </ol>
  );
}

export default function GuidePage() {
  return (
    <main className="min-h-screen max-w-3xl mx-auto px-6 pb-20">
      <Brand subtitle="User guide" />

      <h1 className="text-4xl font-bold mt-10">How to use PrivacyScript</h1>
      <p className={`${muted} mt-4 text-lg leading-relaxed`}>
        PrivacyScript finds names and other personal details in health documents, interview
        transcripts and survey data, and removes or replaces them. Everything runs in your
        browser. Your files are never uploaded.
      </p>

      <nav className={card} aria-label="Contents">
        <div className="mono text-xs uppercase tracking-widest text-[color:var(--color-muted)]">On this page</div>
        <ul className="mt-2 grid sm:grid-cols-2 gap-1 text-sm">
          {[
            ['#choose', 'Anonymise or pseudonymise?'],
            ['#check', 'Check a document'],
            ['#clean', 'Clean up a document'],
            ['#transcripts', 'Interview transcripts'],
            ['#surveys', 'Surveys and spreadsheets'],
            ['#batch', 'Many files at once'],
            ['#key', 'Reversing pseudonymised data'],
            ['#tips', 'Before you share'],
            ['#faq', 'Frequently asked questions'],
          ].map(([href, label]) => (
            <li key={href}><a className="underline hover:text-white" href={href}>{label}</a></li>
          ))}
        </ul>
      </nav>

      <h2 id="choose" className={h2}>Anonymise or pseudonymise?</h2>
      <div className="grid md:grid-cols-2 gap-4">
        <div className={card}>
          <div className="font-semibold">Anonymise</div>
          <p className={`${muted} text-sm mt-2`}>
            Removes identities for good. Nothing can be reversed. Best for AI tools and anything
            shared outside your organisation. Output is blocked if people could still be singled out.
          </p>
        </div>
        <div className={card}>
          <div className="font-semibold">Pseudonymise</div>
          <p className={`${muted} text-sm mt-2`}>
            Replaces identities with codes. You get a key file, locked with your passphrase, to
            reverse them later. The data is still personal data under GDPR, so keep it inside
            your approved research or care setting.
          </p>
        </div>
      </div>

      <h2 id="check" className={h2}>Check a document</h2>
      <p className={`${muted} mt-2`}>Find out what is in a document before you share it or paste it into an AI tool.</p>
      <Steps items={[
        'On the home page choose "Check".',
        'Pick the rules that apply to you (EU, UK, US or General).',
        'Drop your file. A progress card shows each stage while it is scanned.',
        'Read the report. If it is not safe, choose Anonymise or Pseudonymise to clean it up.',
      ]} />

      <h2 id="clean" className={h2}>Clean up a document</h2>
      <Steps items={[
        'On the home page choose "Clean up" and pick where the data will go.',
        'Drop your file and wait for the scan (the first time, the name model downloads once, about a minute).',
        'Work through the numbered review steps. Only the current step is open; press its button to move on.',
        'Read the risk check. If the risk is high you must confirm before continuing.',
        'Download the cleaned file and the audit log. For pseudonymise, also save the key file with a passphrase.',
      ]} />

      <h2 id="transcripts" className={h2}>Interview transcripts</h2>
      <p className={`${muted} mt-2 text-sm leading-relaxed`}>
        Works with TXT, Word, VTT and SRT, including Zoom and Teams exports, in English, Dutch,
        German and Spanish. Timestamps are kept.
      </p>
      <Steps items={[
        'Check the speakers: real names become "Interviewer" or "Participant 1". Change a role with one click, or type your own label.',
        'Choose readable labels ([Person 1]) or codes. Readable labels keep the same number for the same person.',
        'Decide on each highlighted passage. Some sentences identify people without a name, such as "the only nurse on the ward". Keep or remove each one.',
        'Decide on possible names we were not sure about. Confirming a name replaces every mention of it.',
      ]} />

      <h2 id="surveys" className={h2}>Surveys and spreadsheets</h2>
      <p className={`${muted} mt-2 text-sm leading-relaxed`}>
        Works with CSV, Excel and SPSS files, including Qualtrics, REDCap, SurveyMonkey and Microsoft
        Forms exports. The result downloads as CSV.
      </p>
      <Steps items={[
        'Check what each column contains. Columns that identify people (names, emails, IP addresses) are removed or coded.',
        'Look at "Can anyone be singled out?". Each person must share their details with at least 5 others.',
        'If not, press "Fix automatically". It widens groups, for example exact ages become age bands.',
        'Confirm the columns and continue.',
      ]} />

      <h2 id="batch" className={h2}>Many files at once</h2>
      <p className={`${muted} mt-2 text-sm leading-relaxed`}>
        Use <Link className="underline hover:text-white" href="/batch/">Batch processing</Link> for a study with several
        interviews. The same person gets the same label in every file. You review all flagged
        passages on one screen, and files that fail a check are held back. Open surveys and PDFs
        one at a time.
      </p>

      <h2 id="key" className={h2}>Reversing pseudonymised data</h2>
      <p className={`${muted} mt-2 text-sm leading-relaxed`}>
        Go to <Link className="underline hover:text-white" href="/key/">Open a key file</Link>, choose your key
        file and enter its passphrase. You can look up any code, see how dates were shifted, and
        restore a pseudonymised text file. Keep the key file separate from the data; without the
        passphrase it cannot be opened, and it cannot be recovered if lost.
      </p>

      <h2 id="tips" className={h2}>Before you share</h2>
      <ul className={`${muted} mt-3 space-y-2 text-sm list-disc pl-5`}>
        <li>Automated checks can miss things. Skim the result, and ask: could someone who knows this person recognise them?</li>
        <li>Check that your ethics approval and data management plan allow sharing, especially with AI tools.</li>
        <li>Keep the audit log with your records. It shows what was changed and contains no personal data.</li>
        <li>Text in scripts PrivacyScript cannot read (for example Tamil or Sinhala) cannot be checked. It will tell you.</li>
      </ul>

      <h2 id="faq" className={h2}>Frequently asked questions</h2>
      <div className="mt-2">
        {FAQ.map(([q, a]) => (
          <details key={q} className={card}>
            <summary className="cursor-pointer font-semibold">{q}</summary>
            <p className={`${muted} text-sm mt-3 leading-relaxed`}>{a}</p>
          </details>
        ))}
      </div>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(FAQ_LD) }} />

      <div className="mt-12">
        <Link href="/" className="btn-primary">Start now</Link>
      </div>
    </main>
  );
}
