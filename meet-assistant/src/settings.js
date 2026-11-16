// Общие настройки расширения (хранятся в chrome.storage.local).
export const DEFAULTS = {
  apiKey: "",
  model: "claude-opus-5-5",
  effort: "low", // для живых подсказок важна скорость; можно поднять в настройках
  language: "русском",
  context: "",
  autoMode: true, // Claude сам слушает и подсказывает — ничего вводить не нужно
  autoOnMyVoice: true, // реагировать, когда я сам зачитываю вопрос вслух
  hideWhilePresenting: true,
  speechSource: "audio", // "audio" — распознавание звука встречи, "captions" — субтитры Мита
  speechLang: "uk-UA",
  transcriptChars: 15000,
  materialsOnly: true, // отвечать строго по загруженным презентациям, ничего не добавляя от себя
  fastMode: true, // максимальная скорость: без «размышлений» модели (Haiku/Sonnet)
};

export async function loadSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...stored };
}
