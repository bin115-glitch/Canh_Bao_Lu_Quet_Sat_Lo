let mediaStream = null;
let mediaRecorderFull = null;
let mediaRecorderLive = null;
let fullChunks = [];
let liveTimer = null;

async function stopStreamTracks() {
  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    if (mediaStream.tabStream) {
      mediaStream.tabStream.getTracks().forEach(t => t.stop());
    }
    if (mediaStream.micStream) {
      mediaStream.micStream.getTracks().forEach(t => t.stop());
    }
    if (mediaStream.audioContext && mediaStream.audioContext.state !== "closed") {
      mediaStream.audioContext.close();
    }
    mediaStream = null;
  }
}

async function resetRecording() {
  fullChunks = [];
  chunkQueue = Promise.resolve();
  firstChunkSeen = false;
  if (liveTimer) {
    clearTimeout(liveTimer);
    liveTimer = null;
  }
  if (mediaRecorderFull && mediaRecorderFull.state !== "inactive") {
    try { mediaRecorderFull.stop(); } catch (_) {}
  }
  if (mediaRecorderLive && mediaRecorderLive.state !== "inactive") {
    try { mediaRecorderLive.stop(); } catch (_) {}
  }
  mediaRecorderFull = null;
  mediaRecorderLive = null;
  await stopStreamTracks();
}

async function handleLiveChunk(blob) {
  if (!blob || blob.size === 0) {
    return;
  }

  const result = await postAudio(blob, false);
  const text = result.transcript || "";
  if (text) {
    chrome.runtime.sendMessage({
      type: "LIVE_TRANSCRIPT",
      text,
      speaker: "Unknown speaker",
      segments: result.segments || []
    });
    sendDebug("Transcript chunk received from backend");
  } else {
    sendDebug("Backend returned empty transcript chunk");
  }
}

async function startRecording(streamId) {
  await resetRecording();
  sendDebug("Opening tab capture stream");

  const tabStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId
      }
    },
    video: false
  });

  let micStream = null;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: false
    });
    sendDebug("Microphone captured successfully");
  } catch (err) {
    sendDebug("Failed to capture microphone (check permissions)");
  }

  const audioContext = new AudioContext();
  const dest = audioContext.createMediaStreamDestination();
  
  const tabSource = audioContext.createMediaStreamSource(tabStream);
  tabSource.connect(dest);

  if (micStream) {
    const micSource = audioContext.createMediaStreamSource(micStream);
    micSource.connect(dest);
  }

  const stream = dest.stream;
  stream.tabStream = tabStream;
  stream.micStream = micStream;
  stream.audioContext = audioContext;

  mediaStream = stream;
  fullChunks = [];
  chunkQueue = Promise.resolve();

  mediaRecorderFull = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
  
  mediaRecorderFull.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) {
      fullChunks.push(event.data);
    }
  };

  mediaRecorderFull.onerror = (event) => {
    chrome.runtime.sendMessage({
      type: "PROCESSING_ERROR",
      error: event?.error?.message || "MediaRecorder failed to capture audio."
    });
    sendDebug("MediaRecorderFull error");
  };

  mediaRecorderFull.onstop = async () => {
    try {
      chrome.runtime.sendMessage({ type: "PROCESSING_STARTED" });
      await chunkQueue;
      const blob = new Blob(fullChunks, { type: "audio/webm" });
      sendDebug("Final audio blob ready");
      const result = await postAudio(blob, true);
      chrome.runtime.sendMessage({ type: "PROCESSING_DONE", result });
      sendDebug("Final transcript received");
    } catch (error) {
      chrome.runtime.sendMessage({
        type: "PROCESSING_ERROR",
        error: error?.message || "Recording processing failed."
      });
      sendDebug(`Processing error: ${error?.message || "unknown"}`);
    } finally {
      fullChunks = [];
      mediaRecorderFull = null;
      await stopStreamTracks();
    }
  };

  mediaRecorderFull.start(1000); // 1-second chunks for memory efficiency
  sendDebug("Full recorder started");

  function recordNextLiveChunk() {
    if (!mediaStream) return;
    mediaRecorderLive = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
    let liveChunks = [];
    
    mediaRecorderLive.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) liveChunks.push(event.data);
    };
    
    mediaRecorderLive.onstop = () => {
      const blob = new Blob(liveChunks, { type: "audio/webm" });
      if (blob.size > 0) {
        chunkQueue = chunkQueue.then(() => handleLiveChunk(blob)).catch((err) => {
          chrome.runtime.sendMessage({
            type: "PROCESSING_ERROR",
            error: err?.message || "Live transcription failed."
          });
        });
      }
    };
    
    mediaRecorderLive.start();
    
    liveTimer = setTimeout(() => {
      if (mediaRecorderLive && mediaRecorderLive.state === "recording") {
        mediaRecorderLive.stop();
        recordNextLiveChunk();
      }
    }, 5000); // 5-second chunking
  }

  recordNextLiveChunk();
  sendDebug("Live chunking started");
}

async function stopRecording() {
  if (liveTimer) {
    clearTimeout(liveTimer);
    liveTimer = null;
  }
  if (mediaRecorderLive && mediaRecorderLive.state === "recording") {
    mediaRecorderLive.stop();
  }
  if (mediaRecorderFull && mediaRecorderFull.state !== "inactive") {
    sendDebug("Stopping full recorder");
    mediaRecorderFull.stop();
  } else {
    await stopStreamTracks();
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "START_RECORDING") {
    backendUrl = message.backendUrl || backendUrl;
    startRecording(message.streamId)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || "Failed to start capture." }));
    return true;
  }

  if (message?.type === "STOP_RECORDING") {
    stopRecording()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || "Failed to stop capture." }));
    return true;
  }

  if (message?.type === "RESET_RECORDING") {
    resetRecording()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || "Failed to reset capture." }));
    return true;
  }
});
