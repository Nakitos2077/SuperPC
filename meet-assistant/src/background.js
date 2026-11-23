// Service worker: принимает запросы из вкладки Мита, стримит ответы Claude обратно
// и дублирует их в окно-компаньон (невидимое для демонстрации экрана), если оно запущено.
import Anthropic from "@anthropic-ai/sdk";
import { loadSettings } from "./settings.js";
import { loadMaterials as loadAllMaterials, materialBlocks, forClaude, findTicket, parseTicketQuery } from "./materials.js";

// Claude получает только материалы с включённым «🤖» (остальные — только для просмотра билетов).
const loadMaterials = async () => forClaude(await loadAllMaterials());
import { telegramReady, sendPhoto, sendText, sendAnswerImage, chatIds, call, form, sendTyping, downloadFile, findChats } from "./telegram.js";

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
// Теоретические вопросы и билеты (означення, теорема, властивості, приклади) — это тоже задание.
const THEORY_RULE =
  "Билеты и теоретические вопросы:\n" +
  "• Если указан номер («46 билет», «білет 46», «питання 47», «пункт 3») — найди этот номер на изображении " +
  "или в материалах (конспекте) и ответь ПОЛНОСТЬЮ на ВСЕ его подпункты (а, б, в…), каждый под своим " +
  "заголовком. Если номер не указан — ответь на все видимые вопросы.\n" +
  "• Ответ на каждый теоретический подпункт: означення (определение) словами полным предложением; " +
  "формулировка теоремы/властивості; доведення или вывод — если он есть в материалах или его обычно " +
  "спрашивают (коротко, по шагам); приклад (пример); в конце — откуда взято (например «конспект, с. 87–88»).\n" +
  "• Если приложен конспект/материалы — бери определения, обозначения, формулировки и примеры ИЗ НИХ, " +
  "максимально близко к тексту.\n" +
  "• НИКОГДА не отвечай «задачи нет, решать нечего» и не проси «пришлите условие», если есть вопросы, " +
  "темы или номер билета — сразу давай полный ответ. Если номер билета не найден ни на фото, ни в " +
  "материалах — так и скажи одной фразой и ответь на то, что видно.";

const IMAGE_RULE =
  "Отвечай СРАЗУ по тому, что на изображении: не задавай уточняющих вопросов, не спрашивай «что именно " +
  "вас интересует», не жди вопроса. Выбери первое подходящее:\n" +
  "1) Если в расшифровке или в моём вопросе спрашивают что-то конкретное про этот экран (в т.ч. номер " +
  "билета/вопроса) — ответь именно на это, полностью.\n" +
  "2) Если на экране условие задачи (математика, LeetCode, тестовое, «напишите функцию…») — сразу решение.\n" +
  "2а) Если на экране теоретические вопросы, билеты, перечень тем (означення, теорема, властивості, " +
  "приклади) — это ТОЖЕ задание: ответь на них по правилу о билетах ниже.\n" +
  "3) Если на экране ошибка (в консоли, в выводе, подчёркнутый код) или в коде есть баг — что не так, " +
  "в какой строке, и исправленный код.\n" +
  "4) Если на экране просто код — сразу объясни его. " + EXPLAIN_RULE.replace(/^Если просят объяснить код \([^)]*\) — объясни его: /, "Как объяснять: ") + "\n" +
  "5) Если кода нет — кратко объясни, что показано и что из этого важно для разговора.\n" +
  "ВАЖНО: если на экране НЕСКОЛЬКО заданий (Завдання 1, 2, 3…, пункты а), б), в)…) — реши ВСЕ по порядку, " +
  "каждое полностью, с отдельным заголовком («Завдання 1», «Завдання 2»…). Ни одно не пропускай, даже если " +
  "оно внизу экрана или видно частично (тогда реши то, что видно, и отметь, что часть не видна). " +
  "Вычисления доводи до конца и проверяй арифметику.\n\n" + THEORY_RULE;

