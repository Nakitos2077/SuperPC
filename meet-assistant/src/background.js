// Service worker: принимает запросы из вкладки Мита, стримит ответы Claude обратно
// и дублирует их в окно-компаньон (невидимое для демонстрации экрана), если оно запущено.
import Anthropic from "@anthropic-ai/sdk";
import { loadSettings } from "./settings.js";
import { loadMaterials, materialBlocks } from "./materials.js";

// Модели, для которых доступен серверный fallback при отказе (refusal).
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-2"]);
const SKIP = "[SKIP]";

// Короткое правило про код — ставится прямо в запрос (рядом с заданием модель выполняет его надёжнее).
const CODE_RULE =
  "Если нужен код — дай его в блоке ```язык ... ``` (например ```python), полностью и с правильными " +
  "отступами. Если язык не указан — используй язык из задачи, разговора или скриншота, иначе Python.";

// Как объяснять код со скриншота/экрана.
const EXPLAIN_RULE =
  "Если просят объяснить код («поясни/объясни/що робить/как работает этот код») — объясни его: " +
  "сначала в 1–2 предложениях, что делает код в целом и что вернёт/выведет, затем по шагам " +
  "(по блокам или важным строкам: что происходит и зачем), в конце — сложность и подводные камни, " +
  "если они есть. Код целиком не переписывай, цитируй только нужные строки.";

// Что делать со скриншотом/кадром экрана: отвечать СРАЗУ, ничего не уточняя.
const IMAGE_RULE =
  "Отвечай СРАЗУ по тому, что на изображении: не задавай уточняющих вопросов, не спрашивай «что именно " +
  "вас интересует», не жди вопроса. Выбери первое подходящее:\n" +
  "1) Если в расшифровке или в моём вопросе спрашивают что-то конкретное про этот экран — ответь именно на это.\n" +
  "2) Если на экране условие задачи (LeetCode, тестовое, «напишите функцию…») — сразу решение: идея в 1–2 " +
  "предложениях, код, сложность по времени и памяти.\n" +
  "3) Если на экране ошибка (в консоли, в выводе, подчёркнутый код) или в коде есть баг — что не так, " +
  "в какой строке, и исправленный код.\n" +
  "4) Если на экране просто код — сразу объясни его. " + EXPLAIN_RULE.replace(/^Если просят объяснить код \([^)]*\) — объясни его: /, "Как объяснять: ") + "\n" +
  "5) Если кода нет — кратко объясни, что показано и что из этого важно для разговора.\n" +
  "Если на экране несколько задач или фрагментов — бери тот, что в фокусе / последний.";

const TASKS = {
  draw:
    "Нарисуй схему к этому заданию одним блоком ```svg```: структуру данных, шаги алгоритма, " +
    "поток данных или архитектуру — со стрелками и подписями. После схемы — 2–5 коротких пунктов, " +
    "что на ней показано. Весь ответ заново не повторяй.",
  hint:
    "Посмотри на последние реплики в расшифровке. Если мне задали вопрос или ждут от меня ответа — " +
    "дай готовый ответ, который я могу сказать вслух (коротко, 2–5 предложений), и при необходимости " +
    "1–3 ключевых пункта. Если вопроса нет — дай полезную подсказку по текущей теме разговора.",
  summary:
    "Сделай краткое резюме встречи: ключевые темы, принятые решения, задачи (кто/что/когда), открытые вопросы.",
  screen: "На изображении — кадр того, что сейчас показывают на встрече (демонстрация экрана). " + IMAGE_RULE,
  screenshot: "На изображении — скриншот моего экрана. " + IMAGE_RULE,
};

function autoTask(recent, previous) {
  return (
    "Ты работаешь в авто-режиме: я ничего не спрашиваю, ты сам следишь за разговором.\n" +
    (previous?.length
      ? "Подсказки, которые ты уже показал мне недавно:\n<shown>\n" + previous.join("\n---\n") + "\n</shown>\n" +
        "Если новые реплики — это тот же вопрос (повтор, уточнение распознавания, переформулировка) " +
        "и ответ на него уже показан — ответь " + SKIP + ".\n\n"
      : "") +
    "Новые реплики с прошлой проверки:\n<new>\n" + recent + "\n</new>\n\n" +
    "Если в новых репликах мне (пользователю) задали вопрос, о чём-то попросили, ждут моего ответа, " +
    "мнения или решения — сразу дай готовый ответ, который я могу сказать вслух (2–5 предложений), " +
    "и при необходимости 1–3 ключевых пункта.\n" +
    "Если я сам (мои реплики помечены «Вы»/«You» или моим именем) вслух зачитал вопрос или задание " +
    "или спросил о чём-то — тоже ответь на этот вопрос.\n" +
    "Не повторяй подсказки, которые уже давал раньше.\n" +
    "Если от меня сейчас ничего не требуется — ответь ровно " + SKIP + " и больше ничего."
  );
}

