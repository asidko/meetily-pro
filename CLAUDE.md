# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Meetily: privacy-first meeting recorder/transcriber/summarizer. One Tauri 2 desktop app: Rust core + Next.js 14 UI (static export loaded into the webview). No HTTP server, no separate backend.

- Cargo workspace at repo root. Members: `frontend/src-tauri` (crate `meetily`, lib `app_lib`) and `llama-helper` (local LLM sidecar). Shared `target/` lives at the repo root.
- `frontend/` holds both the Next.js app and `src-tauri/`.
- `backend/` (Python/FastAPI, Docker, whisper-server, the `backend/whisper.cpp` submodule) is an unsupported archive. Never add code there, never treat it as an API, never require it.

## Commands

Run from `frontend/` unless noted. Package manager is pnpm 9.15.9.

```bash
pnpm install --frozen-lockfile        # commit pnpm-lock.yaml when deps change on purpose
pnpm tauri:dev                        # auto-detects GPU feature (scripts/tauri-auto.js) then `tauri dev`
pnpm tauri:dev:cpu                    # explicit feature variants: cpu|cuda|vulkan|metal|coreml|openblas|hipblas
TAURI_GPU_FEATURE=vulkan pnpm tauri:dev   # force a feature; "none" forces CPU
./dev-gpu.sh                          # Linux/macOS: builds llama-helper, copies it into src-tauri/binaries, then tauri:dev
./build-gpu.sh                        # same for a release bundle; Windows: build-gpu.ps1 / dev-gpu.ps1
pnpm tauri:build                      # release bundle only (needs the sidecar binary already present)
pnpm dev                              # Next.js alone on port 3118 (Tauri devUrl)
pnpm lint                             # next lint, config in .eslintrc.json (core-web-vitals); no Rust fmt/clippy config in repo
pnpm exec tsc --noEmit                # typecheck; tsconfig excludes src-tauri
```

`./clean_run.sh [info|debug|trace]` and `./clean_build.sh` are macOS convenience scripts: they delete node_modules/.next, reinstall, set `RUST_LOG`, then run tauri dev/build. `clean_build.sh` also wipes `target/`.

The sidecar: `tauri.conf.json` lists `binaries/llama-helper` and `binaries/ffmpeg` as `externalBin`. `build.rs` downloads ffmpeg (and on Windows `onnxruntime.dll`, sha-pinned) into `src-tauri/binaries/` at compile time, so the first build needs network. llama-helper is only produced by the `dev-gpu`/`build-gpu` scripts (`cargo build -p llama-helper [--features metal|cuda|vulkan]` plus a copy named `llama-helper-<target-triple>`); `tauri-build` resolves `externalBin` entries at compile time, so run one of those scripts before a bare `tauri dev`/`tauri build`.

### Tests

Frontend tests use Bun's runner (`bun:test`, `react-test-renderer`), not Jest or Vitest. Files live in `frontend/tests/{hooks,lib}`.

```bash
pnpm test                                      # all files, one Bun process each (scripts/run-tests.js)
bun test tests/lib/summary-content.test.ts     # one file
bun test tests/lib/summary-content.test.ts -t "accepts visible markdown"   # by test name
```

Never run a bare `bun test` over the whole directory: Bun shares `mock.module` state across files in one process and the suites mock the same modules (`@tauri-apps/api/core`, `next/navigation`, `sonner`) differently, so results depend on file order. The runner isolates each file. New suites still restore what they mock in `afterAll`, as the existing ones do.

Rust tests are inline `#[cfg(test)]` modules (about 250 tests) plus a fixture in `src-tauri/tests/fixtures/`. Run from the repo root:

```bash
cargo check -p meetily                 # fast type check
cargo test -p meetily                  # full; first run compiles whisper.cpp via cmake (slow, needs cmake + clang/llvm on Linux)
cargo test -p meetily decoder          # filter by name
```

