import { useMemo } from "react";
import { createTwoFilesPatch } from "diff";

import type { HistoryEntry } from "../../shared/types.ts";
import { useParams } from "../router.ts";
import { useResource } from "../store.ts";
import { Button, Diff, Empty, bytes, when } from "../ui/kit.tsx";
import { useApp } from "../shell/app-context.ts";

const VERB: Record<HistoryEntry["action"], string> = { save: "Saved", create: "Created", delete: "Deleted", restore: "Restored" };

export function History() {
  const [params, setParams] = useParams();
  const { data: entries, error } = useResource<HistoryEntry[]>("/api/history");

  if (error) return <Empty title="History couldn't be read.">{error.message}</Empty>;
  if (!entries) return <p className="loading">Reading history…</p>;

  const selected = entries.find((e) => e.id === params.get("id")) ?? entries[0];

  return (
    <>
      <header className="head">
        <div className="head-text">
          <h1>History</h1>
        </div>
      </header>
      {entries.length === 0 && (
        <div className="body one">
          <Empty title="No changes yet">Every save, new file and deletion made here shows up in this list, with the file as it was before, so you can put it back.</Empty>
        </div>
      )}
      {entries.length > 0 && (
        <div className="body two">
          <nav className="pane list" aria-label="Changes">
            {entries.map((e) => (
              <button key={e.id} type="button" className="item hist-row" aria-selected={selected?.id === e.id} onClick={() => setParams({ id: e.id })} title={e.display}>
                <span className="dot" style={{ ["--c" as string]: e.action === "delete" ? "var(--pencil)" : e.action === "create" ? "var(--sage)" : "var(--graphite)" }} />
                <span className="t">{VERB[e.action]} {e.display.split("/").pop()}</span>
                <span className="m">{when(e.at)}</span>
                <span className="s">{e.display}</span>
              </button>
            ))}
          </nav>
          {selected && <Detail key={selected.id} entry={selected} />}
        </div>
      )}
    </>
  );
}

function Detail({ entry }: { entry: HistoryEntry }) {
  const { save, project } = useApp();
  const { data } = useResource<{ entry: HistoryEntry; before: string | null; current: string | null; currentHash: string | null }>(`/api/history/entry?id=${encodeURIComponent(entry.id)}`);
  const patch = useMemo(() => {
    if (!data) return "";
    return createTwoFilesPatch("before", "now", data.before ?? "", data.current ?? "", "", "", { context: 3 });
  }, [data]);
  const name = entry.display.split("/").pop();

  const undo = () => {
    if (!data) return;
    save({
      path: entry.path,
      content: data.before,
      baseHash: data.currentHash,
      project,
      title: data.before === null ? `Remove ${name} again?` : `Put back ${name} as it was before this change?`,
      verb: data.before === null ? "Remove" : "Restore",
    });
  };

  return (
    <section className="pane center">
      <div className="toolbar">
        <div className="file">
          <b>{VERB[entry.action]} {name}</b>
          <span>{new Date(entry.at).toLocaleString()} · {entry.display}</span>
        </div>
        <Button kind="primary" onClick={undo} disabled={!data || (data.before === (data.current ?? null))}>
          {data?.before === null ? "Remove this file" : "Restore this version"}
        </Button>
      </div>
      <div className="hist-body">
        {!data ? (
          <p className="muted">Comparing…</p>
        ) : data.before === data.current ? (
          <p className="muted">The file on disk is the same as the version before this change.</p>
        ) : (
          <>
            <p className="diffsum">
              <span>
                From the version before this change ({data.before === null ? "no file" : bytes(new Blob([data.before]).size)}) to the file on disk now ({data.current === null ? "no file" : bytes(new Blob([data.current]).size)}).
              </span>
            </p>
            <Diff patch={patch} />
          </>
        )}
      </div>
    </section>
  );
}
