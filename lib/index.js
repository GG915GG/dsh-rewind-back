import { randomUUID } from "node:crypto";

/**
 * Minimal local rewind:
 *   /rewind <n>          n=1 is the latest user message; removes it and everything after
 *   /rewind b64:<text>   internal form used by the browser button (prefix of the bubble text)
 *
 * The actual truncation is a surface replacement event (same mechanism as compaction):
 * an empty system message with surfaceOp.replace hides the selected range from the
 * model-visible surface. 0.2.1 forbids sourceEventSeqs on assistant/message, so the
 * placeholder is a system message (empty content is skipped by deriveEventMessage).
 */
const name = "dsh-rewind-back";
const inject = ["commands"];

const RECEIPT_MODES = new Set(["turn", "always", "hidden"]);
const DEFAULT_RECEIPT_MODE = "turn";

/** Accept `config.receipt` when set; fall back to the one-turn default. */
function normalizeReceiptMode(config) {
  const raw = config?.receipt;
  return typeof raw === "string" && RECEIPT_MODES.has(raw) ? raw : DEFAULT_RECEIPT_MODE;
}

// Client-side projection so the Web UI can hide the shadowed transcript nodes and
// apply the receipt display preference. The model-visible surface hides messages
// already; DSH's human transcript intentionally keeps append-origin events, so
// hiding must be done in the browser.
function createLocalRewindProjection(receiptMode) {
  return {
    key: "localRewind",
    stateSchema: { parse: (value) => value },
    // 2: state grew `ids`/`callIds`. The projection cache keeps a `ver` per row
    // and discards it on a mismatch; keeping 1 made it replay 0.3.2 checkpoints
    // (no ids) through the new apply, which threw on `state.ids` and left the
    // browser without a value at all.
    stateVersion: 2,
    init: () => ({ ranges: [], turns: [], fromTurns: [], ids: [], callIds: [] }),
    apply: (state, event) => {
      // A checkpoint written by an older definition can lack fields; normalize so
      // a shape change never becomes a thrown replay (the regression behind
      // "nothing hides at all").
      const base = {
        ranges: Array.isArray(state.ranges) ? state.ranges : [],
        turns: Array.isArray(state.turns) ? state.turns : [],
        fromTurns: Array.isArray(state.fromTurns) ? state.fromTurns : [],
        ids: Array.isArray(state.ids) ? state.ids : [],
        callIds: Array.isArray(state.callIds) ? state.callIds : [],
      };
      const range = event?.data?.localRewind;
      if (range === undefined) return state;
      const incomingIds = Array.isArray(range.ids) ? range.ids.filter((id) => typeof id === "string" && id !== "") : [];
      const incomingCallIds = Array.isArray(range.callIds)
        ? range.callIds.filter((id) => typeof id === "string" && id !== "")
        : [];
      // A neutralized placeholder (a repair that turned a bad rewind back into an
      // append) carries only `ids`: hide that one row, restore the shadowed span.
      if (!Number.isSafeInteger(range.startSeq) || !Number.isSafeInteger(range.endSeq)) {
        if (incomingIds.length === 0 && incomingCallIds.length === 0) return state;
        return {
          ...base,
          ids: [...new Set([...base.ids, ...incomingIds])],
          callIds: [...new Set([...base.callIds, ...incomingCallIds])],
        };
      }
      const incomingTurns = Array.isArray(range.turns) ? range.turns.filter((turn) => Number.isSafeInteger(turn)) : [];
      const fromTurns = Number.isSafeInteger(range.fromTurn) ? [...base.fromTurns, range.fromTurn] : base.fromTurns;
      // The replacement event itself is a user/message carrying U+200B; hide its
      // transcript row as well as the shadowed span.
      const replacementRange = Number.isSafeInteger(event.seq) ? [{ start: event.seq, end: event.seq }] : [];
      return {
        ranges: [...base.ranges, { start: range.startSeq, end: range.endSeq }, ...replacementRange],
        turns: [...new Set([...base.turns, ...incomingTurns])],
        fromTurns,
        ids: [...new Set([...base.ids, ...incomingIds])],
        callIds: [...new Set([...base.callIds, ...incomingCallIds])],
      };
    },
    wire: {
      viewSchema: { parse: (value) => value },
      view: (state) => ({
        ranges: state.ranges,
        turns: state.turns,
        fromTurn: state.fromTurns.length === 0 ? null : Math.min(...state.fromTurns),
        ids: state.ids,
        callIds: state.callIds,
        receipt: receiptMode,
      }),
    },
  };
}

