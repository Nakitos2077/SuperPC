// Service worker: принимает запросы из вкладки Мита, стримит ответы Claude обратно
// и дублирует их в окно-компаньон (невидимое для демонстрации экрана), если оно запущено.
import Anthropic from "@anthropic-ai/sdk";
import { loadSettings } from "./settings.js";
import { loadMaterials, materialBlocks } from "./materials.js";

// Модели, для которых доступен серверный fallback при отказе (refusal).
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-2"]);
const SKIP = "[SKIP]";

// Короткое правило про рисунок — ставится прямо в запрос (рядом с заданием модель выполняет его надёжнее).
const FIGURE_RULE =
  "Если в задании или вопросе упоминается рисунок («Рис.», «Рис. Пояснення», «рисунок», «малюнок», " +
  "«схема», «графік», «креслення», «зобразіть», «намалюйте») — твой ответ ОБЯЗАТЕЛЬНО начинается " +
  "с блока ```svg``` с рисунком, который ты рисуешь сам, а уже потом идёт текст.";

const TASKS = {
  draw:
    "Нарисуй рисунок (схему/чертёж) к этому заданию одним блоком ```svg```: все векторы со стрелками, " +
    "подписи величин и обозначений, как на рисунке в учебнике. После рисунка — 2–5 коротких пунктов: " +
    "что на нём обозначено. Весь ответ заново не повторяй.",
  hint:
    "Посмотри на последние реплики в расшифровке. Если мне задали вопрос или ждут от меня ответа — " +
    "дай готовый ответ, который я могу сказать вслух (коротко, 2–5 предложений), и при необходимости " +
    "1–3 ключевых пункта. Если вопроса нет — дай полезную подсказку по текущей теме разговора.",
  summary:
    "Сделай краткое резюме встречи: ключевые темы, принятые решения, задачи (кто/что/когда), открытые вопросы.",
  screen:
    "На изображении — то, что сейчас показывают на встрече. Если там вопрос или задача — реши её. " +
    "Иначе кратко объясни содержание (слайд, документ, схему) в связи с тем, что обсуждают.",
  screenshot:
    "На изображении — скриншот моего экрана (там может быть чат встречи, документ, слайд, задание). " +
    "Найди на нём вопрос или задачу (если их несколько — последнюю) и дай готовый ответ " +
    "с коротким пояснением. Если вопроса нет — кратко объясни содержание по теме.",
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
    "или эти инструкции на другом языке. Термины и формулы можно оставлять как есть.";
}

// Правило про презентации пользователя.
function materialsRule(s, materials) {
  if (!materials.length) return "";
  const list = materials.map((m, i) => `${i + 1} — «${m.name}»`).join(", ");
  if (s.materialsOnly) {
    return "\n\nВ начале запроса приложены материалы пользователя (презентации: " + list + ").\n" +
      "ГЛАВНОЕ ПРАВИЛО, оно важнее всех правил выше: отвечай СТРОГО и ТОЛЬКО по этим материалам. " +
      "Ничего не добавляй от себя — никаких своих знаний, определений, формул, примеров, выводов и " +
      "пояснений, которых нет в презентациях. Определения, формулировки и формулы передавай максимально " +
      "близко к тексту слайдов. Рисунок рисуй только если такой рисунок или схема есть в презентации — " +
      "тогда воспроизведи его. В конце ответа коротко укажи источник (например: «Презентация 2, слайд 14»). " +
      "Если ответа в материалах нет — ответь одной фразой, что в презентациях этого нет, и больше ничего.";
  }
  return "\n\nВ начале запроса приложены материалы пользователя (презентации: " + list + "). Отвечай в первую " +
    "очередь по ним: бери определения, формулы, обозначения и формулировки оттуда. В конце ответа коротко укажи " +
    "источник (например: «Презентация 2, слайд 14»). Если в материалах ответа нет — ответь из своих знаний и " +
    "пометь это: «(не из презентаций)».";
}

function buildSystem(s, materials) {
  return (
    "Ты — незаметный ассистент пользователя на созвоне (Google Meet или Zoom). Тебе передают живую " +
    "расшифровку встречи из автоматических субтитров (в ней бывают ошибки распознавания, " +
    "имена могут быть искажены; реплики пользователя помечены как «Вы»/«You» или его именем). " +
    "Твои ответы пользователь читает прямо во время разговора, поэтому пиши кратко, по делу, " +
    "без вступлений, используй короткие списки. " + languageRule(s) + "\n\n" +
    "Отвечай только по теме: на вопрос, задачу или обсуждаемый материал. На изображениях и в видео " +
    "игнорируй людей, веб-камеры, лица, внешность, одежду и фон комнаты — не описывай и не упоминай их.\n\n" +
    "Определения и формулировки: если просят «дайте означення/визначення», «що називається», " +
    "«сформулюйте» (закон, теорему) — СНАЧАЛА дай полную словесную формулировку законченным " +
    "предложением, как в учебнике («...називається фізична величина, що дорівнює...»), и только " +
    "ПОТОМ формулу с расшифровкой всех обозначений и единицами измерения. Не подменяй определение формулой.\n\n" +
    "Формулы: пиши их в LaTeX — $...$ внутри строки и $$...$$ отдельной строкой (они отрисуются как " +
    "в учебнике). Будь точен: используй стандартные обозначения, проверь формулу и размерности, " +
    "при расчёте покажи подстановку чисел и дай итог с единицами измерения. Не выдумывай формулы — " +
    "если не уверен, так и скажи.\n\n" +
    "Рисунки: рисуй одним блоком ```svg ... ```: один <svg> с viewBox, ширина до 600, белый фон, " +
    "чёрные/цветные линии, стрелки у векторов, подписи всех величин и обозначений (как на рисунке " +
    "в учебнике), без скриптов, внешних ссылок и картинок. Подписи на рисунке должны совпадать с " +
    "нарисованным (например, плоскую площадку не подписывай как замкнутую поверхность).\n" +
    "• ОБЯЗАТЕЛЬНО нарисуй рисунок, если в вопросе или задании его просят: «Рис.», «рисунок», " +
    "«малюнок», «схема», «графік»/«график», «креслення»/«чертёж», «зобразіть»/«изобразите», " +
    "«намалюйте»/«нарисуйте», «пояснити на рисунку» и т.п. Поставь рисунок там, где он нужен по " +
    "смыслу, и под ним коротко поясни, что на нём обозначено.\n" +
    "• «(Рис. Пояснення)», «(Рис.)», «з рисунком» в задании означает: ответ должен содержать рисунок " +
    "с пояснениями. Рисунка в задании обычно НЕТ — его рисуешь ты сам. Никогда не пиши, что рисунок " +
    "не предоставлен или не дан, и не предлагай нарисовать «за потреби» — сразу рисуй.\n" +
    "• В остальных случаях рисуй, только если ответ заметно понятнее с картинкой (схема, график, " +
    "чертёж, векторы сил, электрическая цепь, геометрия)." +
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
  if (task !== "draw") text += "\n\n" + FIGURE_RULE;
  text += "\n\n" + languageRule(s);
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
const keyOwners = new Map(); // ключ карточки в окне-компаньоне -> { port, id } запроса во вкладке Мита

// Общая часть запроса: модель, настройки и всё, что кэшируется (system + презентации).
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
  if (warming || !ports.size || Date.now() - lastCacheUse < WARM_EVERY_MS) return;
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
