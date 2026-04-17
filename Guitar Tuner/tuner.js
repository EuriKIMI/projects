const noteDisplay = document.getElementById("note");
const noteMeta = document.getElementById("noteMeta");
const freqDisplay = document.getElementById("freq");
const centsDisplay = document.getElementById("centsDisplay");
const targetDisplay = document.getElementById("targetDisplay");
const needle = document.getElementById("needle");
const autoBtn = document.getElementById("autoBtn");
const manualBtn = document.getElementById("manualBtn");
const stringButtonsContainer = document.getElementById("stringButtons");
const stringButtons = [...stringButtonsContainer.querySelectorAll(".string-btn")];
const feedback = document.getElementById("feedback");
const feedbackCopy = document.getElementById("feedbackCopy");
const statusText = document.getElementById("statusText");
const statusPill = document.getElementById("statusPill");
const statusCopy = document.getElementById("statusCopy");
const signalStrength = document.getElementById("signalStrength");
const accuracyMarker = document.getElementById("accuracyMarker");
const toggleTunerBtn = document.getElementById("toggleTunerBtn");
const playReferenceBtn = document.getElementById("playReferenceBtn");
const modeCopy = document.getElementById("modeCopy");

const noteStrings = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const standardNotes = {
  E2: { label: "Low E", frequency: 82.41 },
  A2: { label: "A", frequency: 110.0 },
  D3: { label: "D", frequency: 146.83 },
  G3: { label: "G", frequency: 196.0 },
  B3: { label: "B", frequency: 246.94 },
  E4: { label: "High E", frequency: 329.63 },
};

let mode = "auto";
let selectedNote = null;
let audioCtx = null;
let source = null;
let analyser = null;
let stream = null;
let animationId = null;
let isTuning = false;
let toneOscillator = null;
let toneGainNode = null;
let toneContext = null;
let stablePitch = null;
let lastUpdateTimestamp = 0;

function setMode(nextMode) {
  mode = nextMode;
  autoBtn.classList.toggle("active", nextMode === "auto");
  manualBtn.classList.toggle("active", nextMode === "manual");
  stringButtonsContainer.classList.toggle("hidden", nextMode !== "manual");

  if (nextMode === "auto") {
    selectedNote = null;
    clearManualSelection();
    targetDisplay.textContent = "Auto Detect";
    modeCopy.textContent = "Automatic mode listens for the closest pitch and finds the nearest note for you.";
  } else {
    selectedNote = selectedNote || "E2";
    highlightStringButton(selectedNote);
    updateSelectedTarget();
    modeCopy.textContent = "Manual mode locks the tuner to one guitar string so the feedback stays focused.";
  }

  if (!isTuning) {
    resetDisplay();
  }
}

function clearManualSelection() {
  stringButtons.forEach((button) => button.classList.remove("active"));
}

function highlightStringButton(note) {
  stringButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.note === note);
  });
}

function updateSelectedTarget() {
  if (mode === "manual" && selectedNote) {
    const target = standardNotes[selectedNote];
    targetDisplay.textContent = `${target.label} • ${target.frequency.toFixed(2)} Hz`;
  } else {
    targetDisplay.textContent = "Auto Detect";
  }
}

function selectString(note) {
  selectedNote = note;
  highlightStringButton(note);
  updateSelectedTarget();
  playTone(standardNotes[note].frequency);
}

function getNoteDetails(frequency) {
  const a4 = 440;
  const noteNumber = 69 + 12 * Math.log2(frequency / a4);
  const roundedNote = Math.round(noteNumber);
  const cents = (noteNumber - roundedNote) * 100;
  const noteIndex = ((roundedNote % 12) + 12) % 12;
  const octave = Math.floor(roundedNote / 12) - 1;
  const targetFrequency = a4 * Math.pow(2, (roundedNote - 69) / 12);

  return {
    noteName: `${noteStrings[noteIndex]}${octave}`,
    cents,
    targetFrequency,
  };
}

function getSignalLevel(buffer) {
  let sum = 0;

  for (let i = 0; i < buffer.length; i += 1) {
    sum += buffer[i] * buffer[i];
  }

  return Math.sqrt(sum / buffer.length);
}

