import { allRounds, deleteNote, notesForRound, putNote, putRound } from "./db.js";
import { createTracker } from "./geo.js";
import { createSpeech, speechSupported } from "./speech.js";

const titleEl = document.querySelector("#title");
const statusEl = document.querySelector("#status");
const mainEl = document.querySelector("#main");
const dockEl = document.querySelector("#dock");
const consentEl = document.querySelector("#consent");
const liveEl = document.querySelector("#live");
const pairEl = document.querySelector("#pair");
const speakBtn = document.querySelector("#speak-btn");
const startBtn = document.querySelector("#start-btn");
const endBtn = document.querySelector("#end-round");
const backBtn = document.querySelector("#back");
const composerEl = document.querySelector("#composer");
const draftEl = document.querySelector("#draft");
const cameraInput = document.querySelector("#camera");

const timeFormat = new Intl.DateTimeFormat("en-IE", { hour: "2-digit", minute: "2-digit" });
const dayFormat = new Intl.DateTimeFormat("en-IE", {
  weekday: "long",
  day: "numeric",
  month: "long",
});

let round = null;
let notes = [];
let viewingPast = false;
let editingId = null;
let talkNoteId = null;
let talkPin = null;
let talkGeneration = 0;
let photoTargetId = null;
let phraseChain = Promise.resolve();
let roundWrite = Promise.resolve();
let startingRound = false;
let geoStatus = "waiting";
const photoUrls = new Map();

const tracker = createTracker({
  onPoint: (pin) => {
    if (!round || round.endedAt || document.hidden) return false;
    round.points.push(pin);
    saveRound().then(paintStatus);
    return true;
  },
  onStatus: (status) => {
    geoStatus = status;
    paintStatus();
  },
});

const speech = createSpeech({
  onPhrase: (text) => queuePhrase(text),
  onInterim: (text) => {
    liveEl.hidden = !text;
    liveEl.textContent = text;
  },
  onState: (state) => {
    if (state === "listening") {
      speakBtn.textContent = "Stop";
      speakBtn.setAttribute("aria-pressed", "true");
      consentEl.textContent = "Listening. Press the side button to end this talk.";
      return;
    }
    speakBtn.textContent = "Speak";
    speakBtn.setAttribute("aria-pressed", "false");
    liveEl.hidden = true;
    liveEl.textContent = "";
    if (state === "denied") {
      consentEl.textContent = "Microphone is blocked. Allow it in the browser settings.";
    } else if (state === "unsupported") {
      consentEl.textContent = "Speaking needs Chrome. You can still type a note.";
    } else {
      consentEl.textContent = "Ask the person with you before you use the microphone.";
    }
  },
});

function showFailure(error) {
  statusEl.textContent = error && error.message ? error.message : "Something went wrong. Try that again.";
}

function formatWhen(timestamp) {
  return `${dayFormat.format(timestamp)}, ${timeFormat.format(timestamp)}`;
}

function positionSentence() {
  if (geoStatus === "fix") {
    const count = round && round.points ? round.points.length : 0;
    return count === 1 ? "Position on. 1 trail point." : `Position on. ${count} trail points.`;
  }
  if (geoStatus === "denied") return "Location is blocked. Allow it to pin notes.";
  if (geoStatus === "unavailable") return "This phone has no location service.";
  if (geoStatus === "error") return "Position failed. Try again outdoors.";
  return "Waiting for position.";
}

function paintStatus() {
  if (!round) {
    statusEl.textContent = "No round yet";
    return;
  }
  const started = `Started ${formatWhen(round.startedAt)}`;
  if (round.endedAt) {
    statusEl.textContent = `${started}. Ended ${timeFormat.format(round.endedAt)}.`;
    return;
  }
  statusEl.textContent = `${started}. ${positionSentence()}`;
}

