import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { type Diagnostic, linter, lintGutter, setDiagnostics } from "@codemirror/lint";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

import type { Finding } from "../../shared/types.ts";

export type EditorHandle = {
  jumpTo: (line: number) => void;
  getText: () => string;
  replaceAll: (text: string) => void;
};

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "13px", backgroundColor: "var(--paper)", color: "var(--ink)" },
  ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.6" },
  ".cm-content": { padding: "14px 0 60vh", caretColor: "var(--ink)", maxWidth: "92ch" },
  ".cm-line": { padding: "0 20px 0 14px" },
  ".cm-gutters": { backgroundColor: "var(--paper)", color: "var(--faint)", border: "none", paddingLeft: "6px" },
  ".cm-lineNumbers .cm-gutterElement": { minWidth: "32px", paddingRight: "4px", fontSize: "11.5px" },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--paper-2) 70%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--graphite)" },
  "&.cm-focused": { outline: "none" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": { backgroundColor: "var(--focus-wash) !important" },
  ".cm-cursor": { borderLeftColor: "var(--ink)" },
  ".cm-searchMatch": { backgroundColor: "var(--amber-wash)", outline: "1px solid var(--amber)" },
  ".cm-panels": { backgroundColor: "var(--paper-2)", color: "var(--ink)", borderColor: "var(--rule)" },
  ".cm-panel.cm-search": { padding: "8px 12px", fontFamily: "var(--sans)", fontSize: "12.5px" },
  ".cm-panel.cm-search input, .cm-panel.cm-search button": { fontFamily: "var(--sans)", fontSize: "12.5px" },
  ".cm-lintRange-error": { backgroundImage: "none", textDecoration: "underline wavy var(--pencil)", textUnderlineOffset: "3px" },
  ".cm-lintRange-warning": { backgroundImage: "none", textDecoration: "underline wavy var(--amber)", textUnderlineOffset: "3px" },
  ".cm-lintRange-info": { backgroundImage: "none", textDecoration: "underline dotted var(--faint)", textUnderlineOffset: "3px" },
  ".cm-lint-marker": { width: "8px", height: "8px", borderRadius: "50%", border: "none" },
  ".cm-lint-marker-error": { content: "none", backgroundColor: "var(--pencil)" },
  ".cm-lint-marker-warning": { content: "none", backgroundColor: "var(--amber)" },
  ".cm-lint-marker-info": { content: "none", backgroundColor: "var(--faint)" },
  ".cm-tooltip": { backgroundColor: "var(--paper)", border: "1px solid var(--rule)", borderRadius: "8px", boxShadow: "var(--shadow-pop)", fontFamily: "var(--sans)" },
  ".cm-diagnostic": { padding: "6px 10px", fontSize: "12.5px", maxWidth: "380px", borderLeft: "3px solid var(--faint)" },
  ".cm-diagnostic-error": { borderLeftColor: "var(--pencil)" },
  ".cm-diagnostic-warning": { borderLeftColor: "var(--amber)" },
  ".cm-cutline": { borderTop: "2px dashed var(--pencil)" },
  ".cm-dropped": { opacity: "0.45" },
});

const highlight = HighlightStyle.define([
  { tag: t.heading1, fontWeight: "700", color: "var(--ink)" },
  { tag: [t.heading2, t.heading3, t.heading4], fontWeight: "650", color: "var(--ink)" },
  { tag: t.strong, fontWeight: "650" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: [t.link, t.url], color: "var(--focus)" },
  { tag: t.monospace, color: "var(--amber)" },
  { tag: [t.processingInstruction, t.meta], color: "var(--faint)" },
  { tag: t.quote, color: "var(--graphite)" },
  { tag: t.list, color: "var(--graphite)" },
  { tag: [t.string], color: "var(--sage)" },
  { tag: [t.number, t.bool, t.null], color: "var(--amber)" },
  { tag: [t.propertyName], color: "var(--ink)", fontWeight: "600" },
  { tag: t.comment, color: "var(--faint)", fontStyle: "italic" },
]);