function autoCorrelate(buffer, sampleRate) {
  const size = buffer.length;
  const correlation = new Array(size).fill(0);
  const rms = getSignalLevel(buffer);

  if (rms < 0.01) {
    return -1;
  }

  let trimStart = 0;
  let trimEnd = size - 1;
  const threshold = 0.2;

  while (trimStart < size / 2 && Math.abs(buffer[trimStart]) < threshold) {
    trimStart += 1;
  }

  while (trimEnd > size / 2 && Math.abs(buffer[trimEnd]) < threshold) {
    trimEnd -= 1;
  }

  const trimmed = buffer.slice(trimStart, trimEnd);
  const trimmedSize = trimmed.length;

  if (!trimmedSize) {
    return -1;
  }

  for (let lag = 0; lag < trimmedSize; lag += 1) {
    for (let index = 0; index < trimmedSize - lag; index += 1) {
      correlation[lag] += trimmed[index] * trimmed[index + lag];
    }
  }

  let dip = 0;
  while (dip + 1 < correlation.length && correlation[dip] > correlation[dip + 1]) {
    dip += 1;
  }

  let bestLag = -1;
  let bestValue = -1;

  for (let lag = dip; lag < trimmedSize; lag += 1) {
    if (correlation[lag] > bestValue) {
      bestValue = correlation[lag];
      bestLag = lag;
    }
  }

  if (bestLag <= 0) {
    return -1;
  }

  const previous = correlation[bestLag - 1] || correlation[bestLag];
  const current = correlation[bestLag];
  const next = correlation[bestLag + 1] || correlation[bestLag];
  const adjustment = (next - previous) / (2 * (2 * current - next - previous));
  const refinedLag = Number.isFinite(adjustment) ? bestLag + adjustment : bestLag;

  return sampleRate / refinedLag;
}

function setMeterPosition(cents) {
  const clamped = Math.max(-50, Math.min(50, cents));
  const angle = clamped * 0.95;
  needle.style.transform = `translateX(-50%) rotate(${angle}deg)`;
  accuracyMarker.style.left = `${clamped + 50}%`;
}

function setFeedbackState(type, text, copy) {
  feedback.textContent = text;
  feedback.className = "feedback-line";

  if (type) {
    feedback.classList.add(type);
  }

  feedbackCopy.textContent = copy;
}

function updateSignalLabel(rms) {
  if (rms < 0.01) {
    signalStrength.textContent = "Signal: none";
  } else if (rms < 0.03) {
    signalStrength.textContent = "Signal: soft";
  } else if (rms < 0.06) {
    signalStrength.textContent = "Signal: good";
  } else {
    signalStrength.textContent = "Signal: strong";
  }
}

function showNoSignalState() {
  noteDisplay.textContent = "--";
  noteMeta.textContent = isTuning ? "Listening for a stable string vibration." : "Start the tuner and pluck one string clearly.";
  freqDisplay.textContent = "-- Hz";
  centsDisplay.textContent = "0 cents";
  setMeterPosition(0);
  setFeedbackState("", "Ready when you are", "The needle and accuracy marker will respond as soon as the tuner catches a stable note.");
  statusCopy.textContent = isTuning
    ? "Try muting background noise and pluck only one open string."
    : "Use a quiet room and pluck one open string at a time for the fastest lock.";
}

function updateStatus(active, message) {
  statusPill.classList.toggle("live", active);
  statusText.textContent = message;
}

function resetDisplay() {
  stablePitch = null;
  signalStrength.textContent = "Waiting for signal";
  updateStatus(false, isTuning ? "Listening..." : "Microphone idle");
  showNoSignalState();
}

function updateDetectedState(pitch) {
  const now = performance.now();

  if (!stablePitch || now - lastUpdateTimestamp > 260) {
    stablePitch = pitch;
  } else {
    stablePitch = stablePitch * 0.7 + pitch * 0.3;
  }

  lastUpdateTimestamp = now;

  const currentPitch = stablePitch;
  const displayPitch = `${currentPitch.toFixed(2)} Hz`;
  freqDisplay.textContent = displayPitch;

  let cents = 0;
  let noteName = "--";
  let targetFrequency = currentPitch;

  if (mode === "manual" && selectedNote) {
    const target = standardNotes[selectedNote];
    targetFrequency = target.frequency;
    cents = 1200 * Math.log2(currentPitch / targetFrequency);
    noteName = selectedNote;
    noteMeta.textContent = `${target.label} target • ${targetFrequency.toFixed(2)} Hz`;
  } else {
    const details = getNoteDetails(currentPitch);
    cents = details.cents;
    noteName = details.noteName;
    targetFrequency = details.targetFrequency;
    noteMeta.textContent = `Nearest pitch target • ${targetFrequency.toFixed(2)} Hz`;
  }

  noteDisplay.textContent = noteName;
  centsDisplay.textContent = `${cents >= 0 ? "+" : ""}${cents.toFixed(1)} cents`;
  setMeterPosition(cents);

  const absCents = Math.abs(cents);

  if (absCents <= 5) {
    setFeedbackState("good", "In tune", "Nice. The string is sitting close enough to center for a clean standard tuning.");
    needle.style.background = "linear-gradient(180deg, #7df0b8, #d9fff0)";
  } else if (cents < 0) {
    setFeedbackState("warn", "Tune up", "The pitch is flat. Tighten the string slightly until the needle settles in the center.");
    needle.style.background = "linear-gradient(180deg, #ffbf69, #ffe4bf)";
  } else {
    setFeedbackState("bad", "Tune down", "The pitch is sharp. Loosen the string a touch and watch the marker move back to center.");
    needle.style.background = "linear-gradient(180deg, #ff6b8c, #ffd6de)";
  }

  updateStatus(true, "Microphone live");
  statusCopy.textContent = `Detected ${displayPitch} against a target of ${targetFrequency.toFixed(2)} Hz.`;
}

