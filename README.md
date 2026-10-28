<p align="center"><img src="frontend/src-tauri/icons/icon.png" width="200" alt="Meetily Pro" /></p>

# Meetily Pro 🎙️ - Private AI meeting notes: record, transcribe, summarize on your machine

<p align="center">
  <a href="https://tauri.app"><img src="https://img.shields.io/badge/Tauri_2-24C8D8?style=for-the-badge&logo=tauri&logoColor=white" alt="Tauri 2"></a>
  <a href="https://www.rust-lang.org"><img src="https://img.shields.io/badge/Rust-000000?style=for-the-badge&logo=rust&logoColor=white" alt="Rust"></a>
  <a href="https://github.com/ggerganov/whisper.cpp"><img src="https://img.shields.io/badge/whisper.cpp-4B5563?style=for-the-badge" alt="whisper.cpp"></a>
  <a href="frontend/package.json"><img src="https://img.shields.io/github/package-json/v/asidko/meetily-pro?filename=frontend%2Fpackage.json&style=for-the-badge&label=version&color=F59E0B" alt="Version"></a>
  <a href="https://github.com/asidko/meetily-pro/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/asidko/meetily-pro/ci.yml?branch=main&style=for-the-badge&label=CI" alt="CI"></a>
  <a href="LICENSE.md"><img src="https://img.shields.io/badge/License-MIT-3B82F6?style=for-the-badge" alt="MIT License"></a>
</p>

<p align="center"><img src="docs/meetily_demo.gif" width="720" alt="Meetily demo" /></p>

Records mic and system audio, transcribes live with Whisper, Parakeet or OpenAI's GPT Transcribe, summarizes with the LLM you pick. Nothing leaves the machine unless you choose a cloud model.