// Строгое правило языка ответа (повторяем в system и в конце запроса — так модель не «съезжает»
// на язык разговора или инструкций).
function languageRule(s) {
  if (s.language.startsWith("том же")) return "Пиши ответ на том же языке, на котором идёт разговор.";
  return "Пиши ответ ТОЛЬКО на " + s.language + " языке — даже если разговор, вопрос, скриншот " +
    "или эти инструкции на другом языке. Код, имена переменных и функций, термины и названия технологий " +
    "оставляй как есть.";
}

// Правило про презентации пользователя.
function materialsRule(s, materials) {
  if (!materials.length) return "";
  const list = materials.map((m, i) => `${i + 1} — «${m.name}»`).join(", ");
  if (s.materialsOnly) {
    return "\n\nВ начале запроса приложены материалы пользователя (файлы: " + list + ").\n" +
      "ГЛАВНОЕ ПРАВИЛО, оно важнее всех правил выше: отвечай СТРОГО и ТОЛЬКО по этим материалам. " +
      "Ничего не добавляй от себя — никаких своих знаний, определений, формул, примеров, выводов и " +
      "пояснений, которых нет в презентациях. Определения, формулировки и формулы передавай максимально " +
      "близко к тексту материалов. Схему рисуй только если она есть в материалах — " +
      "тогда воспроизведи её. В конце ответа коротко укажи источник (например: «Презентация 2, слайд 14»). " +
      "Если ответа в материалах нет — ответь одной фразой, что в презентациях этого нет, и больше ничего.";
  }
  return "\n\nВ начале запроса приложены материалы пользователя (файлы: " + list + "). Отвечай в первую " +
    "очередь по ним: бери определения, код, обозначения и формулировки оттуда. В конце ответа коротко укажи " +
    "источник (например: «Презентация 2, слайд 14»). Если в материалах ответа нет — ответь из своих знаний и " +
    "пометь это: «(не из презентаций)».";
}

function buildSystem(s, materials) {
  return (
    "Ты — незаметный ассистент программиста на созвоне (Google Meet или Zoom): собеседование, live coding, " +
    "ревью кода, обсуждение задачи. Тебе передают живую расшифровку встречи, сделанную распознаванием речи: " +
    "в ней бывают ошибки, а термины программирования часто записаны неправильно или по-русски/по-украински " +
    "(«джава скрипт» = JavaScript, «пайтон» = Python, «хеш мап» = HashMap, «реакт» = React, «эс ку эль» = SQL, " +
    "«гит» = Git и т.п.) — понимай их как названия из программирования. Реплики пользователя помечены «Вы»/«You».\n" +
    "Пользователь читает твои ответы прямо во время разговора, поэтому пиши кратко, по делу, без вступлений. " +
    languageRule(s) + "\n\n" +
    "Как отвечать:\n" +
    "• Сначала 1–3 предложения — готовый ответ, который можно сказать вслух.\n" +
    "• Потом, если нужно, код и короткие пункты.\n" +
    "• Теоретический вопрос («что такое…», «чем отличается…», «как работает…») — сначала определение " +
    "словами, потом короткий пример кода.\n" +
    "• Алгоритмическая задача — идея решения в 1–2 предложениях, код, сложность по времени и памяти " +
    "(например $O(n \\log n)$ / $O(n)$), при необходимости крайние случаи.\n" +
    "• Код с ошибкой — в чём ошибка (строка/место) и исправленный код.\n" +
    "• Вопросы про системы, базы данных, архитектуру — ключевые пункты и компромиссы (trade-offs).\n" +
    "• Отвечай только по теме. На изображениях и в видео игнорируй людей, веб-камеры, лица и фон комнаты.\n\n" +
    "Код: только в блоках ```язык ... ``` с указанием языка (```python, ```javascript, ```java, ```sql …), " +
    "с правильными отступами, рабочий и без лишнего. Короткие комментарии в коде — на языке ответа. " +
    "Не выдумывай API и функции библиотек — если не уверен, так и скажи.\n\n" +
    "Формулы и сложность можно писать в LaTeX: $...$ в строке, $$...$$ отдельной строкой.\n\n" +
    "Схемы: если ответ заметно понятнее с картинкой (структура данных — дерево, граф, связный список, " +
    "стек; шаги алгоритма; архитектура; поток запросов) или схему прямо просят — нарисуй одним блоком " +
    "```svg ... ```: один <svg> с viewBox, ширина до 600, белый фон, стрелки и подписи, без скриптов и внешних ссылок." +
    (webSearchOn(s)
      ? "\n\nУ тебя есть веб-поиск. Используй его ТОЛЬКО когда нужен точный факт, в котором ты не уверен: " +
        "даты, имена, история конкретного университета или организации, свежие данные, версии библиотек. " +
        "Для общих знаний и обычных вопросов по программированию не ищи — отвечай сразу. В авто-режиме сначала " +
        "реши, нужно ли вообще отвечать; если нет — сразу " + SKIP + ", без поиска. Не пиши вступлений вроде " +
        "«сейчас поищу». Если искал — в конце коротко укажи источник (название сайта)."
      : "") +
    materialsRule(s, materials) +
    (s.context ? "\n\nКонтекст от пользователя (кто он, что за встреча):\n" + s.context : "")
  );
}

