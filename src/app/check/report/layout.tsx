import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Compliance report',
  description: 'Private report page.',
  alternates: { canonical: 'https://tekdruid.com/privacyscript/check/report/' },
  robots: { index: false, follow: true },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
