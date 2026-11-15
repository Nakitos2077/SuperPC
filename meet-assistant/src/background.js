// Service worker: принимает запросы из вкладки Мита, стримит ответы Claude обратно
// и дублирует их в окно-компаньон (невидимое для демонстрации экрана), если оно запущено.
import Anthropic from "@anthropic-ai/sdk";
import { loadSettings } from "./settings.js";

// Модели, для которых доступен серверный fallback при отказе (refusal).
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-2"]);
const SKIP = "[SKIP]";

const TASKS = {
  hint:
    "Посмотри на последние реплики в расшифровке. Если мне задали вопрос или ждут от меня ответа — " +
    "дай готовый ответ, который я могу сказать вслух (коротко, 2–5 предложений), и при необходимости " +
    "1–3 ключевых пункта. Если вопроса нет — дай полезную подсказку по текущей теме разговора.",
  summary:
    "Сделай краткое резюме встречи: ключевые темы, принятые решения, задачи (кто/что/когда), открытые вопросы.",
  screen:
    "На изображении — то, что сейчас показывают на встрече (демонстрация экрана или видео). " +
    "Опиши, что там важного, и свяжи это с тем, что обсуждают. Если там вопрос/задача — помоги её решить.",
  screenshot:
    "На изображении — скриншот моего экрана (там может быть чат Мита, документ, слайд, задание). " +
    "Найди на нём вопрос или задачу, обращённую ко мне (если их несколько — последнюю), и дай готовый ответ " +
    "с коротким пояснением. Если вопроса нет — кратко скажи, что важного на экране.",
};

function autoTask(recent) {
  return (
    "Ты работаешь в авто-режиме: я ничего не спрашиваю, ты сам следишь за разговором.\n" +
    "Новые реплики с прошлой проверки:\n<new>\n" + recent + "\n</new>\n\n" +
    "Если в новых репликах мне (пользователю) задали вопрос, о чём-то попросили, ждут моего ответа, " +
    "мнения или решения — сразу дай готовый ответ, который я могу сказать вслух (2–5 предложений), " +
    "и при необходимости 1–3 ключевых пункта. Не повторяй подсказки, которые уже были бы уместны раньше.\n" +
    "Если от меня сейчас ничего не требуется — ответь ровно " + SKIP + " и больше ничего."
  );
}

function buildSystem(s) {
  return (
    "Ты — незаметный ассистент пользователя на созвоне в Google Meet. Тебе передают живую " +
    "расшифровку встречи из автоматических субтитров (в ней бывают ошибки распознавания, " +
    "имена могут быть искажены; реплики пользователя помечены как «Вы»/«You» или его именем). " +
    "Твои ответы пользователь читает прямо во время разговора, поэтому пиши кратко, по делу, " +
    "без вступлений, используй короткие списки. Отвечай на " + s.language + " языке, " +
    "если пользователь не попросил иначе." +
    (s.context ? "\n\nКонтекст от пользователя (кто он, что за встреча):\n" + s.context : "")
  );
}

function buildUserContent({ task, question, transcript, recent, image }, s) {
  const tail = transcript.length > s.transcriptChars
    ? "…(начало опущено)\n" + transcript.slice(-s.transcriptChars)
    : transcript;
  const parts = [];
  if (image) parts.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } });
  let text = "<transcript>\n" + (tail || "(расшифровка пока пустая)") + "\n</transcript>\n\n";
  if (question && task === "screenshot") text += TASKS.screenshot + "\n\nМой вопрос к скриншоту: " + question;
  else if (question) text += "Мой вопрос: " + question;
  else if (task === "auto") text += autoTask(recent || "");
  else text += TASKS[task] || TASKS.hint;
  parts.push({ type: "text", text });
  return parts;
}

function errorText(err) {
  if (err instanceof Anthropic.AuthenticationError) return "Неверный API-ключ. Проверь его в настройках расширения.";
  if (err instanceof Anthropic.PermissionDeniedError) return "Нет доступа к модели для этого ключа.";
  if (err instanceof Anthropic.NotFoundError) return "Модель не найдена — выбери другую в настройках.";
  if (err instanceof Anthropic.RateLimitError) return "Превышен лимит запросов, попробуй через несколько секунд.";
  if (err instanceof Anthropic.APIUserAbortError) return null;
  if (err instanceof Anthropic.APIConnectionError) return "Нет соединения с API Anthropic.";
  if (err instanceof Anthropic.APIError) return `Ошибка API (${err.status ?? "?"}): ${err.message}`;
  return String(err?.message || err);
}

