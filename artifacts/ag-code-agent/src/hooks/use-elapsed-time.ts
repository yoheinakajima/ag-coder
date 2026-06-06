import { useState, useEffect } from "react";

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m ${seconds}s`;
}

export interface ElapsedInfo {
  /** Formatted label, with a trailing "…" while live. Null if no start time. */
  text: string | null;
  /** Raw elapsed milliseconds, or null if no start time. */
  ms: number | null;
  /** True while the run is still in progress (has start, no end). */
  isLive: boolean;
}

export function useElapsedInfo(
  startedAt: string | null | undefined,
  endedAt: string | null | undefined,
): ElapsedInfo {
  const [now, setNow] = useState(() => Date.now());

  const isLive = !!startedAt && !endedAt;

  useEffect(() => {
    if (!isLive) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isLive]);

  if (!startedAt) return { text: null, ms: null, isLive: false };

  const start = new Date(startedAt).getTime();
  const end = endedAt ? new Date(endedAt).getTime() : now;
  const ms = Math.max(0, end - start);
  const label = formatDuration(ms);
  return { text: isLive ? `${label}…` : label, ms, isLive };
}

export function useElapsedTime(
  startedAt: string | null | undefined,
  endedAt: string | null | undefined,
): string | null {
  return useElapsedInfo(startedAt, endedAt).text;
}
