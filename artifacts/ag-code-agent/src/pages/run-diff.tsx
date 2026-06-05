import { useState } from "react";
import { useParams, Link } from "wouter";
import {
  useDiffRuns,
  useGetRun,
  queryConfig,
} from "@workspace/api-client-react";
import type { ObjectDiff } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SplitDiffView } from "@/components/SplitDiffView";
import { strField } from "@/lib/utils";
import {
  ChevronLeft,
  ChevronDown,
  ChevronUp,
  Plus,
  Minus,
  RefreshCw,
} from "lucide-react";

function statusColor(status: string | undefined) {
  if (status === "completed") return "border-green-500/50 text-green-500";
  if (status === "failed") return "border-red-500/50 text-red-500";
  if (status === "running") return "border-blue-500/50 text-blue-500 animate-pulse";
  return "border-muted-foreground/50 text-muted-foreground";
}

function typeColor(type: string) {
  if (type === "plan") return "bg-blue-500/15 text-blue-400 border-blue-500/30";
  if (type === "task") return "bg-purple-500/15 text-purple-400 border-purple-500/30";
  if (type === "patch") return "bg-orange-500/15 text-orange-400 border-orange-500/30";
  if (type === "model_call") return "bg-slate-500/15 text-slate-300 border-slate-500/30";
  if (type === "file_snapshot") return "bg-amber-500/15 text-amber-400 border-amber-500/30";
  if (type === "command_result") return "bg-yellow-500/15 text-yellow-400 border-yellow-500/30";
  if (type === "test_run") return "bg-teal-500/15 text-teal-400 border-teal-500/30";
  if (type.startsWith("git_")) return "bg-cyan-500/15 text-cyan-400 border-cyan-500/30";
  return "bg-muted/40 text-muted-foreground border-border";
}

function changeColor(changeType: string) {
  if (changeType === "added") return "border-l-green-500";
  if (changeType === "removed") return "border-l-red-500";
  return "border-l-amber-500";
}

function changeIcon(changeType: string) {
  if (changeType === "added") return <Plus className="h-3.5 w-3.5 text-green-500 shrink-0" />;
  if (changeType === "removed") return <Minus className="h-3.5 w-3.5 text-red-500 shrink-0" />;
  return <RefreshCw className="h-3.5 w-3.5 text-amber-500 shrink-0" />;
}

function changeBadge(changeType: string) {
  if (changeType === "added")
    return <Badge className="bg-green-500/10 text-green-500 border-green-500/30 shrink-0">added</Badge>;
  if (changeType === "removed")
    return <Badge className="bg-red-500/10 text-red-500 border-red-500/30 shrink-0">removed</Badge>;
  return <Badge className="bg-amber-500/10 text-amber-500 border-amber-500/30 shrink-0">modified</Badge>;
}

function StatCell({ label, a, b }: { label: string; a?: number; b?: number }) {
  const va = a ?? 0;
  const vb = b ?? 0;
  const diff = vb - va;
  return (
    <div className="flex flex-col gap-1 min-w-[90px]">
      <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
      <div className="flex items-end gap-2">
        <span className="font-mono text-lg font-bold text-foreground">{va}</span>
        <span className="font-mono text-xs text-muted-foreground mb-0.5">→</span>
        <span className="font-mono text-lg font-bold text-foreground">{vb}</span>
        {diff !== 0 && (
          <span className={`font-mono text-xs mb-0.5 font-semibold ${diff > 0 ? "text-green-500" : "text-red-400"}`}>
            {diff > 0 ? `+${diff}` : diff}
          </span>
        )}
      </div>
    </div>
  );
}

