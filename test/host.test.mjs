import { apply } from '../lib/index.js';

let command;
let projection;
const fakeCtx = {
  inject(_deps, callback) {
    callback({ sessionProjections: { register(definition) { projection = definition; } } });
  },
  effect(fn) {
    const iterator = fn();
    iterator.next();
  },
  commands: {
    register(definition) {
      command = definition;
      return () => {};
    },
  },
};
apply(fakeCtx);
if (!command) throw new Error('command not registered');
if (!projection) throw new Error('projection not registered');

function makeSession(messages) {
  const events = [];
  const surface = { nodes: [] };
  const appends = [];
  let lastAppend = null;
  const append = (type, data, options) => {
    const seq = events.length;
    events[seq] = { seq, type, data, time: Date.now() };
    lastAppend = { type, data, options, seq };
    appends.push(lastAppend);
    if (options?.surfaceOp !== undefined) {
      const start = surface.nodes.indexOf(options.surfaceOp.startSeq);
      const end = surface.nodes.indexOf(options.surfaceOp.endSeq);
      surface.nodes.splice(start, end - start + 1, seq);
    }
    return { seq };
  };
  for (const [index, text] of messages.entries()) {
    events[index] = {
      seq: index,
      type: 'user/message',
      time: Date.now(),
      data: { source: { kind: 'user' }, content: [{ type: 'text', text }], turn: index + 1 },
    };
    surface.nodes.push(index);
  }
  return {
    log: events,
    events,
    surface,
    append,
    appends,
    eventAt(seq) { return events[seq]; },
    get lastAppend() { return lastAppend; },
  };
}

const session = makeSession(['first question', 'second question', 'third question']);
const encoded = Buffer.from('second question', 'utf8').toString('base64url');
const result = await command.handler({ agent: { session }, rawInput: `b64:${encoded}` });
console.log('b64 result:', JSON.stringify(result));
if (result.kind !== 'success') throw new Error('b64 handler failed');
if (session.surface.nodes.length !== 2) throw new Error('surface not truncated: ' + JSON.stringify(session.surface.nodes));
const order = session.appends.map((item) => item.type).join(',');
if (order !== 'user/message') {
  throw new Error('unexpected append order: ' + order);
}
const placeholder = session.appends.find((item) => item.type === 'user/message');
if (placeholder === undefined) throw new Error('missing user/message placeholder');
if (placeholder.data.role !== 'user' || placeholder.data.source?.kind !== 'rewind-back') {
  throw new Error('placeholder must be a user/message with rewind-back source');
}
if (placeholder.data.content?.[0]?.type !== 'text' || placeholder.data.content[0].text !== '\u200b') {
  throw new Error('placeholder content must be a zero-width text block');
}
if (typeof placeholder.data.id !== 'string' || placeholder.data.id.length === 0) throw new Error('message id must be nonempty');
if (placeholder.data.localRewind.startSeq !== 1) throw new Error('missing localRewind marker');
if (!placeholder.data.localRewind.turns.includes(2)) throw new Error('missing shadowed turn');
if (placeholder.data.localRewind.fromTurn !== 2) throw new Error('wrong fromTurn');
if (placeholder.options.surfaceOp.startSeq !== 1 || placeholder.options.surfaceOp.endSeq !== 2) {
  throw new Error('wrong surfaceOp range: ' + JSON.stringify(placeholder.options.surfaceOp));
}
const projectionState = projection.apply(
  { ranges: [], turns: [], fromTurns: [], ids: [], callIds: [] },
  { data: { localRewind: { startSeq: 1, endSeq: 2, turns: [2], fromTurn: 2 } } },
);
if (projectionState.ranges.length !== 1 || projectionState.ranges[0].start !== 1) {
  throw new Error('projection did not record the range');
}
if (!projectionState.turns.includes(2)) throw new Error('projection did not record the turn');
if (!projectionState.fromTurns.includes(2)) throw new Error('projection did not record fromTurn');
const view = projection.wire.view(projectionState);
if (view.fromTurn !== 2) throw new Error('projection view fromTurn wrong');
if (view.receipt !== 'turn') throw new Error('default receipt policy must be "turn"');

// The config is passed through Cordis without a schema; validate/fallback here.
apply(fakeCtx, { receipt: 'always' });
if (projection.wire.view(projectionState).receipt !== 'always') throw new Error('receipt config was ignored');
apply(fakeCtx, { receipt: 'bogus' });
if (projection.wire.view(projectionState).receipt !== 'turn') throw new Error('invalid receipt config must fall back to "turn"');

