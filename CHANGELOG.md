# Changelog

## 0.3.0 — 2026-10-23

- **Fix:** the surface replacement carrier is now a `user/message`, not a `system/message`.
  Session format v4 requires `system/message` to belong to an open turn/step; the rewind command runs between
  turns, and fabricating a turn desynchronizes the runtime's own turn counter (the next real turn reuses the
  same number, producing `turn/start does not open the expected turn`). A `user/message` is the one surface
  event the v4 state machine allows between turns, so it does not touch the turn counter.
- The replacement carries a single zero-width text block (`U+200B`) and `source.kind: "local-rewind"`.
  The client projection hides the replacement row, so the transcript stays clean; the model sees at most one
  zero-width token instead of the removed history.
- No synthetic `turn/start`/`step/start` events are written.

## 0.2.0 — 2026-10-23 (withdrawn)

- Tried wrapping the system/message placeholder in a synthetic turn/step. Format-valid, but the runtime turn
  counter ignores plugin-created turns, so the next real turn collided with the synthetic one. Never published.

## 0.1.1 — 2026-10-22

- **Fix:** the placeholder `system/message` now carries a `source.kind` (v0.1.1 used `dsh-local-rewind`, which
  still fails the v4 `system-prompt` requirement; use 0.3.0).

## 0.1.0 — 2026-10-22

- Initial release.
- Per-message **撤回** button and `/rewind <n>` command.
- Context truncation through a surface replacement; the marker and the receipt never reach the model.
- `localRewind` session projection keeps the transcript consistent after a reload.
- Hiding is limited to the turns explicitly recorded by the host; later turns stay visible.
- Command receipt policy: `turn` (default), `always`, `hidden`.
