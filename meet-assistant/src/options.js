import { DEFAULTS, loadSettings } from "./settings.js";

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
