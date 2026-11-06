const fs = require('fs');
const path = require('path');
const vm = require('vm');

const code = fs.readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf8');

// Creation order stands in for document order in this fake DOM.
const ORDER = [];

function makeElement(tag) {
  const element = {
    tagName: tag,
    style: {},
    dataset: {},
    children: [],
    attributes: {},
    handlers: {},
    className: '',
    id: '',
    title: '',
    textContent: '',
    appendChild(child) { this.children.push(child); child.parentElement = this; return child; },
    insertBefore(child, reference) {
      const index = this.children.indexOf(reference);
      if (index === -1) this.children.push(child);
      else this.children.splice(index, 0, child);
      child.parentElement = this;
      return child;
    },
    setAttribute(key, value) { this.attributes[key] = String(value); },
    getAttribute(key) { return this.attributes[key] ?? null; },
    removeAttribute(key) { delete this.attributes[key]; },
    addEventListener(type, handler) { this.handlers[type] = handler; },
    remove() {},
    compareDocumentPosition(other) {
      const self = ORDER.indexOf(element);
      const offset = ORDER.indexOf(other);
      if (self === -1 || offset === -1) return 0;
      return offset < self ? 2 : 4; // PRECEDING / FOLLOWING
    },
    cloneNode() {
      const copy = { querySelectorAll() { return []; }, textContent: this.textContent };
      return copy;
    },
    querySelector(selector) {
      if (selector === 'button') return this.children.find((child) => child.tagName === 'button') ?? null;
      if (selector === '.dsh-rewind-back-btn') {
        return this.children.find((child) => child.className === 'dsh-rewind-back-btn') ?? null;
      }
      return null;
    },
    querySelectorAll() { return []; },
  };
  ORDER.push(element);
  return element;
}

const bubble = makeElement('div');
bubble.textContent = 'hello world';
const row = makeElement('div');
row.setAttribute('data-clock', 'start');
const copy = makeElement('button');
row.appendChild(copy);
bubble.appendChild(row);

// A question-reply card: its action bar has no data-clock, it lives inside
// [data-question-reply] as the child that owns the copy button.
const replyRoot = makeElement('div');
replyRoot.setAttribute('data-question-reply', 'call-1');
replyRoot.textContent = 'question text';
const replyBubble = makeElement('div');
const replyBar = makeElement('div');
const replyCopy = makeElement('button');
replyBar.appendChild(replyCopy);
replyRoot.appendChild(replyBubble);
replyRoot.appendChild(replyBar);

const flowRow = makeElement('div');
flowRow.setAttribute('data-chat-anchor-key', '1:user');
const turnRow = makeElement('div');
turnRow.setAttribute('data-chat-turn', '1');
// Rows created after the rewind: the user's next message and the reply. They
// must stay visible; hiding `turn >= fromTurn` used to swallow them.
const laterFlowRow = makeElement('div');
laterFlowRow.setAttribute('data-chat-anchor-key', '30:user');
const laterTurnRow = makeElement('div');
laterTurnRow.setAttribute('data-chat-turn', '2');
// A row inside a recorded turn whose own sequence survives the range: it must stay
// visible, because the model still sees that message.
const partialTurnRow = makeElement('div');
partialTurnRow.setAttribute('data-chat-turn', '1');
partialTurnRow.setAttribute('data-chat-anchor-key', '40:user');

// Command receipts: the old one has a later user turn (must disappear under the
// default "turn" policy); the fresh one is the last row (must stay visible).
const receiptOld = makeElement('div');
receiptOld.setAttribute('data-chat-flow-kind', 'command');
receiptOld.textContent = 'rewind 已撤回 2 条消息（所选消息本身也在内）。原话（可复制重发）：hello';
const laterUserFlow = makeElement('div');
laterUserFlow.setAttribute('data-chat-flow-kind', 'user');
laterUserFlow.textContent = 'next question';
const receiptFresh = makeElement('div');
receiptFresh.setAttribute('data-chat-flow-kind', 'command');
receiptFresh.textContent = 'rewind 已撤回 1 条消息（所选消息本身也在内）。原话（可复制重发）：hi';
// A failed rewind writes a command/done error row that never goes away on its own.
const receiptError = makeElement('div');
receiptError.setAttribute('data-chat-flow-kind', 'command');
receiptError.textContent = 'rewind · 没有找到与按钮对应的用户消息。';

const projectionValue = { ranges: [{ start: 1, end: 3 }], turns: [1], fromTurn: 1, receipt: 'turn' };

const document = {
  getElementById() { return null; },
  createElement(tag) { return makeElement(tag); },
  createElementNS(_namespace, tag) { return makeElement(tag); },
  head: { appendChild() {} },
  body: {},
  documentElement: {},
  querySelectorAll(selector) {
    if (selector === 'div[data-clock]' || selector === 'div[data-clock="start"]') return [row];
    if (selector === '[data-question-reply]') return [replyRoot];
    if (selector.includes('data-chat-anchor-key')) return [flowRow, laterFlowRow];
    if (selector.includes('data-chat-turn')) return [turnRow, laterTurnRow, partialTurnRow];
    if (selector.includes('data-chat-flow-kind')) return [receiptOld, laterUserFlow, receiptFresh, receiptError];
    return [];
  },
  addEventListener() {},
};

