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

export const metadata: Metadata = {
  title: 'PrivacyScript — by TekDruid',
  description:
    'De-identify health records in your browser. Nothing leaves your device. GDPR, HIPAA, EHDS, UK GDPR, NIS2.',
  robots: { index: true, follow: true },
  manifest: '/privacyscript/manifest.json',
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
      </head>
      <body>
        {children}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              if ('serviceWorker' in navigator) {
                window.addEventListener('load', function() {
                  navigator.serviceWorker.register('/privacyscript/sw.js')
                    .catch(function() { /* SW registration failure is non-fatal */ });
                });
              }
            `,
          }}
        />
      </body>
    </html>
  );
}
