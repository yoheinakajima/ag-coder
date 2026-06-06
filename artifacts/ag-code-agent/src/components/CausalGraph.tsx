import { useMemo, useState, useCallback, useEffect } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  MarkerType,
  Panel,
  useNodesState,
  type Node as RFNode,
  type Edge as RFEdge,
  type NodeProps,
  type NodeMouseHandler,
  type EdgeMouseHandler,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import * as dagre from "@dagrejs/dagre";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  MapIcon,
  CheckSquare,
  Code,
  Brain,
  FileText,
  Terminal,
  TestTube,
  Network,
  GitBranch,
  ChevronRight,
  ChevronDown,
  X,
  RotateCcw,
} from "lucide-react";
import type { GraphObject, GraphRelation } from "@workspace/api-client-react";

// ── Helpers ───────────────────────────────────────────────────────────────────

export function getNodeLabel(obj: GraphObject): string {
  const d = obj.data as Record<string, unknown> | null | undefined;
  if (!d) return obj.type;
  switch (obj.type) {
    case "plan":
      return String(d.title ?? "Plan");
    case "task":
      return String(
        d.title ?? (typeof d.description === "string" ? d.description.slice(0, 40) : "Task"),
      );
    case "patch":
      return String(d.path ?? "Patch");
    case "file_snapshot":
      return String(d.path ?? "Snapshot");
    case "command_result":
      return typeof d.command === "string" ? d.command.slice(0, 35) : "Command";
    case "test_run":
      return d.status ? `Tests: ${d.status}` : "Test run";
    case "model_call":
      return String(d.model ?? "LLM call");
    default:
      return obj.type;
  }
}

export function getGraphIcon(type: string, size = "h-3.5 w-3.5") {
  switch (type) {
    case "plan":
      return <MapIcon className={`${size} text-blue-500 shrink-0`} />;
    case "task":
      return <CheckSquare className={`${size} text-purple-400 shrink-0`} />;
    case "patch":
      return <Code className={`${size} text-orange-400 shrink-0`} />;
    case "model_call":
      return <Brain className={`${size} text-gray-400 shrink-0`} />;
    case "file_snapshot":
      return <FileText className={`${size} text-amber-400 shrink-0`} />;
    case "command_result":
      return <Terminal className={`${size} text-yellow-400 shrink-0`} />;
    case "test_run":
      return <TestTube className={`${size} text-green-400 shrink-0`} />;
    case "git_clone":
    case "git_commit":
      return <GitBranch className={`${size} text-teal-400 shrink-0`} />;
    default:
      return <Network className={`${size} text-muted-foreground shrink-0`} />;
  }
}

// ── Node color palette ────────────────────────────────────────────────────────

const NODE_COLORS: Record<string, { border: string; bg: string }> = {
  plan: { border: "#3b82f6", bg: "rgba(59,130,246,0.12)" },
  task: { border: "#8b5cf6", bg: "rgba(139,92,246,0.12)" },
  patch: { border: "#f97316", bg: "rgba(249,115,22,0.12)" },
  model_call: { border: "#6b7280", bg: "rgba(107,114,128,0.12)" },
  file_snapshot: { border: "#f59e0b", bg: "rgba(245,158,11,0.12)" },
  command_result: { border: "#eab308", bg: "rgba(234,179,8,0.12)" },
  test_run: { border: "#22c55e", bg: "rgba(34,197,94,0.12)" },
  git_clone: { border: "#14b8a6", bg: "rgba(20,184,166,0.12)" },
  git_commit: { border: "#14b8a6", bg: "rgba(20,184,166,0.12)" },
};
const FAIL_COLOR = { border: "#ef4444", bg: "rgba(239,68,68,0.12)" };
const DEFAULT_COLOR = { border: "#4b5563", bg: "rgba(75,85,99,0.12)" };

// ── Custom node component (must live outside the parent component) ─────────────

type CausalNodeData = {
  label: string;
  type: string;
  obj: GraphObject;
};