function saveRound() {
  const snapshot = {
    id: round.id,
    startedAt: round.startedAt,
    endedAt: round.endedAt,
    points: round.points.map((point) => ({ ...point })),
  };
  roundWrite = roundWrite.then(() => putRound(snapshot)).catch(showFailure);
  return roundWrite;
}

function pinFields(pin) {
  if (!pin) return { lat: null, lng: null, accuracy: null };
  return { lat: pin.lat, lng: pin.lng, accuracy: pin.accuracy };
}

function blankNote(extra) {
  return {
    id: crypto.randomUUID(),
    roundId: round.id,
    text: "",
    at: Date.now(),
    photo: null,
    ...pinFields(talkPin),
    ...extra,
  };
}

function foldWords(text) {
  return text.replace(/\s+/g, " ").trim();
}

function mergeSpeech(existing, incoming) {
  const next = foldWords(incoming);
  const prev = foldWords(existing);
  if (!prev) return next;
  if (!next) return prev;
  const prevFold = prev.toLowerCase();
  const nextFold = next.toLowerCase();
  if (nextFold === prevFold || prevFold.endsWith(` ${nextFold}`)) return prev;
  if (nextFold.startsWith(prevFold)) return next;
  if (prevFold.startsWith(nextFold)) return prev;
  const words = next.split(" ").filter(Boolean).length;
  if (words <= 3) return `${prev} ${next}`;
  return `${prev}\n${next}`;
}

function tidySpeech(text) {
  if (!text) return "";
  return text.split(/\n+/).reduce((combined, line) => mergeSpeech(combined, line), "");
}

function formatPlace(lat, lng) {
  const north = lat >= 0 ? "N" : "S";
  const east = lng >= 0 ? "E" : "W";
  const latitude = `${Math.abs(lat).toFixed(5)}° ${north}`;
  const longitude = `${Math.abs(lng).toFixed(5)}° ${east}`;
  return `${latitude}, ${longitude}`;
}

function queuePhrase(text) {
  const phrase = text.trim();
  if (!phrase || !round || round.endedAt) return;
  if (!talkNoteId) {
    const note = blankNote({ text: phrase });
    talkNoteId = note.id;
    notes.push(note);
  }
  const noteId = talkNoteId;
  phraseChain = phraseChain.then(() => commitPhrase(noteId, phrase)).catch(showFailure);
}

async function commitPhrase(noteId, phrase) {
  const note = notes.find((item) => item.id === noteId);
  if (!note || !round || round.endedAt) return;
  note.text = mergeSpeech(note.text, phrase);
  if (note.lat == null) {
    const pin = talkPin || (await tracker.current());
    if (pin) Object.assign(note, pinFields(pin));
  }
  await putNote(note);
  if (editingId !== note.id) renderNotes();
}

function endTalk() {
  if (!speech.listening()) return;
  const generation = talkGeneration;
  speech.stop();
  phraseChain = phraseChain.then(() => {
    if (talkGeneration === generation) {
      talkNoteId = null;
      talkPin = null;
    }
  });
}

function screenWentAway() {
  endTalk();
  tracker.stop();
}

function screenCameBack() {
  if (round && !round.endedAt && !viewingPast) tracker.start();
}

async function loadNotes() {
  notes = round ? await notesForRound(round.id) : [];
  await Promise.all(notes.map(async (note) => {
    const tidy = tidySpeech(note.text);
    if (tidy !== note.text) {
      note.text = tidy;
      await putNote(note);
    }
  }));
}

function showDock(mode) {
  composerEl.hidden = true;
  if (mode === "home") {
    dockEl.hidden = false;
    consentEl.hidden = true;
    pairEl.hidden = true;
    speakBtn.hidden = true;
    startBtn.hidden = false;
    endBtn.hidden = true;
    backBtn.hidden = true;
    return;
  }
  if (mode === "active") {
    dockEl.hidden = false;
    consentEl.hidden = false;
    pairEl.hidden = false;
    speakBtn.hidden = false;
    startBtn.hidden = true;
    endBtn.hidden = false;
    backBtn.hidden = true;
    return;
  }
  dockEl.hidden = true;
  endBtn.hidden = true;
  backBtn.hidden = false;
}