function placeholderEventData(start, end, turns, fromTurn, ids, callIds) {
  // A system/message cannot be appended outside a turn (and its source kind must
  // be system-prompt). A user/message is the one surface event the v4 state
  // machine allows between turns, so use it as the replacement carrier. The
  // zero-width text keeps the model-visible cost to a single token; the client
  // projection hides this node from the transcript.
  const id = `rewind-back-${randomUUID()}`;
  return {
    id,
    role: "user",
    content: [{ type: "text", text: "\u200b" }],
    source: { kind: "rewind-back" },
    localRewind: { startSeq: start, endSeq: end, turns, fromTurn, ids: [id, ...ids], callIds },
  };
}

/**
 * Row identities the browser can match without seeing events. DSH 0.2.2 renders
 * anchor keys as `<kind length>:<kind><message id>` and tool rows carry
 * `data-chat-call-id`, so the projection must record message ids and tool call
 * ids — a seq range cannot be mapped onto a row at all.
 * @param session - owner session.
 * @param shadowed - surface seqs inside the replaced range.
 * @returns message ids and tool call ids to hide.
 */
function shadowedIdentifiers(session, shadowed) {
  const ids = new Set();
  const callIds = new Set();
  for (const seq of shadowed) {
    const event = eventAt(session, seq);
    const data = event?.data;
    if (data === undefined || data === null) continue;
    if (typeof data.id === "string" && data.id !== "") ids.add(data.id);
    if (typeof data.callId === "string" && data.callId !== "") callIds.add(data.callId);
    // DSH 0.2.2 renders an assistant node as `assistant-step<turn>:<step>`, never
    // by its message id, so that identity has to be recorded as well.
    if (event?.type === "assistant/message" && Number.isSafeInteger(data.turn) && Number.isSafeInteger(data.step)) {
      ids.add(`assistant-step${data.turn}:${data.step}`);
    }
    const message = data.message;
    if (message === undefined || message === null) continue;
    if (typeof message.id === "string" && message.id !== "") ids.add(message.id);
    if (typeof message.toolCallId === "string" && message.toolCallId !== "") callIds.add(message.toolCallId);
    const source = message.source;
    if (source !== undefined && source !== null && typeof source.callId === "string" && source.callId !== "") {
      callIds.add(source.callId);
    }
  }
  return { ids: [...ids], callIds: [...callIds] };
}

/** Mention-style source kinds that are still the user's own words on the surface. */
const USER_QUESTION_REPLY_KIND = "user-question-reply";

function contentText(event) {
  const content = event?.content ?? event?.data?.content ?? [];
  return content
    .filter((block) => block?.type === "text")
    .map((block) => block.text)
    .join(" ")
    .trim();
}

/**
 * ask_user_question answers arrive as a user/message whose text is the answer
 * payload as JSON. Decode it once; anything else returns null.
 * @param event - candidate session event.
 * @returns the decoded `{ questions, answers }` payload, or null.
 */