// ------------------------------------------------------------ Окно-компаньон
const COMPANION_URL = "ws://127.0.0.1:47823";
const ports = new Set();
let ws = null;

function companionConnected() { return ws?.readyState === WebSocket.OPEN; }

function broadcastCompanion() {
  for (const p of ports) { try { p.postMessage({ type: "companion", connected: companionConnected() }); } catch {} }
}

function connectCompanion() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
  try {
    ws = new WebSocket(COMPANION_URL);
    ws.onopen = broadcastCompanion;
    ws.onclose = () => { ws = null; broadcastCompanion(); };
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.type !== "screenshot" || typeof m.image !== "string") return;
      // Скрин из окна-компаньона: отдаём во вкладку Мита (там есть расшифровка для контекста).
      const port = [...ports].pop();
      if (port) port.postMessage({ type: "companion-ask", image: m.image });
      else {
        const key = `${Date.now()}-${++keySeq}`;
        toCompanion({ type: "start", key, title: "📸 Скрин экрана" });
        toCompanion({ key, type: "error", text: "Открой вкладку Google Meet — запросы идут через неё." });
      }
    };
    ws.onerror = () => {};
  } catch { ws = null; }
}

function toCompanion(msg) {
  if (companionConnected()) { try { ws.send(JSON.stringify(msg)); } catch {} }
}

// Пока открыта вкладка Мита — периодически пытаемся подключиться к окну.
setInterval(() => {
  if (!ports.size) return;
  connectCompanion();
  toCompanion({ type: "ping" });
}, 5000);

// ------------------------------------------------------------------ Запросы
let keySeq = 0;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "claude") return;
  ports.add(port);
  connectCompanion();
  port.postMessage({ type: "companion", connected: companionConnected() });
  const active = new Map(); // id -> stream

  port.onDisconnect.addListener(() => {
    ports.delete(port);
    for (const st of active.values()) st.abort();
    active.clear();
  });

  port.onMessage.addListener(async (msg) => {
    if (msg.type === "abort") { active.get(msg.id)?.abort(); return; }
    if (msg.type !== "ask") return;
    const { id } = msg;
    const key = `${Date.now()}-${++keySeq}`;
    const isAuto = msg.task === "auto";
    const send = (m) => { try { port.postMessage({ id, ...m }); } catch {} };
    let shown = false;
    const show = () => {
      if (shown) return;
      shown = true;
      send({ type: "show" });
      toCompanion({ type: "start", key, title: msg.label });
    };
    const out = (m) => { send(m); toCompanion({ key, ...m }); };

    const s = await loadSettings();
    if (!s.apiKey) {
      show();
      out({ type: "error", text: "Не задан API-ключ Anthropic. Открой настройки расширения (иконка на панели)." });
      return;
    }
    if (!isAuto) show();

    const client = new Anthropic({ apiKey: s.apiKey, dangerouslyAllowBrowser: true });
    const params = {
      model: s.model,
      max_tokens: 8000,
      output_config: { effort: s.effort },
      system: buildSystem(s),
      messages: [{ role: "user", content: buildUserContent(msg, s) }],
    };
    if (FALLBACK_MODELS.has(s.model)) {
      params.betas = ["server-side-fallback-2026-07-01"];
      params.fallbacks = "default";
    }

    // В авто-режиме сначала копим начало ответа: если это [SKIP] — карточку не показываем.
    let pending = "";
    let skipped = false;
    try {
      const stream = client.beta.messages.stream(params);
      active.set(id, stream);
      stream.on("text", (delta) => {
        if (skipped) return;
        if (shown) { out({ type: "delta", text: delta }); return; }
        pending += delta;
        const head = pending.trimStart();
        if (head.length < SKIP.length && SKIP.startsWith(head)) return; // пока не ясно
        if (head.startsWith(SKIP)) { skipped = true; stream.abort(); return; }
        show();
        out({ type: "delta", text: head });
      });
      const final = await stream.finalMessage();
      if (!shown) { send({ type: "skip" }); return; }
      if (final.stop_reason === "refusal") out({ type: "error", text: "Модель отказалась отвечать на этот запрос." });
      else out({ type: "done" });
    } catch (err) {
      const text = skipped ? null : errorText(err);
      if (!shown && !text) { send({ type: "skip" }); return; }
      if (text) { show(); out({ type: "error", text }); }
      else out({ type: "done" });
    } finally {
      active.delete(id);
    }
  });
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
