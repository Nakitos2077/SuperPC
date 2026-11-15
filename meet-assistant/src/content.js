// Content script для meet.google.com:
//  1) читает живые субтитры Мита (это и есть «слух» — Meet сам распознаёт речь всех участников);
//  2) по кнопке/горячей клавише/автоматически отправляет расшифровку Claude;
//  3) показывает ответы панелью поверх вкладки Мита.
// Внимание: Meet использует Trusted Types, поэтому здесь нигде нет innerHTML — только DOM-API.

const PANEL_ID = "meet-assistant-root";
function main() {
  // ---------------------------------------------------------------- Транскрипт
  const lines = []; // { speaker, text, updated }
  const byEl = new WeakMap(); // элемент реплики -> объект строки
  let lastSpeakerSeen = "";

  const CAPTION_REGION =
    'div[role="region"][aria-label*="aption" i], div[role="region"][aria-label*="убтитр" i], div[jsname="dsyhDe"]';

  function findCaptionRegion() {
    return document.querySelector(CAPTION_REGION);
  }

  // Достаём (говорящий, текст) из блока реплики. Сначала известные классы Meet,
  // затем эвристика: первая строка innerText — имя, остальное — текст.
  function parseEntry(el) {
    const nameEl = el.querySelector(".NWpY1d, .zs7s8d, [data-self-name]");
    const textEl = el.querySelector(".ygicle, .iTTPOb, .bh44bd");
    if (textEl) {
      return { speaker: nameEl?.textContent.trim() || lastSpeakerSeen || "?", text: textEl.textContent.trim() };
    }
    const raw = (el.innerText || "").trim();
    if (!raw) return null;
    const parts = raw.split("\n").map((s) => s.trim()).filter(Boolean);
    if (parts.length >= 2 && parts[0].length < 60) return { speaker: parts[0], text: parts.slice(1).join(" ") };
    return { speaker: lastSpeakerSeen || "?", text: raw };
  }

  function entryElements(region) {
    // Каждая реплика — прямой «блок» внутри списка субтитров. Ищем уровень, где лежат реплики.
    const known = region.querySelectorAll(".nMcdL, .TBMuR");
    if (known.length) return [...known];
    let level = region;
    while (level.children.length === 1 && level.firstElementChild.children.length) level = level.firstElementChild;
    return [...level.children].filter((c) => c.offsetParent !== null || c.innerText);
  }

  function scanCaptions() {
    const region = findCaptionRegion();
    setCaptionStatus(!!region);
    if (!region) return;
    for (const el of entryElements(region)) {
      if (el.closest("#" + PANEL_ID)) continue;
      const parsed = parseEntry(el);
      if (!parsed || !parsed.text) continue;
      lastSpeakerSeen = parsed.speaker;
      const existing = byEl.get(el);
      if (existing) {
        if (existing.text !== parsed.text) {
          existing.text = parsed.text;
          existing.speaker = parsed.speaker;
          existing.updated = Date.now();
          onLineChanged(existing);
        }
      } else {
        const line = { ...parsed, updated: Date.now() };
        lines.push(line);
        byEl.set(el, line);
        onLineChanged(line);
      }
    }
    setCaptionStatus(true);
    renderTranscript();
  }

  let scanTimer = null;
  new MutationObserver(() => {
    if (scanTimer) return;
    scanTimer = setTimeout(() => { scanTimer = null; scanCaptions(); }, 300);
  }).observe(document.body, { childList: true, subtree: true, characterData: true });

  function transcriptText() {
    // Склеиваем подряд идущие реплики одного говорящего.
    const out = [];
    for (const l of lines) {
      const last = out[out.length - 1];
      if (last && last.speaker === l.speaker) last.text += " " + l.text;
      else out.push({ speaker: l.speaker, text: l.text });
    }
    return out.map((l) => `${l.speaker}: ${l.text}`).join("\n");
  }

  function tryEnableCaptions() {
    const btn = document.querySelector(
      'button[aria-label*="captions" i][aria-pressed="false"], button[aria-label*="субтитр" i][aria-pressed="false"]'
    );
    if (btn) { btn.click(); return true; }
    return false;
  }

  // ------------------------------------------------------------- Авто-режим
  const QUESTION_RE =
    /\?\s*$|^(как|что|почему|зачем|когда|где|кто|какой|какая|какие|сколько|можешь|можете|расскажи|расскажите|объясни|объясните|what|why|how|when|where|who|which|can you|could you|tell me|explain|do you|have you)\b/i;
  const SELF_RE = /^(you|вы|я)$/i;
  let autoTimer = null;
  let lastAutoAt = 0;
  let lastAutoLine = null;

  function onLineChanged(line) {
    if (!settings.autoMode) return;
    clearTimeout(autoTimer);
    autoTimer = setTimeout(() => {
      // Реплика «устоялась» 2 секунды — проверяем, похоже ли это на вопрос ко мне.
      if (line === lastAutoLine || SELF_RE.test(line.speaker)) return;
      const sentences = line.text.split(/(?<=[.!?])\s+/);
      const tail = sentences.slice(-2).join(" ");
      if (!QUESTION_RE.test(tail.trim()) && !/\?/.test(tail)) return;
      if (Date.now() - lastAutoAt < 12000 || busy) return;
      lastAutoAt = Date.now();
      lastAutoLine = line;
      ask({ task: "hint", label: "🤖 Авто: вопрос от " + line.speaker });
    }, 2000);
  }

  // --------------------------------------------------------- Скриншот видео
  function captureVideoFrame() {
    const videos = [...document.querySelectorAll("video")].filter((v) => v.videoWidth > 0 && v.offsetParent !== null);
    if (!videos.length) return null;
    // Самое крупное видео на экране — обычно это демонстрация экрана или активный спикер.
    const v = videos.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
    const scale = Math.min(1, 1568 / Math.max(v.videoWidth, v.videoHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(v.videoWidth * scale);
    c.height = Math.round(v.videoHeight * scale);
    c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.85).split(",")[1];
  }

  // ------------------------------------------------------------ Связь с Claude
  let port = null;
  let busy = false;
  let reqSeq = 0;
  const handlers = new Map();

  function getPort() {
    if (port) return port;
    port = chrome.runtime.connect({ name: "claude" });
    port.onMessage.addListener((m) => handlers.get(m.id)?.(m));
    port.onDisconnect.addListener(() => {
      port = null;
      for (const h of handlers.values()) h({ type: "error", text: "Соединение с расширением прервано, повтори запрос." });
      handlers.clear();
    });
    return port;
  }

  function ask({ task, question, withScreen, label }) {
    let image = null;
    if (withScreen) {
      try { image = captureVideoFrame(); } catch (e) { image = null; }
      if (!image) { showNotice("Не нашёл видео на экране для снимка."); return; }
    }
    const id = ++reqSeq;
    const card = addCard(label || question || "Подсказка", () => {
      try { getPort().postMessage({ type: "abort", id }); } catch {}
    });
    let text = "";
    busy = true;
    setBusy(true);
    handlers.set(id, (m) => {
      if (m.type === "delta") {
        text += m.text;
        card.setBody(text);
      } else {
        handlers.delete(id);
        busy = handlers.size > 0;
        setBusy(busy);
        if (m.type === "error") card.setError(m.text);
        card.finish();
      }
    });
    try {
      getPort().postMessage({ type: "ask", id, task, question, transcript: transcriptText(), image });
    } catch (e) {
      port = null;
      handlers.get(id)?.({ type: "error", text: "Расширение было обновлено — перезагрузи вкладку Мита." });
    }
  }

  // ----------------------------------------------------------------- Настройки
  const settings = { autoMode: false };
  chrome.storage.local.get(["autoMode"]).then((s) => { settings.autoMode = !!s.autoMode; syncAutoBox(); });
  chrome.storage.onChanged.addListener((ch) => {
    if (ch.autoMode) { settings.autoMode = !!ch.autoMode.newValue; syncAutoBox(); }
  });

  // ------------------------------------------------------------------- UI
  const host = document.createElement("div");
  host.id = PANEL_ID;
  host.style.cssText = "position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:2147483647;";
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = CSS;
  root.append(style);

  const el = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    Object.assign(n, props);
    n.append(...kids);
    return n;
  };

  const statusDot = el("span", { className: "dot" });
  const statusText = el("span", { className: "status", textContent: "Субтитры выключены" });
  const autoBox = el("input", { type: "checkbox" });
  const collapseBtn = el("button", { className: "icon", title: "Свернуть (Alt+M)", textContent: "▁" });
  const header = el("div", { className: "header" },
    el("span", { className: "title", textContent: "✳ Claude" }), statusDot, statusText,
    el("span", { className: "spacer" }),
    el("label", { className: "auto", title: "Автоматически отвечать, когда тебе задают вопрос" }, autoBox, " авто"),
    collapseBtn);

  const cards = el("div", { className: "cards" });
  const transcriptBox = el("div", { className: "transcript hidden" });
  const input = el("input", { className: "q", placeholder: "Спроси что-нибудь про встречу… (Enter)" });
  const btn = (label, title, fn) => { const b = el("button", { textContent: label, title }); b.onclick = fn; return b; };
  const ccBtn = btn("CC", "Включить субтитры Мита", () => {
    if (!tryEnableCaptions()) showNotice("Не нашёл кнопку субтитров — включи их вручную (кнопка CC или клавиша C).");
  });
  const toolbar = el("div", { className: "toolbar" },
    btn("💡 Подсказка", "Что ответить сейчас (Alt+Q)", () => ask({ task: "hint", label: "💡 Подсказка" })),
    btn("📝 Итоги", "Резюме встречи", () => ask({ task: "summary", label: "📝 Итоги встречи" })),
    btn("📸 Экран", "Снимок демонстрации/видео + анализ", () => ask({ task: "screen", withScreen: true, label: "📸 Что на экране" })),
    btn("📜", "Показать/скрыть расшифровку", () => transcriptBox.classList.toggle("hidden")),
    ccBtn);
  const body = el("div", { className: "body" }, toolbar, el("div", { className: "row" }, input), cards, transcriptBox);
  const panel = el("div", { className: "panel" }, header, body);
  root.append(panel);
  document.documentElement.append(host);

  input.addEventListener("keydown", (e) => {
    e.stopPropagation(); // чтобы горячие клавиши Мита не срабатывали при наборе
    if (e.key === "Enter" && input.value.trim()) {
      const q = input.value.trim();
      input.value = "";
      ask({ question: q, label: "❓ " + q });
    }
  });
  input.addEventListener("keyup", (e) => e.stopPropagation());
  input.addEventListener("keypress", (e) => e.stopPropagation());

  autoBox.onchange = () => chrome.storage.local.set({ autoMode: autoBox.checked });
  function syncAutoBox() { autoBox.checked = settings.autoMode; }

  let collapsed = false;
  collapseBtn.onclick = () => {
    collapsed = !collapsed;
    body.classList.toggle("hidden", collapsed);
    collapseBtn.textContent = collapsed ? "▢" : "▁";
  };

  document.addEventListener("keydown", (e) => {
    if (!e.altKey) return;
    if (e.code === "KeyQ") { e.preventDefault(); ask({ task: "hint", label: "💡 Подсказка" }); }
    if (e.code === "KeyM") { e.preventDefault(); collapseBtn.click(); }
  }, true);

  // Перетаскивание панели за заголовок.
  header.addEventListener("mousedown", (e) => {
    if (e.target.closest("button, label, input")) return;
    const r = host.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    const move = (ev) => {
      host.style.transform = "none";
      host.style.left = Math.max(0, ev.clientX - dx) + "px";
      host.style.top = Math.max(0, ev.clientY - dy) + "px";
    };
    const up = () => { removeEventListener("mousemove", move); removeEventListener("mouseup", up); };
    addEventListener("mousemove", move);
    addEventListener("mouseup", up);
  });

  function setCaptionStatus(on) {
    statusDot.classList.toggle("on", on);
    statusText.textContent = on ? `Слушаю · ${lines.length} реплик` : "Субтитры выключены — нажми CC";
    ccBtn.classList.toggle("hidden", on);
  }

  function setBusy(b) { panel.classList.toggle("busy", b); }

  function showNotice(text) {
    const c = addCard("ℹ️", null);
    c.setError(text);
    c.finish();
  }

  function addCard(title, onStop) {
    const stop = el("button", { className: "icon", title: "Остановить", textContent: "■" });
    const close = el("button", { className: "icon", title: "Убрать", textContent: "✕" });
    const content = el("div", { className: "content" }, el("span", { className: "typing", textContent: "думаю…" }));
    const card = el("div", { className: "card" },
      el("div", { className: "card-head" }, el("span", { className: "card-title", textContent: title }), stop, close),
      content);
    stop.onclick = () => onStop?.();
    if (!onStop) stop.remove();
    close.onclick = () => card.remove();
    cards.prepend(card);
    while (cards.children.length > 15) cards.lastElementChild.remove();
    return {
      setBody(text) { content.replaceChildren(...renderMarkdown(text)); },
      setError(text) { content.replaceChildren(el("div", { className: "error", textContent: text })); },
      finish() {
        stop.remove();
        content.querySelector(".typing")?.replaceWith(el("span", { className: "muted", textContent: "(нет ответа)" }));
      },
    };
  }

  // Мини-рендер markdown без innerHTML: заголовки, списки, **жирный**, `код`.
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

  let renderPending = false;
  function renderTranscript() {
    if (transcriptBox.classList.contains("hidden") || renderPending) return;
    renderPending = true;
    requestAnimationFrame(() => {
      renderPending = false;
      transcriptBox.textContent = transcriptText() || "Пока ничего не услышал.";
      transcriptBox.scrollTop = transcriptBox.scrollHeight;
    });
  }
  new MutationObserver(renderTranscript).observe(transcriptBox, { attributes: true, attributeFilter: ["class"] });

  // Пытаемся включить субтитры, когда пользователь зашёл во встречу.
  let ccTries = 0;
  const ccTimer = setInterval(() => {
    if (findCaptionRegion() || ++ccTries > 60) return clearInterval(ccTimer);
    tryEnableCaptions();
  }, 3000);
  scanCaptions();
}