function buildUserContent({ task, question, transcript, recent, image, prev, previous }, s, materials) {
  const tail = transcript.length > s.transcriptChars
    ? "…(начало опущено)\n" + transcript.slice(-s.transcriptChars)
    : transcript;
  // Презентации — первыми: это неизменная часть запроса, она кэшируется между вопросами.
  const parts = materialBlocks(materials);
  if (image) parts.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } });
  let text = "<transcript>\n" + (tail || "(расшифровка пока пустая)") + "\n</transcript>\n\n";
  if (task === "draw") {
    text += TASKS.draw + (question ? "\n\nЗадание: " + question : "") +
      (prev ? "\n\nМой предыдущий ответ на это задание:\n<answer>\n" + prev + "\n</answer>" : "");
  } else if (question && task === "screenshot") text += TASKS.screenshot + "\n\nМой вопрос к скриншоту: " + question;
  else if (question) text += "Мой вопрос: " + question;
  else if (task === "auto") text += autoTask(recent || "", previous);
  else text += TASKS[task] || TASKS.hint;
  if (task !== "draw") text += "\n\n" + CODE_RULE;
  text += "\n\n" + languageRule(s);
  parts.push({ type: "text", text });
  return parts;
}

// Расход токенов ответа — показываем под карточкой, чтобы было видно, работает ли кэш презентаций.
function pickUsage(u) {
  if (!u) return null;
  return {
    input: u.input_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0,
    cacheWrite: u.cache_creation_input_tokens || 0,
    output: u.output_tokens || 0,
  };
}