async function showHome() {
  viewingPast = false;
  editingId = null;
  const rounds = await allRounds();
  const unfinished = rounds.find((item) => !item.endedAt);
  if (unfinished) {
    await openExisting(unfinished);
    return;
  }
  round = null;
  notes = [];
  titleEl.textContent = "Route notes";
  paintStatus();
  showDock("home");
  mainEl.replaceChildren();

  const lead = document.createElement("p");
  lead.className = "lead";
  lead.textContent = "Start a round, then speak at the door.";
  mainEl.append(lead);

  const finished = rounds.filter((item) => item.endedAt);
  if (!finished.length) return;

  const list = document.createElement("ul");
  list.className = "round-list";
  finished.forEach((item) => {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = formatWhen(item.startedAt);
    button.addEventListener("click", () => openExisting(item));
    li.append(button);
    list.append(li);
  });
  mainEl.append(list);
}

async function openExisting(existing) {
  round = existing;
  viewingPast = Boolean(round.endedAt);
  editingId = null;
  titleEl.textContent = viewingPast ? "Past round" : "This round";
  await loadNotes();
  paintStatus();
  showDock(viewingPast ? "past" : "active");
  if (!viewingPast) tracker.start();
  else tracker.stop();
  renderNotes();
}

async function beginRound() {
  if (startingRound || (round && !round.endedAt)) return;
  startingRound = true;
  round = {
    id: crypto.randomUUID(),
    startedAt: Date.now(),
    endedAt: null,
    points: [],
  };
  viewingPast = false;
  geoStatus = "waiting";
  tracker.start();
  try {
    await saveRound();
  } finally {
    startingRound = false;
  }
  notes = [];
  titleEl.textContent = "This round";
  paintStatus();
  showDock("active");
  renderNotes();
}

async function finishRound() {
  if (!round || round.endedAt) return;
  endTalk();
  await phraseChain;
  tracker.stop();
  round.endedAt = Date.now();
  await saveRound();
  viewingPast = true;
  titleEl.textContent = "Past round";
  paintStatus();
  showDock("past");
  renderNotes();
}

function renderNotes() {
  mainEl.replaceChildren();
  if (!notes.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = round && round.endedAt ? "No notes on this round." : "No notes yet.";
    mainEl.append(empty);
  } else {
    notes.forEach((note) => mainEl.append(renderNote(note)));
  }
  mainEl.append(renderExports());
}

function renderTime(note) {
  const time = document.createElement("time");
  time.dateTime = new Date(note.at).toISOString();
  time.textContent = timeFormat.format(note.at);
  return time;
}

function renderPlace(note) {
  if (note.lat == null || note.lng == null) return null;
  const place = formatPlace(note.lat, note.lng);
  const link = document.createElement("a");
  link.className = "place";
  link.href = `https://www.google.com/maps?q=${note.lat},${note.lng}`;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = place;
  link.setAttribute("aria-label", `${place}. Open in Google Maps`);
  return link;
}

function renderNote(note) {
  const article = document.createElement("article");
  article.className = "note";
  article.dataset.noteId = note.id;

  if (note.photo) {
    const head = document.createElement("div");
    head.className = "note-head";
    const image = document.createElement("img");
    image.className = "thumb";
    image.alt = "Photo taken with this note";
    image.src = photoUrl(note);
    const meta = document.createElement("div");
    meta.className = "note-meta";
    meta.append(renderTime(note));
    const place = renderPlace(note);
    if (place) meta.append(place);
    head.append(image, meta);
    article.append(head);
  } else {
    article.append(renderTime(note));
  }

  if (editingId === note.id) {
    const field = document.createElement("textarea");
    field.rows = 4;
    field.value = note.text;
    field.setAttribute("aria-label", "Note");
    field.addEventListener("blur", () => saveEdit(note.id, field.value));
    article.append(field);
    queueMicrotask(() => field.focus());
  } else {
    if (!note.text) return article;
    const paragraph = document.createElement("p");
    paragraph.textContent = note.text;
    paragraph.tabIndex = 0;
    paragraph.addEventListener("click", () => {
      editingId = note.id;
      renderNotes();
    });
    paragraph.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        editingId = note.id;
        renderNotes();
      }
    });
    article.append(paragraph);
  }

  if (!note.photo) {
    const place = renderPlace(note);
    if (place) article.append(place);
  }

  return article;
}

