import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  MarkerType,
  applyNodeChanges,
  applyEdgeChanges,
  type Node,
  type Edge,
  type NodeProps,
  type NodeChange,
  type Connection,
} from '@xyflow/react';
import type { Agent, Group, InvalidAgent } from '../../core/model';
import type {
  Point,
  WorkspaceActions,
  WorkspaceSnapshot,
} from '../../core/workspace';
import type { ChatStatus } from '../../core/chat';
import { BroadcastBar } from './broadcastBar';
import { StopAllButton } from './stopAllButton';
import {
  GRAPH_AGENT_WIDTH,
  GRAPH_AGENT_HEIGHT,
  graphGroupFrame,
  graphLayoutPositions,
} from '../../core/graphLayout';

type GraphData = {
  kind: 'agent' | 'group' | 'invalid';
  status?: ChatStatus;
  agent?: Agent;
  group?: Group;
  invalid?: InvalidAgent;
  anchor?: Point;
  count?: number;
};
type GraphNode = Node<GraphData>;
type GroupDrag = {
  id: string;
  start: Point;
  anchor: Point;
  members: Map<string, Point>;
};

function AgentNode({ data }: NodeProps<GraphNode>) {
  const agent = data.agent!;
  const status = data.status ?? 'offline';
  return (
    <div className="agenthq-agent-card">
      <Handle
        type="target"
        position={Position.Top}
        id="report"
        aria-label="Reports to manager"
      />
      <div className="agenthq-agent-heading">
        <strong title={agent.name}>{agent.name}</strong>
        {agent.warnings.length > 0 && (
          <span
            className="agenthq-warning"
            title={agent.warnings.join('\n')}
            aria-label={agent.warnings.join('; ')}
          >
            ⚠
          </span>
        )}
      </div>
      <div className="agenthq-agent-role" title={agent.role}>
        {agent.role || 'No role set'}
      </div>
      <div className="agenthq-agent-meta">
        <span className="agenthq-runtime" title={`Runtime: ${agent.runtime}`}>
          <span aria-hidden="true">⌘</span> {agent.runtime}
        </span>
        <span
          className={`agenthq-status agenthq-status-${status}`}
          title={status}
        >
          <span className="agenthq-status-dot" aria-hidden="true" />
          {status}
        </span>
      </div>
      <Handle
        type="source"
        position={Position.Bottom}
        id="manager"
        aria-label="Manage another agent"
      />
    </div>
  );
}
function InvalidNode({ data }: NodeProps<GraphNode>) {
  const invalid = data.invalid!;
  return (
    <div
      className="agenthq-agent-card agenthq-invalid-card"
      title={invalid.reason}
    >
      <div className="agenthq-agent-heading">
        <strong>{invalid.name}</strong>
        <span className="agenthq-warning" aria-label={invalid.reason}>
          ⚠
        </span>
      </div>
      <div className="agenthq-invalid-reason">{invalid.reason}</div>
      <div className="agenthq-repair-hint">Click to open note and repair</div>
    </div>
  );
}
function GroupNode({ data }: NodeProps<GraphNode>) {
  return (
    <div className="agenthq-group-frame">
      <div className="agenthq-group-heading">
        <strong>{data.group!.name}</strong>
        <span>{data.count} agents</span>
      </div>
    </div>
  );
}
const nodeTypes = { agent: AgentNode, invalid: InvalidNode, team: GroupNode };

