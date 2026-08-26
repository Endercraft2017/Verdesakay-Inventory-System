import { EditorState } from '@codemirror/state';
import { EditorView, basicSetup } from 'codemirror';
import { html, htmlCompletionSource } from '@codemirror/lang-html';
import { autocompletion } from '@codemirror/autocomplete';
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { tags } from '@lezer/highlight';

/* ---- syntax colors: picked once at mount time from the app's current theme ---- */
const lightHighlight = HighlightStyle.define([
  { tag: tags.tagName, color: '#1e6ef0', fontWeight: '600' },
  { tag: tags.attributeName, color: '#7a3cff' },
  { tag: tags.attributeValue, color: '#15803d' },
  { tag: tags.string, color: '#15803d' },
  { tag: tags.comment, color: '#8a97ad', fontStyle: 'italic' },
  { tag: tags.keyword, color: '#b7791f' },
  { tag: tags.number, color: '#c2410c' },
  { tag: tags.propertyName, color: '#1e6ef0' },
  { tag: tags.className, color: '#7a3cff' },
  { tag: [tags.bracket, tags.punctuation], color: '#5d6b84' },
]);
const darkHighlight = HighlightStyle.define([
  { tag: tags.tagName, color: '#7aa2ff', fontWeight: '600' },
  { tag: tags.attributeName, color: '#c299ff' },
  { tag: tags.attributeValue, color: '#7ee2a8' },
  { tag: tags.string, color: '#7ee2a8' },
  { tag: tags.comment, color: '#8a97ad', fontStyle: 'italic' },
  { tag: tags.keyword, color: '#f0b155' },
  { tag: tags.number, color: '#ff9166' },
  { tag: tags.propertyName, color: '#7aa2ff' },
  { tag: tags.className, color: '#c299ff' },
  { tag: [tags.bracket, tags.punctuation], color: '#aab4c6' },
]);

/* ---- theme: driven by the app's own CSS variables, so it follows light/dark for free ---- */
function buildTheme(dark) {
  return EditorView.theme({
    '&': { color: 'var(--text, #16243d)', backgroundColor: 'var(--surface, #fff)', height: '100%', fontSize: '13px' },
    '.cm-scroller': { fontFamily: 'Consolas, ui-monospace, monospace', lineHeight: '1.6' },
    '.cm-content': { caretColor: 'var(--text, #16243d)' },
    '.cm-gutters': { backgroundColor: 'var(--surface-2, #eef4fb)', color: 'var(--text-faint, #8a97ad)', border: 'none' },
    '.cm-activeLine': { backgroundColor: 'var(--surface-2, #eef4fb)' },
    '.cm-activeLineGutter': { backgroundColor: 'var(--surface-3, #e6eef8)' },
    '.cm-selectionBackground, ::selection': { backgroundColor: 'var(--accent-weak, #e7f1ff) !important' },
    '.cm-cursor': { borderLeftColor: 'var(--text, #16243d)' },
    '&.cm-focused': { outline: 'none' },
    '.cm-tooltip': { backgroundColor: 'var(--surface, #fff)', border: '1px solid var(--border-strong, #c6d4e6)', color: 'var(--text, #16243d)' },
    '.cm-tooltip-autocomplete ul li': { padding: '3px 8px' },
    '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--accent-weak, #e7f1ff)', color: 'var(--accent, #2b7fff)' },
    '.cm-tooltip.cm-tooltip-autocomplete > ul': { fontFamily: 'Consolas, ui-monospace, monospace', fontSize: '12.5px' },
  }, { dark });
}

/* ---- our own {{variable}} / {{= formula(...)}} completions — a generic HTML/CSS language
   server has no idea this syntax exists. Reuses the same variable list (getVariables()) and
   formula function names already used by Visual mode's {{ autocomplete + formula builder. */
const FORMULA_FNS = [
  { name: 'sum(', desc: 'Sum a column across every line item' },
  { name: 'avg(', desc: 'Average of a column' },
  { name: 'count(', desc: 'Number of line items' },
  { name: 'min(', desc: 'Smallest value' },
  { name: 'max(', desc: 'Largest value' },
  { name: 'round(', desc: 'Round a number' },
];