const session2 = makeSession(['a', 'b', 'c']);
const result2 = await command.handler({ agent: { session: session2 }, rawInput: '1' });
console.log('numeric result:', JSON.stringify(result2));
if (result2.kind !== 'success') throw new Error('numeric handler failed');
if (session2.surface.nodes.length !== 3) throw new Error('numeric truncation wrong');

// ask_user_question replies are user/message events whose text is the answer
// payload as JSON while the bubble shows "question + chosen answer". The button
// must resolve them, and /rewind <n> must count them as anchors.
const replySession = makeSession(['22211124214']);
const replyEvent = {
  seq: 1,
  type: 'user/message',
  time: Date.now(),
  data: {
    id: 'm-reply',
    role: 'user',
    source: { kind: 'user-question-reply', callId: 'c1', outcome: 'answered' },
    content: [{
      type: 'text',
      text: JSON.stringify({
        kind: 'answer_to_pending_question',
        tool: 'ask_user_question',
        callId: 'c1',
        questions: [{ id: 'q1', header: '需要确认', question: '你发的 "22211124214" 我看不出具体意图。想让我做什么？' }],
        answers: [{ id: 'q1', selected: [], custom: '这是个数字要处理' }],
      }),
    }],
  },
};
replySession.log[1] = replyEvent;
replySession.events[1] = replyEvent;
replySession.surface.nodes.push(1);

const rendered = '需要确认\n你发的 "22211124214" 我看不出具体意图。想让我做什么？\n这是个数字要处理';
const encodedReply = Buffer.from(rendered, 'utf8').toString('base64url');
const replyResult = await command.handler({ agent: { session: replySession }, rawInput: `b64:${encodedReply}` });
console.log('question-reply result:', JSON.stringify(replyResult));
if (replyResult.kind !== 'success') throw new Error('question-reply rewind failed: ' + JSON.stringify(replyResult));
if (!replyResult.text.includes('这是个数字要处理')) throw new Error('receipt lost the chosen answer');
const replyPlaceholder = replySession.appends.at(-1);
if (replyPlaceholder.options.surfaceOp.startSeq !== 1 || replyPlaceholder.options.surfaceOp.endSeq !== 1) {
  throw new Error('question-reply surfaceOp wrong: ' + JSON.stringify(replyPlaceholder.options.surfaceOp));
}
if (replySession.surface.nodes.length !== 2 || replySession.surface.nodes[1] !== replyPlaceholder.seq) {
  throw new Error('question-reply truncation wrong: ' + JSON.stringify(replySession.surface.nodes));
}

// The reply is the newest anchor, so "1" selects it by number too.
const replySession2 = makeSession(['first']);
replySession2.log[1] = replyEvent;
replySession2.events[1] = replyEvent;
replySession2.surface.nodes.push(1);
const numericReply = await command.handler({ agent: { session: replySession2 }, rawInput: '1' });
if (numericReply.kind !== 'success') throw new Error('numeric rewind skipped the question reply: ' + JSON.stringify(numericReply));

// A partially shadowed turn must not be recorded: the transcript would hide the
// whole turn while the model keeps its surviving messages.
const partial = makeSession(['first prompt']);
const assistant = {
  seq: 1,
  type: 'assistant/message',
  time: Date.now(),
  data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }] } },
};
const steered = {
  seq: 2,
  type: 'user/message',
  time: Date.now(),
  data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'steered prompt' }] },
};
const steeredReply = {
  seq: 3,
  type: 'assistant/message',
  time: Date.now(),
  data: { turn: 1, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: 'reply two' }] } },
};
partial.log[1] = assistant;
partial.log[2] = steered;
partial.log[3] = steeredReply;
partial.surface.nodes.push(1, 2, 3);
const encodedSteered = Buffer.from('steered prompt', 'utf8').toString('base64url');
const partialResult = await command.handler({ agent: { session: partial }, rawInput: `b64:${encodedSteered}` });
if (partialResult.kind !== 'success') throw new Error('partial-turn rewind failed: ' + JSON.stringify(partialResult));
const partialPlaceholder = partial.appends.at(-1);
if (partialPlaceholder.data.localRewind.turns.length !== 0) {
  throw new Error('partially shadowed turn must not be recorded: ' + JSON.stringify(partialPlaceholder.data.localRewind.turns));
}
if (partialPlaceholder.data.localRewind.ids.some((id) => String(id).startsWith('turn-process'))) {
  throw new Error('partially shadowed turn must keep its process row: ' + JSON.stringify(partialPlaceholder.data.localRewind.ids));
}

