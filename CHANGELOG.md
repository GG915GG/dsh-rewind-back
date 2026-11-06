# Changelog

## 0.3.1 — 2026-11-06

- **Feature:** `ask_user_question` answers (the question-reply card introduced in DSH 0.2.2) are now rewindable.
  The card renders its own action bar inside `[data-question-reply]` without `data-clock`, so the old scan never
  reached it; the button is now injected there too, and the reply counts as a rewind anchor for `/rewind <n>`.
- **Fix:** a card answered through the live panel has no message event at all — the question sits in
  `tool/call` and the answer in `tool/result` — so matching the card's rendered text always failed with
  "没有找到与按钮对应的用户消息". The card's button now rewinds the user prompt that started that turn, which
  removes the card and everything after it.
- **Fix:** matching a question-reply button used to be impossible — the browser sends the rendered
  "question + chosen answer" text while the event stores the answer payload as JSON. Anchors now carry the
  question and answer snippets, matched before the loose substring rule so an earlier message quoted inside the
  question cannot win. The receipt shows a readable "question — 回答" summary instead of raw JSON.
- **UI:** the button is an icon button that matches DSH's own message action row (28px hit area, 15px glyph,
  17px on turn-tail rows, tertiary label colour, `--dsw-radius-sm`, hover-only background) instead of a text pill.
- **Fix:** hidden rows no longer flash when a conversation is opened. Hiding used to run only on `apply()`, after
  a click, and on an 800 ms poll, so the full transcript painted first. It now runs in the same microtask that
  renders a row (MutationObserver → `sweepSoon`) and on every `localRewind` projection update (the face's
  `subscribe`), with a 400 ms poll only as a fallback.
- **Fix:** a failed rewind leaves a `command/done` error row (`>_ rewind · 没有找到与按钮对应的用户消息。`) in the
  transcript forever. Those rows are now hidden regardless of the `receipt` policy — the alert already reported
  the failure.
- **Manifest:** declares `engines.dsh` (`^0.2.1-rc.2`). DSH 0.2.2 no longer reads
  `dsh.compatibility.dshReleases` at all, so that field alone no longer reports support.

## 0.3.0 — 2026-10-23

- **Fix:** the surface replacement carrier is now a `user/message`, not a `system/message`.
  Session format v4 requires `system/message` to belong to an open turn/step; the rewind command runs between
  turns, and fabricating a turn desynchronizes the runtime's own turn counter (the next real turn reuses the
  same number, producing `turn/start does not open the expected turn`). A `user/message` is the one surface
  event the v4 state machine allows between turns, so it does not touch the turn counter.
- The replacement carries a single zero-width text block (`U+200B`) and `source.kind: "rewind-back"`.
  The client projection hides the replacement row, so the transcript stays clean; the model sees at most one
  zero-width token instead of the removed history.
- No synthetic `turn/start`/`step/start` events are written.

## 0.2.0 — 2026-10-23 (withdrawn)

- Tried wrapping the system/message placeholder in a synthetic turn/step. Format-valid, but the runtime turn
  counter ignores plugin-created turns, so the next real turn collided with the synthetic one. Never published.

## 0.1.1 — 2026-10-22

- **Fix:** the placeholder `system/message` now carries a `source.kind` (v0.1.1 used `dsh-rewind-back`, which
  still fails the v4 `system-prompt` requirement; use 0.3.0).

## 0.1.0 — 2026-10-22

- Initial release.
- Per-message **撤回** button and `/rewind <n>` command.
- Context truncation through a surface replacement; the marker and the receipt never reach the model.
- `localRewind` session projection keeps the transcript consistent after a reload.
- Hiding is limited to the turns explicitly recorded by the host; later turns stay visible.
- Command receipt policy: `turn` (default), `always`, `hidden`.
