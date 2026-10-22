const fs = require('fs');
const path = require('path');
const vm = require('vm');

const code = fs.readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf8');

function makeElement(tag) {
  return {
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
    cloneNode() {
      const copy = { querySelectorAll() { return []; }, textContent: this.textContent };
      return copy;
    },
    querySelector(selector) {
      if (selector === 'button') return this.children.find((child) => child.tagName === 'button') ?? null;
      if (selector === '.dsh-local-rewind-btn') {
        return this.children.find((child) => child.className === 'dsh-local-rewind-btn') ?? null;
      }
      return null;
    },
    querySelectorAll() { return []; },
  };
}

const bubble = makeElement('div');
bubble.textContent = 'hello world';
const row = makeElement('div');
row.setAttribute('data-clock', 'start');
const copy = makeElement('button');
row.appendChild(copy);
bubble.appendChild(row);

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

const projectionValue = { ranges: [{ start: 1, end: 3 }], turns: [1], fromTurn: 1, receipt: 'turn' };

const document = {
  getElementById() { return null; },
  createElement(tag) { return makeElement(tag); },
  head: { appendChild() {} },
  body: {},
  documentElement: {},
  querySelectorAll(selector) {
    if (selector === 'div[data-clock]') return [row];
    if (selector.includes('data-chat-anchor-key')) return [flowRow, laterFlowRow];
    if (selector.includes('data-chat-turn')) return [turnRow, laterTurnRow];
    if (selector.includes('data-chat-flow-kind')) return [receiptOld, laterUserFlow, receiptFresh];
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
      return { getSnapshot() { return projectionValue; } };
    },
  },
};
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
if (receiptOld.style.display !== 'none') throw new Error('past-turn receipt must be hidden by default');
if (receiptFresh.style.display === 'none') throw new Error('current receipt must stay visible by default');

// "always" keeps historical receipts; "hidden" removes every receipt.
projectionValue.receipt = 'always';
mod.apply(clientContext);
if (receiptOld.style.display === 'none') throw new Error('always policy must keep the past receipt');

projectionValue.receipt = 'hidden';
mod.apply(clientContext);
if (receiptFresh.style.display !== 'none') throw new Error('hidden policy must hide the current receipt');

const button = row.querySelector('.dsh-local-rewind-btn');
if (!button) throw new Error('rewind button was not inserted');
if (row.children[0] !== button) throw new Error('button is not before the copy button');
if (typeof button.handlers.click !== 'function') throw new Error('button has no click handler');

(async () => {
  await button.handlers.click({ preventDefault() {}, stopPropagation() {} });
  await new Promise((resolve) => setTimeout(resolve, 30));
  if (executed.length !== 1) throw new Error('command was not executed');
  const line = executed[0].line;
  if (!line.startsWith('/rewind b64:')) throw new Error('unexpected command line: ' + line);
  const decoded = Buffer.from(line.slice('/rewind b64:'.length), 'base64url').toString('utf8');
  if (decoded !== 'hello world') throw new Error('decoded text mismatch: ' + decoded);
  console.log('CLIENT DOM TEST OK:', line);
})();
