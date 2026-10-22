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
if (placeholder.data.role !== 'user' || placeholder.data.source?.kind !== 'local-rewind') {
  throw new Error('placeholder must be a user/message with local-rewind source');
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
  { ranges: [], turns: [], fromTurns: [] },
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
console.log('HOST TEST OK');
