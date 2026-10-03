import { useMemo, useState } from "react";

import type { HookEntry, HookEvent, HooksView } from "../../shared/types.ts";
import { useAgent } from "../agent.ts";
import { ApiError, api, qs } from "../api.ts";
import { useParams } from "../router.ts";
import { useResource } from "../store.ts";
import { Icon } from "../ui/icons.tsx";
import { Button, DocLink, Empty, Sheet } from "../ui/kit.tsx";
import { useApp } from "../shell/app-context.ts";

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Hooks: commands the agent runs itself at fixed points, such as before a tool
 * call or when it finishes answering. What each event is, what its matcher is
 * tested against and whether a hook can stop it come from the agent's own
 * docs; adding or removing a hook is a reviewed write to the file it lives in.
 */
export function Hooks() {
  const { project, save, toast, openDoc, prefs } = useApp();
  const [params, setParams] = useParams();
  const agent = useAgent();
  const { data: view, error, reload } = useResource<HooksView>(`/api/hooks${qs({ project, agent })}`);
  const [adding, setAdding] = useState(false);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of view?.entries ?? []) m.set(e.event, (m.get(e.event) ?? 0) + 1);
    return m;
  }, [view]);

  if (error) return <Empty title="Hooks couldn't be read.">{error.message}</Empty>;
  if (!view) return <p className="loading">Reading hooks…</p>;

  const used = view.events.filter((e) => counts.has(e.name));
  const rest = view.events.filter((e) => !counts.has(e.name));
  // Hooks set for an event the docs don't list: a typo, or an event newer than the docs.
  const unknown = [...counts.keys()].filter((n) => !view.events.some((e) => e.name === n));
  const chosen = params.get("event") ?? used[0]?.name ?? view.events.find((e) => e.name === "PreToolUse")?.name ?? view.events[0]?.name;
  const event = view.events.find((e) => e.name === chosen);
  const here = view.entries.filter((e) => e.event === chosen);
  const writable = view.files.filter((f) => f.writable);
  const name = agent === "codex" ? "Codex" : "Claude Code";

  const plan = async (body: Record<string, unknown>, title: string) => {
    try {
      const planned = await api.post<{ path: string; content: string; baseHash: string | null }>("/api/hooks/plan", body);
      save({ path: planned.path, content: planned.content, baseHash: planned.baseHash, project, title, onSaved: () => void reload() });
    } catch (e) {
      toast({ text: e instanceof ApiError ? e.message : String(e), tone: "bad" });
    }
  };

  return (
    <>
      <header className="head">
        <div className="head-text">
          <h1>Hooks</h1>
        </div>
        <div className="head-actions">
          <Button small onClick={() => setAdding(true)} disabled={!writable.length}>
            <Icon.plus />
            Add hook
          </Button>
        </div>
      </header>
      <div className="body two">
        <nav className="pane list" aria-label="Events">
          {view.enabled === false && <p className="banner warn">Hooks are off in your Codex config ([features] hooks = false).</p>}
          {(
            [
              ["In use", [...used.map((e) => e.name), ...unknown]],
              ["Other events", rest.map((e) => e.name)],
            ] as [string, string[]][]
          ).map(([label, names]) =>
            names.length ? (
              <div className="group" key={label}>
                <div className="group-h"><h2>{label}</h2></div>
                {names.map((n) => {
                  const ev = view.events.find((e) => e.name === n);
                  return (
                    <button key={n} type="button" className="item" aria-selected={n === chosen} onClick={() => setParams({ event: n })}>
                      <span className="dot" style={{ ["--c" as string]: counts.has(n) ? "var(--sage)" : "var(--rule)" }} />
                      <span className="t">{n}</span>
                      <span className="m">{counts.get(n) ?? ""}</span>
                      <span className="s">{ev?.summary ?? "Not in the docs"}</span>
                    </button>
                  );
                })}
              </div>
            ) : null,
          )}
        </nav>
        <section className="pane hooks">
          <EventAbout name={chosen ?? ""} event={event} agent={name} onOpenDoc={openDoc} />
          <div className="hooks-list">
            <div className="hooks-list-h">
              <h3>{here.length ? `${here.length} hook${here.length === 1 ? "" : "s"}` : "No hooks yet"}</h3>
              <Button small kind="quiet" onClick={() => setAdding(true)} disabled={!writable.length}>
                <Icon.plus />
                Add
              </Button>
            </div>
            {here.map((h) => (
              <HookCard
                key={h.id}
                h={h}
                matcherOn={event?.matcher?.on ?? null}
                canRemove={!!prefs?.allowEdits && !!view.files.find((f) => f.path === h.file)?.writable}
                onRemove={() => void plan({ file: h.file, event: h.event, remove: { group: h.group, index: h.index } }, `Remove this ${h.event} hook?`)}
              />
            ))}
          </div>
          <div className="hooks-foot">
            <p>
              {name} reads hooks from {view.sources}
            </p>
            {view.notes.map((n) => (
              <p key={n.text}>
                {n.text} <DocLink doc={n.doc} onOpen={openDoc} label="Docs" />
              </p>
            ))}
          </div>
        </section>
      </div>
      {adding && chosen && (
        <AddHook
          events={view.events}
          event={chosen}
          files={writable}
          onClose={() => setAdding(false)}
          onAdd={(ev, file, matcher, command, timeout) => {
            setAdding(false);
            setParams({ event: ev });
            void plan({ file, event: ev, add: { matcher, command, timeout } }, `Add a ${ev} hook?`);
          }}
        />
      )}
    </>
  );
}

