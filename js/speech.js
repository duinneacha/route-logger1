export function speechSupported() {
  return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
}

export function createSpeech({ onPhrase, onInterim, onState }) {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition = null;
  let userWantsMic = false;
  let interim = "";

  function ensure() {
    if (!Recognition || recognition) return recognition;
    recognition = new Recognition();
    recognition.lang = "en-IE";
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onresult = (event) => {
      if (!userWantsMic) return;
      let pending = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const text = event.results[i][0].transcript.trim();
        if (!text) continue;
        if (event.results[i].isFinal) {
          pending = "";
          interim = "";
          onPhrase(text);
        } else {
          pending = `${pending} ${text}`.trim();
        }
      }
      interim = pending;
      onInterim(interim);
    };

    recognition.onerror = (event) => {
      if (event.error === "network") {
        userWantsMic = false;
        interim = "";
        onInterim("");
        onState("network");
        return;
      }
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        userWantsMic = false;
        interim = "";
        onInterim("");
        onState("denied");
      }
    };

    recognition.onend = () => {
      if (userWantsMic && !document.hidden) {
        try {
          recognition.start();
          return;
        } catch {
          userWantsMic = false;
        }
      }
      onState(userWantsMic ? "listening" : "idle");
    };

    return recognition;
  }

  function start() {
    if (!ensure()) {
      onState("unsupported");
      return;
    }
    userWantsMic = true;
    interim = "";
    onState("listening");
    try {
      recognition.start();
    } catch {
      // Chrome throws if start runs while a session is already open.
    }
  }

  function stop() {
    const leftover = interim.trim();
    userWantsMic = false;
    interim = "";
    onInterim("");
    if (leftover) onPhrase(leftover);
    if (recognition) {
      try {
        recognition.stop();
      } catch {
        // Already stopped.
      }
    }
    onState("idle");
  }

  function listening() {
    return userWantsMic;
  }

  return { start, stop, listening };
}
