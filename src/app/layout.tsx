import type { Metadata } from 'next';
import { DM_Sans, DM_Mono } from 'next/font/google';
import './globals.css';

const dmSans = DM_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-dm-sans',
  display: 'swap',
});

const dmMono = DM_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-dm-mono',
  display: 'swap',
});

const SITE = 'https://tekdruid.com/privacyscript/';
const DESCRIPTION =
  'Free, private de-identification in your browser. Anonymise or pseudonymise patient records, interview transcripts and survey data before sharing or using AI tools. Nothing is uploaded. GDPR, HIPAA, EHDS, UK GDPR.';

export const metadata: Metadata = {
  metadataBase: new URL('https://tekdruid.com'),
  title: {
    default: 'PrivacyScript: de-identify health data, transcripts and surveys in your browser',
    template: '%s · PrivacyScript by TekDruid',
  },
  description: DESCRIPTION,
  applicationName: 'PrivacyScript by TekDruid',
  keywords: [
    'de-identification', 'anonymise', 'pseudonymise', 'anonymize', 'pseudonymize',
    'health data', 'patient records', 'interview transcripts', 'survey data', 'qualitative research',
    'GDPR', 'HIPAA', 'EHDS', 'UK GDPR', 'k-anonymity', 'redact names', 'AI tools', 'Qualtrics', 'SPSS',
  ],
  authors: [{ name: 'TekDruid', url: 'https://tekdruid.com' }],
  alternates: { canonical: SITE },
  robots: { index: true, follow: true },
  manifest: '/privacyscript/manifest.json',
  openGraph: {
    type: 'website',
    url: SITE,
    siteName: 'PrivacyScript by TekDruid',
    title: 'PrivacyScript: de-identify health data in your browser',
    description: DESCRIPTION,
    images: [{ url: '/privacyscript/logo.png', alt: 'PrivacyScript by TekDruid' }],
  },
  twitter: {
    card: 'summary',
    title: 'PrivacyScript: de-identify health data in your browser',
    description: DESCRIPTION,
    images: ['/privacyscript/logo.png'],
  },
};

/** Structured data: helps search engines and AI answer engines describe the tool. */
const JSON_LD = {
  '@context': 'https://schema.org',
  '@type': 'WebApplication',
  name: 'PrivacyScript by TekDruid',
  url: SITE,
  applicationCategory: 'HealthApplication',
  operatingSystem: 'Any modern web browser',
  description: DESCRIPTION,
  offers: { '@type': 'Offer', price: '0', priceCurrency: 'EUR' },
  inLanguage: 'en',
  publisher: { '@type': 'Organization', name: 'TekDruid', url: 'https://tekdruid.com' },
  featureList: [
    'Runs entirely in the browser; files are never uploaded',
    'Anonymise or pseudonymise (with an encrypted re-identification key)',
    'Patient records: text, Word, PDF, scanned PDF, FHIR R4, HL7 v2, DICOM',
    'Interview transcripts: TXT, Word, VTT, SRT, Zoom and Teams exports',
    'Survey data: CSV, Excel, SPSS; Qualtrics, REDCap, SurveyMonkey, Microsoft Forms',
    'Name detection in English, Dutch, German, Spanish, French, Italian, Portuguese',
    'k-anonymity risk measurement and audit log',
  ],
};

export function generateViewport() {
  return {
    themeColor: '#4F46E5',
  };
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${dmSans.variable} ${dmMono.variable}`}>
      <head>
        <link rel="manifest" href="/privacyscript/manifest.json" />
        <meta name="theme-color" content="#4F46E5" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD) }} />
      </head>
      <body>
        {children}
        <script
          dangerouslySetInnerHTML={{
            __html:
              process.env.NODE_ENV === 'production'
                ? `
              if ('serviceWorker' in navigator) {
                window.addEventListener('load', function() {
                  navigator.serviceWorker.register('/privacyscript/sw.js')
                    .catch(function() { /* SW registration failure is non-fatal */ });
                });
              }
            `
                : `
              // Dev: no service worker. Unregister any stale one and clear its
              // caches — a cached production shell served against the dev
              // server breaks navigation with 404 chunks.
              if ('serviceWorker' in navigator) {
                navigator.serviceWorker.getRegistrations().then(function(rs) {
                  rs.forEach(function(r) { r.unregister(); });
                });
                if (window.caches) {
                  caches.keys().then(function(ks) {
                    ks.forEach(function(k) { caches.delete(k); });
                  });
                }
              }
            `,
          }}
        />
      </body>
    </html>
  );
}