function frameNodes(nodes: GraphNode[]): GraphNode[] {
  return nodes.map((node) => {
    if (node.data.kind !== 'group') return node;
    const members = nodes.filter(
      (member) => member.data.agent?.group === node.data.group!.id,
    );
    const frame = graphGroupFrame(
      node.data.anchor!,
      members.map((member) => member.position),
    );
    return {
      ...node,
      position: frame.position,
      measured: { width: frame.width, height: frame.height },
      width: frame.width,
      height: frame.height,
      style: { ...node.style, width: frame.width, height: frame.height },
    };
  });
}
function snapshotNodes(snapshot: WorkspaceSnapshot): GraphNode[] {
  const layout = graphLayoutPositions(
    snapshot.agents,
    snapshot.groups,
    snapshot.layout,
  );
  const nodes: GraphNode[] = snapshot.groups.map((group) => ({
    id: `group:${group.id}`,
    type: 'team',
    position: layout[`group:${group.id}`]!,
    data: {
      kind: 'group',
      group,
      anchor: layout[`group:${group.id}`],
      count: snapshot.agents.filter((agent) => agent.group === group.id).length,
    },
    style: { '--agenthq-group-color': group.color } as CSSProperties,
    dragHandle: '.agenthq-group-heading',
    connectable: false,
    zIndex: -1,
    ariaLabel: `Group ${group.name}. Drag its heading to move its agents.`,
  }));
  nodes.push(
    ...snapshot.agents.map((agent): GraphNode => ({
      id: agent.id,
      type: 'agent',
      position: layout[agent.id]!,
      data: {
        kind: 'agent',
        agent,
        status: snapshot.chat?.agents[agent.id]?.status ?? 'offline',
      },
      selected: snapshot.selectedId === agent.id,
      measured: { width: GRAPH_AGENT_WIDTH, height: GRAPH_AGENT_HEIGHT },
      width: GRAPH_AGENT_WIDTH,
      height: GRAPH_AGENT_HEIGHT,
      style: { width: GRAPH_AGENT_WIDTH, height: GRAPH_AGENT_HEIGHT },
      ariaLabel: `${agent.name}, ${agent.role}, ${snapshot.chat?.agents[agent.id]?.status ?? 'offline'}`,
    })),
  );
  const invalidY =
    Math.max(0, ...Object.values(layout).map((point) => point.y)) + 240;
  nodes.push(
    ...snapshot.invalidAgents.map((invalid, index): GraphNode => ({
      id: `invalid:${invalid.path}`,
      type: 'invalid',
      position: {
        x: (index % 3) * 256 + 32,
        y: invalidY + Math.floor(index / 3) * 176,
      },
      data: { kind: 'invalid', invalid },
      connectable: false,
      draggable: false,
      deletable: false,
      measured: { width: GRAPH_AGENT_WIDTH, height: GRAPH_AGENT_HEIGHT },
      width: GRAPH_AGENT_WIDTH,
      height: GRAPH_AGENT_HEIGHT,
      style: { width: GRAPH_AGENT_WIDTH, height: GRAPH_AGENT_HEIGHT },
      ariaLabel: `${invalid.name}: ${invalid.reason}. Open note to repair.`,
    })),
  );
  return frameNodes(nodes);
}
function snapshotEdges(snapshot: WorkspaceSnapshot): Edge[] {
  const ids = new Set(snapshot.agents.map((agent) => agent.id));
  return snapshot.agents.flatMap((agent) =>
    agent.reportsTo && ids.has(agent.reportsTo)
      ? [
          {
            id: `reports:${agent.id}`,
            source: agent.reportsTo,
            target: agent.id,
            sourceHandle: 'manager',
            targetHandle: 'report',
            type: 'smoothstep',
            markerEnd: { type: MarkerType.ArrowClosed },
            interactionWidth: 24,
            ariaLabel: `${agent.name} reports to ${snapshot.agents.find((manager) => manager.id === agent.reportsTo)!.name}`,
          },
        ]
      : [],
  );
}

