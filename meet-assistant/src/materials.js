// Материалы пользователя (презентации), по которым Claude отвечает в первую очередь.
// Хранятся в IndexedDB расширения (общей для страницы настроек и service worker):
// у chrome.storage.local лимит ~10 МБ, а презентации бывают больше.
// Формат записи: { id, name, kind: "pdf" | "text", data, size, pages, added }
//  - pdf  — base64 файла, Claude видит слайды целиком (текст, формулы, схемы, картинки);
//  - text — извлечённый текст (из PPTX/TXT), картинки при этом теряются.

export const MAX_TOTAL_BYTES = 24 * 1024 * 1024; // запрос к API ограничен 32 МБ, оставляем запас
export const MAX_TOTAL_PAGES = 550;

const DB_NAME = "meet-assistant";
const STORE = "materials";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const result = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(result?.result ?? result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error("транзакция отменена"));
    });
  } finally {
    db.close();
  }
}

export async function loadMaterials() {
  const list = await tx("readonly", (s) => s.getAll());
  return (list || []).sort((a, b) => (a.added || 0) - (b.added || 0));
}

export async function addMaterials(items) {
  await tx("readwrite", (s) => { for (const it of items) s.put(it); });
}

export async function deleteMaterial(id) {
  await tx("readwrite", (s) => s.delete(id));
}

// Блоки документов для запроса. На последнем ставим cache_control: тогда при следующих запросах
// (пока идёт встреча) презентации читаются из кэша — примерно в 10 раз дешевле и быстрее.
export function materialBlocks(list) {
  const blocks = list.map((m, i) => ({
    type: "document",
    title: `Презентация ${i + 1}: ${m.name}`,
    source: m.kind === "pdf"
      ? { type: "base64", media_type: "application/pdf", data: m.data }
      : { type: "text", media_type: "text/plain", data: m.data },
  }));
  // Кэш на 1 час: вопросы в боте и на встрече бывают реже, чем раз в 5 минут (стандартный срок кэша).
  // Запись в такой кэш дороже (×2), но каждое следующее чтение в течение часа — ×0.1 от цены.
  if (blocks.length) blocks[blocks.length - 1].cache_control = { type: "ephemeral", ttl: "1h" };
  return blocks;
}

// Обновить материал (например, переключатель «отправлять Claude»).
export async function updateMaterial(item) {
  await tx("readwrite", (s) => s.put(item));
}

// Материалы, которые уходят Claude (переключатель «🤖» в настройках; по умолчанию — все).
export function forClaude(list) {
  return list.filter((m) => m.claude !== false);
}

// ----------------------------------------------------------------- Билеты из конспекта
// Запрос вида «46», «білет 46», «билет 46», «питання 12б», «12б», «46 білет» → { num, sub }.
const TICKET_RE = /^\s*(?:(?:б[іи]л[еє]т|питання|вопрос|№)\s*)?(\d{1,3})\s*([абвгabcd])?\)?\s*(?:б[іи]л[еє]т)?\s*[.!?]?\s*$/i;
const LATIN_SUB = { a: "а", b: "б", c: "в", d: "г" };

export function parseTicketQuery(text) {
  const m = String(text || "").match(TICKET_RE);
  if (!m) return null;
  const sub = m[2] ? (LATIN_SUB[m[2].toLowerCase()] || m[2].toLowerCase()) : null;
  return { num: Number(m[1]), sub };
}

// Найти билет в текстовых материалах (разметка «## Білет N. Назва», «### Nа) …»).
// Возвращает { title, md } — готовый текст из конспекта, без запроса к Claude.
export function findTicket(list, query) {
  const q = typeof query === "string" ? parseTicketQuery(query) : query;
  if (!q) return null;
  for (const mat of list) {
    if (mat.kind !== "text") continue;
    const text = mat.data;
    const head = new RegExp(`^##\\s+(?:Б[іи]лет|Билет)\\s+${q.num}\\b[^\\n]*$`, "mi").exec(text);
    if (!head) continue;
    const rest = text.slice(head.index + head[0].length);
    const next = rest.search(/^##\s/m);
    let section = (next === -1 ? rest : rest.slice(0, next)).replace(/\n-{3,}\s*$/, "").trim();
    let title = head[0].replace(/^#+\s*/, "");
    if (q.sub) {
      const subHead = new RegExp(`^###\\s+${q.num}\\s*${q.sub}\\)[^\\n]*$`, "mi").exec(section);
      if (subHead) {
        const after = section.slice(subHead.index + subHead[0].length);
        const end = after.search(/^###\s/m);
        section = (end === -1 ? after : after.slice(0, end)).trim();
        title = subHead[0].replace(/^#+\s*/, "") + " (білет " + q.num + ")";
      }
    }
    return { title, md: section, source: mat.name };
  }
  return null;
}
