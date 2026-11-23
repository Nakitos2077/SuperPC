// Ответ Claude картинкой (PNG) — для Telegram, который не умеет рисовать формулы.
// Используется во вкладке встречи (content.js) и в скрытом offscreen-документе (бот без открытой встречи).
import { renderRich } from "./render.js";

// requestAnimationFrame не срабатывает в скрытых документах — подстраховываемся таймером.
const nextFrame = () => new Promise((r) => { requestAnimationFrame(() => r()); setTimeout(r, 50); });

const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  Object.assign(n, props);
  n.append(...kids);
  return n;
};

// ---------------------------------------------- Ответ картинкой (для Telegram)
// Рисуем ответ так же, как в панели (формулы, код, рисунки), но в светлой теме, и превращаем в PNG:
// DOM → SVG foreignObject → canvas. Меряем в отдельном скрытом блоке — работает и когда панель спрятана.
const TG_CSS = `
  .tg-render { box-sizing: border-box; width: 760px; padding: 22px 26px; background: #fff; color: #202124;
    font: 17px/1.55 "Segoe UI", system-ui, -apple-system, Roboto, sans-serif; }
  .tg-render p { margin: 0 0 8px; } .tg-render ul { margin: 0 0 8px; padding-left: 22px; }
  .tg-render .h { font-weight: 700; margin: 6px 0; } .tg-render b { color: #000; }
  .tg-render code { font: 15px ui-monospace, Consolas, monospace; background: #f1f3f4; padding: 0 4px; border-radius: 4px; }
  .tg-render .math-block { margin: 10px 0; text-align: center; } .tg-render math { font-size: 1.15em; }
  .tg-render .code-wrap { margin: 8px 0; border: 1px solid #dadce0; border-radius: 8px; background: #f8f9fa; }
  .tg-render .code-head { padding: 3px 10px; font-size: 12px; color: #5f6368; border-bottom: 1px solid #dadce0; }
  .tg-render .code-copy { display: none; }
  .tg-render pre { margin: 0; padding: 10px 12px; white-space: pre-wrap; word-break: break-word; }
  .tg-render pre code { background: none; padding: 0; font-size: 14.5px; }
  .tg-render .drawing { display: block; max-width: 100%; margin: 8px auto; }
  .tg-render .muted { color: #80868b; }`;

export async function renderAnswerPng(text) {
  if (!text.trim()) return { png: null };
  const holderHost = document.createElement("div");
  holderHost.style.cssText = "position:fixed;left:-20000px;top:0;pointer-events:none;";
  const sr = holderHost.attachShadow({ mode: "open" });
  const wrap = el("div", { className: "tg-render" });
  wrap.append(...renderRich(text));
  sr.append(el("style", { textContent: TG_CSS }), wrap);
  document.documentElement.append(holderHost);
  try {
    await Promise.all([...wrap.querySelectorAll("img")].map((i) => i.decode().catch(() => {})));
    await nextFrame();
    // Формулы в строке не переносятся — если что-то шире 760 px, расширяем картинку, чтобы ничего не обрезалось.
    let width = 760;
    if (wrap.scrollWidth > width) {
      width = Math.min(1800, wrap.scrollWidth + 30);
      wrap.style.width = width + "px";
      await nextFrame();
    }
    const height = Math.ceil(wrap.getBoundingClientRect().height) + 4;
    const xhtml = new XMLSerializer().serializeToString(wrap);
    const css = new XMLSerializer().serializeToString(el("style", { textContent: TG_CSS }));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml">${css}${xhtml}</div></foreignObject></svg>`;
    const img = new Image();
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    await img.decode();
    const scale = Math.min(2, 9000 / (width + height)); // чётче, но в пределах лимитов Telegram
    const c = document.createElement("canvas");
    c.width = Math.round(width * scale);
    c.height = Math.round(height * scale);
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0);
    return { png: c.toDataURL("image/png").split(",")[1], width: c.width, height: c.height };
  } finally {
    holderHost.remove();
  }
}