// Блок «своими словами»: объяснение от первого лица, которое пользователь может прочитать вслух.
// Начинается со строки-заголовка с 🗣 — по ней блок отделяется (для Telegram он уходит отдельным текстом).
const OWN_WORDS_RULE =
  "В самом конце ответа добавь блок объяснения своими словами. Он начинается отдельной строкой " +
  "«## 🗣 » и коротким заголовком на языке ответа (например «## 🗣 Своїми словами»). Под ним — 3–6 простых " +
  "предложений от первого лица, как будто я сам рассказываю преподавателю или собеседнику, что и почему я " +
  "делаю: «Спочатку я…, потім я…, тому що…, у результаті я отримав…». Пиши живо и просто, как студент " +
  "говорит вслух. БЕЗ формул, LaTeX, кода, таблиц, markdown и спецсимволов — числа и выражения словами или " +
  "простым текстом (например «ікс дорівнює двадцять один», «визначник дорівнює одиниці»).";
const OWN_WORDS_RE = /^#{1,3}\s*🗣.*$/m;

// Делим ответ на основную часть и блок «своими словами».
function splitOwnWords(text) {
  const m = text.match(OWN_WORDS_RE);
  if (!m) return { main: text.trim(), own: "" };
  return { main: text.slice(0, m.index).trim(), own: text.slice(m.index + m[0].length).trim(), title: m[0].replace(/^#+\s*/, "") };
}

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
    "• Учебные вопросы (математика, физика и т.д., билеты, «означення», «теорема») — полный ответ по правилу ниже.\n" +
    "• Вопросы про системы, базы данных, архитектуру — ключевые пункты и компромиссы (trade-offs).\n" +
    "• Отвечай только по теме. На изображениях и в видео игнорируй людей, веб-камеры, лица и фон комнаты.\n\n" +
    "Код: только в блоках ```язык ... ``` с указанием языка (```python, ```javascript, ```java, ```sql …), " +
    "с правильными отступами, рабочий и без лишнего. Короткие комментарии в коде — на языке ответа. " +
    "Не выдумывай API и функции библиотек — если не уверен, так и скажи.\n\n" +
    THEORY_RULE + "\n\n" +
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
  if (task !== "draw" && task !== "summary" && s.ownWords) text += "\n\n" + OWN_WORDS_RULE;
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
const WARM_EVERY_MS = 50 * 60 * 1000; // кэш живёт час — обновляем чуть раньше
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
  const tgRenders = new Map(); // id запроса -> ждём картинку ответа от вкладки (для Telegram)

  port.onDisconnect.addListener(() => {
    ports.delete(port);
    for (const st of active.values()) st.abort();
    active.clear();
  });

  port.onMessage.addListener(async (msg) => {
    if (msg.type === "abort") { active.get(msg.id)?.abort(); return; }
    if (msg.type === "heard") { toCompanion({ type: "heard", text: String(msg.text || "") }); return; }
    if (msg.type === "tg-image") { tgRenders.get(msg.id)?.(msg); return; }
    // Билет из конспекта по номеру — мгновенно и бесплатно, без Claude.
    if (msg.type === "ticket") {
      const t = findTicket(await loadAllMaterials(), msg.query);
      try { port.postMessage({ type: "ticket-result", id: msg.id, found: !!t, ...(t || {}) }); } catch {}
      if (t) {
        const key = `${Date.now()}-${++keySeq}`;
        toCompanion({ type: "start", key, title: "📚 " + t.title });
        toCompanion({ key, type: "delta", text: t.md });
        toCompanion({ key, type: "done" });
      }
      return;
    }
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

    // Telegram: каждый скрин (📸 / Ctrl+Shift+S / Ctrl+V / «📸 Экран») сразу отправляем фото в чат с ботом,
    // а когда Claude ответит — его ответ, ответом на это фото.
    let tgPhoto = null;
    if (msg.image && (msg.task === "screenshot" || msg.task === "screen") && telegramReady(s)) {
      const time = new Date().toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" });
      tgPhoto = sendPhoto(s, msg.image, `${msg.label || "📸 Скрин"} · ${time}` + (msg.question ? `\n${msg.question}` : ""))
        .catch((e) => { send({ type: "tg", ok: false, error: e.message }); return null; });
    }
    let fullText = "";

    const client = new Anthropic({ apiKey: s.apiKey, dangerouslyAllowBrowser: true });
    const params = {
      ...baseParams(s, materials),
      // Скрин может содержать несколько заданий — даём больше места на ответ.
      max_tokens: msg.image ? 16000 : 8000,
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
        if (shown) { fullText += delta; out({ type: "delta", text: delta }); return; }
        pending += delta;
        const head = pending.trimStart();
        if (head.length < SKIP.length && SKIP.startsWith(head)) return; // пока не ясно
        if (head.startsWith(SKIP)) { skipped = true; stream.abort(); return; }
        show();
        fullText += head;
        out({ type: "delta", text: head });
      });
      const final = await stream.finalMessage();
      if (!shown) { send({ type: "skip" }); return; }
      if (final.stop_reason === "refusal") out({ type: "error", text: "Модель отказалась отвечать на этот запрос." });
      else {
        if (final.stop_reason === "max_tokens") out({ type: "delta", text: "\n\n_(ответ обрезан: слишком длинный — задай оставшееся задание отдельно)_" });
        out({ type: "done", usage: pickUsage(final.usage) });
      }
      if (tgPhoto && fullText.trim()) {
        // Telegram не рисует формулы, поэтому просим вкладку нарисовать ответ картинкой (как в панели).
        // Не получилось за 10 с — отправляем текстом.
        // Блок «своими словами» уходит отдельным текстом, а на картинке — только решение.
        const { main, own, title } = splitOwnWords(fullText);
        const rendered = new Promise((resolve) => {
          const timer = setTimeout(() => { tgRenders.delete(id); resolve(null); }, 10000);
          tgRenders.set(id, (m) => { clearTimeout(timer); tgRenders.delete(id); resolve(m.png ? m : null); });
          send({ type: "tg-render", text: main });
        });
        Promise.all([tgPhoto, rendered])
          .then(async ([photoIds, img]) => {
            if (!photoIds || !Object.keys(photoIds).length) return;
            const errors = [];
            let answerIds = null;
            const sent = img ? await sendAnswerImage(s, img.png, img.height, img.width, photoIds, "✳ Ответ Claude")
              : main ? await sendText(s, main, photoIds) : null;
            if (sent) { errors.push(...sent.errors); answerIds = sent.results; }
            if (own) errors.push(...(await sendText(s, `${title || "🗣 Своїми словами"}\n\n${own}`, photoIds)).errors);
            // Запоминаем ответ на скрин — чтобы в боте можно было задать уточняющий вопрос.
            for (const chat of Object.keys(photoIds)) {
              await rememberTurn(chat, "user", "[скрин екрана з завданням]" + (msg.question ? " " + msg.question : ""), photoIds[chat]);
              await rememberTurn(chat, "assistant", main, answerIds?.[chat]);
            }
            const n = Object.keys(photoIds).length;
            send(errors.length ? { type: "tg", ok: false, error: errors.join("; ") } : { type: "tg", ok: true, count: n });
          })
          .catch((e) => send({ type: "tg", ok: false, error: e.message }));
      }
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

// ================================================================== Telegram-бот
// Пишешь боту вопрос (или фото задания) — Claude отвечает прямо в Telegram.
// Отвечаем только чатам из списка получателей в настройках. Бот помнит последние реплики
// разговора и ответы на скрины, поэтому можно задавать уточняющие вопросы (в т.ч. ответом на сообщение).
// Если открыта встреча — Claude видит и её расшифровку.

const BOT_HISTORY_MAX = 12;               // реплик в памяти на чат
const BOT_HISTORY_TTL = 3 * 60 * 60 * 1000; // забываем разговор через 3 часа тишины
const BOT_NOTE =
  "\n\nСейчас вопрос пришёл не из встречи, а из Telegram-чата с ботом: пользователь пишет тебе сам. " +
  "Отвечай как в обычном чате — полно и по делу. Если вопрос уточняющий («а почему…», «поясни шаг 2») — " +
  "опирайся на предыдущие сообщения и на процитированное сообщение.";

let botPolling = false;

function botEnabled(s) {
  return !!(s.tgEnabled && s.tgBot && s.tgToken);
}

async function botState() {
  const { tgHistory = {}, tgLog = {}, tgSeen = {}, tgOffset = 0 } =
    await chrome.storage.local.get(["tgHistory", "tgLog", "tgSeen", "tgOffset"]);
  return { tgHistory, tgLog, tgSeen, tgOffset };
}

// Запомнить реплику в истории чата (для уточняющих вопросов).
async function rememberTurn(chat, role, text, messageId) {
  const { tgHistory, tgLog } = await botState();
  const now = Date.now();
  let h = (tgHistory[chat] || []).filter((t) => now - t.at < BOT_HISTORY_TTL);
  h.push({ role, text: String(text).slice(0, 6000), at: now });
  h = h.slice(-BOT_HISTORY_MAX);
  tgHistory[chat] = h;
  if (messageId) {
    tgLog[`${chat}:${messageId}`] = String(text).slice(0, 6000);
    const keys = Object.keys(tgLog);
    for (const k of keys.slice(0, Math.max(0, keys.length - 150))) delete tgLog[k];
  }
  await chrome.storage.local.set({ tgHistory, tgLog });
}

// Расшифровка открытой встречи (если есть) — спрашиваем вкладку, ждём не больше секунды.
function meetingTranscript() {
  const port = [...ports].pop();
  if (!port) return Promise.resolve("");
  return new Promise((resolve) => {
    const reqId = `tr-${Date.now()}-${Math.random()}`;
    const done = (text) => { port.onMessage.removeListener(onMsg); clearTimeout(t); resolve(text || ""); };
    const onMsg = (m) => { if (m?.type === "transcript" && m.reqId === reqId) done(m.text); };
    const t = setTimeout(() => done(""), 1000);
    port.onMessage.addListener(onMsg);
    try { port.postMessage({ type: "get-transcript", reqId }); } catch { done(""); }
  });
}

// Картинка ответа без открытой встречи — через скрытый offscreen-документ.
async function renderViaOffscreen(text) {
  try {
    if (!(await chrome.offscreen.hasDocument?.())) {
      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: ["DOM_PARSER"],
        justification: "Рисуем ответ Claude (формулы, код) картинкой для Telegram.",
      });
    }
    const r = await chrome.runtime.sendMessage({ target: "offscreen", type: "render-answer", text });
    return r?.png ? r : null;
  } catch {
    return null;
  }
}

const NEEDS_IMAGE = /\$|```|<svg|\\\(|\\\[/; // формулы, код, рисунки — Telegram их не покажет

async function botReply(s, chat, text, replyTo) {
  const one = { ...s, tgChatId: chat };
  const { main, own, title } = splitOwnWords(text);
  let answerId = null;
  if (main) {
    const img = NEEDS_IMAGE.test(main) ? await renderViaOffscreen(main) : null;
    const r = img
      ? await sendAnswerImage(one, img.png, img.height, img.width, { [chat]: replyTo }, "✳ Ответ Claude")
      : await sendText(one, main, { [chat]: replyTo });
    answerId = r.results[chat];
  }
  if (own) await sendText(one, `${title || "🗣 Своїми словами"}\n\n${own}`, { [chat]: replyTo });
  return answerId;
}

async function handleBotMessage(s, msg) {
  const chat = String(msg.chat.id);
  const name = msg.chat.title || [msg.chat.first_name, msg.chat.last_name].filter(Boolean).join(" ") || msg.chat.username || "";
  const { tgSeen } = await botState();
  tgSeen[chat] = { id: chat, name, group: msg.chat.type !== "private" };
  await chrome.storage.local.set({ tgSeen });

  const text = (msg.text || msg.caption || "").trim();
  const allowed = chatIds(s).includes(chat);
  const one = { ...s, tgChatId: chat };
  if (!allowed) {
    if (/^\/start/.test(text)) {
      await sendText(one, "👋 Бот бачить цей чат. Щоб отримувати відповіді, власник має натиснути «Найти chat id» у налаштуваннях Meet Assistant.").catch(() => {});
    }
    return;
  }
  if (/^\/start/.test(text)) {
    await sendText(one, "✅ Напиши будь-яке питання або надішли фото завдання — я відповім. /new — почати розмову заново.");
    return;
  }
  // «46», «білет 46», «12б» — сразу текст билета из конспекта (картинкой), без Claude и бесплатно.
  const ticketQ = !msg.photo && parseTicketQuery(text);
  if (ticketQ) {
    const t = findTicket(await loadAllMaterials(), ticketQ);
    if (t) {
      const img = await renderViaOffscreen(`## ${t.title}\n\n${t.md}`);
      const r = img
        ? await sendAnswerImage(one, img.png, img.height, img.width, { [chat]: msg.message_id }, "📚 З конспекту · напиши «поясни» — пояснять простіше")
        : await sendText(one, `${t.title}\n\n${t.md}`, { [chat]: msg.message_id });
      await rememberTurn(chat, "user", text, msg.message_id);
      await rememberTurn(chat, "assistant", `${t.title}\n\n${t.md}`, r.results[chat]);
      return;
    }
  }
  if (/^\/new/.test(text)) {
    const { tgHistory } = await botState();
    delete tgHistory[chat];
    await chrome.storage.local.set({ tgHistory });
    await sendText(one, "🧹 Почнемо спочатку.");
    return;
  }

  if (!s.apiKey) { await sendText(one, "⚠️ Не задан API-ключ Anthropic у налаштуваннях розширення."); return; }

  const typing = setInterval(() => sendTyping(s.tgToken, chat), 4500);
  sendTyping(s.tgToken, chat);
  try {
    // Фото: берём самое большое из присланных размеров.
    let image = null;
    const photo = msg.photo?.[msg.photo.length - 1] ||
      (msg.document?.mime_type?.startsWith("image/") ? msg.document : null);
    if (photo) image = await downloadFile(s.tgToken, photo.file_id);

    const { tgHistory, tgLog } = await botState();
    const history = (tgHistory[chat] || []).filter((t) => Date.now() - t.at < BOT_HISTORY_TTL);
    const quoted = msg.reply_to_message
      ? tgLog[`${chat}:${msg.reply_to_message.message_id}`] || msg.reply_to_message.text || msg.reply_to_message.caption || ""
      : "";
    const transcript = await meetingTranscript();
    const materials = await loadMaterials();

    let q = "";
    q += BOT_NOTE.trim() + "\n\n";
    if (transcript) q += "<transcript>\n" + transcript.slice(-s.transcriptChars) + "\n</transcript>\n\n";
    if (quoted) q += "Я отвечаю на это сообщение:\n<quoted>\n" + quoted + "\n</quoted>\n\n";
    if (image) q += TASKS.screenshot + (text ? "\n\nМой вопрос к фото: " + text : "");
    else q += "Мой вопрос: " + text;
    q += "\n\n" + CODE_RULE;
    if (s.ownWords) q += "\n\n" + OWN_WORDS_RULE;
    q += "\n\n" + languageRule(s);

    // Конспект — САМЫМ ПЕРВЫМ сообщением: тогда начало запроса не меняется от вопроса к вопросу
    // и совпадает с запросами встречи — материалы читаются из общего кэша (в ~10 раз дешевле).
    const messages = [];
    if (materials.length) {
      messages.push({ role: "user", content: [...materialBlocks(materials), { type: "text", text: "Выше — мои материалы (конспект). Опирайся на них." }] });
      messages.push({ role: "assistant", content: "Понял, буду опираться на материалы." });
    }
    // История — чередование user/assistant.
    for (const t of history) {
      if (!messages.length && t.role !== "user") continue;
      const last = messages[messages.length - 1];
      if (last && last.role === t.role) last.content += "\n\n" + t.text;
      else messages.push({ role: t.role, content: t.text });
    }
    if (messages.length && messages[messages.length - 1].role === "user") messages.pop();
    const content = [];
    if (image) content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } });
    content.push({ type: "text", text: q });
    messages.push({ role: "user", content });

    const client = new Anthropic({ apiKey: s.apiKey, dangerouslyAllowBrowser: true });
    const base = baseParams(s, materials);
    const final = await client.beta.messages.stream({
      ...base,
      // system — тот же, что у встречи (общий кэш); пометка «вопрос из Telegram» — в тексте вопроса.
      max_tokens: 16000,
      messages,
    }).finalMessage();

    if (materials.length) lastCacheUse = Date.now();
    if (final.stop_reason === "refusal") { await sendText(one, "⚠️ Модель відмовилась відповідати на це питання.", { [chat]: msg.message_id }); return; }
    let answer = final.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    if (final.stop_reason === "max_tokens") answer += "\n\n(відповідь обрізана — запитай решту окремо)";
    if (!answer) { await sendText(one, "🤷 Порожня відповідь, спробуй переформулювати.", { [chat]: msg.message_id }); return; }

    const answerId = await botReply(s, chat, answer, msg.message_id);
    await rememberTurn(chat, "user", (image ? "[фото завдання] " : "") + (text || ""), msg.message_id);
    await rememberTurn(chat, "assistant", answer, answerId);
  } catch (err) {
    await sendText(one, "⚠️ " + (errorText(err) || "Помилка"), { [chat]: msg.message_id }).catch(() => {});
  } finally {
    clearInterval(typing);
  }
}

