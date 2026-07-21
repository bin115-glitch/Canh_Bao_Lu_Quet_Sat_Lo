const statusEl = document.getElementById("status");
const detailEl = document.getElementById("detail");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const refreshBtn = document.getElementById("refreshBtn");
const clearDebugBtn = document.getElementById("clearDebugBtn");
const speakerTextEl = document.getElementById("speakerText");
const captionCountEl = document.getElementById("captionCount");
const monitorStateEl = document.getElementById("monitorState");
const captionBoxEl = document.getElementById("captionBox");
const debugFeedEl = document.getElementById("debugFeed");
const modeSelect = document.getElementById("modeSelect");
const modeSubtitle = document.getElementById("modeSubtitle");

let activeTabId = null;

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function setDisconnectedState(message) {
  statusEl.textContent = "Disconnected";
  detailEl.textContent = message || "Open a Webex meeting tab to connect.";
  speakerTextEl.textContent = "-";
  captionCountEl.textContent = "0 chars";
  monitorStateEl.textContent = "Idle";
  captionBoxEl.innerHTML = `
    <div class="empty-state">
      <div class="empty-title">No active tab</div>
      <div class="empty-text">Open a Webex meeting tab, then reload this popup from the extension icon.</div>
    </div>
  `;
  debugFeedEl.innerHTML = `
    <div class="empty-state">
      <div class="empty-title">No debug data</div>
      <div class="empty-text">Connect to a Webex tab to see the overlay status.</div>
    </div>
  `;
}

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url || !tab.url.includes("webex.com")) {
    return null;
  }
  return tab.id;
}

async function sendToTab(message) {
  if (!activeTabId) {
    return null;
  }
  try {
    return await chrome.tabs.sendMessage(activeTabId, message);
  } catch (error) {
    return null;
  }
}

function renderDebug(events) {
  if (!events || events.length === 0) {
    debugFeedEl.innerHTML = `
      <div class="empty-state">
        <div class="empty-title">No debug events yet</div>
        <div class="empty-text">Start monitoring and each page scan will appear here.</div>
      </div>
    `;
    return;
  }

  debugFeedEl.innerHTML = events.slice(-18).map((event, index, arr) => {
    const active = index === arr.length - 1;
    return `
      <div class="debug-step ${active ? "active" : ""}">
        <div class="debug-time">${escapeHtml(event.time || "")}</div>
        <div class="debug-text">${escapeHtml(event.text || "")}</div>
      </div>
    `;
  }).join("");
}

function renderCaption(text) {
  if (!text) {
    captionBoxEl.innerHTML = `
      <div class="empty-state">
        <div class="empty-title">No caption yet</div>
        <div class="empty-text">Waiting for audio/captions...</div>
      </div>
    `;
    captionCountEl.textContent = "0 chars";
    return;
  }

  captionBoxEl.innerHTML = `<div class="result-text">${escapeHtml(text)}</div>`;
  captionCountEl.textContent = `${text.length} chars`;
}

async function refresh() {
  const mode = modeSelect.value;
  activeTabId = await getActiveTabId();

  if (mode === "webex") {
    modeSubtitle.textContent = "This version reads the Webex page directly and shows captions plus best-effort speaker detection.";
    if (!activeTabId) {
      setDisconnectedState("Open a Webex meeting tab");
      startBtn.disabled = true;
      stopBtn.disabled = true;
      return;
    }
  } else {
    modeSubtitle.textContent = "This mode captures Tab audio (Loa) and System Microphone directly, sending to local Whisper.";
    if (!activeTabId) {
      setDisconnectedState("Open a Webex meeting tab to capture its audio");
      startBtn.disabled = true;
      stopBtn.disabled = true;
      return;
    }
  }

  startBtn.disabled = false;
  stopBtn.disabled = false;
  refreshBtn.disabled = false;
  clearDebugBtn.disabled = false;

  let state = null;
  if (mode === "webex") {
    state = await sendToTab({ type: "GET_STATE" });
    if (!state) {
      setDisconnectedState("Could not connect to the Webex overlay. Reload the Webex tab and try again.");
      return;
    }
  } else {
    state = await chrome.runtime.sendMessage({ type: "GET_AUDIO_STATE" });
    if (!state) {
      setDisconnectedState("Service worker not available.");
      return;
    }
  }

  statusEl.textContent = state.monitoring ? "Monitoring" : "Ready";
  detailEl.textContent = state.monitoring ? "Running..." : "Click Start to begin";
  speakerTextEl.textContent = state.speaker || "-";
  monitorStateEl.textContent = state.monitoring ? "Live" : "Idle";
  
  if (state.isProcessing) {
     monitorStateEl.textContent = "Processing...";
  }

  renderCaption(state.caption || "");
  renderDebug(state.debugEvents || []);
}

modeSelect.addEventListener("change", () => {
  localStorage.setItem("whisper-mode", modeSelect.value);
  refresh();
});

const savedMode = localStorage.getItem("whisper-mode");
if (savedMode) {
  modeSelect.value = savedMode;
}

startBtn.addEventListener("click", async () => {
  if (modeSelect.value === "webex") {
    await sendToTab({ type: "START_MONITORING" });
  } else {
    await chrome.runtime.sendMessage({ type: "START_CAPTURE" });
  }
  await refresh();
});

stopBtn.addEventListener("click", async () => {
  if (modeSelect.value === "webex") {
    await sendToTab({ type: "STOP_MONITORING" });
  } else {
    await chrome.runtime.sendMessage({ type: "STOP_CAPTURE" });
  }
  await refresh();
});

refreshBtn.addEventListener("click", refresh);

clearDebugBtn.addEventListener("click", async () => {
  if (modeSelect.value === "webex") {
    await sendToTab({ type: "CLEAR_DEBUG" });
  } else {
    // Service worker clear debug not implemented yet, just visual clear
    debugFeedEl.innerHTML = ""; 
  }
  await refresh();
});

chrome.tabs.onActivated?.addListener(() => refresh());
chrome.tabs.onUpdated?.addListener(() => refresh());

setInterval(refresh, 2000); // Auto-refresh to get live captions
refresh();
