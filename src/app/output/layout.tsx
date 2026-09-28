import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Working',
  description: 'Private working page.',
  alternates: { canonical: 'https://tekdruid.com/privacyscript/output/' },
  robots: { index: false, follow: true },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
