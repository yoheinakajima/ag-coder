import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { useParams, Link, useLocation } from "wouter";
import {
  useGetRun,
  useGetRunEvents,
  useGetRunGraph,
  useForkRun,
  useCancelRun,
  useResolvePermission,
  useRunTest,
  useGetRunTestAvailability,
  useListRunFiles,
  useGetRunFileContent,
  useGetRunPatch,
  getGetRunEventsQueryKey,
  getGetRunQueryKey,
  getGetRunGraphQueryKey,
  queryConfig,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Slider } from "@/components/ui/slider";
import {
  Square,
  GitFork,
  ChevronLeft,
  FileText,
  TestTube,
  ShieldAlert,
  ChevronDown,
  ChevronUp,
  Folder,
  ArrowLeft,
  GitPullRequest,
  GitCompareArrows,
  Play,
  Pause,
  ChevronRight,
  SkipBack,
  Rewind,
} from "lucide-react";
import { CausalGraph } from "@/components/CausalGraph";
import { CausalChainPanel } from "@/components/CausalChainPanel";
import { ApprovalBanner } from "@/components/ApprovalBanner";
import type {
  AgentEvent,
  GraphObject,
  PermissionDecisionDecision,
} from "@workspace/api-client-react";
import { toast } from "sonner";
import { useElapsedTime } from "@/hooks/use-elapsed-time";
import { useReplay } from "@/hooks/use-replay";
import { Clock } from "lucide-react";
import { getModelLabel } from "@/lib/models";
import { CodeBlock } from "@/components/CodeBlock";
import { SplitDiffView } from "@/components/SplitDiffView";
import { Progress } from "@/components/ui/progress";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useListRuns } from "@workspace/api-client-react";
import type { FileEntry } from "@workspace/api-client-react";
import { Columns2, AlignLeft, History } from "lucide-react";
import { asRecord, strField, numField } from "@/lib/utils";

// Extract a permission ID from any permission-related event payload,
// covering all known key names used by agent (permissionId/id) and backend (permId).
function extractPermId(payload: unknown): string | undefined {
  const p = asRecord(payload);
  return strField(p?.permId) ?? strField(p?.permissionId) ?? strField(p?.id);
}

