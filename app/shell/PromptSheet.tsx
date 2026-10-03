import { useEffect, useState } from "react";

import { api } from "../api.ts";
import { desktop } from "../desktop.ts";
import { Icon } from "../ui/icons.tsx";
import { Button, Sheet } from "../ui/kit.tsx";
import { AGENT_NAMES } from "../../shared/agents.ts";
import type { AgentId } from "../../shared/types.ts";

/**
 * Write with AI: a prompt about one file, to copy into the agent the sidebar
 * shows. The app starts nothing itself; the person pastes it where they work.
 */
export function PromptSheet(props: { path: string; name: string; project: string | null; agent: AgentId; onClose: () => void; onCopied: (agent: string) => void }) {
  const agent = props.agent;
  const [prompt, setPrompt] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let on = true;
    setPrompt(null);
    api
      .post<{ prompt: string }>("/api/prompt", { path: props.path, project: props.project, agent })
      .then((r) => on && setPrompt(r.prompt))
      .catch((e: Error) => on && setErr(e.message));
    return () => {
      on = false;
    };
  }, [props.path, props.project, agent]);

  const name = AGENT_NAMES[agent];
  const copy = async () => {
    if (!prompt) return;
    if (desktop) await desktop.copy(prompt);
    else await navigator.clipboard.writeText(prompt);
    props.onCopied(name);
  };

  return (
    <Sheet
      title="Write with AI"
      subtitle={`A prompt about ${props.name}. Paste it into ${name}.`}
      width="narrow"
      onClose={props.onClose}
      footer={
        <>
          <span className="note" />
          <Button kind="quiet" onClick={props.onClose}>Close</Button>
          <Button kind="primary" disabled={!prompt} onClick={() => void copy()}>
            <Icon.copy />
            Copy prompt
          </Button>
        </>
      }
    >
      {err ? <p className="muted">{err}</p> : <textarea className="field prompt-box" readOnly rows={13} value={prompt ?? "Writing the prompt…"} onFocus={(e) => e.currentTarget.select()} />}
    </Sheet>
  );
}
