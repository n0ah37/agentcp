import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import type { DocRef, FileView, Finding, WritePlan } from "../../shared/types.ts";
import { ApiError, api, qs } from "../api.ts";
import { Editor, type EditorHandle } from "../editor/Editor.tsx";
import { useDebounced, useResource } from "../store.ts";
import { Icon } from "../ui/icons.tsx";
import { Button, DocLink, Empty, FindingList, bytes, plural, when } from "../ui/kit.tsx";
import { useApp } from "./app-context.ts";
import { useHeadSlot } from "./headslot.ts";
import { renderMarkdown } from "../ui/markdown.ts";

type Props = {
  path: string;
  /** Shown above the explanation in the inspector. */
  top?: ReactNode;
  /** Shown below the suggestions. */
  bottom?: ReactNode;
  cutAfterLine?: number | null;
  template?: string;
  canDelete?: boolean;
  onDeleted?: () => void;
  facts?: [string, ReactNode][];
  /** What the file is, when the screen knows better than its kind (Codex reads AGENTS.md differently). */
  about?: { summary: string; doc: DocRef };
  /** The agent that reads this file, when it isn't Claude Code; its own checks and docs apply. */
  agent?: "codex" | "opencode";
  /** The app's checks; off for a file the app has no rules for. */
  checks?: boolean;
  /** Open as a readable note first (title, description, text), with Edit to change it. */
  reader?: boolean;
  /** Markdown that opens as text, with Text | Formatted above it; the choice is kept in Preferences. */
  formattable?: boolean;
};

/**
 * One file, open for reading and editing: the editor in the middle, what the
 * file is and what the documentation says about it on the right. Renders two
 * grid cells, so the screen supplies the list on the left.
 */