function errorText(err) {
  if (err instanceof Anthropic.AuthenticationError) return "Неверный API-ключ. Проверь его в настройках расширения.";
  if (err instanceof Anthropic.PermissionDeniedError) return "Нет доступа к модели для этого ключа.";
  if (err instanceof Anthropic.NotFoundError) return "Модель не найдена — выбери другую в настройках.";
  if (err instanceof Anthropic.RateLimitError) {
    // Показываем точный текст сервера: в нём сказано, какой лимит превышен (запросы или токены в минуту).
    const detail = err.error?.error?.message || err.message || "";
    const retry = err.headers?.get?.("retry-after");
    return "Превышен лимит аккаунта Anthropic" + (retry ? ` (можно повторить через ${retry} с)` : "") + ".\n" + detail;
  }
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
      if (m.type === "draw" && typeof m.key === "string") {
        // Кнопка ✏️ в окне-компаньоне: просим вкладку Мита нарисовать рисунок к этой карточке.
        const owner = keyOwners.get(m.key);
        if (owner) { try { owner.port.postMessage({ type: "companion-draw", id: owner.id }); } catch {} }
        return;
      }
      if (m.type !== "screenshot" || typeof m.image !== "string") return;
      // Скрин из окна-компаньона: отдаём во вкладку Мита (там есть расшифровка для контекста).
      const port = [...ports].pop();
      if (port) port.postMessage({ type: "companion-ask", image: m.image });
      else {
        const key = `${Date.now()}-${++keySeq}`;
        toCompanion({ type: "start", key, title: "📸 Скрин экрана" });
        toCompanion({ key, type: "error", text: "Открой вкладку встречи (Google Meet или Zoom в браузере) — запросы идут через неё." });
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
let rateLimitedUntil = 0; // после 429 авто-режим и прогрев ждут, сколько сказал сервер
const keyOwners = new Map(); // ключ карточки в окне-компаньоне -> { port, id } запроса во вкладке Мита

// Общая часть запроса: модель, настройки и всё, что кэшируется (system + презентации).
function webSearchOn(s) {
  return !!s.webSearch && !s.model.startsWith("claude-haiku");
}

function baseParams(s, materials) {
  const params = {
    model: s.model,
    output_config: { effort: s.effort },
    system: buildSystem(s, materials),
  };
  // Быстрый режим: модель отвечает сразу, без внутренних «размышлений» (там, где модель это позволяет).
  // Haiku 5.5 — thinking отключается; Sonnet 5.5 — режим between_tools (без размышлений, инструментов у нас нет);
  // у Opus 5.5 / Fable размышления не отключаются — там скорость регулирует только effort.
  if (s.fastMode && s.effort !== "xhigh" && s.effort !== "max") {
    if (s.model.startsWith("claude-haiku-5-5")) params.thinking = { type: "disabled" };
    else if (s.model.startsWith("claude-sonnet-5-5")) params.thinking = { type: "between_tools" };
  }
  // Поиск в интернете для фактов (выполняется на серверах Anthropic). У Haiku не включаем —
  // этот вариант инструмента поддерживают Sonnet/Opus/Fable.
  if (webSearchOn(s)) params.tools = [{ type: "web_search_20260209", name: "web_search", max_uses: 2 }];
  if (FALLBACK_MODELS.has(s.model)) {
    params.betas = ["server-side-fallback-2026-07-01"];
    params.fallbacks = "default";
  }
  return params;
}

// ---------------------------------------------------- Прогрев кэша презентаций
// Пока открыт Мит, заранее кладём презентации в кэш Claude (запрос с max_tokens: 0 — ответа нет,
// платится только запись в кэш). Тогда даже первый вопрос не ждёт, пока прочитаются все слайды.
// Кэш живёт 5 минут с последнего использования, поэтому обновляем его, если вопросов не было ~4 мин.
const WARM_EVERY_MS = 4 * 60 * 1000;
let lastCacheUse = 0;
let warming = false;

async function prewarm() {
  if (warming || !ports.size || Date.now() - lastCacheUse < WARM_EVERY_MS || Date.now() < rateLimitedUntil) return;
  warming = true;
  try {
    const s = await loadSettings();
    const materials = await loadMaterials();
    if (!s.apiKey || !materials.length) return;
    const client = new Anthropic({ apiKey: s.apiKey, dangerouslyAllowBrowser: true });
    await client.beta.messages.create({
      ...baseParams(s, materials),
      max_tokens: 0,
      messages: [{ role: "user", content: [...materialBlocks(materials), { type: "text", text: "warmup" }] }],
    });
    lastCacheUse = Date.now();
  } catch {
    // Прогрев — необязательная оптимизация; при ошибке настоящий вопрос просто запишет кэш сам.
  } finally {
    warming = false;
  }
}
setInterval(prewarm, 30 * 1000);

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "claude") return;
  ports.add(port);
  connectCompanion();
  prewarm();
  port.postMessage({ type: "companion", connected: companionConnected() });
  const active = new Map(); // id -> stream

  port.onDisconnect.addListener(() => {
    ports.delete(port);
    for (const st of active.values()) st.abort();
    active.clear();
  });

  port.onMessage.addListener(async (msg) => {
    if (msg.type === "abort") { active.get(msg.id)?.abort(); return; }
    if (msg.type === "heard") { toCompanion({ type: "heard", text: String(msg.text || "") }); return; }
    if (msg.type !== "ask") return;
    const { id } = msg;
    const key = `${Date.now()}-${++keySeq}`;
    keyOwners.set(key, { port, id });
    if (keyOwners.size > 60) keyOwners.delete(keyOwners.keys().next().value);
    const isAuto = msg.task === "auto";
    const send = (m) => { try { port.postMessage({ id, ...m }); } catch {} };
    // Лимит аккаунта исчерпан — авто-проверки молча пропускаем, пока не пройдёт пауза.
    if (isAuto && Date.now() < rateLimitedUntil) { send({ type: "skip" }); return; }
    let shown = false;
    const show = () => {
      if (shown) return;
      shown = true;
      send({ type: "show" });
      toCompanion({ type: "start", key, title: msg.label, drawable: msg.task !== "draw" });
    };
    const out = (m) => { send(m); toCompanion({ key, ...m }); };

    const s = await loadSettings();
    if (!s.apiKey) {
      show();
      out({ type: "error", text: "Не задан API-ключ Anthropic. Открой настройки расширения (иконка на панели)." });
      return;
    }
    if (!isAuto) show();

    const materials = await loadMaterials();
    const client = new Anthropic({ apiKey: s.apiKey, dangerouslyAllowBrowser: true });
    const params = {
      ...baseParams(s, materials),
      max_tokens: 8000,
      messages: [{ role: "user", content: buildUserContent(msg, s, materials) }],
    };
    if (materials.length) lastCacheUse = Date.now();

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
      else out({ type: "done", usage: pickUsage(final.usage) });
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError) {
        const retry = Number(err.headers?.get?.("retry-after")) || 20;
        rateLimitedUntil = Date.now() + retry * 1000;
      }
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
