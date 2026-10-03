import { useMemo, useState } from "react";

import type { UsageRow, UsageView } from "../../shared/types.ts";
import { agentName } from "../agent.ts";
import { qs } from "../api.ts";
import { useParams } from "../router.ts";
import { useResource } from "../store.ts";
import { Empty, plural } from "../ui/kit.tsx";
import { WhoFilter, useEveryone, useWho } from "../ui/who.tsx";
import { useApp } from "../shell/app-context.ts";

/**
 * Tokens the agents used, from the usage each one records with every reply in
 * its own session files, subagents included. Fresh input, output, and the
 * prompt cache's reads and writes are kept apart, because they cost
 * differently and the cache is usually most of it.
 */

const RANGES = [
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 365, label: "Year" },
] as const;

const total = (r: UsageRow) => r.input + r.output + r.cacheRead + r.cacheWrite;

export function short(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
  return String(n);
}

const dayName = (iso: string, opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }) => new Date(iso + "T12:00:00").toLocaleDateString(undefined, opts);

export function Usage() {
  const { project, projectRef } = useApp();
  const [params, setParams] = useParams();
  const who = useWho(params);
  const everyone = useEveryone();
  const days = RANGES.some((r) => String(r.days) === params.get("days")) ? Number(params.get("days")) : 90;
  const scope = params.get("scope") === "project" && project ? project : null;
  const { data, error } = useResource<UsageView>(`/api/usage${qs({ agent: who, days: String(days), project: scope })}`);
  const name = who ? agentName(who) : everyone;

  if (error) return <Empty title="Usage couldn't be read.">{error.message}</Empty>;

  const t = data?.totals;
  const inputSide = t ? t.input + t.cacheRead + t.cacheWrite : 0;
  const cacheShare = t && inputSide ? Math.round((t.cacheRead / inputSide) * 100) : 0;
  const busiest = data?.byDay.reduce((a, b) => (total(b) > total(a) ? b : a), data.byDay[0]);

  return (
    <>
      <header className="head">
        <div className="head-text">
          <h1>Usage</h1>
        </div>
        <div className="head-actions">
          <WhoFilter who={who} onPick={(a) => setParams({ who: a })} />
          <select className="select" value={scope ? "project" : "all"} onChange={(e) => setParams({ scope: e.target.value === "project" ? "project" : null })} aria-label="Projects">
            <option value="all">All projects</option>
            {projectRef && <option value="project">{projectRef.name}</option>}
          </select>
          <div className="seg" role="group" aria-label="Range">
            {RANGES.map((r) => (
              <button key={r.days} type="button" aria-pressed={days === r.days} onClick={() => setParams({ days: r.days === 90 ? null : String(r.days) })}>
                {r.label}
              </button>
            ))}
          </div>
        </div>
      </header>
      <div className="body one">
        <div className="pane usage">
          {data?.problem && <p className="banner warn">{data.problem}</p>}
          {!data ? (
            <div className="card usage-wait">
              <span className="spin" />
              Reading session files… The first time takes a little while.
            </div>
          ) : !data.totals.sessions ? (
            <Empty title={`No sessions from ${name} in this range.`}>Usage comes from the token counts each agent writes into its own session files.</Empty>
          ) : (
            <>
              <div className="kpis">
                <Kpi label="Tokens" value={short(total(data.totals))} note="Input and output together" />
                <Kpi label="Sessions" value={data.totals.sessions.toLocaleString()} note={plural(data.prompts, "prompt")} />
                <Kpi label="From the cache" value={`${cacheShare}%`} note="of everything sent" tone={cacheShare >= 70 ? "on" : undefined} />
                <Kpi label="Busiest day" value={busiest && total(busiest) ? short(total(busiest)) : "—"} note={busiest ? dayName(busiest.label, { weekday: "short", month: "short", day: "numeric" }) : ""} />
              </div>

              <Heatmap year={data.year} />

              <Daily rows={data.byDay} />

              <div className="twocol">
                <Table title="By model" rows={data.byModel} />
                <Table title="By folder" rows={data.byProject} />
              </div>

            </>
          )}
        </div>
      </div>
    </>
  );
}