var CSS = `
:host { all: initial; }
.panel { width: min(680px, calc(100vw - 32px)); font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: #e8eaed; background: rgba(32,33,36,.94); border: 1px solid #5f6368; border-radius: 12px;
  box-shadow: 0 8px 28px rgba(0,0,0,.45); backdrop-filter: blur(6px); overflow: hidden; }
.header { display: flex; align-items: center; gap: 8px; padding: 6px 10px; cursor: move; user-select: none;
  background: rgba(255,255,255,.04); }
.title { font-weight: 600; color: #f6a26b; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: #ea4335; }
.dot.on { background: #34a853; }
.busy .dot.on { animation: pulse 1s infinite; }
@keyframes pulse { 50% { opacity: .3; } }
.status { color: #9aa0a6; font-size: 12px; }
.spacer { flex: 1; }
.auto { color: #bdc1c6; font-size: 12px; cursor: pointer; display: flex; align-items: center; gap: 4px; }
button { font: inherit; color: #e8eaed; background: #3c4043; border: 1px solid #5f6368; border-radius: 8px;
  padding: 4px 10px; cursor: pointer; }
button:hover { background: #4a4e52; }
button.icon { padding: 0 6px; background: transparent; border: none; color: #9aa0a6; }
button.icon:hover { color: #fff; }
.body { padding: 8px 10px 10px; display: flex; flex-direction: column; gap: 8px; }
.toolbar { display: flex; flex-wrap: wrap; gap: 6px; }
.row { display: flex; }
.q { flex: 1; font: inherit; color: #e8eaed; background: #202124; border: 1px solid #5f6368; border-radius: 8px;
  padding: 6px 10px; outline: none; }
.q:focus { border-color: #8ab4f8; }
.cards { max-height: 42vh; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
.card { background: #2b2c2f; border: 1px solid #3c4043; border-radius: 10px; padding: 8px 10px; }
.card:first-child { border-color: #8ab4f8; }
.card-head { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
.card-title { flex: 1; color: #9aa0a6; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.content p { margin: 0 0 6px; }
.content ul { margin: 0 0 6px; padding-left: 18px; }
.content .h { font-weight: 600; margin: 4px 0; color: #fff; }
.content b { color: #fff; }
.content code { background: #202124; padding: 0 4px; border-radius: 4px; }
.typing, .muted { color: #9aa0a6; font-style: italic; }
.error { color: #f28b82; }
.transcript { max-height: 25vh; overflow-y: auto; white-space: pre-wrap; font-size: 12px; color: #bdc1c6;
  background: #202124; border-radius: 8px; padding: 6px 8px; }
.hidden { display: none !important; }
`;

if (!document.getElementById(PANEL_ID)) main();