function updateTuner() {
  if (!analyser || !audioCtx) {
    return;
  }

  const buffer = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buffer);

  const rms = getSignalLevel(buffer);
  const pitch = autoCorrelate(buffer, audioCtx.sampleRate);

  updateSignalLabel(rms);

  if (pitch !== -1 && pitch > 60 && pitch < 1400) {
    updateDetectedState(pitch);
  } else {
    showNoSignalState();
  }

  animationId = requestAnimationFrame(updateTuner);
}

async function startTuner() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Microphone access is not supported in this browser.");
  }

  stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  source = audioCtx.createMediaStreamSource(stream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.82;

  source.connect(analyser);

  isTuning = true;
  toggleTunerBtn.textContent = "Stop Listening";
  updateStatus(true, "Microphone live");
  signalStrength.textContent = "Listening for signal";
  statusCopy.textContent = "Pluck one string cleanly and let it ring for a moment.";
  updateTuner();
}

async function stopTuner() {
  if (animationId) {
    cancelAnimationFrame(animationId);
    animationId = null;
  }

  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
  }

  if (audioCtx) {
    await audioCtx.close();
    audioCtx = null;
  }

  source = null;
  analyser = null;
  isTuning = false;
  toggleTunerBtn.textContent = "Start Listening";
  resetDisplay();
}

async function toggleTuner() {
  toggleTunerBtn.disabled = true;

  try {
    if (isTuning) {
      await stopTuner();
    } else {
      await startTuner();
    }
  } catch (error) {
    isTuning = false;
    toggleTunerBtn.textContent = "Start Listening";
    updateStatus(false, "Microphone unavailable");
    signalStrength.textContent = "Permission needed";
    setFeedbackState("bad", "Microphone blocked", error.message || "Allow microphone access so the tuner can listen.");
    statusCopy.textContent = "If your browser asked for access, approve it and try again.";
  } finally {
    toggleTunerBtn.disabled = false;
  }
}

async function playTone(frequency) {
  try {
    if (!toneContext || toneContext.state === "closed") {
      toneContext = new (window.AudioContext || window.webkitAudioContext)();
    }

    if (toneContext.state === "suspended") {
      await toneContext.resume();
    }

    if (toneOscillator) {
      toneOscillator.stop();
      toneOscillator.disconnect();
      toneGainNode.disconnect();
    }

    toneOscillator = toneContext.createOscillator();
    toneGainNode = toneContext.createGain();

    toneOscillator.type = "sine";
    toneOscillator.frequency.value = frequency;
    toneGainNode.gain.setValueAtTime(0.0001, toneContext.currentTime);
    toneGainNode.gain.linearRampToValueAtTime(0.18, toneContext.currentTime + 0.02);
    toneGainNode.gain.exponentialRampToValueAtTime(0.0001, toneContext.currentTime + 1.25);

    toneOscillator.connect(toneGainNode);
    toneGainNode.connect(toneContext.destination);

    toneOscillator.start();
    toneOscillator.stop(toneContext.currentTime + 1.3);
    toneOscillator.onended = () => {
      toneOscillator?.disconnect();
      toneGainNode?.disconnect();
      toneOscillator = null;
      toneGainNode = null;
    };
  } catch (error) {
    setFeedbackState("bad", "Reference tone unavailable", error.message || "Your browser blocked audio playback.");
  }
}

toggleTunerBtn.addEventListener("click", toggleTuner);
playReferenceBtn.addEventListener("click", () => {
  const targetFrequency =
    mode === "manual" && selectedNote
      ? standardNotes[selectedNote].frequency
      : standardNotes.E2.frequency;

  playTone(targetFrequency);
});

autoBtn.addEventListener("click", () => setMode("auto"));
manualBtn.addEventListener("click", () => setMode("manual"));

stringButtons.forEach((button) => {
  button.addEventListener("click", () => {
    if (mode !== "manual") {
      setMode("manual");
    }

    selectString(button.dataset.note);
  });
});

setMode("auto");
resetDisplay();