export function GraphCanvas({ workspace }: { workspace: WorkspaceActions }) {
  const subscribe = useCallback(
    (listener: () => void) => workspace.subscribe(listener),
    [workspace],
  );
  const getSnapshot = useCallback(() => workspace.getSnapshot(), [workspace]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const geometry = useMemo(
    () => snapshotNodes(snapshot),
    [
      snapshot.agents,
      snapshot.groups,
      snapshot.invalidAgents,
      snapshot.layout,
      snapshot.chat,
    ],
  );
  const relationships = useMemo(
    () => snapshotEdges(snapshot),
    [snapshot.agents],
  );
  const [nodes, setNodes] = useState<GraphNode[]>(geometry);
  const [edges, setEdges] = useState<Edge[]>(relationships);
  const [deleting, setDeleting] = useState(false);
  const dragging = useRef<string | null>(null);
  const groupDrag = useRef<GroupDrag | null>(null);
  useEffect(() => {
    setNodes((current) =>
      geometry.map((node) => {
        const previous = current.find((item) => item.id === node.id);
        return {
          ...node,
          ...(dragging.current && previous
            ? { position: previous.position }
            : {}),
          selected:
            node.data.kind === 'agent'
              ? workspace.getSnapshot().selectedId === node.id
              : (previous?.selected ?? false),
        };
      }),
    );
  }, [geometry, workspace]);
  useEffect(() => {
    setNodes((current) =>
      current.map((node) => ({
        ...node,
        selected: node.data.kind === 'agent' && node.id === snapshot.selectedId,
      })),
    );
    setEdges((current) =>
      current.map((edge) => ({ ...edge, selected: false })),
    );
  }, [snapshot.selectedId, snapshot.selectionRevision]);
  useEffect(() => {
    setEdges((current) =>
      relationships.map((edge) => ({
        ...edge,
        selected:
          current.find((item) => item.id === edge.id)?.selected ?? false,
      })),
    );
  }, [relationships]);
  const perform = useCallback(
    async (operation: () => Promise<void>, restore = false) => {
      try {
        await operation();
      } catch (error) {
        workspace.reportError(error);
      } finally {
        // Restore cancelled confirmations and failed persistence, not just successful writes.
        if (restore && !dragging.current)
          setNodes(snapshotNodes(workspace.getSnapshot()));
      }
    },
    [workspace],
  );
  const onNodesChange = useCallback((changes: NodeChange<GraphNode>[]) => {
    // React can defer the updater until after onNodeDragStop clears the ref.
    const drag = groupDrag.current;
    setNodes((current) => {
      let updated = applyNodeChanges(
        changes.filter((change) => change.type !== 'remove'),
        current,
      );
      if (drag) {
        const frame = updated.find((node) => node.id === drag.id);
        if (frame) {
          const dx = frame.position.x - drag.start.x;
          const dy = frame.position.y - drag.start.y;
          updated = updated.map((node) => {
            const start = drag.members.get(node.id);
            return start
              ? { ...node, position: { x: start.x + dx, y: start.y + dy } }
              : node;
          });
        }
        return updated;
      }
      return frameNodes(updated);
    });
  }, []);
  const connect = useCallback(
    (connection: Connection) => {
      if (
        connection.sourceHandle !== 'manager' ||
        connection.targetHandle !== 'report'
      )
        return;
      const current = workspace.getSnapshot();
      if (
        !current.agents.some((agent) => agent.id === connection.source) ||
        !current.agents.some((agent) => agent.id === connection.target)
      )
        return;
      // Parent owns cycle Notice, persistence and the single-manager rule.
      void perform(() =>
        workspace.setManager(connection.target, connection.source),
      );
    },
    [perform, workspace],
  );
  const deleteSelected = useCallback(async () => {
    if (deleting || dragging.current) return;
    const edge = edges.find((item) => item.selected);
    const group = nodes.find(
      (item) => item.selected && item.data.kind === 'group',
    );
    const agent = nodes.find(
      (item) => item.selected && item.data.kind === 'agent',
    );
    if (!edge && !group && !agent) return;
    setDeleting(true);
    await perform(
      () =>
        edge
          ? workspace.setManager(edge.target, null)
          : group
            ? workspace.deleteGroup(group.data.group!.id)
            : workspace.deleteAgent(agent!.id),
      true,
    );
    setDeleting(false);
  }, [deleting, edges, nodes, perform, workspace]);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (
      target.closest(
        'input, textarea, select, button, [contenteditable="true"]',
      )
    )
      return;
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      event.stopPropagation();
      void deleteSelected();
    }
  };
  const hasSelection =
    edges.some((edge) => edge.selected) ||
    nodes.some((node) => node.selected && node.data.kind !== 'invalid');
  return (
    <div className="agenthq-graph-shell" onKeyDown={onKeyDown}>
      <div
        className="agenthq-graph-toolbar"
        role="toolbar"
        aria-label="Graph actions"
      >
        <button onClick={() => workspace.requestCreateAgent()}>+ Agent</button>
        <button onClick={() => workspace.requestCreateGroup()}>+ Group</button>
        <button
          onClick={() => {
            void deleteSelected();
          }}
          disabled={!hasSelection || deleting}
        >
          Delete selected
        </button>
        <StopAllButton workspace={workspace} />
      </div>
      {snapshot.error && (
        <div className="agenthq-graph-error" role="alert">
          {snapshot.error}
        </div>
      )}
      <div
        className="agenthq-graph-canvas"
        aria-label="Agent organization chart"
      >
        <ReactFlow<GraphNode, Edge>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={(changes) =>
            setEdges((current) =>
              applyEdgeChanges(
                changes.filter((change) => change.type !== 'remove'),
                current,
              ),
            )
          }
          onConnect={connect}
          deleteKeyCode={null}
          multiSelectionKeyCode={null}
          edgesReconnectable={false}
          elevateNodesOnSelect={false}
          minZoom={0.15}
          maxZoom={2}
          fitView
          fitViewOptions={{ padding: 0.18 }}
          onNodeClick={(_event, node) => {
            if (node.data.kind === 'agent')
              workspace.selectAgent(node.id, 'chat');
            if (node.data.kind === 'invalid')
              void perform(() => workspace.openNote(node.data.invalid!.path));
          }}
          onNodeDragStart={(_event, node) => {
            dragging.current = node.id;
            if (node.data.kind === 'group')
              groupDrag.current = {
                id: node.id,
                start: { ...node.position },
                anchor: { ...node.data.anchor! },
                members: new Map(
                  nodes
                    .filter(
                      (member) =>
                        member.data.agent?.group === node.data.group!.id,
                    )
                    .map((member) => [member.id, { ...member.position }]),
                ),
              };
          }}
          onNodeDragStop={(_event, node) => {
            const drag = groupDrag.current;
            dragging.current = null;
            groupDrag.current = null;
            if (node.data.kind === 'group' && drag) {
              const anchor = {
                x: drag.anchor.x + node.position.x - drag.start.x,
                y: drag.anchor.y + node.position.y - drag.start.y,
              };
              setNodes((current) =>
                frameNodes(
                  current.map((item) => {
                    if (item.id === drag.id)
                      return { ...item, data: { ...item.data, anchor } };
                    const start = drag.members.get(item.id);
                    return start
                      ? {
                          ...item,
                          position: {
                            x: start.x + anchor.x - drag.anchor.x,
                            y: start.y + anchor.y - drag.anchor.y,
                          },
                        }
                      : item;
                  }),
                ),
              );
              void perform(
                () => workspace.moveGroup(node.data.group!.id, anchor),
                true,
              );
            } else if (node.data.kind === 'agent')
              void perform(
                () => workspace.moveAgent(node.id, node.position),
                true,
              );
          }}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={24} size={1} />
          <Controls
            showInteractive={false}
            fitViewOptions={{ padding: 0.18, minZoom: 0.8 }}
          />
        </ReactFlow>
        {snapshot.loading && (
          <div className="agenthq-graph-message" role="status">
            Loading team…
          </div>
        )}
        {!snapshot.loading && nodes.length === 0 && (
          <div className="agenthq-graph-message">
            No agents yet. Create an agent to start your team.
          </div>
        )}
      </div>
      <BroadcastBar workspace={workspace} />
      <div className="agenthq-graph-help">
        Connect bottom → top to set a manager · Drag group headings to move
        members · Select a line + Delete to disconnect
      </div>
    </div>
  );
}