/** A dashed rule after the line where MEMORY.md stops loading, and the rest dimmed. */
const setCut = StateEffect.define<number | null>();
const cutField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) {
      if (!e.is(setCut)) continue;
      if (e.value === null) return Decoration.none;
      const b = new RangeSetBuilder<Decoration>();
      const doc = tr.state.doc;
      for (let n = e.value + 1; n <= doc.lines; n++) {
        const line = doc.line(n);
        b.add(line.from, line.from, Decoration.line({ class: n === e.value + 1 ? "cm-cutline cm-dropped" : "cm-dropped" }));
      }
      return b.finish();
    }
    return deco.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

function toDiagnostics(view: EditorView, findings: Finding[]): Diagnostic[] {
  const doc = view.state.doc;
  return findings
    .filter((f) => f.line && f.line <= doc.lines)
    .map((f) => {
      const line = doc.line(f.line!);
      const end = f.endLine && f.endLine <= doc.lines ? doc.line(f.endLine).to : line.to;
      return {
        from: line.from + (line.text.length - line.text.trimStart().length),
        to: Math.max(end, line.from + 1),
        severity: f.severity === "problem" ? "error" : f.severity === "warning" ? "warning" : "info",
        message: f.title,
      } satisfies Diagnostic;
    });
}

type Props = {
  value: string;
  readOnly: boolean;
  language: "markdown" | "json" | "plain";
  findings: Finding[];
  cutAfterLine?: number | null;
  onChange: (text: string) => void;
  onSave?: () => void;
};

export const Editor = forwardRef<EditorHandle, Props>(function Editor(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const ro = useRef(new Compartment());
  const cb = useRef(props);
  useEffect(() => {
    cb.current = props;
  });

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: props.value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          history(),
          search({ top: true }),
          highlightSelectionMatches(),
          props.language === "json" ? json() : props.language === "markdown" ? markdown() : [],
          syntaxHighlighting(highlight),
          EditorView.lineWrapping,
          lintGutter(),
          linter(null),
          cutField,
          theme,
          ro.current.of([EditorState.readOnly.of(props.readOnly), EditorView.editable.of(!props.readOnly)]),
          keymap.of([
            { key: "Mod-s", preventDefault: true, run: () => (cb.current.onSave?.(), true) },
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
            indentWithTab,
          ]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) cb.current.onChange(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = v;
    return () => v.destroy();
    // The editor is created once per file; the parent keys it by path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Text replaced from outside (a reload, a fix, a disk change).
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const cur = v.state.doc.toString();
    if (cur !== props.value) v.dispatch({ changes: { from: 0, to: cur.length, insert: props.value } });
  }, [props.value]);

  useEffect(() => {
    view.current?.dispatch({ effects: ro.current.reconfigure([EditorState.readOnly.of(props.readOnly), EditorView.editable.of(!props.readOnly)]) });
  }, [props.readOnly]);

  useEffect(() => {
    const v = view.current;
    if (v) v.dispatch(setDiagnostics(v.state, toDiagnostics(v, props.findings)));
  }, [props.findings]);

  useEffect(() => {
    view.current?.dispatch({ effects: setCut.of(props.cutAfterLine ?? null) });
  }, [props.cutAfterLine, props.value]);

  useImperativeHandle(ref, () => ({
    jumpTo(line: number) {
      const v = view.current;
      if (!v) return;
      const l = v.state.doc.line(Math.min(Math.max(1, line), v.state.doc.lines));
      v.dispatch({ selection: { anchor: l.from, head: l.to }, effects: EditorView.scrollIntoView(l.from, { y: "center" }) });
      v.focus();
    },
    getText: () => view.current?.state.doc.toString() ?? "",
    replaceAll(text: string) {
      const v = view.current;
      if (!v) return;
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } });
    },
  }));

  return <div className="editor-wrap" ref={host} />;
});