function ObjectDiffRow({ diff }: { diff: ObjectDiff }) {
  const [expanded, setExpanded] = useState(false);
  const localId = diff.objectId.includes(":")
    ? diff.objectId.split(":").slice(1).join(":")
    : diff.objectId;
  const isPatch = diff.type === "patch";
  const patchBefore = isPatch ? strField(diff.before?.diff) : undefined;
  const patchAfter  = isPatch ? strField(diff.after?.diff) : undefined;

  return (
    <div className={`border border-border/50 border-l-2 rounded-lg overflow-hidden ${changeColor(diff.changeType)}`}>
      <button
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-muted/30 transition-colors text-left"
        onClick={() => setExpanded(e => !e)}
      >
        {changeIcon(diff.changeType)}
        <span className={`text-[10px] font-mono font-semibold px-2 py-0.5 rounded border ${typeColor(diff.type)}`}>
          {diff.type}
        </span>
        <span className="font-mono text-sm text-foreground flex-1 truncate">{localId}</span>
        {changeBadge(diff.changeType)}
        {expanded
          ? <ChevronUp className="h-4 w-4 text-muted-foreground shrink-0" />
          : <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />}
      </button>

      {expanded && (
        <div className="border-t border-border/50 bg-black/30">
          {isPatch && (patchBefore || patchAfter) ? (
            <div className="flex flex-col divide-y divide-border/50">
              <div className="overflow-hidden">
                {diff.changeType !== "added" && patchBefore ? (
                  <>
                    <div className="px-3 py-1.5 font-mono text-[10px] text-muted-foreground bg-muted/20 uppercase tracking-wider">
                      Run A patch
                    </div>
                    <div className="max-h-72 overflow-y-auto">
                      <SplitDiffView diff={patchBefore} />
                    </div>
                  </>
                ) : (
                  <div className="px-3 py-4 font-mono text-xs text-muted-foreground italic">Not present in Run A</div>
                )}
              </div>
              <div className="overflow-hidden">
                {diff.changeType !== "removed" && patchAfter ? (
                  <>
                    <div className="px-3 py-1.5 font-mono text-[10px] text-muted-foreground bg-muted/20 uppercase tracking-wider">
                      Run B patch
                    </div>
                    <div className="max-h-72 overflow-y-auto">
                      <SplitDiffView diff={patchAfter} />
                    </div>
                  </>
                ) : (
                  <div className="px-3 py-4 font-mono text-xs text-muted-foreground italic">Not present in Run B</div>
                )}
              </div>
            </div>
          ) : (
            <div className="flex divide-x divide-border/50">
              <div className="flex-1 overflow-hidden">
                {diff.changeType !== "added" ? (
                  <>
                    <div className="px-3 py-1.5 font-mono text-[10px] text-muted-foreground bg-muted/20 uppercase tracking-wider">
                      Run A
                    </div>
                    <pre className="px-3 py-2 text-[11px] font-mono text-white/60 overflow-x-auto max-h-64 overflow-y-auto">
                      {JSON.stringify(diff.before, null, 2)}
                    </pre>
                  </>
                ) : (
                  <div className="px-3 py-4 font-mono text-xs text-muted-foreground italic">Not present in Run A</div>
                )}
              </div>
              <div className="flex-1 overflow-hidden">
                {diff.changeType !== "removed" ? (
                  <>
                    <div className="px-3 py-1.5 font-mono text-[10px] text-muted-foreground bg-muted/20 uppercase tracking-wider">
                      Run B
                    </div>
                    <pre className="px-3 py-2 text-[11px] font-mono text-white/60 overflow-x-auto max-h-64 overflow-y-auto">
                      {JSON.stringify(diff.after, null, 2)}
                    </pre>
                  </>
                ) : (
                  <div className="px-3 py-4 font-mono text-xs text-muted-foreground italic">Not present in Run B</div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function RunDiff() {
  const { runId, otherId } = useParams<{ runId: string; otherId: string }>();

  const { data: runA, isLoading: runALoading } = useGetRun(runId ?? "", {
    query: queryConfig({ enabled: !!runId }),
  });
  const { data: runB, isLoading: runBLoading } = useGetRun(otherId ?? "", {
    query: queryConfig({ enabled: !!otherId }),
  });
  const { data: diff, isLoading: diffLoading } = useDiffRuns(runId ?? "", otherId ?? "", {
    query: queryConfig({ enabled: !!runId && !!otherId }),
  });

  if (runALoading || runBLoading || diffLoading) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center font-mono text-muted-foreground">
        Loading diff…
      </div>
    );
  }

  if (!diff) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center font-mono text-destructive">
        Diff not found.
      </div>
    );
  }

  const { summary, objectDiffs = [] } = diff;
  const added    = objectDiffs.filter(d => d.changeType === "added");
  const removed  = objectDiffs.filter(d => d.changeType === "removed");
  const modified = objectDiffs.filter(d => d.changeType === "modified");

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background text-foreground">
      {/* Header */}
      <header className="h-14 border-b border-border/50 bg-card/50 flex shrink-0 items-center px-4 gap-4">
        <Link href={`/runs/${runId}`}>
          <Button variant="ghost" size="icon" className="h-8 w-8">
            <ChevronLeft className="h-4 w-4" />
          </Button>
        </Link>
        <span className="font-mono text-sm font-semibold text-muted-foreground">← Back to run</span>
        <span className="ml-auto font-mono text-xs text-muted-foreground">
          {runId?.slice(0, 8)} vs {otherId?.slice(0, 8)}
        </span>
      </header>

      <div className="flex-1 p-6 max-w-6xl mx-auto w-full flex flex-col gap-6">
        {/* Run header cards */}
        <div className="grid grid-cols-2 gap-4">
          {([
            { label: "Run A (base)", run: runA, id: runId },
            { label: "Run B (fork)", run: runB, id: otherId },
          ] as const).map(({ label, run, id }) => (
            <div key={id} className="border border-border/50 rounded-lg p-4 bg-card/40 flex flex-col gap-2">
              <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                {label}
              </span>
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant="outline" className={statusColor(run?.status)}>
                  {run?.status ?? "unknown"}
                </Badge>
                {run?.model && (
                  <Badge variant="secondary" className="font-mono text-xs">{run.model}</Badge>
                )}
              </div>
              <p className="font-mono text-sm text-foreground line-clamp-2">{run?.goal ?? id}</p>
              <Link href={`/runs/${id}`}>
                <span className="font-mono text-[11px] text-muted-foreground hover:text-foreground transition-colors underline underline-offset-2">
                  {id}
                </span>
              </Link>
            </div>
          ))}
        </div>

        {/* Summary stats */}
        <div className="border border-border/50 rounded-lg bg-card/40 p-4 flex flex-col gap-4">
          <h2 className="font-mono text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Summary
          </h2>
          <div className="flex flex-wrap gap-6">
            <StatCell label="Events"       a={summary.eventsA}      b={summary.eventsB} />
            <StatCell label="Model Calls"  a={summary.modelCallsA}  b={summary.modelCallsB} />
            <StatCell label="Tool Calls"   a={summary.toolCallsA}   b={summary.toolCallsB} />
            <StatCell label="Files Changed" a={summary.filesChangedA} b={summary.filesChangedB} />
          </div>
          <div className="flex flex-wrap gap-3 pt-2 border-t border-border/30 text-xs font-mono">
            <span className="text-green-500">
              <span className="font-bold">{summary.objectsAddedInB ?? 0}</span> objects added in B
            </span>
            <span className="text-muted-foreground">·</span>
            <span className="text-red-400">
              <span className="font-bold">{summary.objectsRemovedInB ?? 0}</span> objects removed in B
            </span>
            <span className="text-muted-foreground">·</span>
            <span className="text-amber-500">
              <span className="font-bold">{summary.objectsModifiedInB ?? 0}</span> modified
            </span>
          </div>
        </div>

        {/* Object diffs */}
        {objectDiffs.length === 0 ? (
          <div className="border border-border/50 rounded-lg p-10 text-center font-mono text-sm text-muted-foreground">
            No graph object differences found between these runs.
          </div>
        ) : (
          <div className="flex flex-col gap-6">
            {([
              { label: "Added in B",  items: added,    accent: "text-green-500" },
              { label: "Removed in B", items: removed, accent: "text-red-400"   },
              { label: "Modified",    items: modified,  accent: "text-amber-500" },
            ] as const).map(({ label, items, accent }) =>
              items.length > 0 && (
                <section key={label} className="flex flex-col gap-2">
                  <h3 className={`font-mono text-xs font-semibold uppercase tracking-wider ${accent}`}>
                    {label} ({items.length})
                  </h3>
                  <div className="flex flex-col gap-2">
                    {items.map(d => <ObjectDiffRow key={d.objectId} diff={d} />)}
                  </div>
                </section>
              )
            )}
          </div>
        )}
      </div>
    </div>
  );
}
