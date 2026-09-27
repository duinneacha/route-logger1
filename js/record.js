export function recorderSupported() {
  return typeof MediaRecorder === "function" && Boolean(navigator.mediaDevices);
}

export function createRecorder() {
  let recorder = null;
  let chunks = [];
  let stream = null;
  let active = false;

  function mimeType() {
    const types = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
    return types.find((type) => MediaRecorder.isTypeSupported(type)) || "";
  }

  function stopTracks() {
    if (stream) stream.getTracks().forEach((track) => track.stop());
    stream = null;
    recorder = null;
  }

  async function start() {
    if (active) return;
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = mimeType();
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    chunks = [];
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size) chunks.push(event.data);
    };
    recorder.start();
    active = true;
  }

  function stop() {
    if (!active || !recorder) {
      active = false;
      stopTracks();
      return Promise.resolve(null);
    }
    active = false;
    const current = recorder;
    return new Promise((resolve) => {
      current.onstop = () => {
        const blob = new Blob(chunks, { type: current.mimeType || "audio/webm" });
        chunks = [];
        stopTracks();
        resolve(blob.size ? blob : null);
      };
      if (current.state === "recording") current.requestData();
      if (current.state !== "inactive") current.stop();
      else resolve(null);
    });
  }

  function listening() {
    return active;
  }

  return { start, stop, listening };
}
