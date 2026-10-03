import { useEffect, useState } from "react";

import type { RenamePlan } from "../../shared/types.ts";
import { api } from "../api.ts";
import { Button, Sheet } from "../ui/kit.tsx";
import type { MenuFile } from "./app-context.ts";

/**
 * Rename a file in its folder. The ending stays, so the agent still reads it;
 * the name is checked as you type, and a memory file's line in MEMORY.md is
 * rewritten with it. History can undo both.
 */
export function RenameSheet(props: {
  file: MenuFile;
  project: string | null;
  editsOn: boolean;
  onTurnOnEdits: () => Promise<void>;
  onClose: () => void;
  onDone: (r: RenamePlan) => void;
  onError: (e: unknown) => void;
}) {
  const f = props.file;
  const ext = /\.[^.]+$/.exec(f.name)?.[0] ?? "";
  const [name, setName] = useState(f.name.slice(0, f.name.length - ext.length));
  const [plan, setPlan] = useState<RenamePlan | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let on = true;
    api
      .post<RenamePlan>("/api/rename/plan", { from: f.path, name: name + ext, project: props.project })
      .then((p) => on && setPlan(p))
      .catch(props.onError);
    return () => {
      on = false;
    };
    // Checked again on every change of name.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  const submit = async () => {
    if (!plan || plan.refusal || busy) return;
    setBusy(true);
    try {
      if (!props.editsOn) await props.onTurnOnEdits();
      props.onDone(await api.post<RenamePlan>("/api/rename", { from: f.path, name: name + ext, baseHash: f.hash, project: props.project }));
    } catch (e) {
      props.onError(e);
    } finally {
      setBusy(false);
    }
  };

  const note = plan?.refusal ?? (plan?.alsoUpdates.length ? `Also updates its line in ${plan.alsoUpdates.map((u) => u.split("/").pop()).join(", ")}.` : !props.editsOn ? "Editing is off. Renaming turns it on." : "History can undo it.");
  return (
    <Sheet
      title={`Rename ${f.name}`}
      width="narrow"
      onClose={props.onClose}
      footer={
        <>
          <span className={`note ${plan?.refusal ? "warn" : ""}`}>{note}</span>
          <Button kind="quiet" onClick={props.onClose}>Cancel</Button>
          <Button kind="primary" disabled={!plan || !!plan.refusal || busy} onClick={() => void submit()}>Rename</Button>
        </>
      }
    >
      <form className="form" onSubmit={(e) => (e.preventDefault(), void submit())}>
        <label>
          <span>Name</span>
          <span className="field-ext">
            <input className="field" data-autofocus value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} />
            {ext && <span>{ext}</span>}
          </span>
        </label>
      </form>
    </Sheet>
  );
}