// An empty user message (attachment-only send) must never absorb a fuzzy match:
// `wanted.startsWith("")` is always true, which rewound 400+ messages in the wild.
const emptySession = makeSession([]);
const emptyUser = {
  seq: 0,
  type: 'user/message',
  time: Date.now(),
  data: { source: { kind: 'user' }, content: [{ type: 'text', text: '' }] },
};
const realUser = {
  seq: 1,
  type: 'user/message',
  time: Date.now(),
  data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'real question' }] },
};
emptySession.log[0] = emptyUser;
emptySession.log[1] = realUser;
emptySession.surface.nodes.push(0, 1);
const miss = await command.handler({
  agent: { session: emptySession },
  rawInput: `b64:${Buffer.from('一条不存在的消息', 'utf8').toString('base64url')}`,
});
if (miss.kind !== 'error') throw new Error('empty anchor absorbed a fuzzy match: ' + JSON.stringify(miss));
const exactHit = await command.handler({
  agent: { session: emptySession },
  rawInput: `b64:${Buffer.from('real question', 'utf8').toString('base64url')}`,
});
if (exactHit.kind !== 'success') throw new Error('exact match broken by the empty-anchor guard');
if (exactHit.text.includes('没有文字')) throw new Error('exact match landed on the empty anchor');

// 0.2.2 rows carry no sequence: the projection must record message ids and tool
// call ids so the browser can match its `7:message<id>` / `call:<callId>` keys.
const rich = makeSession([]);
const richUser = {
  seq: 0,
  type: 'user/message',
  time: Date.now(),
  data: { id: 'u-1', source: { kind: 'user' }, content: [{ type: 'text', text: 'rich question' }] },
};
const richAssistant = {
  seq: 1,
  type: 'assistant/message',
  time: Date.now(),
  data: { turn: 1, step: 1, message: { id: 'a-1', role: 'assistant', content: [{ type: 'text', text: 'reply' }] } },
};
const richToolCall = {
  seq: 2,
  type: 'tool/call',
  time: Date.now(),
  data: { turn: 1, step: 2, callId: 'call-9', name: 'pwsh', arguments: '{}' },
};
const richToolResult = {
  seq: 3,
  type: 'tool/result',
  time: Date.now(),
  data: { turn: 1, step: 2, message: { id: 'tr-1', role: 'tool', source: { kind: 'tool', callId: 'call-9' }, content: [] }, isError: false },
};
rich.log[0] = richUser;
rich.log[1] = richAssistant;
rich.log[2] = richToolCall;
rich.log[3] = richToolResult;
rich.surface.nodes.push(0, 1, 2, 3);
const richResult = await command.handler({
  agent: { session: rich },
  rawInput: `b64:${Buffer.from('rich question', 'utf8').toString('base64url')}`,
});
if (richResult.kind !== 'success') throw new Error('rich rewind failed: ' + JSON.stringify(richResult));
const richPlaceholder = rich.appends.at(-1);
const richRewind = richPlaceholder.data.localRewind;
for (const expected of ['u-1', 'a-1', 'tr-1']) {
  if (!richRewind.ids.includes(expected)) throw new Error('shadowed message id missing: ' + expected);
}
if (!richRewind.ids.includes('assistant-step1:1')) {
  throw new Error('assistant-step identity missing (0.2.2 keys assistant rows by turn:step): ' + JSON.stringify(richRewind.ids));
}
if (!richRewind.ids.includes('turn-process1')) {
  throw new Error('turn-process identity missing for a fully shadowed turn: ' + JSON.stringify(richRewind.ids));
}
if (!richRewind.ids.some((id) => typeof id === 'string' && id.startsWith('rewind-back-'))) {
  throw new Error('placeholder id not recorded for hiding');
}
for (const expected of ['call-9']) {
  if (!richRewind.callIds.includes(expected)) throw new Error('shadowed callId missing: ' + expected);
}
const richState = projection.apply(projection.init(), richPlaceholder);
const richView = projection.wire.view(richState);
if (!richView.ids.includes('u-1') || !richView.callIds.includes('call-9')) {
  throw new Error('projection view lost ids/callIds: ' + JSON.stringify(richView));
}

// A neutralized placeholder (repaired rewind) carries only ids: it hides its row
// without shadowing anything.
const markerState = projection.apply(projection.init(), {
  data: { localRewind: { ids: ['rewind-back-neutralized'] } },
});
const markerView = projection.wire.view(markerState);
if (!markerView.ids.includes('rewind-back-neutralized')) throw new Error('hide-only marker id lost');
if (markerView.ranges.length !== 0 || markerView.turns.length !== 0) {
  throw new Error('hide-only marker must not shadow ranges or turns');
}

console.log('HOST TEST OK');