CI: `.github/workflows/ci.yml` runs on push to `main` and on every PR: `pnpm lint`, `tsc --noEmit`, `pnpm test`, then builds the llama-helper sidecar and runs `cargo test -p meetily --locked` on Ubuntu. `release.yml` runs on a `v*` tag push: drafts the release, builds an ad-hoc signed macOS arm64 `.dmg` and a Linux x86_64 `.deb`, uploads `SHA256SUMS`, then publishes. Notes take the README "What's new" block for the tag. The upstream `build*.yml` workflows stay `workflow_dispatch` only and need upstream signing secrets. Toolchain pins: `rust-toolchain.toml` (1.96.0), `frontend/.nvmrc` (20), `packageManager` in package.json.

## Branches, versions, commits

- This is the asidko/meetily-pro fork: `origin` is the fork, `upstream` is Zackriya-Solutions/meetily. Branch from `main`, PR into the fork's `main`. Upstream uses `devtest` as integration branch (CONTRIBUTING.md); only matters when sending changes upstream. Conventional commit format.
- Version is duplicated in `frontend/package.json`, `frontend/src-tauri/Cargo.toml` and `frontend/src-tauri/tauri.conf.json`; the release workflow fails unless all three match the tag. Bump all three, update the README "What's new" section, then tag `vX.Y.Z` and push.
- The About page shows the same last 3 releases in `frontend/src/lib/about.ts` (`WHATS_NEW`, one or two short highlights each); `tests/lib/about.test.ts` fails unless its versions match the README blocks and the first one matches package.json.
- README "## What's new" has no version in its heading. It holds one `### vX.Y.Z` block per release for the last 3 releases only, each with the few major user-facing changes; drop the oldest block when adding a new one. The release workflow copies the block matching the tag into the release notes and fails if it is missing. Write it for users: plain words about what they can now do, no technical terms.
- There is no auto-updater. Check for Updates (About, tray, a startup check) asks the GitHub API for this fork's latest release (`release_check.rs`) and only links to the release page.

## Architecture

### Process layout

```
Next.js UI (out/, static export)  <--invoke/emit-->  Rust core (app_lib)
                                                        |-- llama-helper sidecar (JSON lines over stdin/stdout, built-in summaries)
                                                        |-- ffmpeg sidecar (decode/mix imported audio)
                                                        |-- SQLite (sqlx) in app_data_dir/meeting_minutes.sqlite
                                                        |-- local models in app_data_dir/models (whisper ggml, parakeet onnx, llama gguf)
```

External LLM providers (Ollama, OpenAI, Claude, Groq, OpenRouter, custom OpenAI-compatible) are called over HTTP from Rust; the webview CSP in `tauri.conf.json` only allows localhost Ollama from the UI side. Claude Code and Codex are the exception: Rust spawns the user's own `claude`/`codex` binary per request (`summary/cli_agent.rs`) with tools off and no session files. Claude Code gets the login-shell environment and the user's settings (hooks and CLAUDE.md files off), so it signs in exactly like `claude -p` in a terminal; Codex ignores the user config and has its API-key env vars removed.

### Rust core (`frontend/src-tauri/src`)

