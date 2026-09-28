import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Batch de-identify interview transcripts',
  description: 'De-identify many interview transcripts at once, with the same label for the same person in every file and one review screen. Runs in your browser; nothing is uploaded.',
  alternates: { canonical: 'https://tekdruid.com/privacyscript/batch/' },
  robots: { index: true, follow: true },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
