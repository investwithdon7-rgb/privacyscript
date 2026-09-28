import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Check if a document is safe to share or upload to AI',
  description: 'Scan a patient record, interview transcript or survey for names and other personal data, and see whether it is safe to share or paste into an AI tool. Runs in your browser; nothing is uploaded.',
  alternates: { canonical: 'https://tekdruid.com/privacyscript/check/' },
  robots: { index: true, follow: true },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
