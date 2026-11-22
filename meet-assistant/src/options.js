import { DEFAULTS, loadSettings } from "./settings.js";
import { findChatId, sendText } from "./telegram.js";

const $ = (id) => document.getElementById(id);

loadSettings().then((s) => {
  for (const key of Object.keys(DEFAULTS)) {
    const input = $(key);
    if (!input) continue;
    if (input.type === "checkbox") input.checked = !!s[key];
    else input.value = s[key];
  }
});

$("save").onclick = async () => {
  const data = {};
  for (const key of Object.keys(DEFAULTS)) {
    const input = $(key);
    if (!input) continue;
    if (input.type === "checkbox") data[key] = input.checked;
    else if (input.type === "number") data[key] = Number(input.value) || DEFAULTS[key];
    else data[key] = input.value.trim();
  }
  await chrome.storage.local.set(data);
  $("saved").textContent = "Сохранено ✓";
  setTimeout(() => ($("saved").textContent = ""), 2000);
};

// ---------------------------------------------------------------- Пресеты режима
const PRESETS = {
  presetAccurate: { label: "🎯 Точно, как в чате", values: { model: "claude-sonnet-5-5", effort: "medium", fastMode: false, webSearch: true } },
  presetFast: { label: "⚡ Быстро и дёшево", values: { model: "claude-haiku-5-5", effort: "low", fastMode: true, webSearch: false } },
};
for (const [id, preset] of Object.entries(PRESETS)) {
  $(id).onclick = async () => {
    for (const [key, value] of Object.entries(preset.values)) {
      const input = $(key);
      if (!input) continue;
      if (input.type === "checkbox") input.checked = value;
      else input.value = value;
    }
    await chrome.storage.local.set(preset.values);
    $("presetSaved").textContent = `Включён режим «${preset.label}» ✓`;
  };
}

// ---------------------------------------------------------------- Telegram
function tgStatus(text, error = false) {
  $("tgStatus").textContent = text;
  $("tgStatus").classList.toggle("err", error);
}
$("tgFind").onclick = async () => {
  const token = $("tgToken").value.trim();
  if (!token) return tgStatus("Сначала вставь токен бота.", true);
  tgStatus("Ищу…");
  try {
    const chat = await findChatId(token);
    if (!chat) return tgStatus("Бот пока не получил сообщений. Открой своего бота в Telegram, отправь /start и нажми ещё раз.", true);
    $("tgChatId").value = chat.id;
    await chrome.storage.local.set({ tgToken: token, tgChatId: chat.id });
    tgStatus(`Нашёл чат${chat.name ? " «" + chat.name + "»" : ""} (id ${chat.id}) ✓ Сохранено.`);
  } catch (e) {
    tgStatus("Ошибка Telegram: " + e.message + (/Unauthorized/i.test(e.message) ? " — проверь токен." : ""), true);
  }
};
$("tgTest").onclick = async () => {
  const s = { tgToken: $("tgToken").value.trim(), tgChatId: $("tgChatId").value.trim() };
  if (!s.tgToken || !s.tgChatId) return tgStatus("Нужны токен и chat id.", true);
  try {
    await sendText(s, "✅ Meet Assistant подключён. Сюда будут приходить скрины и ответы Claude.");
    tgStatus("Тестовое сообщение отправлено — проверь Telegram ✓");
  } catch (e) {
    tgStatus("Ошибка Telegram: " + e.message, true);
  }
};

// ---------------------------------------------------------------- Презентации
import JSZip from "jszip";
import { loadMaterials, addMaterials, deleteMaterial, MAX_TOTAL_BYTES, MAX_TOTAL_PAGES } from "./materials.js";

const fmtSize = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + " МБ" : Math.ceil(n / 1024) + " КБ");

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// Примерное число страниц PDF (для проверки лимита).
function countPdfPages(buf) {
  const text = new TextDecoder("latin1").decode(buf);
  return (text.match(/\/Type\s*\/Page(?![s\w])/g) || []).length || 1;
}

