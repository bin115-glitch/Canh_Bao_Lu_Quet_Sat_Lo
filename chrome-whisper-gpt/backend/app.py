from __future__ import annotations

import os
import tempfile
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from faster_whisper import WhisperModel

load_dotenv()

HOST = os.getenv("HOST", "127.0.0.1")
PORT = int(os.getenv("PORT", "8000"))
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "small")
WHISPER_DEVICE = os.getenv("WHISPER_DEVICE", "cpu")
WHISPER_COMPUTE_TYPE = os.getenv("WHISPER_COMPUTE_TYPE", "int8")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "").strip()
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4.1-mini")

app = FastAPI(title="Chrome Whisper GPT Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

whisper_model = WhisperModel(
    WHISPER_MODEL,
    device=WHISPER_DEVICE,
    compute_type=WHISPER_COMPUTE_TYPE,
)

_openai_client: Any = None
_openai_style: str = "none"

if OPENAI_API_KEY:
    try:
        from openai import OpenAI  # type: ignore

        _openai_client = OpenAI(api_key=OPENAI_API_KEY)
        _openai_style = "v1"
    except Exception:
        try:
            import openai  # type: ignore

            openai.api_key = OPENAI_API_KEY
            _openai_client = openai
            _openai_style = "legacy"
        except Exception:
            _openai_client = None
            _openai_style = "none"


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


def _transcribe_audio(audio_path: Path) -> tuple[str, list[dict[str, object]]]:
    segments, _info = whisper_model.transcribe(str(audio_path), beam_size=5)
    items: list[dict[str, object]] = []
    transcript_lines: list[str] = []

    for segment in segments:
        start = round(segment.start, 2)
        end = round(segment.end, 2)
        text = segment.text.strip()
        if not text:
            continue
        transcript_lines.append(text)
        items.append({"start": start, "end": end, "text": text})

    transcript = " ".join(transcript_lines).strip()
    return transcript, items


def _ask_gpt(transcript: str, prompt: str, model: str) -> str | None:
    if not transcript or _openai_client is None or not OPENAI_API_KEY:
        return None

    if _openai_style == "v1":
        response = _openai_client.chat.completions.create(  # type: ignore[attr-defined]
            model=model or OPENAI_MODEL,
            messages=[
                {
                    "role": "system",
                    "content": "You are a concise assistant that cleans up transcripts and summarizes them.",
                },
                {
                    "role": "user",
                    "content": f"{prompt}\n\nTranscript:\n{transcript}",
                },
            ],
            temperature=0.2,
        )
        return response.choices[0].message.content

    response = _openai_client.ChatCompletion.create(  # type: ignore[attr-defined]
        model=model or OPENAI_MODEL,
        messages=[
            {
                "role": "system",
                "content": "You are a concise assistant that cleans up transcripts and summarizes them.",
            },
            {
                "role": "user",
                "content": f"{prompt}\n\nTranscript:\n{transcript}",
            },
        ],
        temperature=0.2,
    )
    return response["choices"][0]["message"]["content"]


async def _save_upload(file: UploadFile) -> Path:
    suffix = Path(file.filename or "audio.webm").suffix or ".webm"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp_path = Path(tmp.name)
        tmp.write(await file.read())
    return tmp_path


@app.post("/transcribe")
async def transcribe_audio(
    file: UploadFile = File(...),
) -> dict[str, object]:
    tmp_path = await _save_upload(file)
    try:
        transcript, segments = _transcribe_audio(tmp_path)
        return {
            "filename": file.filename,
            "transcript": transcript,
            "segments": segments,
            "whisper_model": WHISPER_MODEL,
        }
    finally:
        try:
            tmp_path.unlink(missing_ok=True)
        except OSError:
            pass


@app.post("/process")
async def process_audio(
    file: UploadFile = File(...),
    prompt: str = Form("Clean up this transcript and summarize the main points."),
    openai_model: str = Form(OPENAI_MODEL),
) -> dict[str, object]:
    tmp_path = await _save_upload(file)
    try:
        transcript, segments = _transcribe_audio(tmp_path)
        ai_text = _ask_gpt(transcript, prompt, openai_model)
        return {
            "filename": file.filename,
            "transcript": transcript,
            "segments": segments,
            "ai_text": ai_text,
            "openai_model": openai_model if ai_text else None,
            "whisper_model": WHISPER_MODEL,
        }
    finally:
        try:
            tmp_path.unlink(missing_ok=True)
        except OSError:
            pass


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app:app", host=HOST, port=PORT, reload=True)