Fork of [Zackriya-Solutions/meetily](https://github.com/Zackriya-Solutions/meetily). Tracks upstream `main`, adds a live in-meeting assistant.

## Install

- **Download (recommended)**: [macOS Apple Silicon .dmg](https://github.com/asidko/meetily-pro/releases/latest/download/meetily-macos-arm64.dmg), [Linux x86_64 .deb](https://github.com/asidko/meetily-pro/releases/latest/download/meetily-linux-x86_64.deb) (Debian, Ubuntu) or [Linux x86_64 .rpm](https://github.com/asidko/meetily-pro/releases/latest/download/meetily-linux-x86_64.rpm) (Fedora, RHEL, openSUSE), checksums in [Releases](https://github.com/asidko/meetily-pro/releases/latest).
- **Build from source**: Windows, Intel Mac, CUDA. See below.

The macOS app is ad-hoc signed, not notarized. After dragging it to Applications, run `xattr -dr com.apple.quarantine "/Applications/Meetily Pro.app"` once. It needs microphone and screen-recording permission (that is how system audio is captured).

## Quickstart

1. First launch downloads a transcription model. Whisper `base` is fine to start, or press Use on the OpenAI or OpenRouter Speech row in Settings > Models to transcribe in the cloud.
2. Pick an AI model: built-in local model, Ollama, a cloud key (OpenAI, Claude, Groq, OpenRouter, custom OpenAI-compatible), or your own Claude Code or Codex sign-in.
3. Choose mic and system-audio device, press Record. Stop when done; the summary appears in the meeting.

## What's new

### v1.10.1

- The app now updates itself: Update and Restart downloads the new version, checks it is genuine, installs it and reopens. Turn off the automatic check in Settings if you prefer.
- Fedora, RHEL and openSUSE get their own package next to the Ubuntu one, and both are half the size because they use the ffmpeg already on your computer.
- The Mac installer opens a tidy window: drag the app onto Applications.
- Drop an audio file straight onto the open import window, and resize the assistant panel during a call.

### v1.10.0

- Importing a video keeps only its sound, so the import is fast and takes little space.
- Drag the edge of the assistant panel to make it wider or narrower; it remembers the width.
- Ask the assistant for tips or questions and they arrive as cards. Keep typing while it answers: your messages go out right after.
- Fix a meeting's topic and key terms with the pencil next to them.
- Report a Bug in About opens a GitHub issue with your app and system details already filled in, and About shows recent changes, credits and licenses.

### v1.9.0

- Fix a transcript line on the spot: hover it, click the pencil, edit, press Enter. Works during a call and on saved meetings.
- Tips from the assistant now appear in the chat in the order they come, right after your questions and answers.
- Chat errors show the real reason from the AI service and can be closed with a cross.
- Check for Updates looks at the latest release on GitHub and links to its download page.

## Features

Live transcription on device (Whisper with Metal/CUDA/Vulkan/ROCm, or Parakeet on CPU) or in the cloud (OpenAI GPT Transcribe, or any OpenRouter speech model), VAD so only speech hits the model.

<p align="center"><img src="docs/home.png" width="720" alt="Live transcription" /></p>

Live assistant beside the transcript: questions and tips cited to transcript moments, plus a chat about the call so far. Design: [docs/LIVE_ASSISTANT_DESIGN.md](docs/LIVE_ASSISTANT_DESIGN.md).

When a call ends, the assistant posts a short recap into the meeting chat, and the chat stays open for follow-up questions about the meeting.

<p align="center"><img src="docs/summary.png" width="720" alt="Summary" /></p>

Import an audio file, or re-transcribe a meeting with another model or language.

<p align="center"><img src="docs/meetily-export.gif" width="720" alt="Import and re-transcribe" /></p>

Mic and system audio mixed with ducking and clip protection; everything stored as files plus one SQLite database.

<p align="center"><img src="docs/audio.png" width="720" alt="Devices" /></p>

## How it compares

- Otter, Fireflies, Granola: better diarization and integrations, cloud processing and storage.
- MacWhisper, raw whisper.cpp: great local transcription, no system-audio capture, mixing or summaries.
- Meetily Pro: the whole pipeline, local by default, model is your choice. No bot, no diarization yet.

## Configuration

All settings are in the app. Data lives in the Tauri app data dir (`~/Library/Application Support/com.meetily.ai`, `%APPDATA%\com.meetily.ai`, `~/.local/share/com.meetily.ai`): `meeting_minutes.sqlite`, `models/`, and a recordings folder with one directory per meeting.

## Build from source

Rust stable, Node 20, pnpm 9.15.9, CMake. Linux adds clang, libasound2-dev and ffmpeg (the app uses the system ffmpeg on Linux); Windows adds VS Build Tools C++ workload.

```bash
git clone https://github.com/asidko/meetily-pro
cd meetily-pro/frontend
pnpm install --frozen-lockfile
./dev-gpu.sh      # dev run, auto-detects GPU, builds the llama sidecar
./build-gpu.sh    # release bundle in ../target/release/bundle/
```

Windows: `.\dev-gpu.ps1` / `.\build-gpu.ps1`. Force a backend with `TAURI_GPU_FEATURE=cuda|vulkan|hipblas|metal|coreml|openblas|none`. Details: [docs/BUILDING.md](docs/BUILDING.md), [docs/GPU_ACCELERATION.md](docs/GPU_ACCELERATION.md).

Tests: `pnpm test` in `frontend/` (one Bun process per file), `cargo test -p meetily` at the root. Lint: `pnpm lint`.

## Architecture

One Tauri 2 process. Rust owns audio capture, mixing and VAD, transcription (whisper-rs, ONNX Runtime), SQLite, and every LLM call. The UI is a static Next.js export that talks to Rust only via Tauri commands and events; its CSP blocks all network except localhost, so cloud calls can only come from Rust. Sidecars: `llama-helper` (local summaries) and `ffmpeg` (import decoding). More: [CLAUDE.md](CLAUDE.md), [docs/architecture.md](docs/architecture.md).

## License

MIT, see [LICENSE.md](LICENSE.md). Upstream by [Zackriya Solutions](https://github.com/Zackriya-Solutions); code borrowed from [whisper.cpp](https://github.com/ggerganov/whisper.cpp), [Screenpipe](https://github.com/mediar-ai/screenpipe), [transcribe-rs](https://crates.io/crates/transcribe-rs); Parakeet by NVIDIA, ONNX conversion by [istupakov](https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx).
