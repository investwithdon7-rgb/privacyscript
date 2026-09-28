import Link from 'next/link';

export function Brand({ subtitle }: { subtitle?: string }) {
  return (
    <header className="flex items-center justify-between gap-4 py-6 border-b border-[color:var(--color-border)]">
      <Link href="/" className="flex items-baseline gap-2">
        <span className="text-xl font-bold tracking-tight">PrivacyScript</span>
        <span className="mono text-xs text-[color:var(--color-muted)]">
          by TekDruid
        </span>
      </Link>
      <div className="flex items-center gap-4">
        {subtitle ? (
          <span className="mono text-xs text-[color:var(--color-muted)] uppercase tracking-widest hidden sm:inline">
            {subtitle}
          </span>
        ) : null}
        <Link
          href="/guide/"
          className="rounded-full px-4 py-1.5 text-sm border border-[color:var(--color-border)] hover:border-[#4F46E5] hover:text-white transition-colors"
        >
          User guide
        </Link>
      </div>
    </header>
  );
}
