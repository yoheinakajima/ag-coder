import {
  useListRunApprovals,
  useResolveRunApproval,
  queryConfig,
  getGetRunQueryKey,
  getGetRunEventsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";

/**
 * Human-in-the-loop gate. When a run is paused at `awaiting_approval`, the agent
 * has produced changes but not committed them (ActiveGraph approval flow). This
 * surfaces the pending approval and lets a reviewer approve (commit) or reject
 * (discard) — resolving it finalizes the run.
 */
export function ApprovalBanner({ runId, status }: { runId: string; status?: string }) {
  const queryClient = useQueryClient();
  const isPaused = status === "awaiting_approval";

  const { data: approvals } = useListRunApprovals(runId, {
    query: queryConfig({ enabled: isPaused, refetchInterval: isPaused ? 3000 : false }),
  });
  const resolve = useResolveRunApproval();

  const pending = (approvals ?? []).filter((a) => a.status === "pending");
  if (!isPaused || pending.length === 0) return null;

  const onDecide = async (approvalId: string, decision: "approve" | "reject") => {
    await resolve.mutateAsync({ runId, approvalId, data: { decision } });
    void queryClient.invalidateQueries({ queryKey: getGetRunQueryKey(runId) });
    void queryClient.invalidateQueries({ queryKey: getGetRunEventsQueryKey(runId) });
  };

  return (
    <div className="border-b border-amber-500/40 bg-amber-500/10 px-4 py-3">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="text-sm">
          <span className="font-semibold text-amber-600 dark:text-amber-400">
            Approval required
          </span>
          <span className="text-muted-foreground">
            {" "}— the agent paused before committing its changes.
          </span>
          {pending.map((a) => (
            <div key={a.id} className="text-xs text-foreground/80 mt-1 font-mono">
              {a.summary ?? a.kind}
            </div>
          ))}
        </div>
        <div className="flex gap-2 shrink-0">
          {pending.map((a) => (
            <div key={a.id} className="flex gap-2">
              <Button
                size="sm"
                variant="default"
                disabled={resolve.isPending}
                onClick={() => onDecide(a.id, "approve")}
              >
                Approve
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={resolve.isPending}
                onClick={() => onDecide(a.id, "reject")}
              >
                Reject
              </Button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
