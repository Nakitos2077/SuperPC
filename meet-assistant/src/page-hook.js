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

// ------------------------------------------------------------------------------
// Распознавание речи по ЗВУКУ (а не по субтитрам).
// Собираем звуковые дорожки встречи: свой микрофон (через getUserMedia Мита) и голоса
// собеседников (входящие дорожки WebRTC). Каждую дорожку слушает встроенное распознавание
// речи Chrome (SpeechRecognition.start(track), Chrome 135+). Текст отправляем content-скрипту.
(() => {
  const getSR = () => window.SpeechRecognition || window.webkitSpeechRecognition;
  const chromeVer = Number((navigator.userAgent.match(/Chrome\/(\d+)/) || [])[1] || 0);
  const trackInput = chromeVer >= 135; // start(MediaStreamTrack) появился в Chrome 135
  const post = (msg) => window.postMessage({ source: "meet-assistant", ...msg }, location.origin);

  const mics = new Set();    // свои дорожки микрофона
  const remotes = new Set(); // входящие дорожки собеседников
  const sessions = new Map(); // track -> распознаватель
  let enabled = false;
  let lang = "uk-UA";
  let seq = 0;

  // --- сбор дорожек
  const md = navigator.mediaDevices;
  if (md?.getUserMedia && !md.__meetAssistantMicHooked) {
    md.__meetAssistantMicHooked = true;
    const gum = md.getUserMedia.bind(md);
    md.getUserMedia = async function (...args) {
      const stream = await gum(...args);
      for (const t of stream.getAudioTracks()) { mics.add(t); sync(); }
      return stream;
    };
  }
  const PC = window.RTCPeerConnection;
  if (PC && !PC.__meetAssistantHooked) {
    const Hooked = function (...args) {
      const pc = new PC(...args);
      pc.addEventListener("track", (e) => {
        if (e.track?.kind === "audio") { remotes.add(e.track); sync(); }
      });
      return pc;
    };
    Hooked.prototype = PC.prototype;
    Object.setPrototypeOf(Hooked, PC);
    Hooked.__meetAssistantHooked = true;
    window.RTCPeerConnection = Hooked;
  }

  // --- распознавание
  function listen(track, who) {
    if (sessions.has(track)) return;
    const rec = new (getSR())();
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = true;
    const s = { rec, stopped: false, utt: null };
    sessions.set(track, s);
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const text = r[0].transcript.trim();
        if (!text) continue;
        if (!s.utt) s.utt = `${who}-${++seq}`;
        post({ type: "speech", utt: s.utt, who, text, final: r.isFinal });
        if (r.isFinal) s.utt = null;
      }
    };
    rec.onerror = (e) => {
      if (e.error === "no-speech" || e.error === "aborted") return;
      post({ type: "speech-error", who, error: e.error });
      if (e.error === "not-allowed" || e.error === "service-not-allowed" || e.error === "language-not-supported") s.stopped = true;
    };
    // Chrome сам останавливает распознавание после пауз — перезапускаем, пока дорожка жива.
    rec.onend = () => {
      s.utt = null;
      if (s.stopped || !enabled || track.readyState !== "live") { sessions.delete(track); return; }
      setTimeout(() => { try { trackInput ? rec.start(track) : rec.start(); } catch { sessions.delete(track); } }, 250);
    };
    try {
      trackInput ? rec.start(track) : rec.start();
    } catch (err) {
      sessions.delete(track);
      post({ type: "speech-error", who, error: String(err?.message || err) });
    }
  }

  function stopAll() {
    for (const s of sessions.values()) { s.stopped = true; try { s.rec.abort(); } catch {} }
    sessions.clear();
  }

  function sync() {
    if (!enabled || !getSR()) return;
    for (const t of [...mics]) if (t.readyState !== "live") mics.delete(t);
    for (const t of [...remotes]) if (t.readyState !== "live") remotes.delete(t);
    // Свой голос: последняя живая дорожка микрофона (без поддержки дорожек — просто микрофон).
    const mic = [...mics].pop();
    // Остальные (старые) дорожки микрофона не слушаем — иначе свой голос распознается дважды.
    for (const t of mics) {
      if (t === mic) continue;
      const old = sessions.get(t);
      if (old) { old.stopped = true; try { old.rec.abort(); } catch {} sessions.delete(t); }
    }
    if (mic) listen(mic, "self");
    // Голоса собеседников — только если браузер умеет слушать дорожку.
    if (trackInput) for (const t of remotes) listen(t, "other");
    post({ type: "speech-status", supported: true, trackInput, mics: mic ? 1 : 0, remotes: trackInput ? remotes.size : 0 });
  }

  window.addEventListener("message", (e) => {
    if (e.source !== window || e.data?.source !== "meet-assistant-cmd") return;
    if (e.data.type === "speech-config") {
      const want = !!e.data.enabled;
      const langChanged = e.data.lang && e.data.lang !== lang;
      lang = e.data.lang || lang;
      if (!getSR()) { post({ type: "speech-status", supported: false }); return; }
      if (!want || langChanged) stopAll();
      enabled = want;
      sync();
    }
  });
  setInterval(sync, 3000);
})();
