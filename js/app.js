import { allNotes, allRounds, deleteNote, notesForRound, putNote, putRound } from "./db.js";
import { clusterStops, createTracker, distanceMetres, nearestStopIndex, orderEarlierNotes } from "./geo.js";
import { createRecorder, recorderSupported } from "./record.js";
import { createSpeech, speechSupported } from "./speech.js";
import { transcribeBlob } from "./transcribe.js";

const titleEl = document.querySelector("#title");
const statusEl = document.querySelector("#status");
const mainEl = document.querySelector("#main");
const dockEl = document.querySelector("#dock");
const consentEl = document.querySelector("#consent");
const liveEl = document.querySelector("#live");
const pairEl = document.querySelector("#pair");
const speakBtn = document.querySelector("#speak-btn");
const stopBtn = document.querySelector("#stop-btn");
const startBtn = document.querySelector("#start-btn");
const endBtn = document.querySelector("#end-round");
const backBtn = document.querySelector("#back");
const homeBtn = document.querySelector("#home");
const sendBtn = document.querySelector("#send-btn");
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
let viewingExport = false;
let editingId = null;
let talkNoteId = null;
let talkPin = null;
let talkGeneration = 0;
let photoTargetId = null;
let recordingOffline = false;
let confirmingDeleteId = null;
let discardTalk = false;
let writingOut = false;
let transcribeBusy = false;
let micBlocked = false;
const waitingText = "Waiting to write this out.";
let phraseChain = Promise.resolve();
let roundWrite = Promise.resolve();
let startingRound = false;
let geoStatus = "waiting";
let routeDraft = "";
let earlierStops = [];
let earlierIndex = 0;
let earlierFollowing = true;
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
    refreshEarlierPosition();
  },
});

const recorder = createRecorder();

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
      consentEl.hidden = false;
      consentEl.textContent = "Listening. Press the side button to end this talk.";
      return;
    }
    if (state === "network") {
      startOfflineRecording().catch(showFailure);
      return;
    }
    if (state === "denied") micBlocked = true;
    refreshConsent();
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
  if (viewingExport) return;
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
    routeNumber: round.routeNumber || "",
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
    audio: null,
    pendingText: false,
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
  if (discardTalk || !phrase || !round || round.endedAt) return;
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
  note.pendingText = false;
  note.audio = null;
  if (note.lat == null) {
    const pin = talkPin || (await tracker.current());
    if (pin) Object.assign(note, pinFields(pin));
  }
  await putNote(note);
  if (editingId !== note.id) renderNotes();
}

function visibleText(note) {
  if (note.text) return note.text;
  if (note.pendingText) return waitingText;
  return "";
}

function refreshConsent() {
  if (speech.listening()) return;
  if (recordingOffline) {
    speakBtn.textContent = "Stop";
    speakBtn.setAttribute("aria-pressed", "true");
    consentEl.hidden = false;
    consentEl.textContent = "No signal. Press the side button to end this talk.";
    return;
  }
  speakBtn.textContent = "Speak";
  speakBtn.setAttribute("aria-pressed", "false");
  liveEl.hidden = true;
  liveEl.textContent = "";
  if (writingOut) {
    consentEl.hidden = false;
    consentEl.textContent = "Writing out saved talks.";
    return;
  }
  if (micBlocked) {
    consentEl.hidden = false;
    consentEl.textContent = "Microphone is blocked. Allow it in the browser settings.";
    return;
  }
  consentEl.hidden = true;
  if (!navigator.onLine) {
    consentEl.textContent = "No signal. Speaking will be written out when you are back in range. You can type a note now.";
    return;
  }
  if (!speechSupported() && !recorderSupported()) {
    consentEl.textContent = "Speaking needs Chrome. You can still type a note.";
    return;
  }
  consentEl.textContent = "Ask the person with you before you use the microphone.";
}

async function startOfflineRecording() {
  if (recordingOffline || recorder.listening() || document.hidden) return;
  if (!recorderSupported()) {
    consentEl.textContent = "Speaking needs Chrome. You can still type a note.";
    return;
  }
  try {
    await recorder.start();
  } catch {
    micBlocked = true;
    refreshConsent();
    return;
  }
  if (document.hidden) {
    await keepAudioIfNeeded(await recorder.stop(), talkNoteId, talkPin);
    recordingOffline = false;
    refreshConsent();
    return;
  }
  recordingOffline = true;
  refreshConsent();
}

