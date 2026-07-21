# Chrome Whisper GPT

A Chrome Extension that records the active tab, sends the audio to a local Python backend, transcribes it with `faster-whisper`, and optionally passes the transcript to the GPT API for summarization or cleanup.

## Webex mode

This project now includes a **Webex overlay** for the Webex web app in Chrome.

- It shows live captions directly on the meeting page.
- It displays the best-effort active speaker name detected from the Webex UI.
- It records tab audio locally and sends it to the backend.

Important:

- This works on the **Webex web app in Chrome**, not the desktop app.
- Speaker detection is **best-effort** and depends on what Webex exposes in the page DOM.
- If Webex changes its UI, the speaker selector may need tuning.

## Project layout

- `extension/` Chrome Extension source
- `backend/` FastAPI service with `faster-whisper` and OpenAI API integration

## How it works

1. Open a Webex meeting in Chrome.
2. Click **Start** in the extension popup.
3. The extension captures audio from the current tab.
4. The Webex page shows a live overlay with captions and the detected speaker.
5. Click **Stop** to end recording.
6. The backend:
   - transcribes audio with `faster-whisper`
   - optionally sends the transcript to GPT
   - returns transcript + AI result to the extension

## Setup

### 1) Backend

```bash
cd chrome-whisper-gpt/backend
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env
```

Edit `.env` and set:

- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `WHISPER_MODEL`

Run the server:

```bash
uvicorn app:app --reload --host 127.0.0.1 --port 8000
```

### 2) Chrome extension

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `chrome-whisper-gpt/extension` folder

## Notes

- `faster-whisper` runs locally on the backend machine.
- The extension does not store API keys.
- If `OPENAI_API_KEY` is empty, the backend returns transcript only.
