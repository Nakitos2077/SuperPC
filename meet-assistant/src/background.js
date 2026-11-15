// Service worker: принимает запросы из вкладки Мита и стримит ответы Claude обратно.
import Anthropic from "@anthropic-ai/sdk";
import { loadSettings } from "./settings.js";

// Модели, для которых доступен серверный fallback при отказе (refusal).
const FALLBACK_MODELS = new Set([
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-fable-5-2",
]);

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
};

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

function buildUserContent({ task, question, transcript, image }, s) {
  const tail = transcript.length > s.transcriptChars
    ? "…(начало опущено)\n" + transcript.slice(-s.transcriptChars)
    : transcript;
  const parts = [];
  if (image) {
    parts.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } });
  }
  let text = "<transcript>\n" + (tail || "(расшифровка пока пустая)") + "\n</transcript>\n\n";
  text += question ? "Мой вопрос: " + question : TASKS[task] || TASKS.hint;
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

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "claude") return;
  const active = new Map(); // id -> stream

  port.onDisconnect.addListener(() => {
    for (const st of active.values()) st.abort();
    active.clear();
  });

  port.onMessage.addListener(async (msg) => {
    if (msg.type === "abort") {
      active.get(msg.id)?.abort();
      return;
    }
    if (msg.type !== "ask") return;
    const { id } = msg;
    const send = (m) => { try { port.postMessage({ id, ...m }); } catch {} };

    const s = await loadSettings();
    if (!s.apiKey) {
      send({ type: "error", text: "Не задан API-ключ Anthropic. Открой настройки расширения (иконка на панели)." });
      return;
    }

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

    try {
      const stream = client.beta.messages.stream(params);
      active.set(id, stream);
      stream.on("text", (delta) => send({ type: "delta", text: delta }));
      const final = await stream.finalMessage();
      if (final.stop_reason === "refusal") {
        send({ type: "error", text: "Модель отказалась отвечать на этот запрос." });
      } else {
        send({ type: "done", stopReason: final.stop_reason });
      }
    } catch (err) {
      const text = errorText(err);
      send(text ? { type: "error", text } : { type: "done", stopReason: "aborted" });
    } finally {
      active.delete(id);
    }
  });
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
