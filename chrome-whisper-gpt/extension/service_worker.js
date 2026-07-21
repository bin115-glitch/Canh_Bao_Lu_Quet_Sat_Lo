const DEFAULT_BACKEND_URL = "http://127.0.0.1:8000";

async function getState() {
  return chrome.storage.local.get({
    backendUrl: DEFAULT_BACKEND_URL,
    isRecording: false,
    isProcessing: false,
    lastResult: null,
    lastError: null,
    liveCaption: "",
    liveLines: [],
    debugEvents: [],
    liveChunkCount: 0,
    currentSpeaker: "Unknown speaker"
  });
}

async function setState(patch) {
  await chrome.storage.local.set(patch);
}

async function pushDebug(text) {
  const now = new Date();
  const time = now.toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const state = await getState();
  const debugEvents = (state.debugEvents || []).concat({ time, text }).slice(-30);
  await setState({ debugEvents });
}

async function ensureOffscreenDocument() {
  const hasDocument = await chrome.offscreen.hasDocument?.();
  if (hasDocument) {
    return;
  }

  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "Record tab audio with MediaRecorder"
  });
  await pushDebug("Offscreen document ready");
}

async function resetCaptureState() {
  try {
    await chrome.runtime.sendMessage({ type: "RESET_RECORDING" });
  } catch (_) {
    // Offscreen may not exist yet.
  }

  await setState({
    isRecording: false,
    isProcessing: false,
    liveCaption: "",
    liveLines: [],
    debugEvents: [],
    liveChunkCount: 0
  });

  try {
    if (chrome.offscreen.closeDocument) {
      await chrome.offscreen.closeDocument();
    }
  } catch (_) {
    // Safe to ignore if not open.
  }
}

async function startRecording() {
  const state = await getState();
  if (state.isRecording || state.isProcessing) {
    return { ok: false, error: "Recording already in progress." };
  }

  await resetCaptureState();
  await pushDebug("Requested capture start");
  await ensureOffscreenDocument();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    return { ok: false, error: "No active tab found." };
  }

  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: tab.id
    });
    await pushDebug("Stream ID acquired");
  } catch (error) {
    await pushDebug("Failed to acquire tab stream");
    return {
      ok: false,
      error: "Chrome could not capture this tab. Stop any existing capture and reload the extension, then try again."
    };
  }

  await setState({
    isRecording: true,
    isProcessing: false,
    lastError: null,
    liveCaption: "",
    liveLines: [],
    liveChunkCount: 0,
    lastResult: null,
    currentSpeaker: state.currentSpeaker || "Unknown speaker"
  });

  const response = await chrome.runtime.sendMessage({
    type: "START_RECORDING",
    streamId,
    tabId: tab.id,
    backendUrl: state.backendUrl
  });

  if (!response?.ok) {
    await pushDebug(`Capture start failed: ${response?.error || "Unknown"}`);
    await resetCaptureState();
    return { ok: false, error: response?.error || "Failed to start capture." };
  }

  await pushDebug("Capture started");
  return { ok: true };
}

async function stopRecording() {
  const state = await getState();
  if (!state.isRecording && !state.isProcessing) {
    await resetCaptureState();
    return { ok: true };
  }

  await pushDebug("Stop requested");
  const response = await chrome.runtime.sendMessage({ type: "STOP_RECORDING" });
  if (!response?.ok) {
    await pushDebug(`Stop failed: ${response?.error || "Unknown"}`);
    return { ok: false, error: response?.error || "Failed to stop capture." };
  }

  await setState({
    isRecording: false,
    isProcessing: true,
    lastError: null
  });

  await pushDebug("Stopping capture and processing final audio");
  return { ok: true };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "GET_AUDIO_STATE") {
    getState().then(state => {
      sendResponse({
        monitoring: state.isRecording,
        speaker: state.currentSpeaker,
        caption: state.liveCaption,
        debugEvents: state.debugEvents,
        isProcessing: state.isProcessing
      });
    });
    return true;
  }

  if (message?.type === "START_CAPTURE") {
    startRecording()
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "STOP_CAPTURE") {
    stopRecording()
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "RESET_CAPTURE") {
    resetCaptureState()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "PROCESSING_STARTED") {
    setState({ isProcessing: true, lastError: null });
    pushDebug("Backend processing started");
  }

  if (message?.type === "PROCESSING_DONE") {
    setState({
      isRecording: false,
      isProcessing: false,
      lastResult: message.result ?? null,
      lastError: null,
      liveCaption: "",
      liveLines: []
    });
    pushDebug("Backend processing done");
  }

  if (message?.type === "PROCESSING_ERROR") {
    setState({
      isRecording: false,
      isProcessing: false,
      lastError: message.error || "Unknown error"
    });
    pushDebug(`Error: ${message.error || "Unknown error"}`);
  }

  if (message?.type === "WEBEX_SPEAKER_DETECTED") {
    const speaker = message.speaker || "Unknown speaker";
    setState({ currentSpeaker: speaker });
    pushDebug(`Speaker detected: ${speaker}`);
  }

  if (message?.type === "LIVE_TRANSCRIPT") {
    chrome.storage.local.get({ liveLines: [] }).then((state) => {
      const currentSpeaker = message.speaker || state.currentSpeaker || "Unknown speaker";
      const nextLines = state.liveLines.concat({
        speaker: currentSpeaker,
        text: message.text || "",
        ts: Date.now()
      }).filter((item) => item.text);

      setState({
        liveCaption: message.text || "",
        liveLines: nextLines.slice(-24),
        liveChunkCount: (state.liveLines?.length || 0) + 1,
        currentSpeaker
      });
    });
    pushDebug("Transcript chunk received");
  }

  if (message?.type === "DEBUG_EVENT") {
    pushDebug(message.text || "Debug event");
  }
});