- `lib.rs`: `run()` wires plugins, managed state, `setup` (tray, notifications, Whisper/Parakeet init, built-in model manager, DB init) and the `generate_handler![...]` list of ~180 commands. New command = `#[tauri::command]` fn + entry in that list. Modules re-export `__cmd__*` and `__tauri_command_name_*` symbols via `pub use` so the list can name them.
- Startup DB flow (`database/setup.rs`): if no sqlite file exists it emits `first-launch-detected` and does NOT manage `AppState` until onboarding creates the DB; otherwise `AppState { db_manager }` is managed immediately. Commands read it with `app.try_state::<AppState>()` and must handle `None`.
- `database/`: sqlx SQLite. Migrations are `src-tauri/migrations/<timestamp>_<name>.sql`, applied by `sqlx::migrate!` on open. Add a new file, never edit an applied one. A legacy `meeting_minutes.db` from the old Python backend is copied in automatically if found. Access goes through `database/repositories/*`.
- `api/api.rs`: the `api_*` commands are the former FastAPI REST surface (meetings, transcripts, settings, search) reimplemented over the repositories. The UI calls these names directly (`invoke('api_get_meetings')`). Keep the `api_` prefix for data-access commands; `summary/commands.rs` follows it too.
- Settings are split: model/provider config and API keys in the SQLite settings table; recording preferences and onboarding state in `tauri-plugin-store` JSON. Check which store a setting belongs to before adding one.
- `audio/`: two parallel paths out of `pipeline.rs`. `AudioPipelineManager` aligns mic + system samples in a ring buffer, `ProfessionalAudioMixer` applies RMS ducking/clipping control for the saved recording, and silero VAD (`vad.rs`) gates 16 kHz speech chunks for transcription. `recording_manager.rs` orchestrates, `recording_commands.rs` exposes commands, `recording_saver.rs`/`incremental_saver.rs` write files. Capture backends: cpal, macOS ScreenCaptureKit via `cidre` (`capture/core_audio.rs`), WASAPI loopback on Windows (`devices/platform/windows.rs`). `transcription/` defines the `TranscriptionProvider` trait with Whisper and Parakeet providers, `cloud_provider.rs` (voice providers `openai-speech`/`openrouter-speech`: each VAD chunk is uploaded as WAV to `/audio/transcriptions` with the AI key saved for that service), and the worker that emits `transcript-update`; a failed cloud chunk emits `transcription-error` with phase `chunk` and the recording continues. `import.rs` and `retranscription.rs` reuse the same engines for file import and re-running a meeting with another model; for a cloud model they send four segments at a time (`common.rs`), and retranscribe can pass the meeting's stored key terms to OpenAI as the transcription prompt.
- `whisper_engine/` (whisper-rs, GPU via Cargo features) and `parakeet_engine/` (`ort` ONNX). Models live in `app_data_dir/models`, set at startup by each module's `set_models_directory`.
- `summary/`: `llm_client.rs` has `LLMProvider { OpenAI, Claude, Groq, Ollama, OpenRouter, BuiltInAI, CustomOpenAI, ClaudeCode, Codex }`; HTTP clients sit in `ollama/`, `openai/`, `anthropic/`, `groq/`, `openrouter/`. `service.rs` orchestrates chunking and the fixed recap prompt (`processor.rs`), language detection and a cancellation registry. `summary_engine/` is BuiltInAI: gguf model download manager plus the llama-helper sidecar lifecycle (`sidecar.rs`).
- `tray.rs`: closing the main window hides it to the tray, the process keeps running. The single-instance plugin refocuses the window on a second launch. Remember this when testing "quit".
- Logging: `log` + `env_logger`. `perf_debug!`/`perf_trace!` (top of `lib.rs`) compile to nothing in release; use them for per-chunk logging in audio and whisper hot paths. `LOGGING_OPTIMIZATIONS.md` explains why.
- Dead code that is present but not compiled: `lib_old_complex.rs`, `audio/core-old.rs`, `audio/recording_saver_old.rs`, `audio/recording_commands.rs.backup`, and all of `audio_v2/` (no `mod audio_v2`). Do not edit them or copy patterns from them. `CLEANUP_PLAN.md` records the intent to delete them.

### Frontend (`frontend/src`)

