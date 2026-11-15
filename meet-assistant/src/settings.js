// Общие настройки расширения (хранятся в chrome.storage.local).
export const DEFAULTS = {
  apiKey: "",
  model: "claude-opus-5-5",
  effort: "low", // для живых подсказок важна скорость; можно поднять в настройках
  language: "русском",
  context: "",
  autoMode: false,
  transcriptChars: 15000,
};

export async function loadSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...stored };
}