class MutationObserver {
  constructor(callback) { this.callback = callback; }
  observe() {}
  disconnect() {}
}

const executed = [];
let loaded;
const sandbox = {
  document,
  MutationObserver,
  setTimeout,
  clearTimeout,
  TextEncoder,
  btoa,
  alert() {},
  console,
};
sandbox.window = {
  __ModuleLoader__: { load(options) { loaded = options; } },
  setTimeout,
  clearTimeout,
  setInterval() { return 1; },
  clearInterval() {},
  alert() {},
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
if (!loaded) throw new Error('module did not call __ModuleLoader__.load');

const mod = loaded.factory(() => ({}));
if (typeof mod.apply !== 'function') throw new Error('missing apply');
if (!Array.isArray(mod.inject)) throw new Error('missing inject');

const session = {
  sessionId: 's1',
  projections: {
    faceOf(key) {
      if (key !== 'localRewind') return undefined;
      return {
        getSnapshot() { return projectionValue; },
        subscribe(listener) { projectionListeners.push(listener); return () => {}; },
      };
    },
  },
};
const projectionListeners = [];
const clientContext = {
  effect(fn) { fn(); },
  uiSession: { current: { value: { key: 's1' } } },
  sessions: {
    binding(id) { return id === 's1' ? { session } : undefined; },
  },
  remote: {
    commands: {
      async execute(sessionId, line) {
        executed.push({ sessionId, line });
        return { ok: true, value: { result: { kind: 'success' } } };
      },
    },
  },
};
mod.apply(clientContext);

if (flowRow.style.display !== 'none') throw new Error('shadowed flow row was not hidden');
if (turnRow.style.display !== 'none') throw new Error('shadowed turn row was not hidden');
if (laterFlowRow.style.display === 'none') throw new Error('post-rewind flow row must stay visible');
if (laterTurnRow.style.display === 'none') throw new Error('post-rewind turn row must stay visible');
if (partialTurnRow.style.display === 'none') {
  throw new Error('a row whose own seq survives the range must stay visible');
}
if (receiptOld.style.display !== 'none') throw new Error('past-turn receipt must be hidden by default');
if (receiptFresh.style.display === 'none') throw new Error('current receipt must stay visible by default');
if (receiptError.style.display !== 'none') throw new Error('failure receipt must be hidden by default');

// "always" keeps historical receipts; "hidden" removes every receipt.
projectionValue.receipt = 'always';
mod.apply(clientContext);
if (receiptOld.style.display === 'none') throw new Error('always policy must keep the past receipt');
if (receiptError.style.display !== 'none') throw new Error('failure receipt must stay hidden under "always"');

projectionValue.receipt = 'hidden';
mod.apply(clientContext);
if (receiptFresh.style.display !== 'none') throw new Error('hidden policy must hide the current receipt');
if (receiptError.style.display !== 'none') throw new Error('failure receipt must stay hidden under "hidden"');

const button = row.querySelector('.dsh-rewind-back-btn');
if (!button) throw new Error('rewind button was not inserted');
if (row.children.indexOf(button) !== row.children.indexOf(copy) - 1) {
  throw new Error('button must sit right before the copy button');
}
if (typeof button.handlers.click !== 'function') throw new Error('button has no click handler');

const replyButton = replyBar.querySelector('.dsh-rewind-back-btn');
if (!replyButton) throw new Error('rewind button was not inserted into the question-reply card');
if (replyButton.children.length !== 1 || replyButton.children[0].tagName !== 'svg') {
  throw new Error('button must render the undo icon');
}

(async () => {
  await button.handlers.click({ preventDefault() {}, stopPropagation() {} });
  await new Promise((resolve) => setTimeout(resolve, 30));
  if (executed.length !== 1) throw new Error('command was not executed');
  const line = executed[0].line;
  if (!line.startsWith('/rewind b64:')) throw new Error('unexpected command line: ' + line);
  const decoded = Buffer.from(line.slice('/rewind b64:'.length), 'base64url').toString('utf8');
  if (decoded !== 'hello world') throw new Error('decoded text mismatch: ' + decoded);

  await replyButton.handlers.click({ preventDefault() {}, stopPropagation() {} });
  await new Promise((resolve) => setTimeout(resolve, 30));
  if (executed.length !== 2) throw new Error('question-reply button did not execute the command');
  const replyLine = executed[1].line;
  const replyDecoded = Buffer.from(replyLine.slice('/rewind b64:'.length), 'base64url').toString('utf8');
  // The card itself has no message event: it must resolve to the prompt that
  // started its turn, not to the card's own rendered text.
  if (replyDecoded !== 'hello world') throw new Error('question-reply payload mismatch: ' + replyDecoded);

  // A projection value that arrives after the rows rendered must hide them
  // immediately, not on the next poll tick.
  projectionValue.ranges = [{ start: 1, end: 3 }, { start: 30, end: 30 }];
  for (const listener of projectionListeners) listener();
  await new Promise((resolve) => setTimeout(resolve, 20));
  if (laterFlowRow.style.display !== 'none') throw new Error('projection update did not hide the row');
  console.log('CLIENT DOM TEST OK:', line, '|', replyLine);
})();
