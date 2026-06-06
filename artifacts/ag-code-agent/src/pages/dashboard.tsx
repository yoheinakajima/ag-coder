import { useListRuns, useGetRunStats, useCreateRun, getListRunsQueryKey, getGetRunStatsQueryKey } from "@workspace/api-client-react";
import type { Run } from "@workspace/api-client-react";
import { useLocation } from "wouter";
import { Activity, Play, FileTerminal, Network, CheckCircle, XCircle, Github, GitPullRequest, ChevronDown, Search, X, Clock, Bot, GitCompareArrows } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { RepoCombobox } from "@/components/RepoCombobox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { useState, useMemo, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useElapsedInfo } from "@/hooks/use-elapsed-time";
import { MODEL_OPTIONS, PREFERRED_MODEL_KEY, getModelLabel } from "@/lib/models";

type StatusFilter = "all" | "active" | "completed" | "failed";

const LONG_RUN_MS = 5 * 60 * 1000;

function RunCard({
  run,
  selectable,
  selected,
  onToggleSelect,
}: {
  run: Run;
  selectable?: boolean;
  selected?: boolean;
  onToggleSelect?: (id: string) => void;
}) {
  const { text: duration, ms } = useElapsedInfo(run.createdAt, run.completedAt);
  const modelLabel = getModelLabel(run.model);
  const isLong = ms !== null && ms >= LONG_RUN_MS;
  const [, setLocation] = useLocation();
  return (
    <div key={run.id} className="block">
      <Card
        role="link"
        tabIndex={0}
        onClick={() => setLocation(`/runs/${run.id}`)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setLocation(`/runs/${run.id}`);
          }
        }}
        className="p-4 flex items-center justify-between hover:bg-muted/50 transition-colors cursor-pointer border-border/50"
      >
        {selectable && (
          <div
            className="pr-3 flex items-center"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggleSelect?.(run.id); }}
          >
            <Checkbox checked={selected} aria-label={`Select run ${run.id}`} />
          </div>
        )}
        <div className="flex flex-col gap-1 truncate pr-4 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm font-medium truncate">{run.goal}</span>
            {modelLabel && (
              <Badge variant="outline" className="shrink-0 font-mono text-[10px] px-1.5 py-0 border-blue-500/30 text-blue-400 bg-blue-500/5">
                {modelLabel}
              </Badge>
            )}
          </div>
          <div className="text-xs text-muted-foreground font-mono flex items-center gap-3">
            <span>{new Date(run.createdAt).toLocaleString()}</span>
            {duration && (
              <span
                className={`flex items-center gap-1 ${isLong ? "text-amber-400 font-medium" : ""}`}
                title={isLong ? "Long-running (over 5 minutes)" : undefined}
              >
                <Clock className="w-3 h-3" />
                {duration}
              </span>
            )}
            <span>{run.eventCount || 0} events</span>
            {run.repoUrl && (
              <span className="flex items-center gap-1">
                <Github className="w-3 h-3" />
                {run.repoUrl.replace("https://github.com/", "")}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {run.prUrl && (
            <a
              href={run.prUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className={`flex items-center gap-1 text-xs transition-colors ${
                run.prStatus === "merged"
                  ? "text-green-400 hover:text-green-300"
                  : run.prStatus === "closed"
                    ? "text-red-400 hover:text-red-300"
                    : "text-violet-400 hover:text-violet-300"
              }`}
              title={`Pull Request${run.prStatus ? ` · ${run.prStatus}` : ""}`}
            >
              <GitPullRequest className="w-3.5 h-3.5" />
              PR
              {run.prStatus && (
                <span className={`px-1 py-0.5 rounded text-[10px] font-medium leading-none ${
                  run.prStatus === "merged"
                    ? "bg-green-500/20 text-green-400"
                    : run.prStatus === "closed"
                      ? "bg-red-500/20 text-red-400"
                      : "bg-violet-500/20 text-violet-400"
                }`}>
                  {run.prStatus}
                </span>
              )}
            </a>
          )}
          <Badge variant="outline" className={
            run.status === 'completed' ? 'border-green-500/50 text-green-500' :
            run.status === 'failed' ? 'border-red-500/50 text-red-500' :
            run.status === 'running' ? 'border-blue-500/50 text-blue-500' :
            'border-muted-foreground/50 text-muted-foreground'
          }>
            {run.status}
          </Badge>
        </div>
      </Card>
    </div>
  );
}

export default function Dashboard() {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { data: runs, isLoading: runsLoading } = useListRuns();
  const { data: stats } = useGetRunStats();
  
  const createRun = useCreateRun();
  const [goal, setGoal] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [showRepoField, setShowRepoField] = useState(false);
  const [requireApproval, setRequireApproval] = useState(false);
  const [selectedModel, setSelectedModel] = useState<string>(() => {
    if (typeof window === "undefined") return "default";
    return window.localStorage.getItem(PREFERRED_MODEL_KEY) ?? "default";
  });
  const [showModelField, setShowModelField] = useState(false);

  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  const [compareMode, setCompareMode] = useState(false);
  const [selectedForCompare, setSelectedForCompare] = useState<string[]>([]);

  // Persist the preferred model across sessions.
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(PREFERRED_MODEL_KEY, selectedModel);
  }, [selectedModel]);

  const toggleCompareSelect = (id: string) => {
    setSelectedForCompare(prev => {
      if (prev.includes(id)) return prev.filter(x => x !== id);
      if (prev.length >= 2) return [prev[1]!, id];
      return [...prev, id];
    });
  };

  const handleExitCompare = () => {
    setCompareMode(false);
    setSelectedForCompare([]);
  };

  const handleCompareGo = () => {
    if (selectedForCompare.length === 2) {
      setLocation(`/runs/${selectedForCompare[0]}/diff/${selectedForCompare[1]}`);
    }
  };

  const filteredRuns = useMemo(() => {
    if (!runs) return [];
    const q = searchQuery.trim().toLowerCase();
    return runs.filter(run => {
      const matchesSearch =
        !q ||
        run.goal.toLowerCase().includes(q) ||
        (run.repoUrl?.toLowerCase().includes(q) ?? false);
      const matchesStatus =
        statusFilter === "all" ||
        (statusFilter === "active" && (run.status === "running" || run.status === "pending")) ||
        (statusFilter === "completed" && run.status === "completed") ||
        (statusFilter === "failed" && run.status === "failed");
      return matchesSearch && matchesStatus;
    });
  }, [runs, searchQuery, statusFilter]);

  const isFiltered = searchQuery.trim() !== "" || statusFilter !== "all";

  const handleClearFilters = () => {
    setSearchQuery("");
    setStatusFilter("all");
  };

  const handleStartRun = (e: React.FormEvent) => {
    e.preventDefault();
    if (!goal.trim()) return;
    createRun.mutate({
      data: {
        goal,
        repoUrl: repoUrl.trim() || null,
        model: selectedModel === "default" ? null : selectedModel,
        requireApproval,
      }
    }, {
      onSuccess: (newRun) => {
        queryClient.invalidateQueries({ queryKey: getListRunsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetRunStatsQueryKey() });
        setLocation(`/runs/${newRun.id}`);
      }
    });
  };

  return (
    <div className="min-h-[100dvh] w-full flex flex-col bg-background text-foreground">
      <header className="border-b border-border/50 bg-card/50 backdrop-blur sticky top-0 z-10 p-4 px-6 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Network className="w-5 h-5 text-primary" />
          <h1 className="font-mono font-bold tracking-tight">AG Coder</h1>
        </div>
      </header>

      <main className="flex-1 p-6 lg:p-12 max-w-6xl mx-auto w-full flex flex-col gap-8">
        
        {/* Stats Row */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card className="p-4 flex flex-col gap-1 border-border/50 bg-card/50">
            <span className="text-sm text-muted-foreground font-mono">Total Runs</span>
            <span className="text-2xl font-bold font-mono">{stats?.totalRuns ?? '-'}</span>
          </Card>
          <Card className="p-4 flex flex-col gap-1 border-border/50 bg-card/50">
            <span className="text-sm text-muted-foreground font-mono">Active</span>
            <div className="flex items-center gap-2">
              <Activity className="w-4 h-4 text-blue-500" />
              <span className="text-2xl font-bold font-mono">{stats?.activeRuns ?? '-'}</span>
            </div>
          </Card>
          <Card className="p-4 flex flex-col gap-1 border-border/50 bg-card/50">
            <span className="text-sm text-muted-foreground font-mono">Completed</span>
            <div className="flex items-center gap-2">
              <CheckCircle className="w-4 h-4 text-green-500" />
              <span className="text-2xl font-bold font-mono">{stats?.completedRuns ?? '-'}</span>
            </div>
          </Card>
          <Card className="p-4 flex flex-col gap-1 border-border/50 bg-card/50">
            <span className="text-sm text-muted-foreground font-mono">Failed</span>
            <div className="flex items-center gap-2">
              <XCircle className="w-4 h-4 text-red-500" />
              <span className="text-2xl font-bold font-mono">{stats?.failedRuns ?? '-'}</span>
            </div>
          </Card>
        </div>

        {/* New Run Form */}
        <Card className="p-6 border-border bg-card">
          <h2 className="text-lg font-mono font-semibold mb-4 flex items-center gap-2">
            <FileTerminal className="w-5 h-5" />
            New Agent Run
          </h2>
          <form onSubmit={handleStartRun} className="flex flex-col gap-3">
            <div className="flex gap-3">
              <Input 
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                placeholder="Describe what the agent should build or fix..."
                className="flex-1 font-mono bg-background"
                disabled={createRun.isPending}
              />
              <Button type="submit" disabled={createRun.isPending || !goal.trim()} className="min-w-[120px]">
                {createRun.isPending ? "Starting..." : <><Play className="w-4 h-4 mr-2" /> Start Run</>}
              </Button>
            </div>

            {/* Human-in-the-loop: pause before committing changes */}
            <label className="flex items-center gap-2 text-xs text-muted-foreground select-none cursor-pointer">
              <Checkbox
                checked={requireApproval}
                onCheckedChange={(c) => setRequireApproval(c === true)}
                disabled={createRun.isPending}
                aria-label="Require approval before committing"
              />
              Require my approval before the agent commits its changes
            </label>

            {/* GitHub repo URL toggle */}
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => setShowRepoField(v => !v)}
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors w-fit"
              >
                <Github className="w-3.5 h-3.5" />
                <span>GitHub repo (optional)</span>
                <ChevronDown className={`w-3 h-3 transition-transform ${showRepoField ? "rotate-180" : ""}`} />
              </button>
              {showRepoField && (
                <div className="flex flex-col gap-1">
                  <RepoCombobox
                    value={repoUrl}
                    onChange={setRepoUrl}
                    disabled={createRun.isPending}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Agent will clone this repo, make changes on a new branch, and open a PR when done.
                  </p>
                </div>
              )}
            </div>

            {/* Model selector toggle */}
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => setShowModelField(v => !v)}
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors w-fit"
              >
                <Bot className="w-3.5 h-3.5" />
                <span>
                  Model{selectedModel !== "default" ? `: ${MODEL_OPTIONS.find(o => o.value === selectedModel)?.label ?? selectedModel}` : " (optional)"}
                </span>
                <ChevronDown className={`w-3 h-3 transition-transform ${showModelField ? "rotate-180" : ""}`} />
              </button>
              {showModelField && (
                <div className="flex flex-col gap-1">
                  <Select
                    value={selectedModel}
                    onValueChange={setSelectedModel}
                    disabled={createRun.isPending}
                  >
                    <SelectTrigger className="w-56 font-mono text-xs bg-background h-8">
                      <SelectValue placeholder="Default" />
                    </SelectTrigger>
                    <SelectContent>
                      {MODEL_OPTIONS.map(opt => (
                        <SelectItem key={opt.value} value={opt.value} className="font-mono text-xs">
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-[11px] text-muted-foreground">
                    Default lets the server choose. Requires the matching API key to be set.
                  </p>
                </div>
              )}
            </div>
          </form>
        </Card>

        {/* Runs List */}
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-mono font-semibold">Recent Runs</h2>
            <div className="flex items-center gap-3">
              {isFiltered && runs && (
                <span className="font-mono text-xs text-muted-foreground">
                  Showing {filteredRuns.length} of {runs.length} runs
                </span>
              )}
              {compareMode ? (
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs text-muted-foreground">
                    {selectedForCompare.length}/2 selected
                  </span>
                  <Button
                    size="sm"
                    className="h-7 text-xs font-mono gap-1.5"
                    disabled={selectedForCompare.length !== 2}
                    onClick={handleCompareGo}
                  >
                    <GitCompareArrows className="w-3.5 h-3.5" />
                    Compare
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs font-mono"
                    onClick={handleExitCompare}
                  >
                    Cancel
                  </Button>
                </div>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs font-mono gap-1.5"
                  onClick={() => setCompareMode(true)}
                >
                  <GitCompareArrows className="w-3.5 h-3.5" />
                  Compare Runs
                </Button>
              )}
            </div>
          </div>

          {/* Search + filter controls */}
          <div className="flex flex-col gap-2">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
              <Input
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Search by goal or repo…"
                className="pl-8 pr-8 font-mono text-sm bg-background"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery("")}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                  aria-label="Clear search"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              {(["all", "active", "completed", "failed"] as StatusFilter[]).map(s => (
                <button
                  key={s}
                  onClick={() => setStatusFilter(s)}
                  className={`px-3 py-1 rounded-full font-mono text-xs font-medium transition-colors border ${
                    statusFilter === s
                      ? s === "all"
                        ? "bg-foreground text-background border-foreground"
                        : s === "active"
                          ? "bg-blue-500/20 text-blue-400 border-blue-500/40"
                          : s === "completed"
                            ? "bg-green-500/20 text-green-400 border-green-500/40"
                            : "bg-red-500/20 text-red-400 border-red-500/40"
                      : "bg-transparent text-muted-foreground border-border/50 hover:border-border hover:text-foreground"
                  }`}
                >
                  {s.charAt(0).toUpperCase() + s.slice(1)}
                </button>
              ))}
              {isFiltered && (
                <button
                  onClick={handleClearFilters}
                  className="ml-auto font-mono text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
                >
                  <X className="h-3 w-3" /> Clear
                </button>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            {runsLoading ? (
              <div className="text-sm text-muted-foreground font-mono">Loading runs...</div>
            ) : runs?.length === 0 ? (
              <div className="text-sm text-muted-foreground font-mono">No runs yet.</div>
            ) : filteredRuns.length === 0 ? (
              <div className="text-sm text-muted-foreground font-mono py-4 text-center">
                No runs match your filter.{" "}
                <button onClick={handleClearFilters} className="underline underline-offset-2 hover:text-foreground transition-colors">
                  Clear filters
                </button>
              </div>
            ) : (
              filteredRuns.map((run) => (
                <RunCard
                  key={run.id}
                  run={run}
                  selectable={compareMode}
                  selected={selectedForCompare.includes(run.id)}
                  onToggleSelect={toggleCompareSelect}
                />
              ))
            )}
          </div>
        </div>

      </main>
    </div>
  );
}

