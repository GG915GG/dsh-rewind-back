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
    stateVersion: 1,
    init: () => ({ ranges: [], turns: [], fromTurns: [] }),
    apply: (state, event) => {
      const range = event?.data?.localRewind;
      if (range === undefined || !Number.isSafeInteger(range.startSeq) || !Number.isSafeInteger(range.endSeq)) {
        return state;
      }
      const incomingTurns = Array.isArray(range.turns) ? range.turns.filter((turn) => Number.isSafeInteger(turn)) : [];
      const fromTurns = Number.isSafeInteger(range.fromTurn) ? [...state.fromTurns, range.fromTurn] : state.fromTurns;
      // The replacement event itself is a user/message carrying U+200B; hide its
      // transcript row as well as the shadowed span.
      const replacementRange = Number.isSafeInteger(event.seq) ? [{ start: event.seq, end: event.seq }] : [];
      return {
        ranges: [...state.ranges, { start: range.startSeq, end: range.endSeq }, ...replacementRange],
        turns: [...new Set([...state.turns, ...incomingTurns])],
        fromTurns,
      };
    },
    wire: {
      viewSchema: { parse: (value) => value },
      view: (state) => ({
        ranges: state.ranges,
        turns: state.turns,
        fromTurn: state.fromTurns.length === 0 ? null : Math.min(...state.fromTurns),
        receipt: receiptMode,
      }),
    },
  };
}

function placeholderEventData(start, end, turns, fromTurn) {
  // A system/message cannot be appended outside a turn (and its source kind must
  // be system-prompt). A user/message is the one surface event the v4 state
  // machine allows between turns, so use it as the replacement carrier. The
  // zero-width text keeps the model-visible cost to a single token; the client
  // projection hides this node from the transcript.
  return {
    id: `rewind-back-${randomUUID()}`,
    role: "user",
    content: [{ type: "text", text: "\u200b" }],
    source: { kind: "rewind-back" },
    localRewind: { startSeq: start, endSeq: end, turns, fromTurn },
  };
}

function messageText(event) {
  const content = event?.content ?? event?.data?.content ?? [];
  return content
    .filter((block) => block?.type === "text")
    .map((block) => block.text)
    .join(" ")
    .trim();
}

function normalize(text) {
  return String(text ?? "")
    .replace(/\s+/gu, " ")
    .trim();
}

function isUserAnchor(event) {
  return event?.type === "user/message" && event.data?.source?.kind === "user";
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

function listAnchors(session) {
  const nodes = session?.surface?.nodes ?? [];
  const anchors = [];
  for (const seq of nodes) {
    const event = eventAt(session, seq);
    if (!isUserAnchor(event)) continue;
    anchors.push({ seq, text: messageText(event) });
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
      if (text.startsWith(wanted) || wanted.startsWith(text)) return { target: anchors[i], index: i };
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
  const turns = [...new Set(
    shadowed
      .map((seq) => eventAt(session, seq)?.data?.turn)
      .filter((turn) => Number.isSafeInteger(turn)),
  )];
  const fromTurn = turnAtOrBefore(session, target.seq) ?? (turns.length === 0 ? null : Math.min(...turns));

  // The rewind command runs between turns. A user/message is allowed there,
  // unlike system/message, and it does not disturb the runtime's turn counter.
  const replacement = session.append(
    "user/message",
    placeholderEventData(start, end, turns, fromTurn),
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
