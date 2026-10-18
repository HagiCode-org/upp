// Chart geometry for the data wall. d3 only runs at build time: it produces numbers and path strings,
// and the pages ship static SVG. Axis labels are HTML positioned by the percentages returned here,
// so text stays readable at any panel width while the marks scale with the viewBox.
import { scaleLinear, scaleLog, scaleUtc } from 'd3-scale';
import { area, curveStepAfter, line } from 'd3-shape';
import { clockUtc, formatMs } from './wall.mjs';

const round = (value) => Math.round(value * 100) / 100;

function pct(value, total) {
  return round((100 * value) / total);
}

// Runs further apart than the freshness threshold are drawn as separate segments: a gap is a gap, not a held value.
function segments(runs, gapMs) {
  const result = [];
  let current = [];
  for (const run of runs) {
    if (current.length > 0 && run.at - current[current.length - 1].at > gapMs) {
      result.push(current);
      current = [];
    }
    current.push(run);
  }
  if (current.length > 0) {
    result.push(current);
  }
  return result;
}

function niceCeil(value) {
  const steps = [100, 200, 300, 500, 1000, 1500, 2000, 3000, 5000, 10_000];
  return steps.find((step) => step >= value) ?? Math.ceil(value / 1000) * 1000;
}

export const PULSE = Object.freeze({ width: 720, height: 244 });

// Latency band and median across the whole fleet per run, with a lane of probes-down counts under the same time axis.
export function pulseChart(runs, { gapSeconds = 900 } = {}) {
  const { width, height } = PULSE;
  const left = 16;
  const right = width - 12;
  const topPlot = 26;
  const bottomPlot = 148;
  const laneTop = 176;
  const laneBottom = 212;

  const first = runs[0]?.at ?? Date.now();
  const last = runs[runs.length - 1]?.at ?? first;
  // One run still needs an axis: show the hour before it so the point sits at the right edge.
  const domain = runs.length > 1 ? [first, last] : [first - 3_600_000, last];
  const x = scaleUtc().domain(domain).range([left, right]);

  const peak = Math.max(0, ...runs.map((run) => run.highMs ?? 0));
  const yMax = niceCeil(Math.max(peak, 100));
  const y = scaleLinear().domain([0, yMax]).range([bottomPlot, topPlot]);

  const maxDown = Math.max(0, ...runs.map((run) => run.down));
  const lane = scaleLinear().domain([0, Math.max(maxDown, 1)]).range([laneBottom, laneTop + 4]);

  let minGap = Infinity;
  for (let index = 1; index < runs.length; index += 1) {
    minGap = Math.min(minGap, x(runs[index].at) - x(runs[index - 1].at));
  }
  const barWidth = Math.max(3, Math.min(12, Number.isFinite(minGap) ? minGap - 3 : 12));

  const measured = runs.filter((run) => run.medianMs !== null);
  const parts = segments(measured, gapSeconds * 1000);
  const medianLine = line().x((run) => x(run.at)).y((run) => y(run.medianMs)).curve(curveStepAfter);
  const band = area().x((run) => x(run.at)).y0((run) => y(run.lowMs)).y1((run) => y(run.highMs)).curve(curveStepAfter);

  const yTicks = [0, yMax / 2, yMax].map((value) => ({
    value,
    label: value === 0 ? '0' : formatMs(value),
    y: round(y(value)),
    top: pct(y(value), height),
  }));
  const tickValues = runs.length > 1 ? x.ticks(5) : [new Date(last)];
  const xTicks = tickValues.map((date) => ({ label: `${clockUtc(date.getTime())}`, left: pct(x(date), width) }));

  return {
    width,
    height,
    left,
    right,
    topPlot,
    bottomPlot,
    laneTop,
    laneBottom,
    yMax,
    maxDown,
    barWidth,
    yTicks,
    xTicks,
    // The step curve ends at the last run's value; the final segment needs no extra stub.
    medianPaths: parts.map((part) => medianLine(part)).filter(Boolean),
    bandPaths: parts.filter((part) => part.length > 1).map((part) => band(part)).filter(Boolean),
    columns: runs.map((run) => {
      const cx = x(run.at);
      return {
        run,
        x: round(cx),
        barX: round(cx - barWidth / 2),
        medianY: run.medianMs === null ? null : round(y(run.medianMs)),
        downY: run.down === 0 ? round(laneBottom - 2) : round(Math.min(lane(run.down), laneBottom - 4)),
        downHeight: run.down === 0 ? 2 : round(laneBottom - Math.min(lane(run.down), laneBottom - 4)),
        hitX: round(Math.max(left - 4, cx - Math.max(barWidth, 8))),
        hitWidth: round(Math.max(barWidth, 8) * 2),
        label: pulseLabel(run),
      };
    }),
    laneLabel: { top: pct(laneTop - 2, height), maxLabel: String(Math.max(maxDown, 1)), maxTop: pct(laneTop + 4, height) },
  };
}