function CausalNode({ data, selected }: NodeProps<RFNode<CausalNodeData>>) {
  const isFailedTest = data.type === "test_run" && data.obj?.data?.status === "failed";
  const colors = isFailedTest ? FAIL_COLOR : (NODE_COLORS[data.type] ?? DEFAULT_COLOR);

  return (
    <div
      style={{
        width: 190,
        background: colors.bg,
        border: `1.5px solid ${selected ? "#e2e8f0" : colors.border}`,
        borderRadius: 8,
        padding: "6px 10px",
        cursor: "pointer",
        boxShadow: selected ? `0 0 0 2px ${colors.border}40` : undefined,
        transition: "border-color 0.15s, box-shadow 0.15s",
      }}
    >
      <Handle
        type="target"
        position={Position.Top}
        style={{ background: colors.border, border: "none", width: 6, height: 6 }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
        <span style={{ color: colors.border, flexShrink: 0, display: "flex" }}>
          {getGraphIcon(data.type, "h-3.5 w-3.5")}
        </span>
        <div style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }}>
          <span
            style={{
              fontFamily: "monospace",
              fontSize: 11,
              fontWeight: 600,
              color: "#f1f5f9",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              lineHeight: 1.35,
            }}
          >
            {data.label}
          </span>
          <span
            style={{
              fontFamily: "monospace",
              fontSize: 9,
              color: "#64748b",
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              lineHeight: 1.3,
            }}
          >
            {data.type}
          </span>
        </div>
      </div>
      <Handle
        type="source"
        position={Position.Bottom}
        style={{ background: colors.border, border: "none", width: 6, height: 6 }}
      />
    </div>
  );
}

const nodeTypes = { causal: CausalNode };

type CausalRFNode = RFNode<CausalNodeData>;

// ── Dagre layout ──────────────────────────────────────────────────────────────

const NODE_W = 190;
const NODE_H = 58;

function computeLayout(
  objects: GraphObject[],
  relations: GraphRelation[],
): { nodes: CausalRFNode[]; edges: RFEdge[] } {
  const g = new (dagre as any).graphlib.Graph() as dagre.graphlib.Graph;
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "TB", nodesep: 40, ranksep: 64, marginx: 24, marginy: 24 });

  objects.forEach((obj) => g.setNode(obj.id, { width: NODE_W, height: NODE_H }));
  relations.forEach((rel) => {
    if (g.hasNode(rel.source) && g.hasNode(rel.target)) {
      g.setEdge(rel.source, rel.target);
    }
  });

  (dagre as any).layout(g);

  const nodes: CausalRFNode[] = objects.map((obj) => {
    const pos = g.node(obj.id);
    return {
      id: obj.id,
      type: "causal",
      position: { x: (pos?.x ?? 0) - NODE_W / 2, y: (pos?.y ?? 0) - NODE_H / 2 },
      data: { type: obj.type, label: getNodeLabel(obj), obj } satisfies CausalNodeData,
    };
  });

  const edges: RFEdge[] = relations.map((rel) => ({
    id: rel.id,
    source: rel.source,
    target: rel.target,
    type: "smoothstep",
    style: { stroke: "#334155", strokeWidth: 1.5 },
    markerEnd: {
      type: MarkerType.ArrowClosed,
      color: "#334155",
      width: 14,
      height: 14,
    },
    label: rel.type.replace(/_/g, " ").toLowerCase(),
    labelStyle: { fontSize: 8, fill: "#475569" },
    labelBgStyle: { fill: "transparent" },
    animated: false,
  }));

  return { nodes, edges };
}

// ── Node detail panel ─────────────────────────────────────────────────────────

