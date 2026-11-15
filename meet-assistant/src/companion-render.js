// Точка входа сборки рендера для окна-компаньона (кладётся в companion/render.js).
import { renderRich, RICH_CSS } from "./render.js";

window.renderRich = renderRich;
const style = document.createElement("style");
style.textContent = RICH_CSS;
document.head.append(style);
