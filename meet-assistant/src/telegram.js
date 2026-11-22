// Отправка скринов и ответов Claude в Telegram-чат с ботом пользователя.
// Бот создаётся у @BotFather; токен и chat id хранятся только в этом браузере.

const API = (token, method) => `https://api.telegram.org/bot${token}/${method}`;
const MAX_TEXT = 4000; // лимит Telegram — 4096 символов на сообщение

async function call(token, method, body) {
  const res = await fetch(API(token, method), { method: "POST", body });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!data?.ok) throw new Error(data?.description || `HTTP ${res.status}`);
  return data.result;
}

function form(fields) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null) f.append(k, v);
  return f;
}

export function telegramReady(s) {
  return !!(s.tgEnabled && s.tgToken && s.tgChatId);
}

// Фото (base64 JPEG) с подписью. Возвращает id сообщения — к нему потом прикрепляем ответ.
export async function sendPhoto(s, base64, caption) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const photo = new Blob([bytes], { type: "image/jpeg" });
  const f = form({ chat_id: s.tgChatId, caption: (caption || "").slice(0, 1000) });
  f.append("photo", photo, "screen.jpg");
  const msg = await call(s.tgToken, "sendPhoto", f);
  return msg.message_id;
}

// Текст ответа (длинный — несколькими сообщениями), ответом на фото.
export async function sendText(s, text, replyTo) {
  const parts = [];
  for (let i = 0; i < text.length; i += MAX_TEXT) parts.push(text.slice(i, i + MAX_TEXT));
  for (const [i, part] of parts.entries()) {
    await call(s.tgToken, "sendMessage", form({
      chat_id: s.tgChatId,
      text: part,
      reply_to_message_id: i === 0 && replyTo ? String(replyTo) : undefined,
      allow_sending_without_reply: "true",
    }));
  }
}

// Найти chat id: берём последний чат, который написал боту (пользователь отправляет /start).
export async function findChatId(token) {
  const updates = await call(token, "getUpdates", form({ limit: "20" }));
  for (let i = updates.length - 1; i >= 0; i--) {
    const chat = updates[i].message?.chat || updates[i].my_chat_member?.chat;
    if (chat) return { id: String(chat.id), name: chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(" ") || chat.username || "" };
  }
  return null;
}