// Текст слайдов (и заметок докладчика) из PPTX.
async function pptxToText(buf) {
  const zip = await JSZip.loadAsync(buf);
  const num = (p) => Number(p.match(/(\d+)\.xml$/)?.[1] || 0);
  const parser = new DOMParser();
  const textOf = (xml) =>
    [...parser.parseFromString(xml, "application/xml").getElementsByTagName("a:p")]
      .map((p) => [...p.getElementsByTagName("a:t")].map((t) => t.textContent).join(""))
      .filter((t) => t.trim())
      .join("\n");
  const slides = Object.keys(zip.files).filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p)).sort((a, b) => num(a) - num(b));
  const out = [];
  for (const path of slides) {
    const n = num(path);
    let block = `=== Слайд ${n} ===\n` + textOf(await zip.file(path).async("string"));
    const notes = zip.file(`ppt/notesSlides/notesSlide${n}.xml`);
    if (notes) {
      const t = textOf(await notes.async("string")).replace(/^\d+$/m, "").trim();
      if (t) block += "\n[Заметки докладчика] " + t;
    }
    out.push(block);
  }
  return out.join("\n\n");
}

async function renderMaterials() {
  const list = await loadMaterials();
  const box = $("materials");
  box.replaceChildren();
  if (!list.length) {
    box.append(Object.assign(document.createElement("div"), { className: "hint", textContent: "Пока ничего не загружено." }));
  }
  list.forEach((m, i) => {
    const row = document.createElement("div");
    row.className = "mat";
    const name = Object.assign(document.createElement("span"), { className: "name", textContent: `${i + 1}. ${m.name}` });
    const meta = Object.assign(document.createElement("span"), {
      className: "meta",
      textContent: m.kind === "pdf" ? `PDF · ~${m.pages} стр. · ${fmtSize(m.size)}` : `текст · ${fmtSize(m.size)}`,
    });
    const del = Object.assign(document.createElement("button"), { textContent: "Удалить" });
    del.onclick = async () => {
      await deleteMaterial(m.id);
      renderMaterials();
    };
    row.append(name, meta, del);
    box.append(row);
  });
  const bytes = list.reduce((n, m) => n + m.size, 0);
  const pages = list.reduce((n, m) => n + (m.pages || 0), 0);
  $("materialsStatus").textContent = list.length ? `Всего: ${fmtSize(bytes)}, ~${pages} стр. PDF.` : "";
}

$("materialFiles").onchange = async (e) => {
  const status = $("materialsStatus");
  status.classList.remove("err");
  const list = await loadMaterials();
  const added = [];
  try {
    for (const file of e.target.files) {
      status.textContent = `Обрабатываю «${file.name}»…`;
      const buf = await file.arrayBuffer();
      const ext = file.name.split(".").pop().toLowerCase();
      let item;
      if (ext === "pdf") {
        item = { kind: "pdf", data: toBase64(buf), size: buf.byteLength, pages: countPdfPages(buf) };
      } else if (ext === "pptx") {
        const text = await pptxToText(buf);
        item = { kind: "text", data: text, size: text.length, pages: 0 };
      } else {
        const text = new TextDecoder().decode(buf);
        item = { kind: "text", data: text, size: text.length, pages: 0 };
      }
      const rec = { id: crypto.randomUUID(), name: file.name, added: Date.now() + added.length, ...item };
      list.push(rec);
      added.push(rec);
    }
    const bytes = list.reduce((n, m) => n + (m.kind === "pdf" ? m.data.length : m.size), 0);
    const pages = list.reduce((n, m) => n + (m.pages || 0), 0);
    if (bytes > MAX_TOTAL_BYTES) throw new Error(`Слишком большой объём (${fmtSize(bytes)}). Максимум ~${fmtSize(MAX_TOTAL_BYTES)} — сожми PDF или убери лишнее.`);
    if (pages > MAX_TOTAL_PAGES) throw new Error(`Слишком много страниц (~${pages}). Максимум ~${MAX_TOTAL_PAGES}.`);
    await addMaterials(added);
    await renderMaterials();
  } catch (err) {
    status.classList.add("err");
    status.textContent = "Не получилось: " + err.message;
  }
  e.target.value = "";
};

renderMaterials();