async function keepAudioIfNeeded(blob, noteId, pin) {
  if (discardTalk || !blob || !round || round.endedAt) return;
  let note = notes.find((item) => item.id === noteId);
  if (note && note.text) return;
  if (!note) {
    note = blankNote({ ...pinFields(pin) });
    notes.push(note);
  } else if (note.lat == null && pin) {
    Object.assign(note, pinFields(pin));
  }
  note.audio = blob;
  note.pendingText = true;
  await putNote(note);
  if (round && note.roundId === round.id) renderNotes();
}

function endTalk() {
  const wasSpeech = speech.listening();
  const wasRecording = recorder.listening();
  if (!wasSpeech && !wasRecording) return;
  const generation = talkGeneration;
  const noteId = talkNoteId;
  const pin = talkPin;
  recordingOffline = false;
  if (wasSpeech) speech.stop();
  const audioDone = wasRecording ? recorder.stop() : Promise.resolve(null);
  phraseChain = phraseChain
    .then(async () => {
      await keepAudioIfNeeded(await audioDone, noteId, pin);
      if (talkGeneration === generation) {
        talkNoteId = null;
        talkPin = null;
      }
      refreshConsent();
    })
    .catch(showFailure);
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

function routeKey(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function routeTitle(item) {
  const number = String(item && item.routeNumber || "").replace(/\s+/g, " ").trim();
  return number ? `Route ${number}` : "";
}

function roundListLabel(item) {
  const name = routeTitle(item);
  const when = formatWhen(item.startedAt);
  if (!item.endedAt) return name ? `${name}, this round` : `This round, ${when}`;
  return name ? `${name}, ${when}` : when;
}

function chosenRouteNumber() {
  const field = document.querySelector("#route-number");
  const value = field ? field.value : routeDraft;
  return value.replace(/\s+/g, " ").trim().slice(0, 20);
}

function syncStartEnabled() {
  startBtn.disabled = !chosenRouteNumber();
}

function recentRouteNumbers(rounds) {
  const seen = new Set();
  const numbers = [];
  rounds.forEach((item) => {
    const number = String(item.routeNumber || "").replace(/\s+/g, " ").trim();
    const key = routeKey(number);
    if (!key || seen.has(key)) return;
    seen.add(key);
    numbers.push(number);
  });
  return numbers.slice(0, 8);
}

function appendRouteField(rounds) {
  if (startBtn.hidden) return;
  const wrap = document.createElement("form");
  wrap.className = "route-start";
  wrap.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!chosenRouteNumber()) return;
    beginRound().catch(showFailure);
  });
  const label = document.createElement("label");
  label.htmlFor = "route-number";
  label.textContent = "Route number";
  const field = document.createElement("input");
  field.id = "route-number";
  field.maxLength = 20;
  field.autocomplete = "off";
  field.enterKeyHint = "go";
  field.value = routeDraft;
  field.addEventListener("input", () => {
    routeDraft = field.value;
    syncStartEnabled();
  });
  wrap.append(label, field);
  const picks = recentRouteNumbers(rounds);
  if (picks.length) {
    const row = document.createElement("div");
    row.className = "route-picks";
    picks.forEach((number) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = number;
      button.addEventListener("click", () => {
        field.value = number;
        routeDraft = number;
        syncStartEnabled();
      });
      row.append(button);
    });
    wrap.append(row);
  }
  mainEl.append(wrap);
  syncStartEnabled();
}

