import { useGetRunCausalChain, queryConfig } from "@workspace/api-client-react";

/**
 * Renders ActiveGraph's OWN causal_chain for a selected graph object — the
 * framework's provenance walk from the object back through its LLM/tool calls
 * and triggering events up to goal.created. This is not reconstructed from the
 * app's relations; it's computed by the runtime's trace.causal.causal_chain
 * over the authoritative event log (served by GET /runs/:id/causal-chain).
 */
export function CausalChainPanel({
  runId,
  objectId,
  objectLabel,
}: {
  runId: string;
  objectId: string | null;
  objectLabel?: string;
}) {
  const { data, isLoading, isError } = useGetRunCausalChain(
    runId,
    { objectId: objectId ?? "" },
    { query: queryConfig({ enabled: !!objectId }) },
  );

  if (!objectId) {
    return (
      <div className="px-4 py-3 text-xs text-muted-foreground">
        Select a graph node to trace its provenance back to the goal.
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <div className="px-4 py-2 text-[11px] uppercase tracking-wider text-muted-foreground font-mono">
        Provenance · causal_chain
        {objectLabel ? <span className="text-foreground/70"> · {objectLabel}</span> : null}
      </div>
      <div className="px-4 pb-3">
        {isLoading && <div className="text-xs text-muted-foreground">Computing chain…</div>}
        {isError && <div className="text-xs text-destructive">Couldn’t compute the causal chain for this object.</div>}
        {data?.chain && (
          <pre className="text-[11px] leading-relaxed font-mono whitespace-pre-wrap text-foreground/90 bg-muted/30 rounded-md p-3 overflow-x-auto">
            {data.chain}
          </pre>
        )}
      </div>
    </div>
  );
}
