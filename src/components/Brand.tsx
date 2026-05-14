import Link from 'next/link';

export function Brand({ subtitle }: { subtitle?: string }) {
  return (
    <header className="flex items-center justify-between py-6 border-b border-[color:var(--color-border)]">
      <Link href="/" className="flex items-baseline gap-2">
        <span className="text-xl font-bold tracking-tight">PrivacyScript</span>
        <span className="mono text-xs text-[color:var(--color-muted)]">
          by TekDruid
        </span>
      </Link>
      {subtitle ? (
        <span className="mono text-xs text-[color:var(--color-muted)] uppercase tracking-widest">
          {subtitle}
        </span>
      ) : null}
    </header>
  );
}
