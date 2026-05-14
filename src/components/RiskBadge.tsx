import type { RiskLevel } from '@/lib/constants';

const COLOURS: Record<RiskLevel, { bg: string; text: string; label: string }> = {
  LOW: { bg: 'rgba(16,185,129,0.15)', text: '#10B981', label: 'LOW RISK' },
  MEDIUM: { bg: 'rgba(245,158,11,0.15)', text: '#F59E0B', label: 'MEDIUM RISK' },
  HIGH: { bg: 'rgba(239,68,68,0.15)', text: '#EF4444', label: 'HIGH RISK' },
};

export function RiskBadge({ level }: { level: RiskLevel }) {
  const c = COLOURS[level];
  return (
    <span
      className="mono text-xs font-semibold px-3 py-1 rounded-full inline-block tracking-widest"
      style={{ background: c.bg, color: c.text, border: `1px solid ${c.text}` }}
    >
      {c.label}
    </span>
  );
}
