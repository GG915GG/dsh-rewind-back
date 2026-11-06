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
    /** Marks the action bar of a question-reply card so its timestamp stays out of the payload. */
    const ACTIONS_MARK = "data-rewind-back-actions";

    // Metrics copied from MessageIconActions so the control reads as native:
    // 28px hit area, 6px padding, 15px glyph (17px on turn-tail rows),
    // radius-sm, tertiary label colour, hover-only background.
    const CSS = `
.dsh-rewind-back-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: calc(28px + var(--dsh-content-font-delta, 0px));
  height: calc(28px + var(--dsh-content-font-delta, 0px));
  padding: 6px;
  border: 0;
  border-radius: var(--dsw-radius-sm, 6px);
  background: transparent;
  color: var(--dsw-alias-label-tertiary, var(--dsh-text-secondary, #8b909a));
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
}
.dsh-rewind-back-btn svg {
  display: block;
  width: calc(15px + var(--dsh-content-font-delta, 0px));
  height: calc(15px + var(--dsh-content-font-delta, 0px));
  transition: transform 120ms ease;
}
[data-clock="end"] .dsh-rewind-back-btn svg {
  width: calc(17px + var(--dsh-content-font-delta, 0px));
  height: calc(17px + var(--dsh-content-font-delta, 0px));
}
@media (hover: hover) {
  .dsh-rewind-back-btn:hover {
    background: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, 0.08));
    color: var(--dsw-alias-label-secondary, var(--dsh-text-primary, #e6e8ec));
  }
}
.dsh-rewind-back-btn:active svg { transform: scale(0.92); }
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
      for (const actions of clone.querySelectorAll(`[data-clock], [${ACTIONS_MARK}]`)) actions.remove();
      return normalize(clone.textContent);
    }

    /** Whether `row` sits before `node` in document order. */
    function precedes(row, node) {
      if (typeof node.compareDocumentPosition !== "function") return false;
      // Node.DOCUMENT_POSITION_PRECEDING
      return (node.compareDocumentPosition(row) & 2) === 2;
    }

    /**
     * The user prompt that started the turn a row belongs to: the closest
     * `data-clock="start"` row that precedes it in the document. Works for
     * assistant turn-tail rows and for ask_user_question cards, which live
     * inside the assistant message and therefore have no message event of
     * their own.
     */
    function precedingUserText(node) {
      const rows = Array.from(document.querySelectorAll('div[data-clock="start"]'));
      let best = null;
      for (const row of rows) {
        if (precedes(row, node)) best = row;
      }
      return best === null ? "" : bubbleText(best);
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
      // A question card is part of the assistant message (tool call + result),
      // not a message of its own, so rewind the prompt that started that turn:
      // the card and everything after it go with it.
      const isCard = row.getAttribute(ACTIONS_MARK) === "1"
        || (typeof row.closest === "function" && row.closest("[data-question-reply]") !== null);
      let text = bubbleText(row);
      if (isCard) text = precedingUserText(row);
      else if (row.getAttribute("data-clock") === "end") text = precedingUserText(row);
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

    /** Undo arrow (lucide undo-2): a hooked arrow bending back left, not a circular refresh glyph. */
    function makeIcon() {
      const namespace = "http://www.w3.org/2000/svg";
      if (typeof document.createElementNS !== "function") return null;
      const svg = document.createElementNS(namespace, "svg");
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.setAttribute("fill", "none");
      svg.setAttribute("stroke", "currentColor");
      svg.setAttribute("stroke-width", "1.8");
      svg.setAttribute("stroke-linecap", "round");
      svg.setAttribute("stroke-linejoin", "round");
      svg.setAttribute("aria-hidden", "true");
      for (const d of ["M9 14 4 9l5-5", "M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5 5.5 5.5 0 0 1-5.5 5.5H11"]) {
        const path = document.createElementNS(namespace, "path");
        path.setAttribute("d", d);
        svg.appendChild(path);
      }
      return svg;
    }

    function makeButton(row) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = BUTTON_CLASS;
      const icon = makeIcon();
      if (icon === null) button.textContent = "撤回";
      else button.appendChild(icon);
      button.title = "撤回这条消息以及它之后的全部对话（不会进入模型上下文）";
      button.setAttribute("aria-label", "撤回");
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void rewindRow(row);
      });
      return button;
    }

    /** Action bar of one question-reply card, or null when the card has none. */
    function replyActionBar(reply) {
      let marked = null;
      let withButton = null;
      for (const child of reply.children ?? []) {
        if (typeof child.querySelector !== "function" || child.querySelector("button") === null) continue;
        withButton = child;
        const className = typeof child.className === "string" ? child.className : "";
        if (/_actions(\s|$)/u.test(className)) marked = child;
      }
      return marked ?? withButton;
    }

    function scan() {
      scheduled = null;
      ensureStyle();
      // Ordinary message rows: the shipped 0.3.0 path, unchanged.
      for (const row of document.querySelectorAll("div[data-clock]")) {
        if (row.querySelector(`.${BUTTON_CLASS}`) !== null) continue;
        const copy = row.querySelector("button");
        if (copy === null) continue;
        row.insertBefore(makeButton(row), copy);
      }
      // ask_user_question replies render their own bar inside
      // [data-question-reply] with no data-clock. Isolated so a failure here can
      // never take the ordinary rows down with it.
      try {
        for (const reply of document.querySelectorAll("[data-question-reply]")) {
          if (reply.querySelector(`.${BUTTON_CLASS}`) !== null) continue;
          const bar = replyActionBar(reply);
          if (bar === null) continue;
          bar.setAttribute(ACTIONS_MARK, "1");
          bar.appendChild(makeButton(bar));
        }
      } catch {
        /* keep the card path from breaking the ordinary one */
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
        if (!text.includes("rewind")) continue;
        if (!text.includes("已撤回")) {
          // Failure receipts ("没有找到与按钮对应的用户消息") are transient: the
          // alert already reported them, and they would sit in the transcript
          // forever. Hide them regardless of the receipt policy.
          setHidden(row, true);
          continue;
        }
        const laterUser = rows
          .slice(index + 1)
          .some((candidate) => candidate.getAttribute("data-chat-flow-kind") === "user");
        setHidden(row, policy === "hidden" || (policy === "turn" && laterUser));
      }
    }

    /**
     * Hide as soon as either side changes: a newly rendered transcript row or
     * an arriving projection value. Both run as a microtask, so the hidden
     * rows never reach a paint; the interval is only a safety net for a face
     * this build cannot subscribe to.
     */
    let sweepQueued = false;
    function sweepSoon() {
      if (sweepQueued) return;
      sweepQueued = true;
      const run = () => {
        sweepQueued = false;
        if (context !== null) sweep(context);
      };
      if (typeof queueMicrotask === "function") queueMicrotask(run);
      else window.setTimeout(run, 0);
    }

    let subscribedSession = null;
    let unsubscribeProjection = null;

    /** Follow the current session's `localRewind` projection; re-bind on a session switch. */
    function bindProjection(ctx) {
      const session = currentSession(ctx);
      if (session === subscribedSession) return;
      subscribedSession = session;
      try {
        if (typeof unsubscribeProjection === "function") unsubscribeProjection();
      } catch {
        /* the old session is gone; its notifier dies with it */
      }
      unsubscribeProjection = null;
      try {
        const face = session?.projections?.faceOf?.("localRewind");
        if (typeof face?.subscribe === "function") {
          unsubscribeProjection = face.subscribe(sweepSoon);
        }
      } catch {
        /* fall back to the interval */
      }
      sweepSoon();
    }

    function apply(ctx) {
      context = ctx;
      ensureStyle();
      const root = document.body ?? document.documentElement;
      const observer = new MutationObserver(() => {
        // Rows render first, hiding follows in the same microtask checkpoint.
        sweepSoon();
        schedule();
      });
      observer.observe(root, { childList: true, subtree: true });
      scan();
      bindProjection(ctx);
      // First paint of a reopened transcript: hide synchronously, before any
      // microtask gets a chance to run.
      sweep(ctx);
      const sweepTimer = window.setInterval(() => {
        bindProjection(ctx);
        sweep(ctx);
      }, 400);
      ctx.effect?.(() => () => {
        observer.disconnect();
        window.clearInterval(sweepTimer);
        try {
          if (typeof unsubscribeProjection === "function") unsubscribeProjection();
        } catch {
          /* already released */
        }
        unsubscribeProjection = null;
        subscribedSession = null;
        sweepQueued = false;
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