// Долгий опрос Telegram (getUpdates). Работает, пока жив service worker; будильник раз в 30 с
// перезапускает опрос, если Chrome его усыпил. Сообщения обрабатываются по очереди.
async function botPoll() {
  if (botPolling) return;
  botPolling = true;
  try {
    for (;;) {
      const s = await loadSettings();
      if (!botEnabled(s)) break;
      const { tgOffset } = await botState();
      let updates;
      try {
        updates = await call(s.tgToken, "getUpdates", form({
          offset: String(tgOffset), timeout: "25", allowed_updates: JSON.stringify(["message"]),
        }));
      } catch (e) {
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      // Защита: уже обработанные сообщения пропускаем, а «пустые» ответы не крутим чаще раза в секунду.
      const fresh = updates.filter((u) => u.update_id >= tgOffset);
      if (!fresh.length) { await new Promise((r) => setTimeout(r, 1000)); continue; }
      for (const u of fresh) {
        await chrome.storage.local.set({ tgOffset: u.update_id + 1 });
        if (u.message) await handleBotMessage(s, u.message).catch(() => {});
      }
    }
  } finally {
    botPolling = false;
  }
}

chrome.alarms.create("tg-poll", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === "tg-poll") botPoll(); });
chrome.storage.onChanged.addListener((ch) => { if (ch.tgEnabled || ch.tgBot || ch.tgToken) botPoll(); });
botPoll();

// Страница настроек: «Найти chat id». Пока бот слушает сообщения, getUpdates занят им —
// поэтому отдаём чаты, которые бот уже видел; иначе спрашиваем Telegram напрямую.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "tg-find") return;
  (async () => {
    const { tgSeen } = await botState();
    let chats = Object.values(tgSeen);
    if (!botPolling) {
      try { chats = [...new Map([...chats, ...(await findChats(msg.token))].map((c) => [c.id, c])).values()]; }
      catch (e) { if (!chats.length) return sendResponse({ error: e.message }); }
    }
    sendResponse({ chats });
  })();
  return true;
});
