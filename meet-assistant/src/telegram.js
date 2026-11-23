// Отправка скринов и ответов Claude в Telegram — в один или несколько чатов с ботом пользователя.
// Бот создаётся у @BotFather; токен и chat id хранятся только в этом браузере.
// Получатели: каждый, кто нажал Start у бота (личный чат), или группа, куда добавлен бот.

const API = (token, method) => `https://api.telegram.org/bot${token}/${method}`;
const MAX_TEXT = 4000; // лимит Telegram — 4096 символов на сообщение

export async function call(token, method, body) {
  const res = await fetch(API(token, method), { method: "POST", body });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!data?.ok) throw new Error(data?.description || `HTTP ${res.status}`);
  return data.result;
}

export function form(fields) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null) f.append(k, v);
  return f;
}

// «123, -100456» → ["123", "-100456"]
export function chatIds(s) {
  return String(s.tgChatId || "").split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
}

export function telegramReady(s) {
  return !!(s.tgEnabled && s.tgToken && chatIds(s).length);
}

// Шлём в каждый чат; ошибки по отдельным чатам собираем, но остальные чаты всё равно получают.
async function eachChat(s, fn) {
  const results = {};
  const errors = [];
  await Promise.all(chatIds(s).map(async (chat) => {
    try { results[chat] = await fn(chat); } catch (e) { errors.push(`${chat}: ${e.message}`); }
  }));
  if (errors.length && !Object.keys(results).length) throw new Error(errors.join("; "));
  return { results, errors };
}

// Фото (base64 JPEG) с подписью. Возвращает { chatId: messageId } — к ним потом прикрепляем ответ.
export async function sendPhoto(s, base64, caption) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const photo = new Blob([bytes], { type: "image/jpeg" });
  const { results } = await eachChat(s, async (chat) => {
    const f = form({ chat_id: chat, caption: (caption || "").slice(0, 1000) });
    f.append("photo", photo, "screen.jpg");
    return (await call(s.tgToken, "sendPhoto", f)).message_id;
  });
  return results;
}

// Картинка ответа (PNG base64) ответом на фото скрина. Очень длинную — документом (у фото есть лимит размеров).
export async function sendAnswerImage(s, pngBase64, height, width, replyTo, caption) {
  const bytes = Uint8Array.from(atob(pngBase64), (c) => c.charCodeAt(0));
  const file = new Blob([bytes], { type: "image/png" });
  const asPhoto = width + height <= 9500 && height / width <= 19;
  return eachChat(s, async (chat) => {
    const f = form({
      chat_id: chat,
      caption: (caption || "").slice(0, 1000),
      reply_to_message_id: replyTo?.[chat] ? String(replyTo[chat]) : undefined,
      allow_sending_without_reply: "true",
    });
    f.append(asPhoto ? "photo" : "document", file, "answer.png");
    return (await call(s.tgToken, asPhoto ? "sendPhoto" : "sendDocument", f)).message_id;
  });
}

// Текст (длинный — несколькими сообщениями), ответом на фото скрина.
export async function sendText(s, text, replyTo) {
  const parts = [];
  for (let i = 0; i < text.length; i += MAX_TEXT) parts.push(text.slice(i, i + MAX_TEXT));
  return eachChat(s, async (chat) => {
    let first = null;
    for (const [i, part] of parts.entries()) {
      const m = await call(s.tgToken, "sendMessage", form({
        chat_id: chat,
        text: part,
        reply_to_message_id: i === 0 && replyTo?.[chat] ? String(replyTo[chat]) : undefined,
        allow_sending_without_reply: "true",
      }));
      first ??= m.message_id;
    }
    return first;
  });
}

// «Печатает…» в чате, пока Claude думает.
export function sendTyping(token, chat) {
  return call(token, "sendChatAction", form({ chat_id: chat, action: "typing" })).catch(() => {});
}

// Скачать файл из Telegram (фото, присланное боту) — base64.
export async function downloadFile(token, fileId) {
  const file = await call(token, "getFile", form({ file_id: fileId }));
  const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
  if (!res.ok) throw new Error("не удалось скачать фото: HTTP " + res.status);
  const bytes = new Uint8Array(await res.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// Все чаты, которые писали боту (каждый получатель нажимает Start; в группе — пишет /start@имя_бота).
export async function findChats(token) {
  const updates = await call(token, "getUpdates", form({ limit: "100" }));
  const chats = new Map();
  for (const u of updates) {
    const chat = u.message?.chat || u.my_chat_member?.chat || u.channel_post?.chat;
    if (!chat) continue;
    const name = chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(" ") || chat.username || "";
    chats.set(String(chat.id), { id: String(chat.id), name, group: chat.type !== "private" });
  }
  return [...chats.values()];
}
