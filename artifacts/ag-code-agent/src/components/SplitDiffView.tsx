type Side = { lineNo: number | null; text: string; kind: "context" | "add" | "del" | "empty" };
type Row = { left: Side; right: Side; hunk?: string };

const EMPTY: Side = { lineNo: null, text: "", kind: "empty" };

/**
 * Parse a unified diff into aligned side-by-side rows.
 * Removed lines align to the left, added lines to the right; a contiguous
 * block of removals is paired row-by-row with the following block of additions.
 */
export function parseUnifiedDiff(diff: string): Row[] {
  const lines = diff.split("\n");
  const rows: Row[] = [];
  let oldNo = 0;
  let newNo = 0;
  let pendingDel: Side[] = [];
  let pendingAdd: Side[] = [];

  const flush = () => {
    const max = Math.max(pendingDel.length, pendingAdd.length);
    for (let i = 0; i < max; i++) {
      rows.push({ left: pendingDel[i] ?? EMPTY, right: pendingAdd[i] ?? EMPTY });
    }
    pendingDel = [];
    pendingAdd = [];
  };

  for (const line of lines) {
    if (
      line.startsWith("+++") ||
      line.startsWith("---") ||
      line.startsWith("diff ") ||
      line.startsWith("index ")
    ) {
      continue;
    }
    if (line.startsWith("@@")) {
      flush();
      const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) {
        oldNo = parseInt(m[1]!, 10);
        newNo = parseInt(m[2]!, 10);
      }
      rows.push({ left: EMPTY, right: EMPTY, hunk: line });
      continue;
    }
    if (line.startsWith("+")) {
      pendingAdd.push({ lineNo: newNo++, text: line.slice(1), kind: "add" });
    } else if (line.startsWith("-")) {
      pendingDel.push({ lineNo: oldNo++, text: line.slice(1), kind: "del" });
    } else {
      // context line
      flush();
      const text = line.startsWith(" ") ? line.slice(1) : line;
      rows.push({
        left: { lineNo: oldNo++, text, kind: "context" },
        right: { lineNo: newNo++, text, kind: "context" },
      });
    }
  }
  flush();
  return rows;
}

function cellClass(kind: Side["kind"]): string {
  switch (kind) {
    case "add":
      return "bg-green-500/10 text-green-300";
    case "del":
      return "bg-red-500/10 text-red-300";
    case "empty":
      return "bg-muted/20";
    default:
      return "text-foreground/70";
  }
}

function SideCell({ side }: { side: Side }) {
  return (
    <div className={`flex ${cellClass(side.kind)}`}>
      <span className="w-10 shrink-0 px-1.5 text-right text-[9px] text-muted-foreground/60 select-none tabular-nums border-r border-border/30">
        {side.lineNo ?? ""}
      </span>
      <span className="px-2 whitespace-pre flex-1 min-w-0">{side.text || "\u00a0"}</span>
    </div>
  );
}

export function SplitDiffView({ diff }: { diff: string }) {
  if (!diff.trim()) {
    return (
      <div className="p-4 font-mono text-xs text-muted-foreground">No changes (empty diff).</div>
    );
  }
  const rows = parseUnifiedDiff(diff);
  return (
    <div className="overflow-x-auto">
      <div className="text-[11px] font-mono leading-relaxed min-w-max">
        {rows.map((row, i) =>
          row.hunk ? (
            <div
              key={i}
              className="text-blue-400 bg-blue-500/5 px-3 py-0.5 border-y border-border/20"
            >
              {row.hunk}
            </div>
          ) : (
            <div key={i} className="grid grid-cols-2 divide-x divide-border/30">
              <SideCell side={row.left} />
              <SideCell side={row.right} />
            </div>
          ),
        )}
      </div>
    </div>
  );
}