function showDock(mode) {
  composerEl.hidden = true;
  sendBtn.hidden = mode !== "export";
  stopBtn.hidden = mode !== "active";
  homeBtn.hidden = mode === "home";
  if (mode === "home") {
    dockEl.hidden = false;
    consentEl.hidden = true;
    pairEl.hidden = true;
    speakBtn.hidden = true;
    startBtn.hidden = false;
    startBtn.disabled = true;
    endBtn.hidden = true;
    backBtn.hidden = true;
    return;
  }
  if (mode === "active") {
    dockEl.hidden = false;
    consentEl.hidden = true;
    pairEl.hidden = false;
    speakBtn.hidden = false;
    startBtn.hidden = true;
    endBtn.hidden = false;
    backBtn.hidden = true;
    return;
  }
  if (mode === "export") {
    dockEl.hidden = false;
    consentEl.hidden = true;
    pairEl.hidden = true;
    speakBtn.hidden = true;
    startBtn.hidden = true;
    endBtn.hidden = true;
    backBtn.hidden = false;
    return;
  }
  dockEl.hidden = true;
  endBtn.hidden = true;
  backBtn.hidden = true;
}

async function showHome() {
  viewingPast = false;
  viewingExport = false;
  editingId = null;
  const rounds = await allRounds();
  const unfinished = rounds.find((item) => !item.endedAt);
  if (unfinished) {
    await openExisting(unfinished);
    transcribePending();
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
  lead.textContent = "Type the route number, then start.";
  mainEl.append(lead);
  appendRouteField(rounds);

  const finished = rounds.filter((item) => item.endedAt);
  transcribePending();
  if (!finished.length) return;

  const list = document.createElement("ul");
  list.className = "round-list";
  finished.forEach((item) => {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = roundListLabel(item);
    button.addEventListener("click", () => openExisting(item));
    li.append(button);
    list.append(li);
  });
  mainEl.append(list);
}

async function showRoundList() {
  viewingExport = false;
  viewingPast = false;
  editingId = null;
  confirmingDeleteId = null;
  endTalk();
  tracker.stop();
  const rounds = await allRounds();
  round = null;
  notes = [];
  titleEl.textContent = "Route notes";
  statusEl.textContent = rounds.length ? "Choose a round" : "No round yet";
  showDock("home");
  startBtn.hidden = rounds.some((item) => !item.endedAt);
  mainEl.replaceChildren();

  const lead = document.createElement("p");
  lead.className = "lead";
  lead.textContent = startBtn.hidden
    ? "This round is still open."
    : "Type the route number, then start.";
  mainEl.append(lead);
  appendRouteField(rounds);
  if (!rounds.length) return;

  const list = document.createElement("ul");
  list.className = "round-list";
  rounds.forEach((item) => {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = roundListLabel(item);
    button.addEventListener("click", () => openExisting(item).catch(showFailure));
    li.append(button);
    list.append(li);
  });
  mainEl.append(list);
}

async function openExisting(existing) {
  round = existing;
  viewingPast = Boolean(round.endedAt);
  viewingExport = false;
  editingId = null;
  titleEl.textContent = routeTitle(round) || (viewingPast ? "Past round" : "This round");
  await loadNotes();
  paintStatus();
  showDock(viewingPast ? "past" : "active");
  if (!viewingPast) tracker.start();
  else tracker.stop();
  renderNotes();
  refreshConsent();
  if (!viewingPast) await loadEarlier();
}

async function beginRound() {
  if (startingRound || (round && !round.endedAt)) return;
  startingRound = true;
  tracker.start();
  try {
    const existing = (await allRounds()).find((item) => !item.endedAt);
    if (existing) {
      await openExisting(existing);
      return;
    }
    const routeNumber = chosenRouteNumber();
    if (!routeNumber) {
      tracker.stop();
      return;
    }
    round = {
      id: crypto.randomUUID(),
      startedAt: Date.now(),
      endedAt: null,
      routeNumber,
      points: [],
    };
    routeDraft = "";
    viewingPast = false;
    viewingExport = false;
    geoStatus = "waiting";
    await saveRound();
    notes = [];
    titleEl.textContent = routeTitle(round);
    paintStatus();
    showDock("active");
    renderNotes();
    refreshConsent();
    await loadEarlier();
  } finally {
    startingRound = false;
  }
}

async function finishRound() {
  if (!round || round.endedAt) return;
  endTalk();
  await phraseChain;
  tracker.stop();
  round.endedAt = Date.now();
  await saveRound();
  viewingPast = true;
  viewingExport = false;
  titleEl.textContent = routeTitle(round) || "Past round";
  earlierStops = [];
  paintStatus();
  showDock("past");
  renderNotes();
}

async function loadEarlier() {
  const currentId = round && round.id;
  const key = routeKey(round && round.routeNumber);
  earlierStops = [];
  earlierIndex = 0;
  earlierFollowing = true;
  if (!currentId || !round || round.endedAt || !key) {
    renderEarlier();
    return;
  }
  const rounds = await allRounds();
  if (!round || round.id !== currentId) return;
  const earlierRounds = rounds.filter((item) => (
    item.id !== currentId && item.endedAt && routeKey(item.routeNumber) === key
  ));
  if (!earlierRounds.length) {
    renderEarlier();
    return;
  }
  const lists = await Promise.all(earlierRounds.map((item) => notesForRound(item.id)));
  if (!round || round.id !== currentId) return;
  const items = [];
  earlierRounds.forEach((item, index) => {
    lists[index].forEach((note) => {
      if (note.lat == null || note.lng == null) return;
      items.push({
        note,
        at: note.at,
        day: item.startedAt,
        lat: note.lat,
        lng: note.lng,
      });
    });
  });
  const ordered = orderEarlierNotes(items, earlierRounds[0].points || []);
  earlierStops = clusterStops(ordered);
  earlierIndex = nearestStopIndex(tracker.peek(), earlierStops);
  renderEarlier();
}

function refreshEarlierPosition() {
  if (viewingPast || viewingExport || !round || round.endedAt || !earlierStops.length) return;
  if (!earlierFollowing) return;
  const next = nearestStopIndex(tracker.peek(), earlierStops);
  if (next === earlierIndex && document.querySelector("#earlier")) return;
  earlierIndex = next;
  renderEarlier();
}

function stepEarlier(delta) {
  if (!earlierStops.length) return;
  earlierFollowing = false;
  earlierIndex = Math.min(Math.max(earlierIndex + delta, 0), earlierStops.length - 1);
  renderEarlier();
}

function renderEarlier() {
  const existing = document.querySelector("#earlier");
  const pin = tracker.peek();
  const show = !viewingPast && !viewingExport && round && !round.endedAt && earlierStops.length && pin;
  if (!show) {
    if (existing) existing.remove();
    return;
  }
  earlierIndex = Math.min(Math.max(earlierIndex, 0), earlierStops.length - 1);
  const stop = earlierStops[earlierIndex];
  const strip = existing || document.createElement("section");
  strip.id = "earlier";
  strip.className = "earlier";
  strip.replaceChildren();
  const heading = document.createElement("p");
  heading.className = "earlier-label";
  heading.textContent = "Earlier on this route";
  strip.append(heading);
  stop.forEach((item) => {
    const words = document.createElement("p");
    words.className = "earlier-words";
    words.textContent = visibleText(item.note) || (item.note.photo ? "Photograph taken" : "Note");
    const meta = document.createElement("p");
    meta.className = "earlier-meta";
    const distance = Math.max(0, Math.round(distanceMetres(pin, item)));
    meta.textContent = `${dayFormat.format(item.day)} · ${distance} m`;
    strip.append(words, meta);
  });
  const controls = document.createElement("div");
  controls.className = earlierFollowing ? "earlier-controls following" : "earlier-controls";
  const behind = document.createElement("button");
  behind.type = "button";
  behind.textContent = "Behind";
  behind.disabled = earlierIndex === 0;
  behind.addEventListener("click", () => stepEarlier(-1));
  const ahead = document.createElement("button");
  ahead.type = "button";
  ahead.textContent = "Ahead";
  ahead.disabled = earlierIndex === earlierStops.length - 1;
  ahead.addEventListener("click", () => stepEarlier(1));
  controls.append(behind);
  if (!earlierFollowing) {
    const here = document.createElement("button");
    here.type = "button";
    here.textContent = "Here";
    here.addEventListener("click", () => {
      earlierFollowing = true;
      earlierIndex = nearestStopIndex(tracker.peek(), earlierStops);
      renderEarlier();
    });
    controls.append(here);
  }
  controls.append(ahead);
  strip.append(controls);
  if (!existing) mainEl.prepend(strip);
}

function renderNotes() {
  if (viewingExport) return;
  mainEl.replaceChildren();
  renderEarlier();
  if (!notes.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = round && round.endedAt ? "No notes on this round." : "No notes yet.";
    mainEl.append(empty);
  } else {
    notes.forEach((note) => mainEl.append(renderNote(note)));
  }
  mainEl.append(renderExportButton());
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
    field.value = visibleText(note);
    field.setAttribute("aria-label", "Note");
    field.addEventListener("blur", () => saveEdit(note.id, field.value));
    article.append(field);
    queueMicrotask(() => field.focus());
  } else {
    const body = visibleText(note);
    if (body) {
      const paragraph = document.createElement("p");
      if (!note.text && note.pendingText) paragraph.className = "pending";
      paragraph.textContent = body;
      paragraph.tabIndex = 0;
      paragraph.addEventListener("click", () => openNoteEditor(note.id));
      paragraph.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        openNoteEditor(note.id);
      });
      article.append(paragraph);
    } else if (note.stop) {
      const add = document.createElement("button");
      add.type = "button";
      add.className = "add-words";
      add.textContent = "Add words";
      add.addEventListener("click", () => openNoteEditor(note.id));
      article.append(add);
    }
  }

  if (!note.photo) {
    const place = renderPlace(note);
    if (place) article.append(place);
  }

  article.append(renderDelete(note));
  return article;
}

