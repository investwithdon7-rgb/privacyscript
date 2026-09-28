import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Open a re-identification key file',
  description: 'Look up pseudonym codes and restore pseudonymised files with your encrypted PrivacyScript key file. Decrypted in your browser only.',
  alternates: { canonical: 'https://tekdruid.com/privacyscript/key/' },
  robots: { index: true, follow: true },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
