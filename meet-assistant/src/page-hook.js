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
  const failedAt = new WeakMap(); // дорожка, которую не удалось слушать -> когда (повторим позже)
  let enabled = false;
  let enabledAt = 0;
  let lastError = "";
  // Запасной вариант: если микрофон Мита перехватить не удалось — слушаем микрофон по умолчанию.
  const DEFAULT_MIC = { id: "default-mic", readyState: "live" };
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
  // Zoom (веб-клиент) проигрывает голоса через Web Audio, а не через <audio>. Подключаемся к выходу
  // звука страницы: всё, что идёт в динамики, дублируем в дорожку, которую слушает распознавание.
  const IS_MEET = location.hostname === "meet.google.com";
  const AN = window.AudioNode;
  if (!IS_MEET && AN && !AN.prototype.__meetAssistantHooked) {
    AN.prototype.__meetAssistantHooked = true;
    const connect = AN.prototype.connect;
    const taps = new WeakMap(); // AudioContext -> MediaStreamAudioDestinationNode
    AN.prototype.connect = function (target, ...rest) {
      const result = connect.call(this, target, ...rest);
      try {
        if (target instanceof AudioDestinationNode && this.context.createMediaStreamDestination) {
          let tap = taps.get(this.context);
          if (!tap) {
            tap = this.context.createMediaStreamDestination();
            taps.set(this.context, tap);
            for (const t of tap.stream.getAudioTracks()) remotes.add(t);
            setTimeout(sync, 0);
          }
          connect.call(this, tap);
        }
      } catch {}
      return result;
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
    // Неактивные каналы Мита (молчащие/завершённые) не дают запустить распознавание — пробуем раз в 15 с.
    if (Date.now() - (failedAt.get(track) || 0) < 15000) return;
    const rec = new (getSR())();
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = true;
    const s = { rec, stopped: false, utt: null };
    sessions.set(track, s);
    rec.onresult = (e) => {
      lastError = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const text = r[0].transcript.trim();
        if (!text) continue;
        if (!s.utt) s.utt = `${who}-${++seq}`;
        post({ type: "speech", utt: s.utt, who, text, final: r.isFinal });
        if (r.isFinal) s.utt = null;
      }
    };
    const start = () => (trackInput && track !== DEFAULT_MIC ? rec.start(track) : rec.start());
    rec.onerror = (e) => {
      if (e.error === "no-speech" || e.error === "aborted") return;
      lastError = e.error;
      post({ type: "speech-error", who, error: e.error });
      if (e.error === "not-allowed" || e.error === "service-not-allowed" || e.error === "language-not-supported") s.stopped = true;
    };
    // Chrome сам останавливает распознавание после пауз — перезапускаем, пока дорожка жива.
    rec.onend = () => {
      s.utt = null;
      if (s.stopped || !enabled || track.readyState !== "live") { sessions.delete(track); return; }
      setTimeout(() => { try { start(); } catch { sessions.delete(track); } }, 250);
    };
    try {
      start();
    } catch (err) {
      sessions.delete(track);
      failedAt.set(track, Date.now());
      // Для каналов собеседников это нормально (у Мита есть запасные неактивные каналы) — не пугаем ошибкой.
      if (who === "self") {
        lastError = String(err?.message || err);
        post({ type: "speech-error", who, error: lastError });
      }
    }
  }

  function stopAll() {
    for (const s of sessions.values()) { s.stopped = true; try { s.rec.abort(); } catch {} }
    sessions.clear();
  }

  function sync() {
    if (!enabled || !getSR()) return;
    for (const t of [...mics]) if (t.readyState !== "live") mics.delete(t);
    // Ещё один источник голосов собеседников — аудио/видео-плееры страницы Мита.
    for (const m of document.querySelectorAll("audio, video")) {
      const so = m.srcObject;
      if (!(so instanceof MediaStream)) continue;
      for (const t of so.getAudioTracks()) if (!mics.has(t)) remotes.add(t);
    }
    for (const t of [...remotes]) if (t.readyState !== "live") remotes.delete(t);
    // Свой голос: последняя живая дорожка микрофона (без поддержки дорожек — просто микрофон).
    const mic = [...mics].pop();
    // Остальные (старые) дорожки микрофона не слушаем — иначе свой голос распознается дважды.
    for (const t of mics) {
      if (t === mic) continue;
      const old = sessions.get(t);
      if (old) { old.stopped = true; try { old.rec.abort(); } catch {} sessions.delete(t); }
    }
    if (mic) {
      const def = sessions.get(DEFAULT_MIC);
      if (def) { def.stopped = true; try { def.rec.abort(); } catch {} sessions.delete(DEFAULT_MIC); }
      listen(mic, "self");
    } else if (Date.now() - enabledAt > 4000) {
      listen(DEFAULT_MIC, "self");
    }
    // Голоса собеседников — только если браузер умеет слушать дорожку.
    if (trackInput) for (const t of remotes) listen(t, "other");
    post({ type: "speech-status", supported: true, trackInput, chromeVer,
      mics: mic || sessions.has(DEFAULT_MIC) ? 1 : 0, micSource: mic ? "meet" : sessions.has(DEFAULT_MIC) ? "default" : "none",
      remotes: trackInput ? remotes.size : 0, remotesFound: remotes.size, listening: sessions.size, lastError });
  }

  window.addEventListener("message", (e) => {
    if (e.source !== window || e.data?.source !== "meet-assistant-cmd") return;
    if (e.data.type === "speech-config") {
      const want = !!e.data.enabled;
      const langChanged = e.data.lang && e.data.lang !== lang;
      lang = e.data.lang || lang;
      if (!getSR()) { post({ type: "speech-status", supported: false }); return; }
      if (!want || langChanged) stopAll();
      if (want && !enabled) enabledAt = Date.now();
      enabled = want;
      sync();
    }
  });
  setInterval(sync, 3000);
})();
