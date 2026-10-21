import { useEffect, useMemo, useRef, useState } from 'react';
import type { GraphAnalysis } from '../../core/graphMap';
import { shortTitle } from '../../core/overviewLabels';
import {
  buildForceGraph,
  DEFAULT_OVERVIEW,
  fitView,
  ForceSimulation,
  OVERVIEW_RANGES,
  type ForceGraph,
  type OverviewSettings,
  type ViewTransform,
} from '../../core/overviewForce';

/** Physics work per frame, so the view stays smooth while the dots settle. */
const FRAME_BUDGET_MS = 8;
const LEGEND_LIMIT = 12;
const DRAG_TOLERANCE_PX = 4;
const SAVE_DELAY_MS = 400;
/** Labels fade in between these zoom levels, like Obsidian's graph. */
const LABEL_FADE = [0.9, 1.8] as const;

interface Engine {
  fit(): void;
  focus(indices: number[]): void;
  redraw(): void;
  apply(settings: OverviewSettings): void;
}

const SLIDERS: [keyof typeof OVERVIEW_RANGES, string][] = [
  ['nodeSize', 'Node size'],
  ['lineThickness', 'Line thickness'],
  ['centerForce', 'Center force'],
  ['repelForce', 'Repel force'],
  ['linkForce', 'Link force'],
  ['linkDistance', 'Link distance'],
];

/**
 * The vault as a moving graph: every note is a dot, links are lines, and a force simulation settles the clusters. It
 * is drawn on a canvas. The loop stops when the simulation settles, and pauses while the view is off screen.
 */
