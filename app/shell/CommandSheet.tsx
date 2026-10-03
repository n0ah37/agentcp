import { useEffect, useState } from "react";

import type { AgentCommand, AgentCommandResult } from "../../shared/types.ts";
import { ApiError, api } from "../api.ts";
import { refreshAll } from "../store.ts";
import { Button, Sheet } from "../ui/kit.tsx";
import { useApp } from "./app-context.ts";

/**
 * Runs one of Claude Code's own commands for plugins and MCP servers: it shows
 * the command first (secret values hidden), what History keeps and how to undo
 * it, then runs it and says what Claude Code answered.
 */
export function CommandSheet(props: { title: string; command: AgentCommand; action: string; onClose: () => void; onDone?: () => void }) {
  const { project, prefs, setPrefs, toast } = useApp();
  const [about, setAbout] = useState<AgentCommandResult | null>(null);
  const [result, setResult] = useState<AgentCommandResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const key = JSON.stringify(props.command);
  useEffect(() => {
    api
      .post<AgentCommandResult>("/api/agent/command", { project, command: JSON.parse(key) as AgentCommand })
      .then(setAbout)
      .catch((e: unknown) => setError(e instanceof ApiError ? e.message : String(e)));
  }, [project, key]);

  const run = async () => {
    setBusy(true);
    try {
      if (!prefs?.allowEdits) await setPrefs({ allowEdits: true });
      const r = await api.post<AgentCommandResult>("/api/agent/command", { project, command: props.command, run: true });
      refreshAll();
      if (r.ok) {
        toast({ text: r.output ?? "Done." });
        props.onDone?.();
        props.onClose();
      } else setResult(r);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const note = error ?? (result ? "" : !prefs?.allowEdits ? "Editing is off. Running it turns it on." : about?.history || "");
  return (
    <Sheet
      title={props.title}
      width="narrow"
      onClose={props.onClose}
      footer={
        <>
          <span className={`note ${error ? "warn" : ""}`}>{note}</span>
          <Button kind="quiet" onClick={props.onClose}>{result ? "Close" : "Cancel"}</Button>
          {!result && (
            <Button kind="primary" disabled={!about || busy || !!error} onClick={() => void run()}>
              {busy ? "Running…" : props.action}
            </Button>
          )}
        </>
      }
    >
      <div className="command">
        {result ? (
          <>
            <p className="bad">Claude Code didn't do it.</p>
            <pre className="command-out">{result.output}</pre>
          </>
        ) : (
          <>
            <p>AgentCP runs this Claude Code command:</p>
            <pre className="command-line">{about?.command ?? "…"}</pre>
            {about?.undo && <p className="faint">{about.undo}</p>}
          </>
        )}
      </div>
    </Sheet>
  );
}