function questionReplyPayload(event) {
  if (event?.data?.source?.kind !== USER_QUESTION_REPLY_KIND) return null;
  try {
    const value = JSON.parse(contentText(event));
    return value !== null && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

/**
 * Human text for a question reply: the transcript shows the question and the
 * chosen answer, not the raw JSON the model received.
 * @param event - candidate session event.
 * @returns a readable multi-line summary, or "" when the payload is unusable.
 */
function questionReplySummary(event) {
  const payload = questionReplyPayload(event);
  if (payload === null) return "";
  const questions = Array.isArray(payload.questions) ? payload.questions : [];
  if (questions.length === 0) return "";
  const answers = Array.isArray(payload.answers) ? payload.answers : [];
  const lines = questions.map((question) => {
    const answer = answers.find((item) => item?.id === question?.id);
    const values = [];
    if (Array.isArray(answer?.selected)) {
      values.push(...answer.selected.filter((value) => typeof value === "string"));
    }
    if (typeof answer?.custom === "string" && answer.custom.trim() !== "") values.push(answer.custom);
    const header = typeof question?.header === "string" ? question.header : "";
    const body = typeof question?.question === "string" ? question.question : "";
    const head = header !== "" && header !== body ? `${header} — ${body}` : body;
    const shown = values.length === 0 ? "（跳过）" : values.join("，");
    return head === "" ? `回答：${shown}` : `${head}\n回答：${shown}`;
  });
  return lines.join("\n\n").trim();
}

/**
 * Strings a question reply shares with the bubble the browser renders. The
 * browser sends the visible text, which never equals the JSON payload, so the
 * button resolves through these tokens instead.
 * @param event - candidate session event.
 * @returns normalized candidate snippets, longest-lived first.
 */
function questionReplyTokens(event) {
  const payload = questionReplyPayload(event);
  if (payload === null) return [];
  const tokens = [];
  const push = (value) => {
    if (typeof value !== "string") return;
    const text = normalize(value);
    if (text.length >= 4 && !tokens.includes(text)) tokens.push(text);
  };
  for (const question of Array.isArray(payload.questions) ? payload.questions : []) {
    push(question?.question);
    push(question?.header);
    for (const option of Array.isArray(question?.options) ? question.options : []) {
      push(typeof option === "string" ? option : option?.label);
    }
  }
  for (const answer of Array.isArray(payload.answers) ? payload.answers : []) {
    for (const selected of Array.isArray(answer?.selected) ? answer.selected : []) push(selected);
    push(answer?.custom);
  }
  return tokens;
}

function messageText(event) {
  const summary = questionReplySummary(event);
  return summary === "" ? contentText(event) : summary;
}

function normalize(text) {
  return String(text ?? "")
    .replace(/\s+/gu, " ")
    .trim();
}

function isUserAnchor(event) {
  if (event?.type !== "user/message") return false;
  const kind = event.data?.source?.kind;
  return kind === "user" || kind === USER_QUESTION_REPLY_KIND;
}

function eventAt(session, seq) {
  if (typeof session?.eventAt === "function") return session.eventAt(seq);
  return session?.log?.[seq] ?? session?.events?.[seq];
}

/** Turn containing a seq: nearest preceding turn/start event. */
function turnAtOrBefore(session, seq) {
  const log = session?.log ?? session?.events ?? [];
  const from = Math.min(seq, log.length - 1);
  for (let i = from; i >= 0; i--) {
    const event = eventAt(session, i);
    if (event?.type === "turn/start" && Number.isSafeInteger(event.data?.turn)) return event.data.turn;
  }
  return null;
}

/**
 * Turn numbers the transcript may hide wholesale: only turns whose every surface
 * node lies inside the replaced range. A turn that also holds surviving messages
 * (a steered prompt, a question card, tool results) stays out — the browser hides
 * those rows by sequence instead, so the transcript never claims more was removed
 * than the model actually lost.
 */
function fullyShadowedTurns(session, nodes, shadowed) {
  if (shadowed.length === 0) return [];
  const shadowedSet = new Set(shadowed);
  const onSurface = new Set(nodes);
  const log = session?.log ?? session?.events ?? [];
  const turnBySeq = new Map();
  let current = null;
  for (let seq = 0; seq < log.length; seq++) {
    const event = eventAt(session, seq);
    const declared = event?.data?.turn;
    if (event?.type === "turn/start" && Number.isSafeInteger(declared)) current = declared;
    if (!onSurface.has(seq)) continue;
    turnBySeq.set(seq, Number.isSafeInteger(declared) ? declared : current);
  }
  const candidates = new Set();
  for (const seq of shadowed) {
    const turn = turnBySeq.get(seq);
    if (Number.isSafeInteger(turn)) candidates.add(turn);
  }
  const complete = [];
  for (const turn of candidates) {
    let whole = true;
    for (const seq of nodes) {
      if (turnBySeq.get(seq) !== turn) continue;
      if (!shadowedSet.has(seq)) {
        whole = false;
        break;
      }
    }
    if (whole) complete.push(turn);
  }
  return complete.sort((a, b) => a - b);
}

function listAnchors(session) {
  const nodes = session?.surface?.nodes ?? [];
  const anchors = [];
  for (const seq of nodes) {
    const event = eventAt(session, seq);
    if (!isUserAnchor(event)) continue;
    anchors.push({ seq, text: messageText(event), tokens: questionReplyTokens(event) });
  }
  return anchors;
}

function waitForTurnSettle(session, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      const events = session.log ?? session.events ?? [];
      const start = events.findLast((event) => event.type === "turn/start");
      if (start === undefined) return resolve(true);
      const ended = events.findLast(
        (event) => event.type === "turn/end" && event.data?.turn === start.data?.turn,
      );
      if (ended !== undefined && ended.seq > start.seq) return resolve(true);
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(tick, 100);
    };
    tick();
  });
}

function parseBase64Url(raw) {
  try {
    return Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    return "";
  }
}

