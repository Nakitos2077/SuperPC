// Выполняется в контексте самой страницы Мита (world: MAIN), до её скриптов.
// Отслеживает, идёт ли сейчас демонстрация экрана, и сообщает об этом content-скрипту,
// чтобы панель подсказок пряталась и не попадала в трансляцию.
(() => {
  const md = navigator.mediaDevices;
  if (!md?.getDisplayMedia || md.__meetAssistantHooked) return;
  md.__meetAssistantHooked = true;

  const tracks = new Set();
  let presenting = false;
  const report = () => {
    for (const t of tracks) if (t.readyState !== "live") tracks.delete(t);
    const now = tracks.size > 0;
    if (now !== presenting) {
      presenting = now;
      post(now);
    }
  };

  const original = md.getDisplayMedia.bind(md);
  const post = (value) => window.postMessage({ source: "meet-assistant", type: "presenting", value }, location.origin);
  md.getDisplayMedia = async function (...args) {
    // Прячем панель заранее — ещё до выбора окна, чтобы она не попала даже в первый кадр.
    post(true);
    let stream;
    try {
      stream = await original(...args);
    } catch (e) {
      presenting = !tracks.size; // принудительно разошлём актуальное состояние
      report();
      throw e;
    }
    for (const t of stream.getVideoTracks()) {
      tracks.add(t);
      t.addEventListener("ended", report);
      const stop = t.stop.bind(t);
      t.stop = () => { stop(); setTimeout(report, 0); };
    }
    report();
    return stream;
  };
  setInterval(report, 1000);
})();