function templateCompletionSource(getVariables) {
  return function (context) {
    const word = context.matchBefore(/\{\{=?[\w.]*$/);
    if (!word || (word.from === word.to && !context.explicit)) return null;
    const typed = word.text.replace(/^\{\{/, '');
    const isFormula = typed.startsWith('=');
    let options;
    if (isFormula) {
      options = FORMULA_FNS.map((f) => ({ label: f.name, type: 'function', detail: f.desc }));
    } else {
      const vars = typeof getVariables === 'function' ? (getVariables() || []) : [];
      options = vars.map((v) => {
        const tok = String(v.token || v.key || '').replace(/^\{\{|\}\}$/g, '');
        return { label: tok, type: 'variable', detail: v.label || v.category || '' };
      });
    }
    const from = word.from + 2 + (isFormula ? 1 : 0);
    return { from, options, validFor: /^[\w.]*$/ };
  };
}

/* ---- CSS property-name completion inside <style> blocks (e.g. "co" -> "color") ----
   CM's own cssCompletionSource only offers property names once the parser is *certain*
   you're writing a declaration — but the CSS grammar (which supports nesting) can't tell
   "start of a declaration" from "start of a nested rule selector" for a bare, still-being-
   typed identifier right after `{`, so it stays silent there (confirmed directly against
   the real, unmodified @codemirror/lang-css: this is the grammar's own ambiguity, not a
   bug in our wiring — value completion after a `:`, e.g. "color: r" -> "red", already works
   fine via htmlCompletionSource since a colon fully disambiguates that position). This
   source fills that one gap with a plain word-list, scoped to only fire inside a style
   block (checked via the syntax tree, not text-matching) so it never fires in HTML text or
   attribute values. */
const CSS_PROPERTIES = [
  'align-content', 'align-items', 'align-self', 'background', 'background-color', 'background-image',
  'background-position', 'background-repeat', 'background-size', 'border', 'border-bottom', 'border-color',
  'border-left', 'border-radius', 'border-right', 'border-style', 'border-top', 'border-width', 'bottom',
  'box-shadow', 'box-sizing', 'color', 'column-gap', 'content', 'cursor', 'display', 'flex', 'flex-basis',
  'flex-direction', 'flex-grow', 'flex-shrink', 'flex-wrap', 'float', 'font-family', 'font-size',
  'font-style', 'font-weight', 'gap', 'grid-template-columns', 'grid-template-rows', 'height',
  'justify-content', 'left', 'letter-spacing', 'line-height', 'list-style', 'margin', 'margin-bottom',
  'margin-left', 'margin-right', 'margin-top', 'max-height', 'max-width', 'min-height', 'min-width',
  'object-fit', 'opacity', 'outline', 'overflow', 'overflow-x', 'overflow-y', 'padding', 'padding-bottom',
  'padding-left', 'padding-right', 'padding-top', 'page-break-after', 'page-break-before', 'position',
  'resize', 'right', 'row-gap', 'text-align', 'text-decoration', 'text-overflow', 'text-transform', 'top',
  'transform', 'transition', 'vertical-align', 'visibility', 'white-space', 'width', 'word-break',
  'word-wrap', 'z-index',
];

function insideStyleBlock(state, pos) {
  let node = syntaxTree(state).resolveInner(pos, -1);
  for (let n = node; n; n = n.parent) {
    if (n.name === 'StyleSheet' || n.name === 'RuleSet' || n.name === 'Block') return true;
  }
  return false;
}

function cssPropertyCompletionSource(context) {
  const word = context.matchBefore(/[\w-]+$/);
  if (!word || (word.from === word.to && !context.explicit)) return null;
  if (!insideStyleBlock(context.state, context.pos)) return null;
  return { from: word.from, options: CSS_PROPERTIES.map((p) => ({ label: p, type: 'property' })), validFor: /^[\w-]*$/ };
}

/** Mount a CodeMirror editor into `container`.
    opts: { doc, onChange, getVariables, dark }
    returns { getValue(), setValue(text), destroy(), focus() } */
function mount(container, opts) {
  opts = opts || {};
  const dark = !!opts.dark;
  const updateListener = EditorView.updateListener.of((update) => {
    if (update.docChanged && typeof opts.onChange === 'function') opts.onChange();
  });
  const state = EditorState.create({
    doc: opts.doc || '',
    extensions: [
      basicSetup,
      html(),
      // `override` replaces ALL completion sources, including the built-in HTML/CSS ones
      // (tags, attributes, CSS properties/values/colors) — so it must explicitly include
      // htmlCompletionSource too, not just our own {{var}} source, or typing e.g. "co" inside
      // a <style> block would no longer suggest "color".
      autocompletion({ override: [templateCompletionSource(opts.getVariables), htmlCompletionSource, cssPropertyCompletionSource] }),
      syntaxHighlighting(dark ? darkHighlight : lightHighlight),
      buildTheme(dark),
      EditorView.lineWrapping,
      updateListener,
    ],
  });
  const view = new EditorView({ state, parent: container });
  return {
    getValue: () => view.state.doc.toString(),
    setValue: (text) => { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text || '' } }); },
    destroy: () => view.destroy(),
    focus: () => view.focus(),
  };
}

export { mount };
