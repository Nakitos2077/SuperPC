// Общий рендер ответов Claude (для панели в Мите и для окна-компаньона).
// Поддерживает: markdown-лайт (заголовки, списки, **жирный**, `код`),
// формулы LaTeX ($…$, $$…$$, \(…\), \[…\]) через KaTeX в MathML и рисунки ```svg```.
// Никакого innerHTML: Meet требует Trusted Types, поэтому всё строится через DOM-API.
import katex from "katex";

const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  Object.assign(n, props);
  n.append(...kids);
  return n;
};

function mathNode(tex, display) {
  const span = el(display ? "div" : "span", { className: display ? "math-block" : "math" });
  try {
    // __renderToDomTree строит DOM напрямую (без innerHTML) и не зависит от режима документа.
    const opts = { displayMode: display, output: "mathml", throwOnError: false, strict: false };
    span.append(katex.__renderToDomTree(tex.trim(), opts).toNode());
  } catch {
    span.textContent = tex;
  }
  return span;
}

// SVG показываем через <img>: так внутри рисунка гарантированно не выполнится никакой скрипт.
function svgNode(svg) {
  let code = svg.trim();
  if (!/xmlns=/.test(code)) code = code.replace(/<svg\b/, '<svg xmlns="http://www.w3.org/2000/svg"');
  const img = el("img", {
    className: "drawing",
    alt: "рисунок",
    src: "data:image/svg+xml;charset=utf-8," + encodeURIComponent(code),
  });
  img.onerror = () => img.replaceWith(el("div", { className: "muted", textContent: "(рисунок не удалось показать здесь — он есть в окне-компаньоне)" }));
  return el("div", { className: "drawing-wrap" }, img);
}

// Блок кода: моноширинный, отступы сохраняются, сверху язык и кнопка «Копировать».
function codeNode(lang, code, pending = false) {
  const text = code.replace(/\n$/, "");
  const copy = el("button", { className: "code-copy", type: "button", textContent: "📋 Копировать" });
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = el("textarea", { value: text });
      ta.style.cssText = "position:fixed;opacity:0";
      (copy.getRootNode().body || copy.getRootNode()).append(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    copy.textContent = "✓ Скопировано";
    setTimeout(() => (copy.textContent = "📋 Копировать"), 1500);
  };
  const head = el("div", { className: "code-head" },
    el("span", { className: "code-lang", textContent: (lang || "код") + (pending ? " · печатается…" : "") }), copy);
  return el("div", { className: "code-wrap" }, head, el("pre", {}, el("code", { textContent: text })));
}

