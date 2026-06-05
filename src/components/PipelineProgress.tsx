'use client';

import { PIPELINE_STAGES } from '@/lib/constants';

interface PipelineProgressProps {
  stageIndex: number;
}

export function PipelineProgress({ stageIndex }: PipelineProgressProps) {
  return (
    <div className="grid grid-cols-6 gap-2 mt-6">
      {PIPELINE_STAGES.map((stage, i) => {
        const state =
          i < stageIndex ? 'done' : i === stageIndex ? 'active' : 'pending';
        return (
          <div key={stage} className="flex flex-col items-center">
            <div
              className="w-full h-2 rounded-full"
              style={{
                background:
                  state === 'done'
                    ? 'var(--color-success)'
                    : state === 'active'
                    ? 'var(--color-primary)'
                    : 'var(--color-surface-2)',
              }}
            />
            <span
              className={`hidden lg:block mono text-[10px] mt-2 uppercase tracking-wider ${
                state === 'pending'
                  ? 'text-[color:var(--color-muted)]'
                  : 'text-white'
              }`}
            >
              {stage}
            </span>
          </div>
        );
      })}
    </div>
  );
}