export default function RunDetail() {
  const { runId } = useParams<{ runId: string }>();
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const { data: allRuns } = useListRuns();

  const { data: run, isLoading: runLoading } = useGetRun(runId, {
    query: queryConfig({
      refetchInterval: (data: any) =>
        data?.state?.data?.status === "running" || data?.state?.data?.status === "pending"
          ? 3000
          : false,
    }),
  });

  const { data: eventsData, isLoading: eventsLoading } = useGetRunEvents(runId, {
    query: queryConfig({
      refetchInterval: run?.status === "running" ? 2000 : false,
    }),
  });

  const { data: graphData, isLoading: graphLoading } = useGetRunGraph(runId, {
    query: queryConfig({
      refetchInterval: run?.status === "running" ? 2000 : false,
    }),
  });

  const cancelRun = useCancelRun();
  const forkRun = useForkRun();
  const resolvePerm = useResolvePermission();
  const runTest = useRunTest();

  const isCompleted = run?.status === "completed";
  const { data: testAvailability } = useGetRunTestAvailability(runId ?? "", {
    query: queryConfig({ enabled: !!runId && isCompleted }),
  });
  const hasTests = testAvailability?.hasTests ?? null;

  const [streamEvents, setStreamEvents] = useState<AgentEvent[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [highlightedEventId, setHighlightedEventId] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<GraphObject | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const isRunning = run?.status === "running" || run?.status === "pending";
  const isTerminal = run?.status === "completed" || run?.status === "failed";
  const duration = useElapsedTime(run?.createdAt, run?.completedAt);

  useEffect(() => {
    if (!isRunning || !runId) return;

    const es = new EventSource(`/api/runs/${runId}/stream`);

    es.addEventListener("agent_event", (e) => {
      try {
        const event = JSON.parse(e.data) as AgentEvent;
        setStreamEvents((prev) => {
          if (prev.find((p) => p.id === event.id)) return prev;
          return [...prev, event].sort((a, b) => a.seq - b.seq);
        });
        queryClient.invalidateQueries({ queryKey: getGetRunGraphQueryKey(runId) });
      } catch (err) {
        console.error("SSE parse error", err);
      }
    });

    es.addEventListener("run_done", () => {
      queryClient.invalidateQueries({ queryKey: getGetRunQueryKey(runId) });
      queryClient.invalidateQueries({ queryKey: getGetRunEventsQueryKey(runId) });
      queryClient.invalidateQueries({ queryKey: getGetRunGraphQueryKey(runId) });
      es.close();
    });

    return () => es.close();
  }, [runId, isRunning, queryClient]);

  // Combine polled events and stream events
  const allEvents = useMemo(() => {
    const map = new Map<string, AgentEvent>();
    (eventsData || []).forEach((e) => map.set(e.id, e));
    streamEvents.forEach((e) => map.set(e.id, e));
    return Array.from(map.values()).sort((a, b) => a.seq - b.seq);
  }, [eventsData, streamEvents]);

  const replay = useReplay(allEvents, isTerminal);

  // Events visible in the UI — all of them normally, sliced in replay mode
  const displayEvents = replay.visibleEvents;

  // Graph objects/relations filtered to what's visible in replay mode
  const replayObjects = useMemo(() => {
    if (!replay.isReplaying) return graphData?.objects ?? [];
    const seenLocalIds = new Set(
      displayEvents
        .filter((e) => e.type === "object.created")
        .map((e) => strField(e.payload?.id))
        .filter((id): id is string => !!id),
    );
    return (graphData?.objects ?? []).filter((obj) => {
      const localId = obj.id.includes(":") ? obj.id.split(":").slice(1).join(":") : obj.id;
      return seenLocalIds.has(localId);
    });
  }, [replay.isReplaying, displayEvents, graphData?.objects]);

  const replayRelations = useMemo(() => {
    if (!replay.isReplaying) return graphData?.relations ?? [];
    const seenObjIds = new Set(replayObjects.map((o) => o.id));
    return (graphData?.relations ?? []).filter(
      (rel) => seenObjIds.has(rel.source) && seenObjIds.has(rel.target),
    );
  }, [replay.isReplaying, replayObjects, graphData?.relations]);

  // Auto-scroll event stream — only when not replaying
  useEffect(() => {
    if (replay.isReplaying) return;
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [allEvents.length, replay.isReplaying]);

  // Scroll current replay event into view
  useEffect(() => {
    if (!replay.isReplaying || !replay.currentEvent) return;
    setTimeout(() => {
      document.getElementById(`ev-${replay.currentEvent!.id}`)?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    }, 50);
  }, [replay.isReplaying, replay.currentEvent]);

  const handleCancel = () => {
    if (!runId) return;
    cancelRun.mutate(
      { runId },
      {
        onSuccess: () => {
          toast.success("Run cancelled");
          queryClient.invalidateQueries({ queryKey: getGetRunQueryKey(runId) });
        },
      },
    );
  };

  const handleFork = () => {
    if (!runId || !allEvents.length) return;
    const lastEvent = allEvents[allEvents.length - 1];
    forkRun.mutate(
      { runId, data: { atEventId: lastEvent.id } },
      {
        onSuccess: (newRun) => {
          window.location.href = `/runs/${newRun.id}`;
        },
      },
    );
  };

  const handleRunTests = () => {
    if (!runId) return;
    runTest.mutate(
      { runId },
      {
        onSuccess: (result) => {
          toast.success(`Tests ${result.status}: ${result.passed} passed, ${result.failed} failed`);
          queryClient.invalidateQueries({ queryKey: getGetRunEventsQueryKey(runId) });
        },
        onError: (err: any) => {
          const msg = err?.response?.data?.error || "Failed to run tests";
          toast.error(msg);
        },
      },
    );
  };

  // Cross-reference a clicked graph node to the event stream
  const handleGraphNodeSelect = useCallback(
    (obj: GraphObject | null) => {
      if (!obj) {
        setHighlightedEventId(null);
        setSelectedNode(null);
        return;
      }
      setSelectedNode(obj);
      // Patch nodes → open file in browser panel
      if (obj.type === "patch") {
        const path = strField(obj.data?.path);
        if (path) setSelectedFile(path);
      }
      // All nodes → find a matching event and scroll/highlight it
      // Graph object IDs are scoped as "{runPrefix}:{localId}" — match on localId
      const localId = obj.id.includes(":") ? obj.id.split(":").slice(1).join(":") : obj.id;
      const matchingEvent = allEvents.find((e) => {
        // object.created events carry the local graph id as payload.id
        return e.payload?.id === localId || e.payload?.object_id === localId;
      });
      if (matchingEvent) {
        setHighlightedEventId(matchingEvent.id);
        setTimeout(() => {
          document.getElementById(`ev-${matchingEvent.id}`)?.scrollIntoView({
            behavior: "smooth",
            block: "center",
          });
        }, 50);
      }
    },
    [allEvents],
  );

  const handlePerm = (eventId: string, permId: string, decision: PermissionDecisionDecision) => {
    if (!runId) return;
    resolvePerm.mutate(
      {
        runId,
        permId,
        data: { decision },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetRunEventsQueryKey(runId) });
        },
      },
    );
  };

  // Pending permissions: permission.requested events with no matching approved/denied response
  const pendingPermissions = useMemo(() => {
    if (!isRunning) return [];
    const resolvedIds = new Set(
      allEvents
        .filter((e) => e.type === "permission.approved" || e.type === "permission.denied")
        .map((e) => extractPermId(e.payload))
        .filter((id): id is string => !!id),
    );
    return allEvents.filter((e) => {
      if (e.type !== "permission.requested") return false;
      const permId = extractPermId(e.payload);
      return permId !== undefined && !resolvedIds.has(permId);
    });
  }, [allEvents, isRunning]);

  if (runLoading) {
    return (
      <div className="p-8 font-mono text-muted-foreground flex items-center justify-center min-h-[100dvh]">
        Loading...
      </div>
    );
  }

  if (!run) {
    return (
      <div className="p-8 font-mono text-destructive flex items-center justify-center min-h-[100dvh]">
        Run not found.
      </div>
    );
  }

  return (
    <div
      className={`flex flex-col h-[100dvh] bg-background text-foreground overflow-hidden ${replay.isReplaying ? "ring-2 ring-inset ring-cyan-500/30" : ""}`}
    >
      <header className="h-14 border-b border-border/50 bg-card/50 flex flex-shrink-0 items-center justify-between px-4">
        <div className="flex items-center gap-4">
          <Link href="/">
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <ChevronLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div className="flex flex-col">
            <div className="flex items-center gap-2">
              <span className="font-mono font-bold text-sm truncate max-w-[300px]" title={run.goal}>
                {run.goal}
              </span>
              <Badge
                variant="outline"
                className={
                  run.status === "completed"
                    ? "border-green-500/50 text-green-500"
                    : run.status === "failed"
                      ? "border-red-500/50 text-red-500"
                      : run.status === "running"
                        ? "border-blue-500/50 text-blue-500 animate-pulse"
                        : "border-muted-foreground/50 text-muted-foreground"
                }
              >
                {run.status}
              </Badge>
              {duration && (
                <span className="font-mono text-xs text-muted-foreground flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  {duration}
                </span>
              )}
              {run.model === "demo" && (
                <Badge
                  variant="secondary"
                  className="bg-purple-500/10 text-purple-500 border-purple-500/20"
                >
                  DEMO
                </Badge>
              )}
              {getModelLabel(run.model) && (
                <Badge
                  variant="outline"
                  className="font-mono text-[10px] px-1.5 py-0 border-blue-500/30 text-blue-400 bg-blue-500/5"
                  title={run.model ?? undefined}
                >
                  {getModelLabel(run.model)}
                </Badge>
              )}
            </div>
            <span className="font-mono text-xs text-muted-foreground">{run.id}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isRunning ? (
            <Button
              variant="destructive"
              size="sm"
              onClick={handleCancel}
              disabled={cancelRun.isPending}
            >
              <Square className="h-4 w-4 mr-2" /> Cancel
            </Button>
          ) : (
            <>
              {isCompleted && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleRunTests}
                  disabled={runTest.isPending || hasTests === false}
                  title={
                    hasTests === false
                      ? "No test files found in this run's work directory"
                      : "Run tests in this run's work directory"
                  }
                >
                  <TestTube className="h-4 w-4 mr-2" />
                  {runTest.isPending ? "Running…" : "Run Tests"}
                </Button>
              )}
              {run.prUrl && (
                <a href={run.prUrl} target="_blank" rel="noopener noreferrer">
                  <Button
                    variant="outline"
                    size="sm"
                    className={
                      run.prStatus === "merged"
                        ? "border-green-500/50 text-green-400 hover:text-green-300"
                        : run.prStatus === "closed"
                          ? "border-red-500/50 text-red-400 hover:text-red-300"
                          : "border-violet-500/50 text-violet-400 hover:text-violet-300"
                    }
                  >
                    <GitPullRequest className="h-4 w-4 mr-2" />
                    View PR
                    {run.prStatus && (
                      <span
                        className={`ml-1.5 px-1.5 py-0.5 rounded text-[10px] font-medium leading-none ${
                          run.prStatus === "merged"
                            ? "bg-green-500/20 text-green-400"
                            : run.prStatus === "closed"
                              ? "bg-red-500/20 text-red-400"
                              : "bg-violet-500/20 text-violet-400"
                        }`}
                      >
                        {run.prStatus}
                      </span>
                    )}
                  </Button>
                </a>
              )}
              {run.parentRunId && (
                <Link href={`/runs/${run.parentRunId}/diff/${runId}`}>
                  <Button variant="outline" size="sm">
                    <GitCompareArrows className="h-4 w-4 mr-2" /> Compare w/ parent
                  </Button>
                </Link>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm">
                    <GitCompareArrows className="h-4 w-4 mr-2" /> Compare with…
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="max-h-80 overflow-y-auto w-72">
                  <DropdownMenuLabel className="font-mono text-xs">
                    Compare with run
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {(allRuns ?? []).filter((r) => r.id !== runId).length === 0 ? (
                    <DropdownMenuItem disabled className="font-mono text-xs">
                      No other runs
                    </DropdownMenuItem>
                  ) : (
                    (allRuns ?? [])
                      .filter((r) => r.id !== runId)
                      .map((r) => (
                        <DropdownMenuItem
                          key={r.id}
                          className="font-mono text-xs flex flex-col items-start gap-0.5"
                          onClick={() => setLocation(`/runs/${runId}/diff/${r.id}`)}
                        >
                          <span className="truncate w-full">{r.goal}</span>
                          <span className="text-[10px] text-muted-foreground">
                            {r.id.slice(0, 8)} · {r.status}
                          </span>
                        </DropdownMenuItem>
                      ))
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
              <Button variant="outline" size="sm" onClick={handleFork} disabled={forkRun.isPending}>
                <GitFork className="h-4 w-4 mr-2" /> Fork Run
              </Button>
            </>
          )}
        </div>
      </header>

      {/* Permission banner — sticky, only for active runs with pending requests */}
      {pendingPermissions.length > 0 && (
        <PermissionBanner
          permissions={pendingPermissions}
          onResolve={handlePerm}
          isPending={resolvePerm.isPending}
        />
      )}

      <ApprovalBanner runId={runId} status={run?.status} />

      <div className="flex-1 overflow-hidden">
        <ResizablePanelGroup direction="vertical">
          <ResizablePanel defaultSize={70}>
            <ResizablePanelGroup direction="horizontal">
              {/* Left Panel: Graph Tree */}
              <ResizablePanel defaultSize={25} minSize={20}>
                <div className="h-full flex flex-col border-r border-border/50">
                  <div className="h-10 px-4 flex items-center border-b border-border/50 bg-muted/20 font-mono text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    Causal Graph
                  </div>
                  <div className="flex-1 min-h-0 overflow-auto">
                    <CausalGraph
                      objects={replayObjects}
                      relations={replayRelations}
                      onNodeSelect={handleGraphNodeSelect}
                    />
                  </div>
                  <div className="border-t border-border/50 max-h-[40%] overflow-auto bg-muted/10">
                    <CausalChainPanel
                      runId={runId}
                      objectId={selectedNode?.id ?? null}
                      objectLabel={selectedNode?.type}
                    />
                  </div>
                </div>
              </ResizablePanel>

              <ResizableHandle />

              {/* Center Panel: Conversation */}
              <ResizablePanel defaultSize={50} minSize={30}>
                <div className="h-full flex flex-col border-r border-border/50 bg-muted/5">
                  <div className="h-10 px-4 flex items-center border-b border-border/50 bg-muted/20 font-mono text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    Conversation
                  </div>
                  <ScrollArea className="flex-1 p-4">
                    <div className="flex flex-col gap-4">
                      {displayEvents
                        .filter(
                          (e) =>
                            e.type === "assistant.message.added" ||
                            e.type.startsWith("permission.") ||
                            e.type === "test.run.completed",
                        )
                        .map((e) => (
                          <ConversationMessage key={e.id} event={e} onResolve={handlePerm} />
                        ))}
                      {displayEvents.length === 0 && (
                        <div className="text-center font-mono text-sm text-muted-foreground mt-10">
                          No messages yet
                        </div>
                      )}
                    </div>
                  </ScrollArea>
                </div>
              </ResizablePanel>

              <ResizableHandle />

              {/* Right Panel: File Browser */}
              <ResizablePanel defaultSize={25} minSize={20}>
                <FileBrowserPanel
                  runId={runId!}
                  allEvents={allEvents}
                  externalSelectedFile={selectedFile}
                  onExternalSelectFile={setSelectedFile}
                />
              </ResizablePanel>
            </ResizablePanelGroup>
          </ResizablePanel>

          <ResizableHandle />

          {/* Bottom Panel: Event Stream */}
          <ResizablePanel defaultSize={30} minSize={15}>
            <div className="h-full flex flex-col bg-black dark:bg-black">
              <div className="h-8 px-4 flex items-center border-b border-white/10 font-mono text-xs text-white/50 bg-white/5 uppercase tracking-wider">
                Event Stream
                {replay.isReplaying && <span className="ml-2 text-cyan-400">— Replay</span>}
              </div>
              <div ref={scrollRef} className="flex-1 overflow-y-auto p-2 font-mono text-xs">
                {displayEvents.map((e, i) => (
                  <EventStreamRow
                    key={e.id}
                    event={e}
                    prevCreatedAt={i > 0 ? displayEvents[i - 1]!.createdAt : null}
                    highlighted={highlightedEventId === e.id}
                    isCurrent={replay.isReplaying && replay.currentEvent?.id === e.id}
                    seekable={replay.isReplaying}
                    onSeek={replay.isReplaying ? () => replay.stepTo(i) : undefined}
                  />
                ))}
              </div>
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>

      {/* Replay toolbar — shown for terminal runs */}
      {isTerminal && allEvents.length > 0 && (
        <ReplayToolbar replay={replay} totalEvents={allEvents.length} />
      )}
    </div>
  );
}