- Next 14 app router with `output: 'export'`; `reactStrictMode` is off. Alias `@/*` -> `src/*`.
- Layering: `services/*.ts` are thin 1:1 wrappers over `invoke`/`listen` (recording, transcript, config, storage, update). `contexts/` hold global state: `RecordingStateContext` is a status machine (IDLE, STARTING, RECORDING, STOPPING, PROCESSING_TRANSCRIPTS, SAVING, COMPLETED, ERROR) re-synced from the backend so a page reload cannot desync it; `TranscriptContext`, `ConfigContext`, `OnboardingContext`, `ImportDialogContext`. `components/Sidebar/SidebarProvider.tsx` owns the meetings list and current meeting. Page logic lives in `hooks/` (`hooks/meeting-details/*` for the details page).
- Events the UI listens for: `transcript-update`, `transcription-error`, `transcription-complete`, `speech-detected`, `audio-levels`, `chunk-drop-warning`, `recording-starting|started|paused|resumed|stopped|stop-complete`, `mic-unavailable|mic-device-switched|mic-swap-failed|mic-recovery-exhausted`, `model-download-complete`, `builtin-ai-download-progress`, `first-launch-detected`, `request-recording-toggle` (from the tray).
- Settings > Models (`components/model-settings/`) is the only place providers are set up (keys, Ollama URL, custom server, on-device downloads) and picks the models: each ready provider row has a Use button (`UseModelButton`, a search over that provider's models only), OpenAI and OpenRouter each have a Text row and a Speech row sharing one key, and an "In use" section on top shows the voice model and the one AI model, which serves summaries and the assistant. `lib/model-catalog.ts` decides which models are ready right now; Use lists only those. Each part saves alone (`api_save_api_key`, `api_save_ollama_endpoint`, `api_save_custom_openai_config`, `api_save_ai_model`, `api_save_transcript_config`), so setting up a provider never changes a selection.
- The meeting details page shows the transcript next to an Assistant panel: the questions and tips from the call until the user closes each one (`meeting_suggestions.dismissed`), then a chat saved per meeting (`meeting_chat_messages`, `api_ask_meeting_assistant`), which continues the chat from the recording. The summary is written automatically once a meeting has a transcript and an AI model, and loading the chat adds it once as a `recap` message (an assistant reply with its own background). The summary job also asks the AI model for `key_terms` (topic plus names and jargon, stored in the summary result JSON), posted as a small `key_terms` message right before the recap; recap and key terms stay out of chat memory. Both chats show how full the chat memory is; Compact stores a `summary` message and the model reads only from the newest summary on.
- The UI follows the system light or dark theme. `tailwind.colors.js` maps every palette shade to a CSS variable that changes under `prefers-color-scheme: dark`, so plain classes like `bg-white` and `text-gray-700` adapt without `dark:` variants.
- Long transcripts render through `VirtualizedTranscriptView` (`@tanstack/react-virtual`) with paginated loading (`usePaginatedTranscripts`).

### Acceleration and portable builds

- `meetily` crate features: `metal`, `coreml`, `cuda`, `vulkan`, `hipblas`, `openblas`, `openmp`. macOS always gets metal+coreml through target-specific deps; Windows/Linux default to CPU. `scripts/auto-detect-gpu.js` picks the feature; llama-helper gets the same one except `coreml` maps to `metal`.
- Windows distribution builds must stay portable: workflows set `CMAKE_PROJECT_INCLUDE=.github/force-portable-ggml.cmake` (forces `GGML_NATIVE=OFF`) and `RUSTFLAGS=-C target-cpu=x86-64-v2`, then `verify-portable-ggml.cjs` inspects the whisper CMake cache before bundling. The README promises AVX2-only CPUs work; keep these when touching whisper build flags.
- Platform needs: macOS requires microphone and screen-recording permission for system audio; Linux builds need cmake, llvm, libomp; Windows needs VS Build Tools C++ workload and CMake.

## Conventions

- Rust uses `anyhow::Result` internally and `Result<T, String>` at the command boundary. Frontend wraps `invoke` in try/catch with toasts (`sonner`).
- Audio naming is "microphone" and "system", never "input"/"output".
- Use Tauri path APIs (`app_data_dir`, `downloadDir`) for every file location; no hardcoded paths.
- Models are loaded once and cached; switching models needs explicit unload/reload.

## Other useful files

- `docs/BUILDING.md`, `docs/GPU_ACCELERATION.md`: per-platform build and acceleration detail.
- `.github/workflows/WORKFLOWS_OVERVIEW.md`, `README_DEVTEST.md`: what each manual workflow does and which secrets it needs.
- `frontend/src-tauri/NOTIFICATION_TESTING.md`: commands to exercise notifications.
- `scripts/inject_transcript.py`: seed a meeting into the SQLite DB from a CSV for testing summaries.