export function FileWorkspace(props: Props) {
  const { project, prefs, setPrefs, save, openDoc, toast, askAI, fileMenu } = useApp();
  const slot = useHeadSlot();
  const key = `/api/file${qs({ path: props.path, project, agent: props.agent ?? null })}`;
  const { data: view, error, reload } = useResource<FileView>(key);
  const [draft, setDraft] = useState<string | null>(null);
  const [base, setBase] = useState<{ hash: string | null; text: string } | null>(null);
  const [diskMoved, setDiskMoved] = useState<string | null>(null);
  const [reloadedAt, setReloadedAt] = useState<string | null>(null);
  const editor = useRef<EditorHandle>(null);
  const [reading, setReading] = useState(!!props.reader);

  // Track the disk version: follow it while clean, flag it while editing.
  useEffect(() => {
    if (!view) return;
    const hash = view.file.hash;
    if (!base) {
      setBase({ hash, text: view.text });
      setDraft(view.text);
      return;
    }
    if (hash === base.hash) return;
    const dirty = draft !== null && draft !== base.text;
    if (!dirty) {
      setBase({ hash, text: view.text });
      setDraft(view.text);
      setReloadedAt(new Date().toISOString());
    } else {
      setDiskMoved(new Date().toISOString());
    }
    // Reacts to a new disk version only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view?.file.hash, view?.text]);

  const text = draft ?? view?.text ?? "";
  const dirty = base !== null && draft !== null && draft !== base.text;
  const debounced = useDebounced(dirty ? text : null, 350);
  const [live, setLive] = useState<Finding[] | null>(null);
  useEffect(() => {
    if (debounced === null) {
      setLive(null);
      return;
    }
    let on = true;
    api.post<Finding[]>("/api/check", { path: props.path, project, text: debounced, agent: props.agent ?? null }).then((f) => on && setLive(f)).catch(() => {});
    return () => {
      on = false;
    };
  }, [debounced, props.path, project, props.agent]);
  const findings = live ?? view?.findings ?? [];

  // Read the disk afresh rather than trusting the cached copy.
  const useDisk = async () => {
    const fresh = await api.get<FileView>(key);
    setBase({ hash: fresh.file.hash, text: fresh.text });
    setDraft(fresh.text);
    setDiskMoved(null);
    void reload();
  };

  const doSave = () => {
    if (!view || !dirty) return;
    save({
      path: view.file.path,
      content: text,
      baseHash: base?.hash ?? null,
      project,
      onReload: useDisk,
      onSaved: (r) => {
        setBase({ hash: r.hash, text });
        setDiskMoved(null);
      },
    });
  };

  // File › Save in the desktop app's menu; the editor's own ⌘S never reaches it once the menu takes the key.
  const saveRef = useRef(doSave);
  saveRef.current = doSave;
  useEffect(() => {
    const on = () => saveRef.current();
    window.addEventListener("acp:save", on);
    return () => window.removeEventListener("acp:save", on);
  }, []);

  const create = () =>
    save({
      path: props.path,
      content: props.template ?? "",
      baseHash: null,
      project,
      onSaved: (r) => {
        setBase({ hash: r.hash, text: props.template ?? "" });
        setDraft(props.template ?? "");
      },
    });

  const applyFix = async (f: Finding) => {
    const fix = f.fix;
    if (!fix) return;
    if (fix.kind === "replace" || fix.kind === "insert") {
      if (view && !view.file.editable) {
        toast({ text: view.file.lockedBecause ?? "This file can't be edited here." });
        return;
      }
      if (!prefs?.allowEdits) await setPrefs({ allowEdits: true });
      const lines = text.split("\n");
      const i = fix.line - 1;
      if (fix.kind === "replace" && lines[i] !== undefined) lines[i] = lines[i].replace(fix.from, fix.to);
      else if (fix.kind === "insert") lines.splice(i, 0, ...fix.text.replace(/\n$/, "").split("\n"));
      setDraft(lines.join("\n"));
      toast({ text: `${fix.label}: done in the editor. Review it, then save.` });
      return;
    }
    try {
      const planned = await api.post<{ plan: WritePlan; content: string; baseHash: string | null }>("/api/fix/plan", { fix, project });
      save({ path: planned.plan.path, content: planned.content, baseHash: planned.baseHash, project, planned, title: fix.label + "?" });
    } catch (e) {
      toast({ text: e instanceof ApiError ? e.message : String(e), tone: "bad" });
    }
  };

  const language = props.path.endsWith(".json") ? "json" : props.path.endsWith(".toml") || props.path.endsWith(".rules") ? "plain" : "markdown";
  const locked = view ? !view.file.editable : true;
  const readOnly = locked || !prefs?.allowEdits;
  const facts = useMemo(() => {
    if (!view?.file.exists) return [] as [string, ReactNode][];
    const f = view.file;
    if (f.unreadable) return [...(props.facts ?? []), ["Size", "Unknown: it can't be read"]] as [string, ReactNode][];
    const out: [string, ReactNode][] = [
      ["Size", `${plural(f.lines, "line")} · ${bytes(f.bytes)}`],
      ["Changed", when(f.modified)],
    ];
    if (f.isSymlink) out.push(["Link to", f.linkTarget ?? ""]);
    return [...(props.facts ?? []), ...out];
  }, [view, props.facts]);

  if (error) {
    return (
      <>
        <section className="pane center"><Empty title="This file can't be opened.">{error.message}</Empty></section>
        <aside className="pane inspector" />
      </>
    );
  }
  if (!view) {
    return (
      <>
        <section className="pane center"><p className="loading">Opening…</p></section>
        <aside className="pane inspector" />
      </>
    );
  }

  const name = view.file.name;
  const canFormat = !!props.formattable && view.file.exists && !view.file.unreadable;
  const formatted = canFormat && !!prefs?.formatted;
  // A finding names a line, which only the text shows.
  const jump = (l: number) => {
    if (!reading && !formatted) return editor.current?.jumpTo(l);
    setReading(false);
    if (formatted) void setPrefs({ formatted: false });
    setTimeout(() => editor.current?.jumpTo(l), 0);
  };
  const menuFile = { path: view.file.path, display: view.file.display, name, exists: view.file.exists, editable: !readOnly, hash: base?.hash ?? view.file.hash };
  const menuOpts = { canDelete: props.canDelete, onDeleted: props.onDeleted, onRevert: dirty ? () => setDraft(base?.text ?? view.text) : null, agent: props.agent };
  const toolbar = (
    <div className="toolbar">
      <div className="file" title={view.file.display}>
        {locked && <Icon.lock className="lock" aria-label="Read-only" />}
        <b>{name}</b>
        {dirty && <i className="edited" title="Edited" />}
      </div>
      {view.file.exists && reading && !dirty && (
        <Button small kind="quiet" onClick={() => setReading(false)} title="Show the file's text">
          {readOnly ? "Source" : "Edit"}
        </Button>
      )}
      {view.file.exists && props.reader && !reading && !dirty && (
        <Button small kind="quiet" onClick={() => setReading(true)}>
          Done
        </Button>
      )}
      {canFormat && (
        <span className="seg" role="group" aria-label="Show the file as">
          <button type="button" aria-pressed={!formatted} onClick={() => void setPrefs({ formatted: false })}>Text</button>
          <button type="button" aria-pressed={formatted} onClick={() => void setPrefs({ formatted: true })}>Formatted</button>
        </span>
      )}
      {view.file.exists && !locked && !prefs?.allowEdits && !reading && !formatted && (
        <Button small kind="quiet" onClick={() => setPrefs({ allowEdits: true })} title="Editing is off. Turn it on to change files.">
          Turn on editing
        </Button>
      )}
      <Button kind="icon" title="Write with AI" onClick={() => askAI({ path: view.file.path, name }, props.agent)}>
        <Icon.spark />
      </Button>
      <Button kind="icon" title="More" onClick={(e) => fileMenu(e, menuFile, menuOpts)}>
        <Icon.more />
      </Button>
      {dirty && (
        <Button small kind="primary" onClick={doSave} title="⌘S">
          Save
        </Button>
      )}
    </div>
  );
  return (
    <>
      <section className="pane center" aria-label={name}>
        {slot ? createPortal(toolbar, slot) : toolbar}
        {diskMoved && (
          <div className="banner warn">
            <span className="grow">{name} changed on disk while you were editing it.</span>
            <Button small onClick={useDisk}>Use the disk version</Button>
            <Button small kind="quiet" onClick={() => setDiskMoved(null)}>Keep mine</Button>
          </div>
        )}
        {!diskMoved && reloadedAt && !dirty && (
          <div className="banner info">
            <span className="grow">Updated from disk {when(reloadedAt)}.</span>
            <Button small kind="quiet" onClick={() => setReloadedAt(null)}>Dismiss</Button>
          </div>
        )}
        {view.file.exists && locked && (
          <div className="banner info">
            <Icon.lock style={{ width: 14, height: 14, flex: "none" }} />
            <span className="grow">{view.file.lockedBecause}</span>
          </div>
        )}
        {view.file.exists && ((reading && !dirty) || formatted) ? (
          <Note view={view} text={text} whole={formatted && !SKILL_KINDS.has(view.file.kind)} />
        ) : view.file.exists ? (
          <Editor
            key={view.file.path}
            ref={editor}
            value={text}
            readOnly={readOnly}
            language={language}
            findings={props.checks === false ? [] : findings}
            cutAfterLine={props.cutAfterLine}
            onChange={setDraft}
            onSave={doSave}
          />
        ) : (
          <Empty title={`${name} doesn't exist yet.`} action={<Button kind="primary" onClick={create} disabled={locked}><Icon.plus />Create {name}</Button>}>
            {view.about?.summary}
          </Empty>
        )}
      </section>
      <aside className="pane inspector" aria-label="About this file">
        <div className="insp">
          {props.top}
          {(props.about ?? view.about) && (
            <section className="about">
              <p>{(props.about ?? view.about)!.summary}</p>
              {facts.length > 0 && (
                <dl className="facts">
                  {facts.map(([k, v]) => (
                    <FactRow key={k} k={k} v={v} />
                  ))}
                </dl>
              )}
              <DocLink doc={(props.about ?? view.about)!.doc} onOpen={openDoc} />
            </section>
          )}
          {props.checks !== false && view.file.exists && !view.file.unreadable && findings.length === 0 && (
            <p className="insp-ok"><Icon.check />Matches {props.agent === "codex" ? "Codex's" : props.agent === "opencode" ? "OpenCode's" : "Claude Code's"} docs</p>
          )}
          {props.checks !== false && view.file.exists && findings.length > 0 && (
            <section>
              <h3>Suggestions · {findings.length}</h3>
              <FindingList findings={findings} onOpenDoc={openDoc} onJump={jump} onFix={applyFix} canFix empty="" />
            </section>
          )}
          {props.bottom}
        </div>
      </aside>
    </>
  );
}

const SKILL_KINDS = new Set(["skill", "codex-skill", "opencode-skill"]);

/**
 * A memory or skill, read rather than edited: its title, kind and description, then its text.
 * `whole` shows an instruction file as written, formatted, with no title of its own.
 */
function Note({ view, text, whole }: { view: FileView; text: string; whole?: boolean }) {
  const fm = view.frontmatter?.values ?? {};
  const meta = (fm.metadata ?? {}) as Record<string, unknown>;
  const full = text.replace(/^---\n[\s\S]*?\n---\n?/, "");
  // A skill usually opens with its own title: that becomes the page's title, shown once.
  const heading = whole ? null : /^\s*# (.+)\n?/.exec(full);
  const body = heading ? full.slice(heading[0].length) : full;
  // A memory's [[links]] name other memories; anywhere else they're left as written.
  const html = useMemo(() => renderMarkdown(whole ? body : body.replace(/\[\[([^\]]+)\]\]/g, "**$1**")), [body, whole]);
  if (whole) {
    return (
      <div className="note-read">
        <article className="prose" dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    );
  }
  // A skill's name is what you type to run it, so it shows as written; a memory's name reads as words.
  const skill = SKILL_KINDS.has(view.file.kind);
  const named = String(fm.name ?? (skill ? view.file.path.split("/").slice(-2, -1)[0] : view.file.name.replace(/\.md$/, "")));
  const title = heading ? heading[1].trim() : skill ? named : named.replace(/[-_]+/g, " ");
  const type = String(fm.type ?? meta.type ?? "");
  const description = typeof fm.description === "string" ? fm.description : "";
  const links = [...new Set([...body.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]))];
  return (
    <div className="note-read">
      <article>
        <h1>{skill ? title : title.charAt(0).toUpperCase() + title.slice(1)}</h1>
        {(type || description) && (
          <p className="note-meta">
            {type && <span className="tag">{type}</span>}
            {description && <span>{description}</span>}
          </p>
        )}
        <div className="prose" dangerouslySetInnerHTML={{ __html: html }} />
        {links.length > 0 && (
          <p className="note-links">
            Links to {links.map((l) => <span key={l} className="tag">{l}</span>)}
          </p>
        )}
      </article>
    </div>
  );
}

function FactRow({ k, v }: { k: string; v: ReactNode }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </>
  );
}