// Делим текст на блоки: код, рисунки, формулы-блоки и обычный текст.
function splitBlocks(src) {
  const out = [];
  const re = /```(?:svg|xml|html)?[ \t]*\n?(<svg[\s\S]*?<\/svg>)\s*```|```([\w+#.-]*)[^\n]*\n([\s\S]*?)```|(<svg[\s\S]*?<\/svg>)|\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g;
  let last = 0, m;
  while ((m = re.exec(src))) {
    if (m.index > last) out.push({ type: "text", value: src.slice(last, m.index) });
    if (m[1] || m[4]) out.push({ type: "svg", value: m[1] || m[4] });
    else if (m[3] !== undefined) out.push({ type: "code", lang: m[2], value: m[3] });
    else out.push({ type: "math", value: m[5] ?? m[6] });
    last = m.index + m[0].length;
  }
  let rest = src.slice(last);
  // Блок ещё «печатается» (стриминг): рисунок не показываем сырым, код показываем по мере появления.
  const fence = rest.match(/```([\w+#.-]*)[^\n]*\n?/);
  const bareSvg = rest.search(/<svg\b/);
  if (fence && (bareSvg === -1 || fence.index <= bareSvg)) {
    const body = rest.slice(fence.index + fence[0].length);
    if (fence.index) out.push({ type: "text", value: rest.slice(0, fence.index) });
    if (/^(svg|xml|html)?$/.test(fence[1]) && /^\s*<svg/.test(body || "<svg")) out.push({ type: "pending" });
    else out.push({ type: "code", lang: fence[1], value: body, pending: true });
  } else if (bareSvg !== -1) {
    if (bareSvg) out.push({ type: "text", value: rest.slice(0, bareSvg) });
    out.push({ type: "pending" });
  } else if (rest) {
    out.push({ type: "text", value: rest });
  }
  return out;
}

// Строчное оформление: `код`, формулы $…$ и \(…\), ***жирный курсив***, **жирный**, *курсив*.
// Жирный и курсив разбираются рекурсивно — внутри могут быть формулы и вложенное оформление.
function inline(text) {
  const nodes = [];
  const re = new RegExp([
    "`([^`]+)`",                                         // 1: код
    "\\\\\\((.+?)\\\\\\)",                               // 2: \( формула \)
    "\\$(?!\\s)([^$\\n]+?)(?<!\\s)\\$",                  // 3: $формула$
    "\\*\\*\\*(?!\\s)(.+?)(?<!\\s)\\*\\*\\*",            // 4: ***жирный курсив***
    "\\*\\*(?!\\s)((?:[^*]|\\*(?!\\*))+?)(?<!\\s)\\*\\*", // 5: **жирный** (внутри может быть *курсив*)
    "\\*(?![\\s*])((?:\\*\\*(?:[^*]|\\*(?!\\*))+?\\*\\*|[^*\\n])+?)(?<!\\s)\\*(?!\\*)", // 6: *курсив* (внутри может быть **жирный**)
  ].join("|"), "g");
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    if (m[1] !== undefined) nodes.push(el("code", { textContent: m[1] }));
    else if (m[2] !== undefined || m[3] !== undefined) nodes.push(mathNode(m[2] ?? m[3], false));
    else if (m[4] !== undefined) nodes.push(el("b", {}, el("i", {}, ...inline(m[4]))));
    else if (m[5] !== undefined) nodes.push(el("b", {}, ...inline(m[5])));
    else nodes.push(el("i", {}, ...inline(m[6])));
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function renderText(src, out) {
  let list = null;
  for (const raw of src.split("\n")) {
    const line = raw.trimEnd();
    if (/^\s*```/.test(line)) continue;
    const li = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (li) {
      if (!list) { list = el("ul"); out.push(list); }
      list.append(el("li", {}, ...inline(li[1])));
      continue;
    }
    list = null;
    if (!line.trim()) continue;
    const h = line.match(/^#{1,6}\s+(.*)$/);
    out.push(h ? el("div", { className: "h" }, ...inline(h[1])) : el("p", {}, ...inline(line)));
  }
}

export function renderRich(src) {
  const out = [];
  for (const b of splitBlocks(src)) {
    if (b.type === "text") renderText(b.value, out);
    else if (b.type === "math") out.push(mathNode(b.value, true));
    else if (b.type === "svg") out.push(svgNode(b.value));
    else if (b.type === "code") out.push(codeNode(b.lang, b.value, b.pending));
    else out.push(el("div", { className: "muted", textContent: "✏️ рисую…" }));
  }
  return out;
}

export const RICH_CSS = `
.math-block { margin: 6px 0; overflow-x: auto; overflow-y: hidden; padding: 2px 0; }
.math-block math { font-size: 1.15em; }
.math math { font-size: 1.05em; }
.drawing-wrap { margin: 6px 0; }
.code-wrap { margin: 6px 0; border: 1px solid #3c4043; border-radius: 8px; overflow: hidden; background: #1b1c1e; }
.code-head { display: flex; align-items: center; gap: 8px; padding: 3px 8px; background: #2a2b2e; font-size: 11px; color: #9aa0a6; }
.code-lang { flex: 1; }
.code-copy { font: inherit; font-size: 11px; color: #e8eaed; background: #3c4043; border: 0; border-radius: 6px; padding: 2px 8px; cursor: pointer; }
.code-copy:hover { background: #4a4e52; }
.code-wrap pre { margin: 0; padding: 8px 10px; overflow-x: auto; max-height: 50vh; }
.code-wrap code { font: 12.5px/1.45 ui-monospace, "Cascadia Code", Consolas, "Courier New", monospace; color: #e8eaed; white-space: pre; background: none; padding: 0; }
.drawing { display: block; max-width: 100%; max-height: 60vh; background: #fff; border-radius: 8px; padding: 6px; box-sizing: border-box; }
`;
