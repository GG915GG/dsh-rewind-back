> **Disclaimer — read before use**
>
> This is an experimental, unofficial plugin. It appends a `user/message` event with `surfaceOp: replace`
> through DSH's internal session API and relies on DOM/projection internals. This is **not** a supported
> public API.
>
> A DSH upgrade, a plugin bug, or an edge case can write an event that DSH rejects when the session is
> reloaded, leaving that session unable to load (the **历史加载失败** screen). The original events are not
> deleted from the append-only log and can usually be recovered, but until repaired you may not be able to
> open the session.
>
> **Use at your own risk. Do not use this on important sessions without a backup. The author accepts no
> liability for lost access, corrupted sessions, or data loss.** If you need a guaranteed-safe truncation,
> use DSH's official compaction or fork instead.

# dsh-rewind-back

[中文](README.zh.md) | English

A local **rewind / undo** button for [DeepSeek Harness](https://deepseek-harness.github.io/) Web.

Hover any message, click **撤回** (rewind), and that message plus everything after it is removed from the
transcript and from the model-visible context — without leaving a trace in the model context and without
destroying the underlying session log.

> Status: experimental. Built and tested against DSH `0.2.1-rc.2`. The plugin uses internal session/DOM
> APIs, so a DSH upgrade may break it.

## Why

DSH has compaction, forking and session-level operations, but no quick way to take back one bad prompt and
everything that followed it. This plugin adds a per-message button:

- the selected message and every later message disappear from the chat;
- the model no longer sees them on the next request;
- the original text is kept in the command receipt so you can copy it and resend;
- the session log still contains every event, so nothing is physically deleted.

## Features

- A **撤回** button is injected next to the copy/time actions of every message (both user bubbles and
  assistant turn tails).
- Clicking it retracts the selected message and all following messages, for the whole conversation.
- The model context is truncated with a surface replacement, so the retracted messages do not count as
  tokens on subsequent requests.
- The command receipt and the rewind marker itself are not sent to the model.
- The receipt can be `turn` (one turn, default), `always`, or `hidden` — see [Configuration](#configuration).
- The UI state is restored from a session projection, so hidden messages stay hidden after a page reload.
- Also available as a command: `/rewind <n>` (`1` = the latest user message).

## How it works

**Host half** (`lib/index.js`)

- Registers the `/rewind` command.
- Appends a `user/message` event carrying `surfaceOp: { op: "replace", startSeq, endSeq }` — the same
  surface-replacement mechanism compaction uses. Session format v4 does not allow `system/message` outside an
  open turn/step, and fabricating a turn desynchronizes the runtime's turn counter, so the replacement is a
  `user/message` (the one surface event allowed between turns).
- The replacement's content is a single zero-width text block (`U+200B`) with `source.kind: "rewind-back"`;
  the client projection hides its transcript row, and the model sees at most one zero-width token.
- Records the shadowed ranges/turns in `data.localRewind` and exposes them through a `localRewind`
  session projection.

**Browser half** (`lib/client.js`)

- Injects the button with a `MutationObserver` over the chat transcript.
- Calls the host command through `remote.commands.execute` (no extra HTTP endpoint).
- Reads the `localRewind` projection and hides matching rows (`[data-chat-anchor-key]` flow rows and the
  recorded `[data-chat-turn]` rows) with `display: none`.
- Applies the receipt policy: a `command` row containing the rewind receipt is hidden once a later user row
  exists (`turn`), hidden always (`hidden`), or left alone (`always`).

Only the turns explicitly recorded by the host are hidden. Do **not** hide `turn >= fromTurn`: turn numbers
only grow, so that rule would also hide every message you send after the rewind and the assistant's reply.

## Install

Requirements: DSH Web `0.2.1-rc.2` (desktop app or `dsh --profile web`), Node.js 20+ for development.

Clone the repository somewhere stable, then link it into your DSH profile.

```powershell
git clone https://github.com/GG915GG/dsh-rewind-back.git C:\src\dsh-rewind-back

# Windows: create a junction inside the profile
cmd /c mklink /J "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-rewind-back" "C:\src\dsh-rewind-back"
```

Edit `%USERPROFILE%\.dsh\profiles\desktop\package.json`:

```json
{
  "dependencies": {
    "dsh-rewind-back": "link:C:/src/dsh-rewind-back"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "...",
        "dsh-rewind-back"
      ]
    }
  }
}
```

Restart DSH completely. The host half is loaded at startup; the browser half is served by the web app.

To uninstall, remove `dsh-rewind-back` from `dsh.profile.bundles` and from `dependencies`, then restart DSH.

## Usage

- Hover over any message; click **撤回** to retract that message and everything after it.
- Or type `/rewind 1` (latest user message), `/rewind 3`, etc.
- The receipt shows the original text, so it can be copied and sent again. By default it only stays in the
  transcript until you send your next message.

The retracted part is gone from the visible transcript and from the model context. Because the session log is
append-only, the events are still on disk; if you really want to restore them, remove the replacement event
from the session log offline (do this only with DSH closed and after making a backup).

## Configuration

The `> rewind · 已撤回 …` command receipt has a display policy:

```yaml
# %USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml
- id: rewind-back
  config:
    receipt: turn   # turn (default) | always | hidden
```

- `turn` — visible until the next user turn starts, then gone (default);
- `always` — keep every receipt in the transcript;
- `hidden` — never show the receipt (the original text is still recoverable from the session log).

The policy is passed to the browser through the `localRewind` session projection. With profile HMR enabled
the new value is applied on the next recomposition; otherwise restart DSH.

## Compatibility and known limitations

- Built for `0.2.1-rc.2`; the manifest declares exact compatibility. Other versions may work but are not
  tested.
- The button depends on DSH's current DOM (`div[data-clock]`, bubble structure). A front-end redesign will
  break the injection; update the selectors in `lib/client.js`.
- The browser calls the host command with a base64-encoded prefix of the bubble text. Duplicate messages can
  resolve to the newest match.
- Rewinding while a turn is still running is refused; wait for the turn to end.
- There is no built-in undo UI yet.

## Development

No build step. `lib/client.js` is the browser bundle expected by DSH's client module loader.

```bash
node test/run.mjs
# or
npm test
```

The tests do not need DSH installed: `test/host.test.mjs` uses a fake session, and `test/client.test.cjs`
runs the client bundle against a minimal fake DOM.

## License

MIT — see [LICENSE](LICENSE).

Not affiliated with DeepSeek.