function renderDelete(note) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = confirmingDeleteId === note.id ? "delete confirm" : "delete";
  button.textContent = confirmingDeleteId === note.id ? "Delete this note" : "Delete";
  button.addEventListener("click", () => {
    removeNote(note.id).catch(showFailure);
  });
  return button;
}

function revokePhoto(id) {
  photoUrls.forEach((url, key) => {
    if (key.startsWith(`${id}:`)) {
      URL.revokeObjectURL(url);
      photoUrls.delete(key);
    }
  });
}

async function removeNote(id) {
  if (confirmingDeleteId !== id) {
    confirmingDeleteId = id;
    renderNotes();
    return;
  }
  confirmingDeleteId = null;
  if (talkNoteId === id) {
    discardTalk = true;
    endTalk();
  }
  phraseChain = phraseChain.then(async () => {
    if (editingId === id) editingId = null;
    notes = notes.filter((item) => item.id !== id);
    revokePhoto(id);
    await deleteNote(id);
    discardTalk = false;
    renderNotes();
  }).catch(showFailure);
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

function renderExportButton() {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "export";
  button.textContent = "Export";
  button.addEventListener("click", () => showExport().catch(showFailure));
  return button;
}

async function showExport() {
  if (!round) return;
  viewingExport = true;
  editingId = null;
  confirmingDeleteId = null;
  endTalk();
  await phraseChain;
  if (!viewingExport || !round) return;
  titleEl.textContent = "Print";
  statusEl.textContent = "Send this in WhatsApp so it can be printed.";
  showDock("export");
  mainEl.replaceChildren();

  const sheet = document.createElement("article");
  sheet.className = "sheet";
  const heading = document.createElement("h2");
  heading.textContent = routeTitle(round) || "Route notes";
  const when = document.createElement("p");
  when.className = "when";
  when.textContent = formatWhen(round.startedAt);
  sheet.append(heading, when);
  if (round.endedAt) {
    const ended = document.createElement("p");
    ended.className = "when";
    ended.textContent = `Ended ${formatWhen(round.endedAt)}`;
    sheet.append(ended);
  }
  if (!notes.length) {
    const empty = document.createElement("p");
    empty.className = "sheet-note";
    empty.textContent = "No notes on this round.";
    sheet.append(empty);
  } else {
    notes.forEach((note) => sheet.append(renderSheetNote(note)));
  }
  mainEl.append(sheet);
}

function renderSheetNote(note) {
  const block = document.createElement("div");
  block.className = "sheet-note";
  const time = document.createElement("p");
  time.textContent = timeFormat.format(note.at);
  const body = document.createElement("p");
  const written = visibleText(note);
  body.textContent = written || (note.photo ? "Photograph taken" : note.stop ? "Stop" : "");
  block.append(time, body);
  if (note.lat != null && note.lng != null) {
    const place = document.createElement("p");
    place.textContent = formatPlace(note.lat, note.lng);
    block.append(place);
  }
  if (note.photo && written) {
    const photo = document.createElement("p");
    photo.textContent = "Photograph taken";
    block.append(photo);
  }
  return block;
}

async function saveEdit(id, value) {
  if (editingId !== id) return;
  const note = notes.find((item) => item.id === id);
  editingId = null;
  if (!note) return;
  const text = value.trim();
  if (note.pendingText && (!text || text === waitingText)) {
    renderNotes();
    return;
  }
  if (!text && !note.photo && !note.audio && !note.stop) {
    notes = notes.filter((item) => item.id !== id);
    await deleteNote(id);
  } else {
    note.text = text;
    if (text) {
      note.pendingText = false;
      note.audio = null;
    }
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

function printableLines() {
  const lines = [routeTitle(round) || "Route notes", formatWhen(round.startedAt)];
  if (round.endedAt) lines.push(`Ended ${formatWhen(round.endedAt)}`);
  lines.push("");
  if (!notes.length) {
    lines.push("No notes on this round.");
    return lines;
  }
  notes.forEach((note) => {
    lines.push(timeFormat.format(note.at));
    const written = visibleText(note);
    wrapLine(written || (note.photo ? "Photograph taken" : note.stop ? "Stop" : ""), 78).forEach((line) => {
      lines.push(line);
    });
    if (note.lat != null && note.lng != null) lines.push(formatPlace(note.lat, note.lng));
    if (note.photo && written) lines.push("Photograph taken");
    lines.push("");
  });
  return lines;
}

function wrapLine(text, width) {
  const words = String(text).split(/\s+/).filter(Boolean);
  if (!words.length) return [""];
  const lines = [];
  let current = "";
  words.forEach((word) => {
    const next = current ? `${current} ${word}` : word;
    if (next.length > width && current) {
      lines.push(current);
      current = word;
    } else current = next;
  });
  if (current) lines.push(current);
  return lines;
}

const PDF_CHARS = {
  "°": "\\260",
  "á": "\\341",
  "é": "\\351",
  "í": "\\355",
  "ó": "\\363",
  "ú": "\\372",
  "Á": "\\301",
  "É": "\\311",
  "Í": "\\315",
  "Ó": "\\323",
  "Ú": "\\332",
  "’": "'",
  "‘": "'",
  "“": "\"",
  "”": "\"",
  "–": "-",
  "—": "-",
  "…": "...",
};

function pdfEscape(text) {
  let out = "";
  for (const char of String(text)) {
    if (char === "\\") out += "\\\\";
    else if (char === "(") out += "\\(";
    else if (char === ")") out += "\\)";
    else if (PDF_CHARS[char]) out += PDF_CHARS[char];
    else if (char >= " " && char <= "~") out += char;
  }
  return out;
}

function buildPdf(lines) {
  const perPage = 44;
  const chunks = [];
  for (let i = 0; i < lines.length; i += perPage) chunks.push(lines.slice(i, i + perPage));
  if (!chunks.length) chunks.push([""]);

  const objects = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Count ${chunks.length} /Kids [${chunks.map((_, index) => `${4 + index * 2} 0 R`).join(" ")}] >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  chunks.forEach((pageLines, index) => {
    const pageId = 4 + index * 2;
    const contentId = pageId + 1;
    const commands = ["BT", "/F1 12 Tf", "50 790 Td", "16 TL"];
    pageLines.forEach((line, lineIndex) => {
      const text = `(${pdfEscape(line)}) Tj`;
      commands.push(lineIndex === 0 ? text : `T* ${text}`);
    });
    commands.push("ET");
    const stream = commands.join("\n");
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`;
    objects[contentId] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = pdf.length;
    pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length}\n`;
  pdf += "0000000000 65535 f \n";
  for (let id = 1; id < objects.length; id += 1) {
    pdf += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new Blob([pdf], { type: "application/pdf" });
}

async function sendPrintable() {
  if (!round || sendBtn.disabled) return;
  sendBtn.disabled = true;
  try {
    const blob = buildPdf(printableLines());
    const name = `route-${fileStamp()}.pdf`;
    const file = new File([blob], name, { type: "application/pdf" });
    let shared = false;
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: "Route notes" });
        shared = true;
      } catch (error) {
        if (error && error.name === "AbortError") return;
      }
    }
    if (!shared) download(name, blob);
    if (round) await openExisting(round);
  } finally {
    sendBtn.disabled = false;
  }
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

function openNoteEditor(id) {
  confirmingDeleteId = null;
  editingId = id;
  renderNotes();
}

async function saveStop() {
  if (!round || round.endedAt) return;
  const note = {
    id: crypto.randomUUID(),
    roundId: round.id,
    text: "",
    at: Date.now(),
    photo: null,
    audio: null,
    pendingText: false,
    stop: true,
    ...pinFields(tracker.peek()),
  };
  notes.push(note);
  await putNote(note);
  renderNotes();
  const saved = document.querySelector(`[data-note-id="${note.id}"]`);
  if (saved) saved.scrollIntoView({ block: "nearest" });
  rememberPin(note);
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
  refreshConsent();
}

async function transcribePending() {
  if (!navigator.onLine || transcribeBusy || recordingOffline || speech.listening()) return;
  transcribeBusy = true;
  try {
    const stored = await allNotes();
    const pending = stored.filter((item) => item.pendingText && item.audio);
    if (!pending.length) return;
    writingOut = true;
    refreshConsent();
    for (const storedNote of pending) {
      if (!navigator.onLine) break;
      let text = "";
      try {
        text = await transcribeBlob(storedNote.audio);
      } catch {
        consentEl.hidden = false;
        consentEl.textContent = "Saved talks will be written out when you are back in range.";
        break;
      }
      const live = notes.find((item) => item.id === storedNote.id);
      const note = live || storedNote;
      if (!note.pendingText || note.text) continue;
      note.pendingText = false;
      note.audio = null;
      if (text) note.text = text;
      if (!text && !note.photo) {
        if (live) notes = notes.filter((item) => item.id !== note.id);
        await deleteNote(note.id);
      } else {
        await putNote(note);
      }
      if (live) renderNotes();
    }
  } finally {
    writingOut = false;
    transcribeBusy = false;
    refreshConsent();
  }
}

stopBtn.addEventListener("click", () => {
  saveStop().catch(showFailure);
});
speakBtn.addEventListener("click", async () => {
  if (!round || round.endedAt) return;
  if (speech.listening() || recordingOffline || recorder.listening()) {
    endTalk();
    return;
  }
  if (!navigator.onLine && !recorderSupported()) {
    consentEl.textContent = "Speaking needs Chrome. You can still type a note.";
    return;
  }
  if (navigator.onLine && !speechSupported() && !recorderSupported()) {
    consentEl.textContent = "Speaking needs Chrome. You can still type a note.";
    return;
  }
  talkGeneration += 1;
  const generation = talkGeneration;
  talkNoteId = null;
  talkPin = tracker.peek();
  tracker.current().then((pin) => {
    if (pin && talkGeneration === generation) talkPin = pin;
  }).catch(showFailure);
  if (navigator.onLine && speechSupported()) speech.start();
  else await startOfflineRecording();
});

startBtn.addEventListener("click", () => beginRound().catch(showFailure));
endBtn.addEventListener("click", () => finishRound().catch(showFailure));
backBtn.addEventListener("click", () => {
  if (!viewingExport || !round) return;
  openExisting(round).catch(showFailure);
});
homeBtn.addEventListener("click", () => {
  showRoundList().catch(showFailure);
});
sendBtn.addEventListener("click", () => {
  sendPrintable().catch(showFailure);
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
window.addEventListener("online", () => {
  refreshConsent();
  transcribePending();
});
window.addEventListener("offline", refreshConsent);

if ("serviceWorker" in navigator) {
  let refreshing = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });
  navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" }).then((registration) => {
    registration.update();
  }).catch(() => {
    // The page still works for this visit if the worker cannot install.
  });
}

showHome().catch(showFailure);