function photoUrl(note) {
  const size = note.photo.size || 0;
  const key = `${note.id}:${size}`;
  if (!photoUrls.has(key)) {
    photoUrls.forEach((url, oldKey) => {
      if (oldKey.startsWith(`${note.id}:`)) {
        URL.revokeObjectURL(url);
        photoUrls.delete(oldKey);
      }
    });
    photoUrls.set(key, URL.createObjectURL(note.photo));
  }
  return photoUrls.get(key);
}

function renderExports() {
  const row = document.createElement("div");
  row.className = "exports";
  const textBtn = document.createElement("button");
  textBtn.type = "button";
  textBtn.textContent = "Export text";
  textBtn.addEventListener("click", exportText);
  const backupBtn = document.createElement("button");
  backupBtn.type = "button";
  backupBtn.textContent = "Export backup";
  backupBtn.addEventListener("click", exportBackup);
  row.append(textBtn, backupBtn);
  return row;
}

async function saveEdit(id, value) {
  if (editingId !== id) return;
  const note = notes.find((item) => item.id === id);
  editingId = null;
  if (!note) return;
  const text = value.trim();
  if (!text && !note.photo) {
    notes = notes.filter((item) => item.id !== id);
    await deleteNote(id);
  } else {
    note.text = text;
    await putNote(note);
  }
  renderNotes();
}

function download(filename, blob) {
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function fileStamp() {
  const when = new Date(round.startedAt);
  const month = String(when.getMonth() + 1).padStart(2, "0");
  const day = String(when.getDate()).padStart(2, "0");
  return `${when.getFullYear()}-${month}-${day}`;
}

function exportText() {
  if (!round) return;
  const lines = [`Round ${formatWhen(round.startedAt)}`];
  if (round.endedAt) lines.push(`Ended ${formatWhen(round.endedAt)}`);
  lines.push("");
  notes.forEach((note) => {
    lines.push(timeFormat.format(note.at));
    lines.push(note.text || "Photo");
    if (note.lat != null && note.lng != null) {
      lines.push(formatPlace(note.lat, note.lng));
      lines.push(`https://www.google.com/maps?q=${note.lat},${note.lng}`);
    }
    if (note.photo) lines.push("Photo attached");
    lines.push("");
  });
  lines.push(`Trail points: ${round.points.length}`);
  download(`route-${fileStamp()}.txt`, new Blob([lines.join("\n")], { type: "text/plain" }));
}

async function exportBackup() {
  if (!round) return;
  const payload = {
    round,
    notes: await Promise.all(notes.map(async (note) => ({
      ...note,
      photo: note.photo ? await blobToDataUrl(note.photo) : null,
    }))),
  };
  download(
    `route-${fileStamp()}.json`,
    new Blob([JSON.stringify(payload)], { type: "application/json" })
  );
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function compressImage(file) {
  const draw = (source, width, height) => {
    const maxEdge = 1280;
    const scale = Math.min(1, maxEdge / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("Could not save that photo."))),
        "image/jpeg",
        0.72
      );
    });
  };

  if (typeof createImageBitmap === "function") {
    return createImageBitmap(file, { imageOrientation: "from-image" }).then((bitmap) => {
      const blob = draw(bitmap, bitmap.width, bitmap.height);
      bitmap.close();
      return blob;
    });
  }

  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      draw(image, image.width, image.height).then(resolve, reject).finally(() => URL.revokeObjectURL(url));
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read that photo."));
    };
    image.src = url;
  });
}

