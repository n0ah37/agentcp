import { useEffect, useState } from "react";

import type { WritePlan, WriteResult } from "../../shared/types.ts";
import { api } from "../api.ts";
import { Button, Diff, Sheet } from "../ui/kit.tsx";
import type { SaveRequest } from "./app-context.ts";

/**
 * The review step every write goes through: the diff against what is on disk
 * now, then Save. A save against a file that changed after it was opened
 * shows what would be replaced and asks before replacing it.
 */
export function SaveSheet(props: {
  request: SaveRequest;
  editsOn: boolean;
  onTurnOnEdits: () => Promise<void>;
  onClose: () => void;
  onDone: (r: WriteResult, name: string) => void;
  onError: (e: unknown) => void;
}) {
  const r = props.request;
  const [plan, setPlan] = useState<WritePlan | null>(r.planned?.plan ?? null);
  const [content] = useState<string | null>(r.planned ? r.planned.content : r.content);
  const [base, setBase] = useState<string | null>(r.planned ? r.planned.baseHash : r.baseHash);
  const [busy, setBusy] = useState(false);
  const [overwrite, setOverwrite] = useState(false);

  useEffect(() => {
    if (r.planned) return;
    api
      .post<WritePlan>("/api/plan", { path: r.path, content: r.content, baseHash: r.baseHash, project: r.project })
      .then(setPlan)
      .catch(props.onError);
    // Planned once, when the sheet opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const name = (plan?.path ?? r.path).split("/").pop() ?? r.path;
  const deleting = content === null;
  const title = r.title ?? (deleting ? `Delete ${name}?` : plan && !plan.exists ? `Create ${name}?` : `Save changes to ${name}?`);
  const blocked = !!plan?.refusal || (plan?.conflict && !overwrite);

  const confirm = async () => {
    if (!plan) return;
    setBusy(true);
    try {
      if (!props.editsOn) await props.onTurnOnEdits();
      const res = await api.post<WriteResult>("/api/save", { path: plan.path, content, baseHash: overwrite ? plan.diskHash : base, project: r.project });
      props.onDone(res, name);
    } catch (e) {
      props.onError(e);
      // The disk may have moved again; plan afresh so the sheet shows the truth.
      try {
        const fresh = await api.post<WritePlan>("/api/plan", { path: plan.path, content, baseHash: base, project: r.project });
        setPlan(fresh);
        setBase(base);
      } catch {
        /* keep the old plan on screen */
      }
    } finally {
      setBusy(false);
    }
  };

  const verb = r.verb ?? (deleting ? "Delete" : plan && !plan.exists ? "Create" : "Save");

  return (
    <Sheet
      title={title}
      subtitle={plan ? (plan.writesTo !== plan.display ? `${plan.display} is a link. The change is written to ${plan.writesTo}.` : plan.display) : r.path}
      onClose={props.onClose}
      footer={
        <>
          <span className="note">
            {plan?.refusal
              ? plan.refusal
              : !props.editsOn
                ? "Editing is off. Saving turns it on."
                : deleting
                  ? "You can put it back from History."
                  : plan?.exists
                    ? "The current version is kept in History."
                    : "History records the new file, so it can be removed again."}
          </span>
          <Button kind="quiet" onClick={props.onClose}>Cancel</Button>
          <Button kind={deleting ? "danger-primary" : "primary"} onClick={confirm} disabled={!plan || busy || blocked || !plan.changed}>
            {busy ? `${verb}…` : overwrite ? `${verb} anyway` : verb}
          </Button>
        </>
      }
    >
      {!plan ? (
        <p className="muted">Comparing with the file on disk…</p>
      ) : (
        <>
          {plan.conflict && (
            <div className="banner warn" style={{ margin: "0 0 12px", borderRadius: 8 }}>
              <span className="grow">
                {plan.exists ? `${name} changed on disk after you opened it.` : `${name} was deleted after you opened it.`} The comparison below is against what is on disk now, so saving replaces those changes.
              </span>
              {r.onReload && (
                <Button small onClick={() => (r.onReload!(), props.onClose())}>
                  Use the disk version
                </Button>
              )}
              {!overwrite && (
                <Button small onClick={() => setOverwrite(true)}>
                  Replace it
                </Button>
              )}
            </div>
          )}
          {plan.changed ? (
            <>
              <p className="diffsum">
                {plan.added > 0 && <span className="a">+{plan.added}</span>}
                {plan.removed > 0 && <span className="r">−{plan.removed}</span>}
                <span>{plural(plan.added + plan.removed)}</span>
              </p>
              <Diff patch={plan.patch} />
            </>
          ) : (
            <p className="muted">Nothing to save: the file on disk already says this.</p>
          )}
        </>
      )}
    </Sheet>
  );
}

function plural(n: number): string {
  return n === 1 ? "1 line changed" : `${n} lines changed`;
}
