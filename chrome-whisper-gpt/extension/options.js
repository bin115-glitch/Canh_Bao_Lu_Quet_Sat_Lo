const backendUrlInput = document.getElementById("backendUrl");
const saveBtn = document.getElementById("saveBtn");
const messageEl = document.getElementById("message");

async function loadSettings() {
  const state = await chrome.storage.local.get({
    backendUrl: "http://127.0.0.1:8000"
  });
  backendUrlInput.value = state.backendUrl;
}

saveBtn.addEventListener("click", async () => {
  await chrome.storage.local.set({
    backendUrl: backendUrlInput.value.trim() || "http://127.0.0.1:8000"
  });
  messageEl.textContent = "Saved.";
  setTimeout(() => {
    messageEl.textContent = "";
  }, 1400);
});

loadSettings();