export function pulseLabel(run) {
  const probes = `${run.total} probe${run.total === 1 ? '' : 's'}`;
  const down = run.down === 0 ? 'none down' : `${run.down} down`;
  const median = run.medianMs === null ? 'no response times' : `median ${formatMs(run.medianMs)}`;
  return `${clockUtc(run.at)} UTC · ${probes}, ${down}, ${median}`;
}

export const LANES = Object.freeze({ width: 720, laneHeight: 40, labelHeight: 22, axisHeight: 28 });

// Places dots at their latency on a log axis and nudges neighbours onto free rows, so overlapping probes stay countable.
function swarm(points, radius, maxOffset) {
  const placed = [];
  const step = radius * 2 + 1;
  const candidates = [0];
  for (let row = 1; row * step <= maxOffset; row += 1) {
    candidates.push(row * step, -row * step);
  }
  for (const point of [...points].sort((a, b) => a.x - b.x)) {
    const free = candidates.find((offset) =>
      placed.every((other) => Math.hypot(other.x - point.x, other.offset - offset) >= step),
    );
    // A crowded lane falls back to a stable offset derived from the id rather than hiding a dot.
    point.offset = free ?? ((hash(point.id) % 5) - 2) * (maxOffset / 2.5);
    placed.push(point);
  }
  return points;
}

function hash(text) {
  let value = 0;
  for (const character of text) {
    value = (value * 31 + character.charCodeAt(0)) >>> 0;
  }
  return value;
}

// One lane per endpoint kind on a shared log axis. A probe that answered nothing sits in a "no response" gutter.
export function laneChart(lanes) {
  const { width, laneHeight, labelHeight, axisHeight } = LANES;
  const radius = 4.5;
  const gutter = 52;
  const left = 14;
  const right = width - gutter - 10;
  const all = lanes.flatMap((lane) => lane.probes).filter((probe) => probe.ms !== null).map((probe) => probe.ms);
  const lo = Math.max(1, Math.min(60, all.length > 0 ? Math.floor(Math.min(...all) * 0.85) : 60));
  const hi = Math.max(3000, all.length > 0 ? Math.ceil(Math.max(...all) * 1.15) : 3000);
  const x = scaleLog().domain([lo, hi]).range([left, right]);
  const blockHeight = labelHeight + laneHeight;
  const height = blockHeight * lanes.length + axisHeight;
  const gutterX = width - gutter / 2 - 4;

  const ticks = [100, 300, 1000, 3000, 10_000].filter((value) => value >= lo && value <= hi);
  const axisTop = blockHeight * lanes.length;

  return {
    width,
    height,
    radius,
    gutterX: round(gutterX),
    axisTop,
    ticks: ticks.map((value) => ({ value, label: formatMs(value), x: round(x(value)), left: pct(x(value), width) })),
    gutterLeft: pct(gutterX, width),
    lanes: lanes.map((lane, index) => {
      const top = index * blockHeight;
      const mid = top + labelHeight + laneHeight / 2;
      const measured = lane.probes.filter((probe) => probe.ms !== null);
      const dots = swarm(
        measured.map((probe) => ({ ...probe, x: x(probe.ms) })),
        radius,
        laneHeight / 2 - radius - 1,
      ).map((dot) => ({ ...dot, cx: round(dot.x), cy: round(mid + dot.offset) }));
      const silent = lane.probes.filter((probe) => probe.ms === null).map((probe, order) => ({
        ...probe,
        cx: round(gutterX),
        cy: round(mid + (order % 3 - 1) * (radius * 2 + 1)),
      }));
      return {
        ...lane,
        top,
        mid,
        labelTop: pct(top, height),
        median: lane.medianMs === null ? null : { x: round(x(lane.medianMs)), left: pct(x(lane.medianMs), width) },
        dots,
        silent,
      };
    }),
  };
}
