window.__ModuleLoader__.load({
  id: "dsh-rewind-back",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const inject = ["sessions", "uiSession", "remote", "remote.commands"];
    let context = null;
    let scheduled = null;

    const STYLE_ID = "dsh-rewind-back-style";
    const BUTTON_CLASS = "dsh-rewind-back-btn";

    const CSS = `
.dsh-rewind-back-btn {
  height: 20px;
  padding: 0 5px;
  margin: 0 2px 0 0;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--dsh-text-secondary, #9aa1ad);
  font: inherit;
  font-size: 11px;
  line-height: 20px;
  cursor: pointer;
  opacity: 0.6;
  transition: opacity 120ms ease, background 120ms ease, color 120ms ease;
  white-space: nowrap;
}
[data-clock]:hover .dsh-rewind-back-btn { opacity: 0.75; }
.dsh-rewind-back-btn:hover {
  opacity: 1 !important;
  background: rgba(255, 255, 255, 0.08);
  color: var(--dsh-text-primary, #e6e8ec);
}
.dsh-rewind-back-btn:active { transform: translateY(1px); }
`;

    function ensureStyle() {
      if (document.getElementById(STYLE_ID) !== null) return;
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = CSS;
      (document.head || document.documentElement).appendChild(style);
    }

    function encodeUtf8Base64Url(text) {
      const bytes = new TextEncoder().encode(text);
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
    }

    function normalize(text) {
      return String(text ?? "").replace(/\s+/gu, " ").trim();
    }

    /** Text of the bubble that owns an action row (row is a direct child of the bubble). */
    function bubbleText(row) {
      const bubble = row.parentElement;
      if (bubble === null) return "";
      const clone = bubble.cloneNode(true);
      for (const actions of clone.querySelectorAll("[data-clock]")) actions.remove();
      return normalize(clone.textContent);
    }

    /** For an assistant turn-tail row, use the user prompt that started that turn. */
    function precedingUserText(row) {
      const rows = Array.from(document.querySelectorAll("div[data-clock]"));
      const index = rows.indexOf(row);
      for (let i = index - 1; i >= 0; i--) {
        if (rows[i].getAttribute("data-clock") === "start") return bubbleText(rows[i]);
      }
      return "";
    }

    function currentSession(ctx) {
      try {
        // DSH 0.2.1: the selected session lives in the ui-session binding source,
        // not in sessions.list (the list snapshot only has ids/byId/phase).
        const value = ctx.uiSession?.current?.value;
        if (value?.binding?.session !== undefined) return value.binding.session;
        const id = value?.key ?? value?.sessionId;
        if (id === undefined || id === null) return undefined;
        return ctx.sessions?.binding?.(id)?.session;
      } catch {
        return undefined;
      }
    }

    async function rewindRow(row) {
      if (context === null) return;
      const session = currentSession(context);
      if (session === undefined) {
        window.alert("没有打开的会话，无法撤回。");
        return;
      }
      let text = bubbleText(row);
      if (row.getAttribute("data-clock") === "end") text = precedingUserText(row);
      if (text === "") {
        window.alert("取不到这条消息的文字，无法撤回。");
        return;
      }
      const payload = encodeUtf8Base64Url(text.slice(0, 600));
      try {
        const remote = context.remote?.commands;
        if (remote === undefined) throw new Error("remote.commands 不可用");
        const result = await remote.execute(session.sessionId, `/rewind b64:${payload}`, []);
        if (result?.ok === false) {
          throw new Error(result.error?.message ?? result.error?.code ?? "命令执行失败");
        }
        const outcome = result?.value?.result;
        if (outcome?.kind === "error" && typeof outcome.text === "string") {
          window.alert(outcome.text);
        }
        window.setTimeout(() => {
          if (context !== null) sweep(context);
        }, 200);
      } catch (error) {
        window.alert(`撤回失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }

    function makeButton(row) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = BUTTON_CLASS;
      button.textContent = "撤回";
      button.title = "撤回这条消息以及它之后的全部对话（不会进入模型上下文）";
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void rewindRow(row);
      });
      return button;
    }

    function scan() {
      scheduled = null;
      ensureStyle();
      for (const row of document.querySelectorAll("div[data-clock]")) {
        if (row.querySelector(`.${BUTTON_CLASS}`) !== null) continue;
        const copy = row.querySelector("button");
        if (copy === null) continue;
        row.insertBefore(makeButton(row), copy);
      }
    }

    function schedule() {
      if (scheduled !== null) return;
      scheduled = window.setTimeout(scan, 80);
    }

    function valueFor(ctx) {
      try {
        const session = currentSession(ctx);
        const face = session?.projections?.faceOf?.("localRewind");
        const value = face?.getSnapshot?.();
        return value ?? {};
      } catch {
        return {};
      }
    }

    function setHidden(element, hidden) {
      if (hidden) {
        element.style.display = "none";
        element.setAttribute("data-rewind-back-hidden", "1");
      } else if (element.getAttribute("data-rewind-back-hidden") === "1") {
        element.style.display = "";
        element.removeAttribute("data-rewind-back-hidden");
      }
    }

    /**
     * DSH's human transcript renders append-origin events, so a model-surface
     * replacement does not remove bubbles by itself. Hide every flow row whose
     * anchor seq falls into a rewind-back replacement range, plus the turns
     * recorded by the host (covers grouped/turn-tail rows that carry no seq).
     *
     * Only the recorded turns may be hidden. Turn numbers are monotonic, so a
     * `turn >= fromTurn` rule would also hide every turn created after the
     * rewind — the user's next messages and the assistant's replies — and the
     * transcript would look permanently empty. Do not reintroduce it.
     */
    function sweep(ctx) {
      const value = valueFor(ctx);
      const ranges = Array.isArray(value.ranges) ? value.ranges : [];
      const turns = Array.isArray(value.turns) ? value.turns : [];
      for (const element of document.querySelectorAll("[data-chat-anchor-key], [data-chat-flow-key]")) {
        const key = element.getAttribute("data-chat-anchor-key")
          ?? element.getAttribute("data-chat-flow-key")
          ?? "";
        const match = /^(\d+):/u.exec(key);
        const seq = match === null ? null : Number(match[1]);
        setHidden(element, seq !== null && ranges.some((range) => seq >= range.start && seq <= range.end));
      }
      for (const element of document.querySelectorAll("[data-chat-turn], [data-turn-tail]")) {
        const raw = element.getAttribute("data-chat-turn") ?? element.getAttribute("data-turn-tail");
        const turn = Number(raw);
        const shadowed = Number.isSafeInteger(turn) && turns.includes(turn);
        setHidden(element, shadowed);
      }
      sweepReceipts(value.receipt);
    }

    /**
     * The rewind receipt is a `command` flow row (`> rewind · 已撤回 …`). Its
     * display policy comes from the host config:
     *   - "turn"   (default) — visible until the next user turn starts
     *   - "always"            — keep it in the transcript
     *   - "hidden"            — never show it
     * Rows are ordered by seq, so "a later user row exists" means the receipt
     * belongs to a past turn.
     */
    function sweepReceipts(mode) {
      const policy = mode === "always" || mode === "hidden" ? mode : "turn";
      const rows = Array.from(document.querySelectorAll("[data-chat-flow-kind]"));
      for (let index = 0; index < rows.length; index++) {
        const row = rows[index];
        if (row.getAttribute("data-chat-flow-kind") !== "command") continue;
        const text = row.textContent ?? "";
        if (!text.includes("已撤回")) continue;
        const laterUser = rows
          .slice(index + 1)
          .some((candidate) => candidate.getAttribute("data-chat-flow-kind") === "user");
        setHidden(row, policy === "hidden" || (policy === "turn" && laterUser));
      }
    }

    function apply(ctx) {
      context = ctx;
      ensureStyle();
      const root = document.body ?? document.documentElement;
      const observer = new MutationObserver(schedule);
      observer.observe(root, { childList: true, subtree: true });
      scan();
      sweep(ctx);
      const sweepTimer = window.setInterval(() => sweep(ctx), 800);
      ctx.effect?.(() => () => {
        observer.disconnect();
        window.clearInterval(sweepTimer);
        if (scheduled !== null) {
          window.clearTimeout(scheduled);
          scheduled = null;
        }
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