function PermissionBanner({
  permissions,
  onResolve,
  isPending,
}: {
  permissions: AgentEvent[];
  onResolve: (eventId: string, permId: string, d: PermissionDecisionDecision) => void;
  isPending: boolean;
}) {
  const current = permissions[0]!;
  const permId = extractPermId(current.payload) ?? "";
  const description: string =
    strField(current.payload?.description) || "Agent requested permission to proceed.";
  const queueSize = permissions.length;

  return (
    <div className="shrink-0 border-b border-red-500/40 bg-red-950/60 px-4 py-3 flex items-start gap-3">
      <ShieldAlert className="h-5 w-5 text-red-400 shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="font-mono text-sm font-semibold text-red-400">
            Agent is waiting for your approval
          </span>
          {queueSize > 1 && (
            <Badge
              variant="outline"
              className="border-red-500/40 text-red-400 font-mono text-[10px] px-1.5 py-0"
            >
              1 of {queueSize}
            </Badge>
          )}
        </div>
        <p className="font-mono text-xs text-red-200/80 leading-relaxed">{description}</p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Button
          size="sm"
          variant="outline"
          className="h-7 border-red-500/40 text-red-400 hover:bg-red-500/10 hover:text-red-300 font-mono text-xs"
          onClick={() => onResolve(current.id, permId, "deny")}
          disabled={isPending}
        >
          Deny
        </Button>
        <Button
          size="sm"
          className="h-7 bg-red-500 hover:bg-red-600 text-white font-mono text-xs"
          onClick={() => onResolve(current.id, permId, "approve")}
          disabled={isPending}
        >
          Approve
        </Button>
      </div>
    </div>
  );
}

