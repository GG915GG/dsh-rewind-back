# Changelog

## 0.1.1 — 2026-10-22

- **Fix:** the placeholder `system/message` now carries `source: { kind: "dsh-local-rewind" }`.
  DSH 0.2.1's session format v4 requires every message to have a producer-owned `source.kind`; 0.1.0 wrote
  placeholders without `source`, so any session that used rewind failed to load from history with
  `SessionFormatError: format v4 message requires a producer-owned source kind`.
- Sessions already damaged by 0.1.0 need their invalid placeholders removed; because v4 also requires
  contiguous `seq` values, fill each removed seq with an empty `system/message` that has a valid `source.kind`
  (no `surfaceOp`) instead of leaving a gap.

## 0.1.0 — 2026-10-22

- Initial release.
- Per-message **撤回** button and `/rewind <n>` command.
- Context truncation through a surface replacement; the marker and the receipt never reach the model.
- `localRewind` session projection keeps the transcript consistent after a reload.
- Hiding is limited to the turns explicitly recorded by the host; later turns stay visible.
- Command receipt policy: `turn` (default), `always`, `hidden`.
