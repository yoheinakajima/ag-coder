import { useState, useEffect, useRef, useCallback } from "react";
import type { AgentEvent } from "@workspace/api-client-react";

export interface UseReplayReturn {
  isReplaying: boolean;
  replayIndex: number;
  isPlaying: boolean;
  visibleEvents: AgentEvent[];
  currentEvent: AgentEvent | null;
  enterReplay: () => void;
  exitReplay: () => void;
  stepTo: (index: number) => void;
  stepPrev: () => void;
  stepNext: () => void;
  togglePlay: () => void;
}

const PLAY_INTERVAL_MS = 800;

export function useReplay(events: AgentEvent[], enabled: boolean): UseReplayReturn {
  const [isReplaying, setIsReplaying] = useState(false);
  const [replayIndex, setReplayIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const playTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPlay = useCallback(() => {
    if (playTimerRef.current !== null) {
      clearInterval(playTimerRef.current);
      playTimerRef.current = null;
    }
    setIsPlaying(false);
  }, []);

  const clamp = (idx: number) => Math.max(0, Math.min(idx, events.length - 1));

  const enterReplay = useCallback(() => {
    if (!enabled || events.length === 0) return;
    setReplayIndex(0);
    setIsReplaying(true);
    setIsPlaying(false);
  }, [enabled, events.length]);

  const exitReplay = useCallback(() => {
    stopPlay();
    setIsReplaying(false);
    setIsPlaying(false);
  }, [stopPlay]);

  const stepTo = useCallback(
    (index: number) => {
      stopPlay();
      setReplayIndex(clamp(index));
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [stopPlay, events.length],
  );

  const stepPrev = useCallback(() => {
    stopPlay();
    setReplayIndex((prev) => clamp(prev - 1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stopPlay, events.length]);

  const stepNext = useCallback(() => {
    stopPlay();
    setReplayIndex((prev) => clamp(prev + 1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stopPlay, events.length]);

  const togglePlay = useCallback(() => {
    if (isPlaying) {
      stopPlay();
      return;
    }
    if (events.length === 0) return;
    // If at the end, restart from beginning
    setReplayIndex((prev) => {
      const start = prev >= events.length - 1 ? 0 : prev;
      return start;
    });
    setIsPlaying(true);
    playTimerRef.current = setInterval(() => {
      setReplayIndex((prev) => {
        const next = prev + 1;
        if (next >= events.length) {
          clearInterval(playTimerRef.current!);
          playTimerRef.current = null;
          setIsPlaying(false);
          return prev;
        }
        return next;
      });
    }, PLAY_INTERVAL_MS);
  }, [isPlaying, stopPlay, events.length]);

  // Exit replay if run is no longer terminal (shouldn't happen, but safety)
  useEffect(() => {
    if (!enabled && isReplaying) exitReplay();
  }, [enabled, isReplaying, exitReplay]);

  // Escape key exits replay
  useEffect(() => {
    if (!isReplaying) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") exitReplay();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isReplaying, exitReplay]);

  // Cleanup on unmount
  useEffect(() => () => stopPlay(), [stopPlay]);

  const visibleEvents = isReplaying ? events.slice(0, replayIndex + 1) : events;
  const currentEvent = isReplaying && events.length > 0 ? (events[replayIndex] ?? null) : null;

  return {
    isReplaying,
    replayIndex,
    isPlaying,
    visibleEvents,
    currentEvent,
    enterReplay,
    exitReplay,
    stepTo,
    stepPrev,
    stepNext,
    togglePlay,
  };
}
