const $ = (id) => document.getElementById(id);
const cardsBox = $("cards");
const cards = new Map(); // id -> { card, content, text }

const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  Object.assign(n, props);
  n.append(...kids);
  return n;
};

function renderMarkdown(src) {
  const out = [];
  let list = null;
  for (const raw of src.split("\n")) {
    const line = raw.trimEnd();
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
  return out;
}

function inline(text) {
  const nodes = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    nodes.push(tok.startsWith("**") ? el("b", { textContent: tok.slice(2, -2) }) : el("code", { textContent: tok.slice(1, -1) }));
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function getCard(id, title) {
  let c = cards.get(id);
  if (c) return c;
  cardsBox.querySelector(".empty")?.remove();
  const close = el("button", { textContent: "✕", title: "Убрать" });
  const content = el("div", { className: "content" }, el("span", { className: "typing", textContent: "думаю…" }));
  const card = el("div", { className: "card" },
    el("div", { className: "card-head" }, el("span", { className: "card-title", textContent: title || "Подсказка" }), close),
    content);
  close.onclick = () => { card.remove(); cards.delete(id); };
  cardsBox.prepend(card);
  c = { card, content, text: "" };
  cards.set(id, c);
  while (cardsBox.children.length > 20) cardsBox.lastElementChild.remove();
  return c;
}

window.overlay.onHint((m) => {
  if (m.type === "fatal") {
    cardsBox.prepend(el("div", { className: "card" }, el("div", { className: "error", textContent: m.text })));
    return;
  }
  if (m.type === "start") { getCard(m.key, m.title); return; }
  const c = cards.get(m.key);
  if (!c) return;
  if (m.type === "delta") {
    c.text += m.text;
    c.content.replaceChildren(...renderMarkdown(c.text));
  } else if (m.type === "error") {
    c.content.replaceChildren(el("div", { className: "error", textContent: m.text }));
  } else if (m.type === "done" && !c.text) {
    c.content.querySelector(".typing")?.replaceWith(el("span", { className: "muted", textContent: "(нет ответа)" }));
  }
});

window.overlay.onStatus(({ connected }) => {
  $("dot").classList.toggle("on", connected);
  $("status").textContent = connected ? "Подключено к Мит" : "Ждёт Chrome…";
});

$("quit").onclick = () => window.overlay.quit();
$("shot").onclick = () => window.overlay.screenshot();
$("min").onclick = () => window.overlay.minimize();
$("clear").onclick = () => {
  cards.clear();
  cardsBox.replaceChildren(el("div", { className: "empty", textContent: "Пусто." }));
};
$("opacity").oninput = (e) => window.overlay.setOpacity(e.target.value / 100);