function ConversationMessage({
  event,
  onResolve,
}: {
  event: AgentEvent;
  onResolve: (eventId: string, permId: string, d: PermissionDecisionDecision) => void;
}) {
  if (event.type === "assistant.message.added") {
    const p = event.payload;
    return (
      <div className="flex flex-col items-start gap-1 max-w-[85%]">
        <span className="font-mono text-[10px] text-muted-foreground ml-1">Agent</span>
        <div className="bg-muted rounded-2xl rounded-tl-sm px-4 py-2 text-sm whitespace-pre-wrap">
          {strField(p?.content) || strField(p?.message) || "(no content)"}
        </div>
      </div>
    );
  }

  if (event.type === "permission.requested") {
    const permId = extractPermId(event.payload) ?? "";
    return (
      <Card className="border-red-500/30 bg-red-500/5 p-4 flex flex-col gap-3">
        <div className="flex items-center gap-2 text-red-500">
          <ShieldAlert className="h-4 w-4" />
          <span className="font-mono text-sm font-semibold">Permission Required</span>
        </div>
        <p className="text-sm font-mono text-muted-foreground">
          {strField(event.payload?.description) || "Agent requested permission to proceed."}
        </p>
        <div className="flex items-center gap-2 mt-2">
          <Button
            size="sm"
            variant="outline"
            className="border-red-500/30 text-red-500 hover:bg-red-500/10"
            onClick={() => onResolve(event.id, permId, "deny")}
          >
            Deny
          </Button>
          <Button
            size="sm"
            className="bg-red-500 hover:bg-red-600 text-white"
            onClick={() => onResolve(event.id, permId, "approve")}
          >
            Approve
          </Button>
        </div>
      </Card>
    );
  }

  if (event.type === "permission.approved") {
    return (
      <div className="flex justify-center my-2">
        <Badge variant="outline" className="border-green-500/30 text-green-500 bg-green-500/5">
          Permission Approved
        </Badge>
      </div>
    );
  }

  if (event.type === "permission.denied") {
    return (
      <div className="flex justify-center my-2">
        <Badge variant="outline" className="border-red-500/30 text-red-500 bg-red-500/5">
          Permission Denied
        </Badge>
      </div>
    );
  }

  if (event.type === "test.run.completed") {
    return <TestResultCard event={event} />;
  }

  return null;
}