function NodeDetailPanel({
  obj,
  allObjects,
  allRelations,
  onClose,
}: {
  obj: GraphObject;
  allObjects: GraphObject[];
  allRelations: GraphRelation[];
  onClose: () => void;
}) {
  const data = obj.data as Record<string, unknown> | null | undefined;
  const outgoing = allRelations.filter((r) => r.source === obj.id);
  const incoming = allRelations.filter((r) => r.target === obj.id);

  function renderValue(val: unknown): string {
    if (val === null || val === undefined) return "—";
    if (typeof val === "string") return val.length > 300 ? val.slice(0, 300) + "…" : val;
    if (typeof val === "number" || typeof val === "boolean") return String(val);
    if (Array.isArray(val)) return `[${val.length} items]`;
    const s = JSON.stringify(val);
    return s.length > 300 ? s.slice(0, 300) + "…" : s;
  }

  const entries = data ? Object.entries(data).filter(([k]) => k !== "task_id") : [];

  return (
    <div
      className="border-t border-border/60 bg-muted/10 flex flex-col shrink-0 overflow-hidden"
      style={{ maxHeight: "45%" }}
    >
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/40 shrink-0">
        <div className="flex items-center gap-1.5">
          {getGraphIcon(obj.type, "h-3 w-3")}
          <span className="font-mono text-[11px] font-semibold text-foreground uppercase">
            {obj.type}
          </span>
          <span className="font-mono text-[9px] text-muted-foreground">{obj.id.slice(0, 14)}</span>
        </div>
        <button
          onClick={onClose}
          className="h-5 w-5 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
      <ScrollArea className="flex-1 min-h-0">
        <div className="p-3 flex flex-col gap-2 text-[10px] font-mono">
          {entries.length > 0 && (
            <div className="flex flex-col gap-1.5">
              {entries.map(([k, v]) => (
                <div key={k} className="flex gap-2 min-w-0">
                  <span className="text-muted-foreground shrink-0 w-20 truncate pt-px">{k}</span>
                  <span className="text-foreground break-all leading-relaxed">
                    {renderValue(v)}
                  </span>
                </div>
              ))}
            </div>
          )}
          {(outgoing.length > 0 || incoming.length > 0) && (
            <div className="flex flex-col gap-1 pt-1.5 border-t border-border/30">
              {outgoing.map((r) => {
                const target = allObjects.find((o) => o.id === r.target);
                return (
                  <div key={r.id} className="flex items-center gap-1.5">
                    <span className="text-muted-foreground shrink-0">→</span>
                    <span className="bg-primary/10 text-primary px-1 rounded text-[9px] uppercase shrink-0">
                      {r.type}
                    </span>
                    <span className="text-muted-foreground truncate">
                      {target ? getNodeLabel(target) : r.target.slice(0, 10)}
                    </span>
                  </div>
                );
              })}
              {incoming.map((r) => {
                const src = allObjects.find((o) => o.id === r.source);
                return (
                  <div key={r.id} className="flex items-center gap-1.5">
                    <span className="text-muted-foreground shrink-0">←</span>
                    <span className="bg-muted text-muted-foreground px-1 rounded text-[9px] uppercase shrink-0">
                      {r.type}
                    </span>
                    <span className="text-muted-foreground truncate">
                      {src ? getNodeLabel(src) : r.source.slice(0, 10)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
          {entries.length === 0 && outgoing.length === 0 && incoming.length === 0 && (
            <span className="text-muted-foreground">No data</span>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

// ── Tree fallback (when graph has no relations) ───────────────────────────────

interface GraphTreeNode {
  obj: GraphObject;
  children: GraphTreeNode[];
  depth: number;
}

function buildTree(objects: GraphObject[], relations: GraphRelation[]): GraphTreeNode[] {
  if (!objects.length) return [];
  const targetIds = new Set(relations.map((r) => r.target));
  const roots = objects.filter((o) => !targetIds.has(o.id));

  function buildChildren(parentId: string, depth: number, visited: Set<string>): GraphTreeNode[] {
    const result: GraphTreeNode[] = [];
    for (const r of relations) {
      if (r.source !== parentId || visited.has(r.target)) continue;
      const child = objects.find((o) => o.id === r.target);
      if (!child) continue;
      const next = new Set(visited).add(r.target);
      result.push({ obj: child, children: buildChildren(child.id, depth + 1, next), depth });
    }
    return result;
  }

  return roots.map((obj) => ({
    obj,
    children: buildChildren(obj.id, 1, new Set([obj.id])),
    depth: 0,
  }));
}

function TreeNodeRow({
  node,
  selectedId,
  onSelect,
  collapsed,
  onToggle,
}: {
  node: GraphTreeNode;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  collapsed: Set<string>;
  onToggle: (id: string) => void;
}) {
  const { obj, children, depth } = node;
  const isSelected = obj.id === selectedId;
  const hasChildren = children.length > 0;
  const isCollapsed = collapsed.has(obj.id);
  const label = getNodeLabel(obj);
  const indent = depth * 14;

  return (
    <div>
      <div style={{ paddingLeft: `${indent}px` }} className="flex items-center gap-0.5 min-w-0">
        <button
          className={`h-5 w-5 flex items-center justify-center shrink-0 rounded transition-colors
            ${hasChildren ? "text-muted-foreground hover:text-foreground hover:bg-muted/50" : "opacity-0 pointer-events-none"}`}
          onClick={(e) => {
            e.stopPropagation();
            if (hasChildren) onToggle(obj.id);
          }}
          tabIndex={hasChildren ? 0 : -1}
        >
          {hasChildren &&
            (isCollapsed ? (
              <ChevronRight className="h-3 w-3" />
            ) : (
              <ChevronDown className="h-3 w-3" />
            ))}
        </button>
        <button
          onClick={() => onSelect(isSelected ? null : obj.id)}
          className={`flex-1 flex items-center gap-1.5 px-2 py-1 rounded-md text-left transition-colors min-w-0
            ${isSelected ? "bg-primary/15 ring-1 ring-primary/30" : "hover:bg-muted/60"}`}
        >
          {getGraphIcon(obj.type)}
          <div className="flex flex-col min-w-0 flex-1">
            <span className="font-mono text-[11px] font-medium truncate leading-tight text-foreground">
              {label}
            </span>
            <span className="font-mono text-[9px] text-muted-foreground leading-tight uppercase tracking-wider">
              {obj.type}
            </span>
          </div>
          {hasChildren && (
            <span className="font-mono text-[9px] text-muted-foreground shrink-0 ml-1 tabular-nums">
              {children.length}
            </span>
          )}
        </button>
      </div>
      {hasChildren && !isCollapsed && (
        <div style={{ marginLeft: `${indent + 10}px` }} className="border-l border-border/40 pl-px">
          <div className="flex flex-col gap-0.5 py-0.5">
            {children.map((child) => (
              <TreeNodeRow
                key={child.obj.id}
                node={child}
                selectedId={selectedId}
                onSelect={onSelect}
                collapsed={collapsed}
                onToggle={onToggle}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function TreeFallback({
  objects,
  relations,
  selectedId,
  onSelect,
}: {
  objects: GraphObject[];
  relations: GraphRelation[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const tree = useMemo(() => buildTree(objects, relations), [objects, relations]);

  const handleToggle = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  return (
    <ScrollArea className="flex-1 min-h-0">
      <div className="py-2 px-1 flex flex-col gap-0.5">
        {tree.map((node) => (
          <TreeNodeRow
            key={node.obj.id}
            node={node}
            selectedId={selectedId}
            onSelect={onSelect}
            collapsed={collapsed}
            onToggle={handleToggle}
          />
        ))}
      </div>
    </ScrollArea>
  );
}

// ── CausalGraph (main export) ─────────────────────────────────────────────────

export interface CausalGraphProps {
  objects: GraphObject[];
  relations: GraphRelation[];
  onNodeSelect?: (obj: GraphObject | null) => void;
}

export function CausalGraph({ objects, relations, onNodeSelect }: CausalGraphProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null);

  const hasRelations = relations.length > 0;

  // Stable topology key so layout re-runs only when the actual graph changes,
  // not just because the array reference changed.
  const topoKey = `${objects.map((o) => o.id).join(",")}|${relations.map((r) => r.id).join(",")}`;

  // Compute dagre layout only when graph topology changes (not on selection)
  const layoutData = useMemo(
    () =>
      hasRelations
        ? computeLayout(objects, relations)
        : { nodes: [] as CausalRFNode[], edges: [] as RFEdge[] },
    // topoKey captures full topology; objects/relations refs change every poll cycle
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [topoKey, hasRelations],
  );

  // Controlled node state so users can drag/pin nodes (#34). Positions persist
  // across topology updates (#33) — only brand-new nodes take their dagre slot.
  const [nodes, setNodes, onNodesChange] = useNodesState<CausalRFNode>([]);

  // Incremental layout: merge fresh dagre output with any positions the user
  // (or a previous layout) already established, so existing nodes never jump.
  useEffect(() => {
    setNodes((prev) => {
      const prevById = new Map(prev.map((n) => [n.id, n]));
      return layoutData.nodes.map((n) => {
        const existing = prevById.get(n.id);
        return {
          ...n,
          position: existing ? existing.position : n.position,
          selected: n.id === selectedId,
        };
      });
    });
  }, [layoutData.nodes, selectedId, setNodes]);

  // Reset layout (#34): discard manual positions and re-run dagre fresh.
  const handleResetLayout = useCallback(() => {
    const fresh = hasRelations
      ? computeLayout(objects, relations)
      : { nodes: [] as CausalRFNode[], edges: [] as RFEdge[] };
    setNodes(fresh.nodes.map((n) => ({ ...n, selected: n.id === selectedId })));
  }, [objects, relations, hasRelations, selectedId, setNodes]);

  // Edge labels only on hover (#35) to keep the graph readable when dense.
  const displayEdges = useMemo(
    () =>
      layoutData.edges.map((e) => {
        const active = e.id === hoveredEdgeId;
        return {
          ...e,
          label: active ? e.label : undefined,
          style: active ? { ...(e.style as object), stroke: "#64748b", strokeWidth: 2 } : e.style,
          markerEnd: active
            ? { type: MarkerType.ArrowClosed, color: "#64748b", width: 14, height: 14 }
            : e.markerEnd,
        };
      }),
    [layoutData.edges, hoveredEdgeId],
  );

  const handleNodeClick: NodeMouseHandler = useCallback(
    (_evt: React.MouseEvent, node: RFNode) => {
      const id = node.id;
      setSelectedId((prev) => (prev === id ? null : id));
      if (onNodeSelect) {
        const obj = objects.find((o) => o.id === id) ?? null;
        onNodeSelect(obj);
      }
    },
    [objects, onNodeSelect],
  );

  const handleEdgeEnter: EdgeMouseHandler = useCallback(
    (_e, edge) => setHoveredEdgeId(edge.id),
    [],
  );
  const handleEdgeLeave: EdgeMouseHandler = useCallback(() => setHoveredEdgeId(null), []);

  const selectedObj = selectedId ? (objects.find((o) => o.id === selectedId) ?? null) : null;

  if (!objects.length) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-xs font-mono text-muted-foreground">No graph objects yet</div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden min-h-0">
      {hasRelations ? (
        <div className="flex-1 min-h-0" style={{ background: "hsl(var(--background))" }}>
          <ReactFlow
            nodes={nodes}
            edges={displayEdges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onNodeClick={handleNodeClick}
            onEdgeMouseEnter={handleEdgeEnter}
            onEdgeMouseLeave={handleEdgeLeave}
            onPaneClick={() => {
              setSelectedId(null);
              onNodeSelect?.(null);
            }}
            fitView
            fitViewOptions={{ padding: 0.18, maxZoom: 1.2 }}
            colorMode="dark"
            minZoom={0.15}
            maxZoom={2.5}
            proOptions={{ hideAttribution: true }}
            nodesConnectable={false}
            nodesDraggable
            elementsSelectable
          >
            <Panel position="top-right">
              <button
                onClick={handleResetLayout}
                title="Reset layout"
                className="flex items-center gap-1 px-2 py-1 rounded font-mono text-[10px] text-muted-foreground bg-card/90 border border-border hover:text-foreground hover:bg-muted/60 transition-colors"
              >
                <RotateCcw className="h-3 w-3" />
                Reset layout
              </button>
            </Panel>
            <Background color="#1e293b" gap={16} size={1} />
            <Controls
              showInteractive={false}
              style={{
                background: "hsl(var(--card))",
                borderColor: "hsl(var(--border))",
                borderRadius: 6,
              }}
            />
            <MiniMap
              nodeColor={(node) => {
                const d = node.data as CausalNodeData | undefined;
                return (NODE_COLORS[d?.type ?? ""] ?? DEFAULT_COLOR).border;
              }}
              maskColor="rgba(0,0,0,0.55)"
              style={{
                background: "#0f172a",
                border: "1px solid #1e293b",
                borderRadius: 4,
              }}
              nodeStrokeWidth={0}
              pannable
              zoomable
            />
          </ReactFlow>
        </div>
      ) : (
        <TreeFallback
          objects={objects}
          relations={relations}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
      )}
      {selectedObj && (
        <NodeDetailPanel
          obj={selectedObj}
          allObjects={objects}
          allRelations={relations}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}
