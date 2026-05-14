'use client';

import { useEffect, useState } from 'react';
import { getSession, subscribe, type SessionState } from '@/state/session';

export function useSession(): SessionState {
  const [snapshot, setSnapshot] = useState<SessionState>(getSession());
  useEffect(() => subscribe(setSnapshot), []);
  return snapshot;
}
