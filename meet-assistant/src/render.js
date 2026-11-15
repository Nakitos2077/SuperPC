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

// Делим текст на блоки: рисунки, формулы-блоки и обычный текст.
function splitBlocks(src) {
  const out = [];
  const re = /```(?:svg|xml|html)?\s*\n?(<svg[\s\S]*?<\/svg>)\s*```|(<svg[\s\S]*?<\/svg>)|\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g;
  let last = 0, m;
  while ((m = re.exec(src))) {
    if (m.index > last) out.push({ type: "text", value: src.slice(last, m.index) });
    if (m[1] || m[2]) out.push({ type: "svg", value: m[1] || m[2] });
    else out.push({ type: "math", value: m[3] ?? m[4] });
    last = m.index + m[0].length;
  }
  let rest = src.slice(last);
  // Рисунок ещё «печатается» (стриминг) — не показываем сырой код.
  const open = rest.search(/```(?:svg|xml|html)?\s*\n?<svg|<svg\b/);
  let drawing = false;
  if (open !== -1) { rest = rest.slice(0, open); drawing = true; }
  if (rest) out.push({ type: "text", value: rest });
  if (drawing) out.push({ type: "pending" });
  return out;
}

function inline(text) {
  const nodes = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\\\((.+?)\\\)|\$(?!\s)([^$\n]+?)(?<!\s)\$|\*(?!\s)([^*\n]+?)(?<!\s)\*)/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) nodes.push(el("b", { textContent: tok.slice(2, -2) }));
    else if (tok.startsWith("`")) nodes.push(el("code", { textContent: tok.slice(1, -1) }));
    else if (m[4] !== undefined) nodes.push(el("i", {}, ...inline(m[4]))); // *курсив* (внутри может быть формула)
    else nodes.push(mathNode(m[2] ?? m[3], false));
    last = m.index + tok.length;
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
    else out.push(el("div", { className: "muted", textContent: "✏️ рисую…" }));
  }
  return out;
}

export const RICH_CSS = `
.math-block { margin: 6px 0; overflow-x: auto; overflow-y: hidden; padding: 2px 0; }
.math-block math { font-size: 1.15em; }
.math math { font-size: 1.05em; }
.drawing-wrap { margin: 6px 0; }
.drawing { display: block; max-width: 100%; max-height: 60vh; background: #fff; border-radius: 8px; padding: 6px; box-sizing: border-box; }
`;
