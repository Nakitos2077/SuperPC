// Скрытый offscreen-документ: рисует ответ Claude картинкой для Telegram-бота,
// когда вкладка встречи не открыта (у service worker нет DOM).
import { renderAnswerPng } from "./answer-image.js";

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "offscreen" || msg.type !== "render-answer") return;
  renderAnswerPng(msg.text || "").then(sendResponse, () => sendResponse({ png: null }));
  return true;
});