function findTarget(anchors, raw) {
  if (raw.length === 0) {
    return { error: "缺少撤回目标。请使用 /rewind <编号>，或点消息旁的「撤回」按钮。" };
  }
  const b64 = raw.match(/^b64:(.+)$/u);
  if (b64 !== null) {
    const wanted = normalize(parseBase64Url(b64[1]));
    if (wanted === "") return { error: "撤回目标为空。" };
    for (let i = anchors.length - 1; i >= 0; i--) {
      const text = normalize(anchors[i].text);
      if (text === wanted) return { target: anchors[i], index: i };
    }
    for (let i = anchors.length - 1; i >= 0; i--) {
      const text = normalize(anchors[i].text);
      // An empty anchor (attachment-only send) would satisfy `wanted.startsWith("")`
      // and absorb every fuzzy match, rewinding from it. Skip it.
      if (text === "") continue;
      if (text.startsWith(wanted) || wanted.startsWith(text)) return { target: anchors[i], index: i };
    }
    // ask_user_question replies store the answer payload as JSON, while the
    // transcript shows the questions and the chosen labels. Match on the
    // snippets both sides carry before the looser substring pass, which would
    // otherwise let an earlier message quoted by the question win.
    for (let i = anchors.length - 1; i >= 0; i--) {
      const tokens = anchors[i].tokens ?? [];
      if (tokens.some((token) => wanted.includes(token) || token.includes(wanted))) {
        return { target: anchors[i], index: i };
      }
    }
    for (let i = anchors.length - 1; i >= 0; i--) {
      const text = normalize(anchors[i].text);
      if (text.length >= 8 && wanted.length >= 8 && (text.includes(wanted) || wanted.includes(text))) {
        return { target: anchors[i], index: i };
      }
    }
    return { error: "没有找到与按钮对应的用户消息。" };
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(n) || n < 1 || n > anchors.length) {
    return { error: `编号需要在 1 到 ${Math.max(anchors.length, 1)} 之间（1 = 最新）。` };
  }
  return { target: anchors[anchors.length - n], index: anchors.length - n };
}

async function rewindTo(session, raw) {
  if (session === undefined || session === null) {
    return { kind: "error", text: "当前没有可操作的会话。" };
  }
  const settled = await waitForTurnSettle(session);
  if (!settled) {
    return { kind: "error", text: "当前回合还在跑，等它结束再撤回。" };
  }
  const anchors = listAnchors(session);
  if (anchors.length === 0) {
    return { kind: "error", text: "这个会话里还没有可撤回的用户消息。" };
  }
  const found = findTarget(anchors, raw);
  if (found.error !== undefined) return { kind: "error", text: found.error };
  const target = found.target;

  const nodes = session.surface.nodes;
  const targetIndex = nodes.indexOf(target.seq);
  if (targetIndex === -1) {
    return { kind: "error", text: "目标消息不在当前可见对话里，可能已经撤回过了。" };
  }
  const start = target.seq;
  const end = nodes[nodes.length - 1];
  const shadowed = nodes.slice(targetIndex);
  if (start === undefined || end === undefined) {
    return { kind: "error", text: "找不到要撤回的消息范围。" };
  }
  const turns = fullyShadowedTurns(session, nodes, shadowed);
  const fromTurn = turnAtOrBefore(session, target.seq) ?? (turns.length === 0 ? null : Math.min(...turns));
  const { ids: shadowedIds, callIds } = shadowedIdentifiers(session, shadowed);

  // The rewind command runs between turns. A user/message is allowed there,
  // unlike system/message, and it does not disturb the runtime's turn counter.
  const replacement = session.append(
    "user/message",
    placeholderEventData(start, end, turns, fromTurn, shadowedIds, callIds),
    {
      surfaceOp: { op: "replace", startSeq: start, endSeq: end },
      sourceEventSeqs: [...shadowed],
    },
  );

  const removedText = target.text === "" ? "(这条消息没有文字)" : target.text;
  return {
    kind: "success",
    text: [
      `已撤回 ${shadowed.length} 条消息（所选消息本身也在内）。`,
      `原话（可复制重发）：${removedText.slice(0, 500)}`,
    ].join("\n"),
    sourceEventSeq: replacement.seq,
  };
}

function apply(ctx, config) {
  const receiptMode = normalizeReceiptMode(config);
  ctx.inject(["sessionProjections"], (projectionCtx) => {
    projectionCtx.sessionProjections.register(createLocalRewindProjection(receiptMode));
  });
  ctx.effect(function* () {
    yield ctx.commands.register({
      name: "rewind",
      description: "撤回某条消息以及它之后的全部对话（不进上下文）",
      input: { hint: "编号（1 = 最新），或内部 b64 目标" },
      handler: (invocation) => rewindTo(invocation.agent.session, invocation.rawInput.trim()),
    });
  });
}

export { apply, inject, name };