/** A year of days as a grid, a column per week, darker for busier days, like a GitHub profile. */
function Heatmap({ year }: { year: UsageView["year"] }) {
  const { cells, weeks, months, levels, active, sum } = useMemo(() => {
    // Weeks start on Sunday, and the grid starts on the first full one, so no column sticks out on the left.
    const skip = (7 - new Date(year[0].day + "T12:00:00").getDay()) % 7;
    const days = year.slice(skip);
    const cells = days.map((d, i) => ({ ...d, col: Math.floor(i / 7), row: i % 7 }));
    const nonzero = days.map((d) => d.tokens).filter((n) => n > 0).sort((a, b) => a - b);
    const q = (p: number) => nonzero[Math.min(nonzero.length - 1, Math.floor(p * nonzero.length))] ?? 0;
    const months: { col: number; label: string }[] = [];
    for (const c of cells) {
      if (new Date(c.day + "T12:00:00").getDate() !== 1) continue;
      months.push({ col: c.row === 0 ? c.col : c.col + 1, label: dayName(c.day, { month: "short" }) });
    }
    return { cells, weeks: cells[cells.length - 1].col + 1, months, levels: [q(0.25), q(0.5), q(0.75)], active: nonzero.length, sum: nonzero.reduce((a, b) => a + b, 0) };
  }, [year]);
  const [hover, setHover] = useState<UsageView["year"][number] | null>(null);
  const level = (n: number) => (n <= 0 ? 0 : n <= levels[0] ? 1 : n <= levels[1] ? 2 : n <= levels[2] ? 3 : 4);
  return (
    <section className="card">
      <div className="card-h">
        <h2>Last year</h2>
      </div>
      <div className="heat-wrap">
        <div className="heat" style={{ gridTemplateColumns: `28px repeat(${weeks}, minmax(0, 1fr))` }} onMouseLeave={() => setHover(null)}>
          {months.map((m) => (
            <span key={m.col} className="heat-m" style={{ gridColumn: m.col + 2, gridRow: 1 }}>{m.label}</span>
          ))}
          {["Mon", "Wed", "Fri"].map((d, i) => (
            <span key={d} className="heat-d" style={{ gridColumn: 1, gridRow: i * 2 + 3 }}>{d}</span>
          ))}
          {cells.map((c) => (
            <i key={c.day} className={`l${level(c.tokens)}`} style={{ gridColumn: c.col + 2, gridRow: c.row + 2 }} onMouseEnter={() => setHover(c)} />
          ))}
        </div>
      </div>
      <div className="heat-foot">
        <span>{hover ? `${dayName(hover.day, { weekday: "long", month: "long", day: "numeric" })}: ${hover.tokens ? `${short(hover.tokens)} tokens` : "nothing"}` : `${short(sum)} tokens on ${plural(active, "day")}`}</span>
        <span className="heat-legend">
          Less <i className="l0" /><i className="l1" /><i className="l2" /><i className="l3" /><i className="l4" /> More
        </span>
      </div>
    </section>
  );
}

/** Tokens each day in the range, stacked by kind, on a labelled scale. */
function Daily({ rows }: { rows: UsageRow[] }) {
  const peak = Math.max(1, ...rows.map(total));
  const [hover, setHover] = useState<UsageRow | null>(null);
  const ticks = [1, 0.5, 0];
  const step = Math.max(1, Math.round(rows.length / 6));
  return (
    <section className="card chart">
      <div className="card-h">
        <h2>{hover ? `${dayName(hover.label, { weekday: "short", month: "short", day: "numeric" })}: ${short(total(hover))} tokens · ${short(hover.cacheRead)} from the cache · ${short(hover.output)} output` : "Each day"}</h2>
        <div className="legend">
          <span className="k read">Cache reads</span>
          <span className="k write">Cache writes</span>
          <span className="k in">Fresh input</span>
          <span className="k out">Output</span>
        </div>
      </div>
      <div className="daily">
        <div className="yaxis">
          {ticks.map((t) => (
            <span key={t}>{t ? short(peak * t) : "0"}</span>
          ))}
        </div>
        <div className="plot" onMouseLeave={() => setHover(null)}>
          {ticks.map((t) => (
            <i key={t} className="grid" style={{ bottom: `${t * 100}%` }} />
          ))}
          <div className="bars" role="img" aria-label="Tokens each day">
            {rows.map((d) => (
              <div key={d.label} className={`bar ${hover === d ? "on" : ""}`} onMouseEnter={() => setHover(d)}>
                <div className="stack" style={{ height: `${(total(d) / peak) * 100}%` }}>
                  <i className="out" style={{ flexGrow: d.output }} />
                  <i className="in" style={{ flexGrow: d.input }} />
                  <i className="write" style={{ flexGrow: d.cacheWrite }} />
                  <i className="read" style={{ flexGrow: d.cacheRead }} />
                </div>
              </div>
            ))}
          </div>
          <div className="axis">
            {rows.map((d, i) => (
              <span key={d.label}>{i % step === 0 ? dayName(d.label) : ""}</span>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function Kpi({ label, value, note, tone }: { label: string; value: string; note: string; tone?: "on" }) {
  return (
    <div className={`card kpi ${tone ?? ""}`}>
      <span className="kl">{label}</span>
      <b className="num">{value}</b>
      <span className="kn">{note}</span>
    </div>
  );
}

function Table({ title, rows }: { title: string; rows: UsageRow[] }) {
  const max = Math.max(1, ...rows.map(total));
  return (
    <section className="card">
      <div className="card-h"><h2>{title}</h2></div>
      <div className="utable">
        {rows.map((r) => (
          <div key={r.label} className="urow">
            <span className="ul">{r.label}</span>
            <span className="ub"><i style={{ width: `${(total(r) / max) * 100}%` }} /></span>
            <span className="uv num">{short(total(r))}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
