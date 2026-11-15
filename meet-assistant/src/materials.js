// Материалы пользователя (презентации), по которым Claude отвечает в первую очередь.
// Хранятся в chrome.storage.local (с разрешением unlimitedStorage) под ключом "materials".
// Формат: [{ id, name, kind: "pdf" | "text", data, size, pages }]
//  - pdf  — base64 файла, Claude видит слайды целиком (текст, формулы, схемы, картинки);
//  - text — извлечённый текст (из PPTX/TXT), картинки при этом теряются.

export const MAX_TOTAL_BYTES = 24 * 1024 * 1024; // запрос к API ограничен 32 МБ, оставляем запас
export const MAX_TOTAL_PAGES = 550;

export async function loadMaterials() {
  const { materials } = await chrome.storage.local.get("materials");
  return Array.isArray(materials) ? materials : [];
}

export async function saveMaterials(list) {
  await chrome.storage.local.set({ materials: list });
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
  if (blocks.length) blocks[blocks.length - 1].cache_control = { type: "ephemeral" };
  return blocks;
}