/** What one event is, in the docs' words: when it fires, what its matcher sees, and whether a hook can stop it. */
function EventAbout({ name, event, agent, onOpenDoc }: { name: string; event: HookEvent | undefined; agent: string; onOpenDoc: (d: HookEvent["doc"]) => void }) {
  if (!event) {
    return (
      <div className="hooks-h">
        <h2>{name}</h2>
        <p>{agent}'s docs don't list this event, so these hooks may never run. Check the spelling.</p>
      </div>
    );
  }
  return (
    <div className="hooks-h">
      <h2>{event.name}</h2>
      <p>{event.summary}</p>
      {event.detail.length > 0 && <p className="more">{event.detail.join(" ")}</p>}
      <dl className="ev-facts">
        <div>
          <dt>Matches on</dt>
          <dd>
            {event.matcher ? (
              <>
                {cap(event.matcher.on)}
                {event.matcher.examples.length > 0 && (
                  <span className="chips">
                    {event.matcher.examples.slice(0, 8).map((x) => (
                      <code key={x} className="chip">{x}</code>
                    ))}
                  </span>
                )}
              </>
            ) : (
              "Nothing. It runs every time."
            )}
          </dd>
        </div>
        {event.block && (
          <div>
            <dt>Can block</dt>
            <dd>{event.block.can ? `Yes. ${event.block.what}` : `No. ${event.block.what}`}</dd>
          </div>
        )}
      </dl>
      <DocLink doc={event.doc} onOpen={onOpenDoc} label={`${event.name} in ${agent}'s docs`} />
    </div>
  );
}

function HookCard({ h, matcherOn, canRemove, onRemove }: { h: HookEntry; matcherOn: string | null; canRemove: boolean; onRemove: () => void }) {
  const values = h.matcher ? h.matcher.split(/[|,]/).map((s) => s.trim()).filter(Boolean) : [];
  return (
    <div className="card hook">
      <div className="hook-top">
        <span className="hook-when">{values.length ? `${cap(matcherOn ?? "matches")}:` : "Every time"}</span>
        {values.length > 0 && (
          <span className="chips">
            {values.map((v) => (
              <code key={v} className="chip">{v}</code>
            ))}
          </span>
        )}
        <span className="grow" />
        {canRemove && (
          <Button small kind="quiet" onClick={onRemove}>
            <Icon.trash />
            Remove
          </Button>
        )}
      </div>
      <code className="hook-run">{h.run || "(nothing to run)"}</code>
      <p className="hook-file">
        {h.type !== "command" && <span className="tag">{h.type}</span>}
        {h.timeout && <span className="tag">{h.timeout} s limit</span>}
        <span>{h.fileLabel} · {h.fileDisplay}</span>
      </p>
    </div>
  );
}

function AddHook(props: { events: HookEvent[]; event: string; files: HooksView["files"]; onAdd: (event: string, file: string, matcher: string | null, command: string, timeout: number | null) => void; onClose: () => void }) {
  const [event, setEvent] = useState(props.event);
  const [file, setFile] = useState(props.files.find((f) => f.scope === "user")?.path ?? props.files[0]?.path ?? "");
  const [matcher, setMatcher] = useState("");
  const [command, setCommand] = useState("");
  const [timeout, setTimeoutV] = useState("");
  const ev = props.events.find((e) => e.name === event);
  const submit = () => command.trim() && props.onAdd(event, file, matcher.trim() || null, command.trim(), timeout ? Number(timeout) : null);
  return (
    <Sheet
      title="Add a hook"
      subtitle={ev?.summary}
      width="narrow"
      onClose={props.onClose}
      footer={
        <>
          <span className="note">Next, review the change to the file.</span>
          <Button kind="quiet" onClick={props.onClose}>Cancel</Button>
          <Button kind="primary" disabled={!command.trim()} onClick={submit}>Review</Button>
        </>
      }
    >
      <form className="form" onSubmit={(e) => (e.preventDefault(), submit())}>
        <label>
          <span>Event</span>
          <select className="select" value={event} onChange={(e) => (setEvent(e.target.value), setMatcher(""))}>
            {props.events.map((e) => <option key={e.name} value={e.name}>{e.name}</option>)}
          </select>
        </label>
        <label>
          <span>Command</span>
          <input className="field mono" data-autofocus placeholder="./scripts/check.sh" value={command} onChange={(e) => setCommand(e.target.value)} />
        </label>
        {ev?.matcher && (
          <label>
            <span>Only for · {ev.matcher.on}</span>
            <input className="field mono" placeholder="Leave empty for every one" value={matcher} onChange={(e) => setMatcher(e.target.value)} />
            {ev.matcher.examples.length > 0 && (
              <span className="chips">
                {ev.matcher.examples.slice(0, 8).map((x) => (
                  <button key={x} type="button" className="chip" onClick={() => setMatcher((m) => (m ? `${m}|${x}` : x))}>{x}</button>
                ))}
              </span>
            )}
          </label>
        )}
        <div className="row2">
          <label>
            <span>Time limit (seconds)</span>
            <input className="field" inputMode="numeric" placeholder="Default" value={timeout} onChange={(e) => setTimeoutV(e.target.value.replace(/\D/g, ""))} />
          </label>
          <label>
            <span>Save in</span>
            <select className="select" value={file} onChange={(e) => setFile(e.target.value)}>
              {props.files.map((f) => <option key={f.path} value={f.path}>{f.label}</option>)}
            </select>
          </label>
        </div>
      </form>
    </Sheet>
  );
}