function TestResultCard({ event }: { event: AgentEvent }) {
  const [expanded, setExpanded] = useState(false);
  const p = event.payload;
  const status = strField(p?.status) ?? "unknown";
  const passed = numField(p?.passed) ?? 0;
  const failed = numField(p?.failed) ?? 0;
  const total = numField(p?.total) ?? passed + failed;
  const output = strField(p?.output) ?? "";
  const triggeredBy = strField(p?.triggered_by);
  const isPassed = status === "passed";

  return (
    <Card
      className={`p-4 flex flex-col gap-3 border ${isPassed ? "border-green-500/30 bg-green-500/5" : "border-red-500/30 bg-red-500/5"}`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <TestTube className={`h-4 w-4 ${isPassed ? "text-green-500" : "text-red-500"}`} />
          <span
            className={`font-mono text-sm font-semibold ${isPassed ? "text-green-500" : "text-red-500"}`}
          >
            Tests {isPassed ? "Passed" : "Failed"}
          </span>
          {triggeredBy === "user" && (
            <Badge variant="secondary" className="text-[10px] px-1 py-0">
              manual
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-3 font-mono text-xs text-muted-foreground">
          <span className="text-green-500 font-semibold">{passed} passed</span>
          {failed > 0 && <span className="text-red-500 font-semibold">{failed} failed</span>}
          {total > 0 && <span>{total} total</span>}
        </div>
      </div>
      {output && (
        <div>
          <button
            className="flex items-center gap-1 font-mono text-xs text-muted-foreground hover:text-foreground transition-colors"
            onClick={() => setExpanded((e) => !e)}
          >
            {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            {expanded ? "Hide output" : "Show output"}
          </button>
          {expanded && (
            <pre className="mt-2 p-3 rounded bg-black/40 text-[11px] font-mono text-muted-foreground overflow-x-auto whitespace-pre-wrap max-h-80 overflow-y-auto">
              {output}
            </pre>
          )}
        </div>
      )}
    </Card>
  );
}

function FileBrowserPanel({
  runId,
  allEvents,
  externalSelectedFile,
  onExternalSelectFile,
}: {
  runId: string;
  allEvents: AgentEvent[];
  externalSelectedFile?: string | null;
  onExternalSelectFile?: (path: string | null) => void;
}) {
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"content" | "diff" | "history">("content");
  const [diffMode, setDiffMode] = useState<"unified" | "split">("unified");
  const [selectedPatchId, setSelectedPatchId] = useState<string | null>(null);

  // When a patch node is clicked in the causal graph, open that file here
  useEffect(() => {
    if (externalSelectedFile) {
      setSelectedFile(externalSelectedFile);
      setActiveTab("content");
      setSelectedPatchId(null);
      onExternalSelectFile?.(null); // reset so future same-file clicks still trigger
    }
  }, [externalSelectedFile, onExternalSelectFile]);

  const { data: files } = useListRunFiles(runId, {
    query: queryConfig({ refetchInterval: 5000 }),
  });

  const { data: fileContent, isLoading: contentLoading } = useGetRunFileContent(
    runId,
    { path: selectedFile ?? "" },
    { query: queryConfig({ enabled: !!selectedFile && activeTab === "content" }) },
  );

  const agentWrittenPaths = useMemo(() => {
    const paths = new Set<string>();
    allEvents.forEach((e) => {
      if (e.type === "patch.applied" || e.type === "file.write" || e.type === "file.created") {
        const p = strField(e.payload?.path) ?? strField(e.payload?.file);
        if (p) paths.add(p);
      }
    });
    return paths;
  }, [allEvents]);

  // All patches applied to the selected file, oldest → newest (patch history, #9)
  const patchHistoryForFile = useMemo(() => {
    if (!selectedFile) return [];
    return allEvents
      .filter((e) => e.type === "patch.applied" && e.payload?.path === selectedFile)
      .map((e) => {
        const localId = strField(e.payload?.patch_id) ?? "";
        return {
          eventId: e.id,
          scopedId: `${runId.slice(0, 8)}:${localId}`,
          createdAt: e.createdAt,
        };
      });
  }, [selectedFile, allEvents, runId]);

  // The most recent patch for this file
  const patchIdForFile = patchHistoryForFile.length
    ? patchHistoryForFile[patchHistoryForFile.length - 1]!.scopedId
    : null;

  // The patch currently being viewed in the Diff tab (history selection or latest)
  const activePatchId = selectedPatchId ?? patchIdForFile;

  const { data: patchDetail, isLoading: patchLoading } = useGetRunPatch(
    runId,
    activePatchId ?? "",
    { query: queryConfig({ enabled: !!(activePatchId && activeTab === "diff") }) },
  );

  const flatFiles = useMemo(() => {
    if (!files) return [];
    function flatten(entries: FileEntry[]): FileEntry[] {
      return entries.flatMap((e) => (e.type === "file" ? [e] : flatten(e.children ?? [])));
    }
    return flatten(files);
  }, [files]);

  const writtenFileCount = useMemo(() => {
    if (!agentWrittenPaths.size) return 0;
    return flatFiles.filter((f) => agentWrittenPaths.has(f.path)).length;
  }, [flatFiles, agentWrittenPaths]);

  const hasPatch = !!patchIdForFile;

  function handleSelectFile(path: string) {
    setSelectedFile(path);
    setActiveTab("content");
  }

  return (
    <div className="h-full flex flex-col border-l border-border/50">
      <div className="h-10 px-4 flex items-center gap-2 border-b border-border/50 bg-muted/20 font-mono text-xs font-semibold text-muted-foreground uppercase tracking-wider shrink-0">
        {selectedFile ? (
          <button
            className="flex items-center gap-1 hover:text-foreground transition-colors"
            onClick={() => {
              setSelectedFile(null);
              setActiveTab("content");
            }}
          >
            <ArrowLeft className="h-3 w-3" />
            Files
          </button>
        ) : (
          <>
            <span>Files</span>
            {writtenFileCount > 0 && (
              <Badge variant="secondary" className="ml-auto font-mono text-[10px] px-1.5 py-0 h-4">
                {writtenFileCount} written
              </Badge>
            )}
          </>
        )}
      </div>

      {selectedFile ? (
        <div className="flex flex-col flex-1 overflow-hidden">
          <div className="px-3 py-1.5 border-b border-border/50 bg-muted/10 font-mono text-[10px] text-muted-foreground truncate flex items-center gap-2">
            <span className="truncate flex-1">{selectedFile}</span>
            {patchDetail && (
              <span className="shrink-0 text-[9px] font-mono">
                <span className="text-green-500">+{patchDetail.lines_added}</span>{" "}
                <span className="text-red-500">-{patchDetail.lines_removed}</span>
              </span>
            )}
          </div>
          {hasPatch && (
            <div className="flex border-b border-border/50 shrink-0 items-center">
              <button
                className={`px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider transition-colors ${activeTab === "content" ? "text-foreground border-b-2 border-foreground" : "text-muted-foreground hover:text-foreground"}`}
                onClick={() => setActiveTab("content")}
              >
                Content
              </button>
              <button
                className={`px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider transition-colors ${activeTab === "diff" ? "text-foreground border-b-2 border-foreground" : "text-muted-foreground hover:text-foreground"}`}
                onClick={() => setActiveTab("diff")}
              >
                Diff
              </button>
              {patchHistoryForFile.length > 1 && (
                <button
                  className={`px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider transition-colors flex items-center gap-1 ${activeTab === "history" ? "text-foreground border-b-2 border-foreground" : "text-muted-foreground hover:text-foreground"}`}
                  onClick={() => setActiveTab("history")}
                >
                  <History className="h-3 w-3" />
                  History
                  <Badge
                    variant="secondary"
                    className="ml-1 font-mono text-[9px] px-1 py-0 h-3.5 leading-none"
                  >
                    {patchHistoryForFile.length}
                  </Badge>
                </button>
              )}
              {activeTab === "diff" && (
                <div className="ml-auto pr-2">
                  <button
                    className="flex items-center gap-1 px-2 py-0.5 rounded font-mono text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
                    onClick={() => setDiffMode((m) => (m === "unified" ? "split" : "unified"))}
                    title={diffMode === "unified" ? "Switch to side-by-side" : "Switch to unified"}
                  >
                    {diffMode === "unified" ? (
                      <Columns2 className="h-3 w-3" />
                    ) : (
                      <AlignLeft className="h-3 w-3" />
                    )}
                    {diffMode === "unified" ? "Split" : "Unified"}
                  </button>
                </div>
              )}
            </div>
          )}
          <ScrollArea className="flex-1">
            {activeTab === "content" ? (
              contentLoading ? (
                <div className="p-4 font-mono text-xs text-muted-foreground">Loading…</div>
              ) : fileContent ? (
                <CodeBlock code={fileContent.content} path={selectedFile} />
              ) : (
                <div className="p-4 font-mono text-xs text-muted-foreground">
                  Could not load file.
                </div>
              )
            ) : activeTab === "diff" ? (
              patchLoading ? (
                <div className="p-4 font-mono text-xs text-muted-foreground">Loading diff…</div>
              ) : patchDetail ? (
                diffMode === "split" ? (
                  <SplitDiffView diff={patchDetail.diff} />
                ) : (
                  <UnifiedDiffView diff={patchDetail.diff} />
                )
              ) : (
                <div className="p-4 font-mono text-xs text-muted-foreground">
                  No diff available.
                </div>
              )
            ) : (
              <div className="p-2 flex flex-col gap-1">
                {patchHistoryForFile
                  .slice()
                  .reverse()
                  .map((p, idx) => {
                    const revNum = patchHistoryForFile.length - idx;
                    const isActive = activePatchId === p.scopedId;
                    const d = new Date(p.createdAt);
                    const t = `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}:${d.getSeconds().toString().padStart(2, "0")}`;
                    return (
                      <button
                        key={p.eventId}
                        onClick={() => {
                          setSelectedPatchId(p.scopedId);
                          setActiveTab("diff");
                        }}
                        className={`flex items-center gap-2 px-3 py-2 rounded font-mono text-[11px] text-left transition-colors ${isActive ? "bg-foreground/10 text-foreground" : "text-muted-foreground hover:bg-muted/40 hover:text-foreground"}`}
                      >
                        <span className="text-green-500 shrink-0">rev {revNum}</span>
                        <span className="text-muted-foreground/70 shrink-0">{t}</span>
                        <span className="truncate text-[10px] text-muted-foreground/50">
                          {p.scopedId}
                        </span>
                      </button>
                    );
                  })}
              </div>
            )}
          </ScrollArea>
        </div>
      ) : !files || flatFiles.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-2 text-muted-foreground">
          <FileText className="h-8 w-8 opacity-20" />
          <p className="font-mono text-xs">No files yet</p>
        </div>
      ) : (
        <ScrollArea className="flex-1">
          <div className="p-2">
            <FileTreeItems
              entries={files}
              agentWrittenPaths={agentWrittenPaths}
              onSelect={handleSelectFile}
              depth={0}
            />
          </div>
        </ScrollArea>
      )}
    </div>
  );
}

function UnifiedDiffView({ diff }: { diff: string }) {
  if (!diff.trim()) {
    return (
      <div className="p-4 font-mono text-xs text-muted-foreground">
        No changes (empty diff — file was created with no prior content, or diff not available).
      </div>
    );
  }
  const lines = diff.split("\n");
  return (
    <div className="overflow-x-auto">
      <pre className="text-[11px] font-mono p-3 leading-relaxed min-w-max">
        {lines.map((line, i) => {
          let cls = "text-foreground/60 block";
          if (line.startsWith("+++") || line.startsWith("---")) {
            cls = "text-muted-foreground block font-semibold";
          } else if (line.startsWith("+")) {
            cls = "text-green-400 bg-green-500/10 block";
          } else if (line.startsWith("-")) {
            cls = "text-red-400 bg-red-500/10 block";
          } else if (line.startsWith("@@")) {
            cls = "text-blue-400 block";
          }
          return (
            <span key={i} className={cls}>
              {line || "\u00a0"}
            </span>
          );
        })}
      </pre>
    </div>
  );
}

function FileTreeItems({
  entries,
  agentWrittenPaths,
  onSelect,
  depth,
}: {
  entries: FileEntry[];
  agentWrittenPaths: Set<string>;
  onSelect: (path: string) => void;
  depth: number;
}) {
  return (
    <>
      {entries.map((entry) => (
        <div key={entry.path} style={{ paddingLeft: `${depth * 10}px` }}>
          {entry.type === "directory" ? (
            <div>
              <div className="flex items-center gap-1.5 py-1 px-2 font-mono text-[11px] text-muted-foreground">
                <Folder className="h-3 w-3 shrink-0" />
                <span className="truncate">{entry.name}/</span>
              </div>
              {entry.children && entry.children.length > 0 && (
                <FileTreeItems
                  entries={entry.children}
                  agentWrittenPaths={agentWrittenPaths}
                  onSelect={onSelect}
                  depth={depth + 1}
                />
              )}
            </div>
          ) : (
            <button
              className="w-full flex items-center gap-1.5 py-1 px-2 rounded hover:bg-muted/60 font-mono text-[11px] text-left group transition-colors"
              onClick={() => onSelect(entry.path)}
            >
              <FileText className="h-3 w-3 text-muted-foreground shrink-0" />
              <span className="truncate flex-1 group-hover:text-foreground transition-colors">
                {entry.name}
              </span>
              {agentWrittenPaths.has(entry.path) && (
                <span className="shrink-0 text-[9px] font-bold text-green-500 bg-green-500/10 px-1 rounded">
                  NEW
                </span>
              )}
            </button>
          )}
        </div>
      ))}
    </>
  );
}

function ReplayToolbar({
  replay,
  totalEvents,
}: {
  replay: ReturnType<typeof useReplay>;
  totalEvents: number;
}) {
  const {
    isReplaying,
    replayIndex,
    isPlaying,
    enterReplay,
    exitReplay,
    stepPrev,
    stepNext,
    stepTo,
    togglePlay,
  } = replay;

  if (!isReplaying) {
    return (
      <div className="h-10 border-t border-border/50 bg-card/80 flex items-center px-4 gap-3 shrink-0">
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs font-mono gap-1.5"
          onClick={enterReplay}
        >
          <Play className="h-3 w-3" />
          Replay Run
        </Button>
        <span className="font-mono text-xs text-muted-foreground">{totalEvents} events</span>
      </div>
    );
  }

  const progressPct = totalEvents > 1 ? (replayIndex / (totalEvents - 1)) * 100 : 100;

  return (
    <div className="border-t border-cyan-500/30 bg-card/90 shrink-0">
      <Progress
        value={progressPct}
        className="h-1 rounded-none bg-cyan-500/10 [&>div]:bg-cyan-400"
      />
      <div className="h-12 flex items-center px-4 gap-3">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs font-mono text-cyan-400 hover:text-cyan-300 hover:bg-cyan-500/10 gap-1 px-2"
          onClick={exitReplay}
        >
          Exit Replay
        </Button>

        <div className="h-4 w-px bg-border/50" />

        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground hover:text-foreground"
          onClick={stepPrev}
          disabled={replayIndex === 0}
          title="Previous event"
        >
          <SkipBack className="h-3.5 w-3.5" />
        </Button>

        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-foreground"
          onClick={togglePlay}
          title={isPlaying ? "Pause" : "Play"}
        >
          {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        </Button>

        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground hover:text-foreground"
          onClick={stepNext}
          disabled={replayIndex >= totalEvents - 1}
          title="Next event"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </Button>

        <span className="font-mono text-xs text-cyan-400 w-28 shrink-0 text-center">
          Event {replayIndex + 1} / {totalEvents}
        </span>

        <Slider
          min={0}
          max={totalEvents - 1}
          step={1}
          value={[replayIndex]}
          onValueChange={([v]) => stepTo(v!)}
          className="flex-1 max-w-xs"
        />
      </div>
    </div>
  );
}

function formatDelta(ms: number): string {
  if (ms < 1000) return `+${ms}ms`;
  if (ms < 60000) return `+${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `+${m}m${s}s`;
}

function EventStreamRow({
  event,
  prevCreatedAt,
  highlighted,
  isCurrent,
  seekable,
  onSeek,
}: {
  event: AgentEvent;
  prevCreatedAt?: string | null;
  highlighted?: boolean;
  isCurrent?: boolean;
  seekable?: boolean;
  onSeek?: () => void;
}) {
  const type = event.type;

  let colorClass = "text-white/60";
  if (type.startsWith("llm.")) colorClass = "text-purple-400";
  else if (type.startsWith("tool.") || type.startsWith("bash.")) colorClass = "text-amber-400";
  else if (type.startsWith("patch.")) colorClass = "text-green-400";
  else if (type.startsWith("test.")) colorClass = "text-blue-400";
  else if (type.startsWith("permission.")) colorClass = "text-red-400";
  else if (type.startsWith("task.")) colorClass = "text-slate-400";

  const date = new Date(event.createdAt);
  const timeStr = `${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}:${date.getSeconds().toString().padStart(2, "0")}.${date.getMilliseconds().toString().padStart(3, "0")}`;

  const deltaMs = prevCreatedAt
    ? Math.max(0, date.getTime() - new Date(prevCreatedAt).getTime())
    : null;

  return (
    <div
      id={`ev-${event.id}`}
      onClick={onSeek}
      title={seekable ? "Click to seek replay here" : undefined}
      className={`flex gap-3 px-2 py-1 rounded group transition-colors ${seekable ? "cursor-pointer" : ""} ${
        isCurrent
          ? "bg-cyan-500/20 ring-1 ring-inset ring-cyan-500/50"
          : highlighted
            ? "bg-amber-500/20 ring-1 ring-inset ring-amber-500/40"
            : "hover:bg-white/5"
      }`}
    >
      <span className="text-white/30 shrink-0 w-[100px]">{timeStr}</span>
      <span
        className="text-white/25 shrink-0 w-[52px] text-right tabular-nums"
        title={deltaMs !== null ? "Time since previous event" : undefined}
      >
        {deltaMs !== null ? formatDelta(deltaMs) : ""}
      </span>
      <span className={`shrink-0 w-[180px] font-semibold ${colorClass}`}>{event.type}</span>
      <span className="text-white/40 truncate">{JSON.stringify(event.payload || {})}</span>
    </div>
  );
}
