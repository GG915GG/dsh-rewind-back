# Changelog

## 0.2.0 — 2026-10-23

- **Fix:** session format v4 has two separate rules that the old placeholder broke:
  1. `system/message` must carry `source.kind: "system-prompt"` (the official system prompt producer).
     A custom or missing kind fails history loading with `message must have system-prompt source` or
     `requires a producer-owned source kind`.
  2. `system/message` must belong to an **open turn and step**. The rewind command runs between turns, so the
     host now opens a short synthetic turn/step, appends the placeholder, and closes them again
     (`turn/start` → `step/start` → `system/message` → `step/end` → `turn/end`). The placeholder has empty
     content and is skipped by `deriveEventMessage`, so the synthetic turn never reaches the model.
- The rewind receipt and the `localRewind` projection are unchanged.

## 0.1.1 — 2026-10-22

- **Fix:** the placeholder `system/message` now carries a `source.kind` (v0.1.1 used `dsh-local-rewind`, which
  still fails the v4 `system-prompt` requirement; use 0.2.0).

## 0.1.0 — 2026-10-22

- Initial release.
- Per-message **撤回** button and `/rewind <n>` command.
- Context truncation through a surface replacement; the marker and the receipt never reach the model.
- `localRewind` session projection keeps the transcript consistent after a reload.
- Hiding is limited to the turns explicitly recorded by the host; later turns stay visible.
- Command receipt policy: `turn` (default), `always`, `hidden`.