export function OverviewCanvas({
  load,
  onOpen,
  initial,
  onSettings,
}: {
  load: () => GraphAnalysis | null;
  onOpen: (path: string) => void;
  initial: OverviewSettings;
  onSettings: (settings: OverviewSettings) => void;
}) {
  const [analysis, setAnalysis] = useState<GraphAnalysis | null>(() => load());
  const graph = useMemo<ForceGraph | null>(
    () => (analysis ? buildForceGraph(analysis) : null),
    [analysis],
  );
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [settings, setSettings] = useState(initial);
  const [panelOpen, setPanelOpen] = useState(false);
  const [clustersOpen, setClustersOpen] = useState(false);
  const [allClusters, setAllClusters] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const searchRef = useRef('');
  const onOpenRef = useRef(onOpen);
  const engineRef = useRef<Engine | null>(null);

  useEffect(() => {
    onOpenRef.current = onOpen;
  }, [onOpen]);
  const settingsRef = useRef(settings);
  const onSettingsRef = useRef(onSettings);
  useEffect(() => {
    onSettingsRef.current = onSettings;
  }, [onSettings]);
  // Slider changes move the layout at once and are saved once they stop.
  useEffect(() => {
    settingsRef.current = settings;
    engineRef.current?.apply(settings);
    const timer = window.setTimeout(
      () => onSettingsRef.current(settings),
      SAVE_DELAY_MS,
    );
    return () => window.clearTimeout(timer);
  }, [settings]);
  useEffect(() => {
    searchRef.current = search.trim().toLowerCase();
    engineRef.current?.redraw();
  }, [search]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !graph) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const sim = new ForceSimulation(graph, settingsRef.current);
    let view: ViewTransform = { scale: 1, tx: 0, ty: 0 };
    let width = 0;
    let height = 0;
    let dpr = 1;
    let frame: number | null = null;
    let visible = true;
    let autoFit = true;
    let hovered = -1;
    let dragging = -1;
    let panning = false;
    let moved = false;
    let last = { x: 0, y: 0 };
    let down = { x: 0, y: 0 };

    const local = (event: { clientX: number; clientY: number }) => {
      const rect = canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const toWorld = (x: number, y: number) => ({
      x: (x - view.tx) / view.scale,
      y: (y - view.ty) / view.scale,
    });
    const visibleNode = (i: number) =>
      settingsRef.current.showOrphans || !graph.nodes[i]!.orphan;
    const radius = (i: number) =>
      graph.nodes[i]!.r * settingsRef.current.nodeSize;
    const fitAll = () => {
      const points = graph.nodes
        .map((_, i) => i)
        .filter(visibleNode)
        .map((i) => ({ x: sim.x[i]!, y: sim.y[i]! }));
      view = fitView(points, width, height);
    };
    const hitTest = (wx: number, wy: number) => {
      let best = -1;
      let bestDistance = Infinity;
      graph.nodes.forEach((_, i) => {
        if (!visibleNode(i)) return;
        const distance = Math.hypot(sim.x[i]! - wx, sim.y[i]! - wy);
        const reach = radius(i) + 4 / view.scale;
        if (distance <= reach && distance < bestDistance) {
          best = i;
          bestDistance = distance;
        }
      });
      return best;
    };

    const draw = () => {
      const styles = getComputedStyle(canvas);
      const colour = (name: string, fallback: string) =>
        styles.getPropertyValue(name).trim() || fallback;
      const faint = colour('--text-faint', '#888');
      const normal = colour('--text-normal', '#ddd');
      const accent = colour('--text-accent', '#7aa2f7');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.translate(view.tx, view.ty);
      ctx.scale(view.scale, view.scale);

      const query = searchRef.current;
      const matches = (i: number) =>
        query === '' || graph.nodes[i]!.path.toLowerCase().includes(query);
      const around = hovered >= 0 ? new Set([hovered]) : null;
      if (around && hovered >= 0)
        for (const [a, b] of graph.edges) {
          if (a === hovered) around.add(b);
          if (b === hovered) around.add(a);
        }
      const lit = (i: number) => (!around || around.has(i)) && matches(i);
      const { lineThickness, showLabels } = settingsRef.current;

      ctx.lineWidth = (0.6 * lineThickness) / view.scale;
      ctx.strokeStyle = faint;
      for (const [a, b] of graph.edges) {
        if (!visibleNode(a) || !visibleNode(b)) continue;
        ctx.globalAlpha = lit(a) && lit(b) ? 0.4 : 0.05;
        ctx.beginPath();
        ctx.moveTo(sim.x[a]!, sim.y[a]!);
        ctx.lineTo(sim.x[b]!, sim.y[b]!);
        ctx.stroke();
      }

      graph.nodes.forEach((node, i) => {
        if (!visibleNode(i)) return;
        const x = sim.x[i]!;
        const y = sim.y[i]!;
        ctx.globalAlpha = lit(i) ? 1 : 0.12;
        ctx.fillStyle = node.orphan ? faint : `hsl(${node.hue} 60% 55%)`;
        ctx.beginPath();
        ctx.arc(x, y, radius(i), 0, Math.PI * 2);
        ctx.fill();
        if (node.bridge) {
          ctx.strokeStyle = accent;
          ctx.lineWidth = 1.5 / view.scale;
          ctx.stroke();
        }
      });

      ctx.fillStyle = normal;
      ctx.textAlign = 'center';
      ctx.font = `${12 / view.scale}px sans-serif`;
      const fade = Math.min(
        1,
        Math.max(
          0,
          (view.scale - LABEL_FADE[0]) / (LABEL_FADE[1] - LABEL_FADE[0]),
        ),
      );
      graph.nodes.forEach((node, i) => {
        if (!visibleNode(i)) return;
        const alpha = i === hovered ? 1 : showLabels && lit(i) ? fade : 0;
        if (alpha === 0) return;
        ctx.globalAlpha = alpha;
        ctx.fillText(
          shortTitle(node.path),
          sim.x[i]!,
          sim.y[i]! - radius(i) - 4 / view.scale,
        );
      });
      ctx.globalAlpha = 1;
    };

    const step = () => {
      frame = null;
      if (!visible) return;
      const started = performance.now();
      while (!sim.settled && performance.now() - started < FRAME_BUDGET_MS)
        sim.tick();
      if (autoFit) fitAll();
      draw();
      if (!sim.settled) frame = window.requestAnimationFrame(step);
    };
    const wake = () => {
      if (frame === null && visible) frame = window.requestAnimationFrame(step);
    };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      dpr = window.devicePixelRatio || 1;
      width = rect.width;
      height = rect.height;
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      if (autoFit) fitAll();
      draw();
    };

    const onDown = (event: PointerEvent) => {
      canvas.setPointerCapture(event.pointerId);
      const p = local(event);
      down = p;
      last = p;
      moved = false;
      const w = toWorld(p.x, p.y);
      const hit = hitTest(w.x, w.y);
      if (hit >= 0) {
        dragging = hit;
        sim.pin(hit, w.x, w.y);
        wake();
      } else panning = true;
    };
    const onMove = (event: PointerEvent) => {
      const p = local(event);
      if (Math.hypot(p.x - down.x, p.y - down.y) > DRAG_TOLERANCE_PX)
        moved = true;
      if (dragging >= 0) {
        const w = toWorld(p.x, p.y);
        sim.pin(dragging, w.x, w.y);
        wake();
      } else if (panning) {
        view = {
          ...view,
          tx: view.tx + p.x - last.x,
          ty: view.ty + p.y - last.y,
        };
        autoFit = false;
        draw();
      } else {
        const w = toWorld(p.x, p.y);
        const next = hitTest(w.x, w.y);
        if (next !== hovered) {
          hovered = next;
          setStatus(next >= 0 ? graph.nodes[next]!.path : '');
          draw();
        }
      }
      last = p;
    };
    const onUp = () => {
      if (dragging >= 0) {
        const node = dragging;
        dragging = -1;
        sim.unpin(node);
        if (!moved) onOpenRef.current(graph.nodes[node]!.path);
        wake();
      }
      panning = false;
    };
    const onLeave = () => {
      hovered = -1;
      setStatus('');
      draw();
    };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const p = local(event);
      const scale = Math.min(
        12,
        Math.max(0.05, view.scale * Math.exp(-event.deltaY * 0.0015)),
      );
      const k = scale / view.scale;
      view = {
        scale,
        tx: p.x - (p.x - view.tx) * k,
        ty: p.y - (p.y - view.ty) * k,
      };
      autoFit = false;
      draw();
    };

    engineRef.current = {
      fit() {
        autoFit = true;
        fitAll();
        draw();
      },
      focus(indices) {
        if (indices.length === 0) return;
        const points = indices.map((i) => ({ x: sim.x[i]!, y: sim.y[i]! }));
        view = fitView(points, width, height);
        autoFit = false;
        draw();
      },
      redraw: () => draw(),
      apply(next) {
        sim.setParams(next);
        wake();
      },
    };

    const observer = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? true;
      if (visible) wake();
    });
    observer.observe(canvas);
    const resizer = new ResizeObserver(() => resize());
    resizer.observe(canvas);
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    resize();
    wake();

    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      observer.disconnect();
      resizer.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('wheel', onWheel);
      engineRef.current = null;
    };
  }, [graph]);

  if (!analysis || !graph)
    return (
      <p className="agenthq-overview-empty">
        The vault overview opens once Mesa has loaded your vault.
      </p>
    );

  const query = search.trim().toLowerCase();
  const matchCount =
    query === ''
      ? null
      : graph.nodes.filter((node) => node.path.toLowerCase().includes(query))
          .length;
  const orphans = graph.nodes
    .map((node, i) => (node.orphan ? i : -1))
    .filter((i) => i >= 0);

  return (
    <div className="agenthq-overview-body">
      <div className="agenthq-overview-toolbar">
        <button onClick={() => engineRef.current?.fit()}>Fit</button>
        <button
          onClick={() => {
            setAnalysis(load());
          }}
        >
          Refresh
        </button>
        <input
          type="search"
          className="agenthq-overview-search"
          placeholder="Search notes"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        {matchCount !== null && (
          <span className="agenthq-overview-status">{matchCount} matching</span>
        )}
        <span className="agenthq-overview-status">
          {status ||
            `${graph.total} notes, ${analysis.clusters.length} clusters, ${analysis.orphans.length} orphans`}
        </span>
      </div>
      {settings.showClusterList && (
        <div className="agenthq-overview-legend">
          <button
            className="agenthq-overview-legend-toggle"
            aria-expanded={clustersOpen}
            onClick={() => setClustersOpen(!clustersOpen)}
          >
            Clusters ({graph.clusters.length}) {clustersOpen ? '▴' : '▾'}
          </button>
          {clustersOpen && (
            <div className="agenthq-overview-legend-list">
              {(allClusters
                ? graph.clusters
                : graph.clusters.slice(0, LEGEND_LIMIT)
              ).map((cluster) => (
                <button
                  key={cluster.number}
                  className="agenthq-overview-legend-item"
                  title={cluster.hub}
                  onClick={() => engineRef.current?.focus(cluster.nodes)}
                >
                  <span
                    className="agenthq-overview-swatch"
                    style={{ background: `hsl(${cluster.hue} 60% 55%)` }}
                  />
                  {cluster.name} ({cluster.count})
                </button>
              ))}
              {orphans.length > 0 && (
                <button
                  className="agenthq-overview-legend-item"
                  onClick={() => engineRef.current?.focus(orphans)}
                >
                  <span
                    className="agenthq-overview-swatch"
                    style={{ background: 'var(--text-faint)' }}
                  />
                  Orphans ({orphans.length})
                </button>
              )}
              {graph.clusters.length > LEGEND_LIMIT && (
                <a
                  href="#"
                  className="agenthq-overview-show-all"
                  onClick={(event) => {
                    event.preventDefault();
                    setAllClusters(!allClusters);
                  }}
                >
                  {allClusters ? 'Show fewer' : 'Show all'}
                </a>
              )}
            </div>
          )}
        </div>
      )}
      {graph.nodes.length === 0 ? (
        <p className="agenthq-overview-empty">No notes outside Mesa yet.</p>
      ) : (
        <div className="agenthq-overview-stage">
          <canvas ref={canvasRef} className="agenthq-overview-canvas" />
          <button
            className="agenthq-overview-gear"
            aria-label="Display and forces"
            aria-expanded={panelOpen}
            onClick={() => setPanelOpen(!panelOpen)}
          >
            ⚙
          </button>
          {panelOpen && (
            <div className="agenthq-overview-panel">
              <strong>Display &amp; forces</strong>
              {SLIDERS.map(([key, label]) => (
                <label key={key} className="agenthq-overview-slider">
                  <span>{label}</span>
                  <input
                    type="range"
                    min={OVERVIEW_RANGES[key][0]}
                    max={OVERVIEW_RANGES[key][1]}
                    step={OVERVIEW_RANGES[key][2]}
                    value={settings[key]}
                    onChange={(event) =>
                      setSettings({
                        ...settings,
                        [key]: Number(event.target.value),
                      })
                    }
                  />
                </label>
              ))}
              {(
                [
                  ['showLabels', 'Show labels'],
                  ['showOrphans', 'Show orphans'],
                  ['showClusterList', 'Show cluster list'],
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="agenthq-overview-toggle">
                  <input
                    type="checkbox"
                    checked={settings[key]}
                    onChange={(event) =>
                      setSettings({ ...settings, [key]: event.target.checked })
                    }
                  />
                  {label}
                </label>
              ))}
              <button onClick={() => setSettings(DEFAULT_OVERVIEW)}>
                Reset
              </button>
            </div>
          )}
        </div>
      )}
      {graph.total > graph.nodes.length && (
        <p className="agenthq-overview-empty">
          Showing the {graph.nodes.length} most linked of {graph.total} notes.
          Search finds only the notes shown.
        </p>
      )}
    </div>
  );
}
