const STATE = {
  monitoring: true,
  speaker: "Unknown speaker",
  caption: "",
  debugEvents: [],
  lines: [],
  lastCaptionSignature: "",
  lastSpeakerSignature: ""
};

const OVERLAY_ID = "cwgp-webex-overlay-root";
const POLL_MS = 1200;
let pollTimer = null;
let observer = null;

const CAPTION_BLACKLIST = [
  /show apps/i,
  /open the participants panel/i,
  /you can join breakout sessions/i,
  /participants list/i,
  /show chat/i,
  /meeting info/i,
  /start video/i,
  /mute/i,
  /share/i,
  /waiting in the lobby/i,
  /back/i,
  /download the webex app/i
];

const SPEAKER_BLACKLIST = [
  /participants/i,
  /invite people/i,
  /meeting info/i,
  /layout/i,
  /show apps/i,
  /show chat/i,
  /waiting in the lobby/i,
  /download the webex app/i,
  /unverified/i,
  /^host, presenter, me$/i,
  /^me$/i,
  /^td$/i
];

function nowTime() {
  return new Date().toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function pushDebug(text) {
  STATE.debugEvents.push({ time: nowTime(), text });
  STATE.debugEvents = STATE.debugEvents.slice(-30);
  renderOverlay();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function ensureOverlay() {
  let host = document.getElementById(OVERLAY_ID);
  if (host) return host;

  host = document.createElement("div");
  host.id = OVERLAY_ID;
  host.style.all = "initial";
  host.style.position = "fixed";
  host.style.right = "16px";
  host.style.bottom = "16px";
  host.style.zIndex = "2147483647";
  host.style.pointerEvents = "none";

  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .card {
        width: 360px;
        pointer-events: auto;
        font-family: "Segoe UI", Arial, sans-serif;
        color: #e5e7eb;
        background: linear-gradient(160deg, rgba(10, 15, 28, 0.96), rgba(17, 24, 39, 0.93));
        border: 1px solid rgba(148, 163, 184, 0.18);
        border-radius: 18px;
        box-shadow: 0 20px 50px rgba(2, 6, 23, 0.35);
        backdrop-filter: blur(16px);
        overflow: hidden;
      }
      .top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 12px 14px;
        background: linear-gradient(90deg, rgba(59, 130, 246, 0.18), rgba(34, 197, 94, 0.12));
        border-bottom: 1px solid rgba(148, 163, 184, 0.14);
      }
      .brand {
        font-size: 12px;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        color: #c7d2fe;
        font-weight: 700;
      }
      .status {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 6px 10px;
        border-radius: 999px;
        background: rgba(34, 197, 94, 0.14);
        border: 1px solid rgba(34, 197, 94, 0.24);
        color: #bbf7d0;
        font-size: 12px;
        font-weight: 700;
      }
      .body { padding: 12px 14px 14px; }
      .speaker {
        font-size: 14px;
        font-weight: 800;
        color: #f8fafc;
        line-height: 1.35;
        margin-bottom: 6px;
      }
      .caption {
        min-height: 54px;
        font-size: 13px;
        line-height: 1.55;
        color: #dbe7f7;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .history {
        margin-top: 10px;
        max-height: 180px;
        overflow: auto;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .line {
        padding: 8px 10px;
        border-radius: 12px;
        background: rgba(2, 6, 23, 0.42);
        border: 1px solid rgba(148, 163, 184, 0.12);
        font-size: 12px;
        line-height: 1.45;
        color: #dbe7f7;
      }
      .line.active {
        background: rgba(34, 197, 94, 0.12);
        border-color: rgba(34, 197, 94, 0.24);
        color: #f0fdf4;
      }
      .meta {
        display: flex;
        gap: 8px;
        align-items: center;
        margin-top: 10px;
        color: #93a4bd;
        font-size: 11px;
      }
      .dot {
        width: 4px;
        height: 4px;
        border-radius: 999px;
        background: #64748b;
      }
      .empty { color: #94a3b8; font-style: italic; }
    </style>
    <div class="card">
      <div class="top">
        <div class="brand">Webex live captions</div>
        <div id="cwgp-status" class="status">Live</div>
      </div>
      <div class="body">
        <div id="cwgp-speaker" class="speaker">Waiting for speaker...</div>
        <div id="cwgp-caption" class="caption empty">Enable Webex captions to see text here.</div>
        <div class="meta"><span>Speaker-aware</span><span class="dot"></span><span>Local overlay</span></div>
        <div id="cwgp-history" class="history"></div>
      </div>
    </div>
  `;

  document.documentElement.appendChild(host);
  return host;
}

function isVisibleElement(el) {
  if (!(el instanceof HTMLElement)) return false;
  const style = getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function normalizeText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function looksLikeCaption(text) {
  if (!text) return false;
  if (text.length < 3 || text.length > 180) return false;
  if (CAPTION_BLACKLIST.some((pattern) => pattern.test(text))) return false;
  const words = text.split(" ").filter(Boolean);
  if (words.length < 2) return false;
  return true;
}

function pickCaptionCandidate() {
  const selectors = [
    "[aria-live]",
    "[role='log']",
    "[role='status']",
    "[data-testid*='caption' i]",
    "[data-testid*='transcript' i]",
    "[class*='caption' i]",
    "[class*='transcript' i]",
    "[class*='subtitle' i]"
  ];

  const candidates = [];
  for (const selector of selectors) {
    for (const el of document.querySelectorAll(selector)) {
      if (!isVisibleElement(el)) continue;
      const text = normalizeText(el.textContent);
      if (!looksLikeCaption(text)) continue;
      candidates.push({ text, rect: el.getBoundingClientRect(), score: scoreCaptionElement(el, text) });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.text || "";
}

function scoreCaptionElement(el, text) {
  const rect = el.getBoundingClientRect();
  let score = 0;

  const attrSource = [el.getAttribute("aria-live"), el.getAttribute("role"), el.getAttribute("data-testid"), el.className]
    .map((v) => normalizeText(v || ""))
    .join(" ");

  if (/caption|transcript|subtitle/i.test(attrSource)) score += 8;
  if (/\b(log|status)\b/i.test(attrSource)) score += 4;
  if (rect.width < 700 && rect.height < 260) score += 3;
  if (rect.bottom > window.innerHeight * 0.45) score += 2;
  if (rect.right > window.innerWidth * 0.5) score += 2;
  if (text.includes(":")) score += 2;
  if (/^[A-Z][^.!?]{2,120}$/.test(text)) score += 1;

  return score;
}

function cleanSpeakerText(raw) {
  let text = normalizeText(raw);
  text = text.replace(/\s+\bUnverified\b.*$/i, "");
  text = text.replace(/\s+Host, presenter, me$/i, "");
  text = text.replace(/\s+Me$/i, "");
  text = text.replace(/\s*\.{3}\s*$/g, "");
  text = text.replace(/\s*\|\s*$/g, "");
  text = text.replace(/\s{2,}/g, " ").trim();
  return text;
}

function borderHighlightScore(style) {
  let score = 0;
  const borderBlob = [style.borderTopColor, style.borderRightColor, style.borderBottomColor, style.borderLeftColor, style.outlineColor, style.boxShadow]
    .map((v) => String(v || "").toLowerCase())
    .join(" ");

  if (/rgb\(0, 1?8?7, 2?3?5\)|rgb\(34, 197, 94\)|rgb\(45, 212, 191\)|rgb\(6, 182, 212\)|rgba\(34, 197, 94|rgba\(45, 212, 191|rgba\(6, 182, 212/i.test(borderBlob)) score += 6;
  if (style.outlineStyle !== "none" && style.outlineWidth !== "0px") score += 4;
  if (style.boxShadow && style.boxShadow !== "none") score += 3;
  return score;
}

function scoreSpeakerElement(el, text) {
  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  let score = 0;

  const attrSource = [
    el.getAttribute("aria-label"),
    el.getAttribute("title"),
    el.getAttribute("role"),
    el.getAttribute("data-testid"),
    el.className
  ].map((v) => normalizeText(v || "")).join(" ");

  if (/speaker|participant|participant row|tile|avatar|meeting|person/i.test(attrSource)) score += 3;
  if (el.getAttribute("aria-selected") === "true" || el.getAttribute("aria-current") === "true") score += 8;
  if (el.dataset?.active === "true" || el.dataset?.selected === "true") score += 8;
  score += borderHighlightScore(style);
  if (rect.width > 160 && rect.width < 900) score += 2;
  if (rect.height > 34 && rect.height < 500) score += 2;
  if (rect.top < window.innerHeight * 0.9) score += 1;
  if (rect.left < window.innerWidth * 0.95) score += 1;
  if (/unverified|speaking|audio|microphone|mute|presenter/i.test(text)) score += 2;

  return score;
}

function candidateFromElement(el, text) {
  const score = scoreSpeakerElement(el, text);
  return {
    text,
    score,
    source: `${el.tagName.toLowerCase()}.${normalizeText(el.className).slice(0, 60)}`
  };
}

function pickSpeakerCandidate() {
  const candidates = [];
  const selectors = [
    "[aria-label*='speaking' i]",
    "[title*='speaking' i]",
    "[data-testid*='speaker' i]",
    "[data-testid*='participant' i]",
    "[class*='speaker' i]",
    "[class*='participant' i]",
    "[class*='tile' i]",
    "[role='button']",
    "[role='listitem']"
  ];

  for (const selector of selectors) {
    for (const el of document.querySelectorAll(selector)) {
      if (!isVisibleElement(el)) continue;
      const rawText = normalizeText(el.textContent);
      const text = cleanSpeakerText(rawText);
      if (!text || text.length > 120) continue;
      if (SPEAKER_BLACKLIST.some((pattern) => pattern.test(text))) continue;
      const candidate = candidateFromElement(el, text);
      if (candidate.score > 0) candidates.push(candidate);
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  if (candidates.length) {
    pushDebug(`Top speaker candidate: ${candidates[0].text}`);
  }

  return candidates[0]?.text || "Unknown speaker";
}

function scanPage() {
  if (!STATE.monitoring) return;

  const caption = pickCaptionCandidate();
  const speaker = pickSpeakerCandidate();

  if (caption && caption !== STATE.lastCaptionSignature) {
    STATE.lastCaptionSignature = caption;
    STATE.caption = caption;
    STATE.lines.push({ speaker: speaker || STATE.speaker, text: caption });
    STATE.lines = STATE.lines.slice(-20);
    pushDebug(`Caption updated: ${caption.slice(0, 70)}${caption.length > 70 ? "..." : ""}`);
  }

  if (speaker && speaker !== STATE.lastSpeakerSignature) {
    STATE.lastSpeakerSignature = speaker;
    STATE.speaker = speaker;
    pushDebug(`Speaker detected: ${speaker}`);
  }

  renderOverlay();
}

function renderOverlay() {
  const host = ensureOverlay();
  const shadow = host.shadowRoot;
  if (!shadow) return;

  shadow.getElementById("cwgp-status").textContent = STATE.monitoring ? "Live" : "Stopped";
  shadow.getElementById("cwgp-speaker").textContent = STATE.speaker || "Unknown speaker";

  const captionEl = shadow.getElementById("cwgp-caption");
  const captionText = STATE.caption || "Enable Webex captions to see text here.";
  captionEl.textContent = captionText;
  captionEl.classList.toggle("empty", !STATE.caption);

  const historyEl = shadow.getElementById("cwgp-history");
  historyEl.innerHTML = STATE.lines.length
    ? STATE.lines.slice(-12).map((line, index, arr) => {
        const active = index === arr.length - 1;
        return `<div class="line ${active ? "active" : ""}"><strong>${escapeHtml(line.speaker || "Unknown speaker")}:</strong> ${escapeHtml(line.text || "")}</div>`;
      }).join("")
    : `<div class="line empty">No transcript yet.</div>`;
}

function startMonitoring() {
  STATE.monitoring = true;
  pushDebug("Monitoring started");
  renderOverlay();
}

function stopMonitoring() {
  STATE.monitoring = false;
  pushDebug("Monitoring stopped");
  renderOverlay();
}

function clearDebug() {
  STATE.debugEvents = [];
  renderOverlay();
}

function startObservers() {
  if (observer) return;
  observer = new MutationObserver(() => scanPage());
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true });
  pollTimer = window.setInterval(scanPage, POLL_MS);
  pushDebug("Overlay attached");
  scanPage();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "GET_STATE") {
    sendResponse({
      monitoring: STATE.monitoring,
      speaker: STATE.speaker,
      caption: STATE.caption,
      lines: STATE.lines,
      debugEvents: STATE.debugEvents
    });
    return true;
  }

  if (message?.type === "START_MONITORING") {
    startMonitoring();
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === "STOP_MONITORING") {
    stopMonitoring();
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === "CLEAR_DEBUG") {
    clearDebug();
    sendResponse({ ok: true });
    return true;
  }
});

startObservers();