function rememberPin(note) {
  if (!note || note.lat != null) return;
  tracker.current().then(async (pin) => {
    if (!pin || note.lat != null) return;
    if (!notes.some((item) => item.id === note.id)) return;
    Object.assign(note, pinFields(pin));
    await putNote(note);
    if (editingId !== note.id) renderNotes();
  }).catch(showFailure);
}

async function saveTypedNote(text) {
  const phrase = text.trim();
  if (!phrase || !round || round.endedAt) return;
  endTalk();
  await phraseChain;
  const note = {
    id: crypto.randomUUID(),
    roundId: round.id,
    text: phrase,
    at: Date.now(),
    photo: null,
    ...pinFields(tracker.peek()),
  };
  notes.push(note);
  await putNote(note);
  renderNotes();
  rememberPin(note);
}

async function savePhoto(file) {
  if (!round || round.endedAt) return;
  let blob = file;
  try {
    blob = await compressImage(file);
  } catch {
    blob = file;
  }
  const pin = talkPin || tracker.peek();
  const targetId = photoTargetId || talkNoteId;
  photoTargetId = null;
  let note = notes.find((item) => item.id === targetId);
  if (!note) {
    note = blankNote({ photo: blob, ...pinFields(pin) });
    if (speech.listening()) {
      talkNoteId = note.id;
      talkPin = pin;
    }
    notes.push(note);
  } else {
    note.photo = blob;
    if (note.lat == null) Object.assign(note, pinFields(pin));
  }
  await putNote(note);
  renderNotes();
  const saved = document.querySelector(`[data-note-id="${note.id}"]`);
  if (saved) saved.scrollIntoView({ block: "nearest" });
  rememberPin(note);
}

function openComposer() {
  if (!round || round.endedAt) return;
  endTalk();
  draftEl.value = "";
  dockEl.hidden = true;
  composerEl.hidden = false;
  draftEl.focus();
}

function closeComposer() {
  composerEl.hidden = true;
  if (round && !round.endedAt) showDock("active");
}

speakBtn.addEventListener("click", async () => {
  if (!round || round.endedAt) return;
  if (speech.listening()) {
    endTalk();
    return;
  }
  if (!speechSupported()) {
    consentEl.textContent = "Speaking needs Chrome. You can still type a note.";
    return;
  }
  talkGeneration += 1;
  const generation = talkGeneration;
  talkNoteId = null;
  talkPin = tracker.peek();
  speech.start();
  tracker.current().then((pin) => {
    if (pin && talkGeneration === generation) talkPin = pin;
  }).catch(showFailure);
});

startBtn.addEventListener("click", () => beginRound().catch(showFailure));
endBtn.addEventListener("click", () => finishRound().catch(showFailure));
backBtn.addEventListener("click", () => {
  round = null;
  tracker.stop();
  showHome().catch(showFailure);
});
document.querySelector("#type-btn").addEventListener("click", openComposer);
document.querySelector("#draft-cancel").addEventListener("click", closeComposer);
composerEl.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = draftEl.value;
  closeComposer();
  saveTypedNote(text).catch(showFailure);
});
document.querySelector("#camera-btn").addEventListener("click", () => {
  if (!round || round.endedAt) return;
  photoTargetId = talkNoteId;
  cameraInput.click();
});
cameraInput.addEventListener("change", () => {
  const file = cameraInput.files && cameraInput.files[0];
  cameraInput.value = "";
  if (file) savePhoto(file).catch(showFailure);
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) screenWentAway();
  else screenCameBack();
});
window.addEventListener("pagehide", screenWentAway);

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => {
    // The page still works for this visit if the worker cannot install.
  });
}

showHome().catch(showFailure);
