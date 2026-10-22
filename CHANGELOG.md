# Changelog

## 0.1.0 — 2026-10-22

- Initial release.
- Per-message **撤回** button and `/rewind <n>` command.
- Context truncation through a surface replacement; the marker and the receipt never reach the model.
- `localRewind` session projection keeps the transcript consistent after a reload.
- Hiding is limited to the turns explicitly recorded by the host; later turns stay visible.
- Command receipt policy: `turn` (default), `always`, `hidden`.
