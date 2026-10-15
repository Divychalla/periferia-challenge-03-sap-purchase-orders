const turns = document.querySelector('#turns');
const conversation = document.querySelector('#conversation');
const welcome = document.querySelector('#welcome-card');
const form = document.querySelector('#chat-form');
const input = document.querySelector('#message-input');
const sendButton = document.querySelector('#send-button');
const thinking = document.querySelector('#thinking');
const caseList = document.querySelector('#case-list');
const providerStatus = document.querySelector('#provider-status');
const cases = [
  ['req-001', 'Standard flow', 'READY'],
  ['req-002', 'Unknown supplier', 'BLOCK'],
  ['req-003', 'Approver mismatch', 'BLOCK'],
  ['req-004', 'Quote variance', 'REVIEW'],
  ['req-005', 'Retroactive invoice', 'REVIEW'],
  ['req-006', 'Derived tax code', 'REVIEW'],
];
let sessionId = localStorage.getItem('po-session-id') || undefined;
let pendingConfirmation = false;

for (const [id, label, status] of cases) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'case-link';
  button.innerHTML = `<span class="case-number">${id.slice(-3)}</span><span class="case-name"></span><span class="case-tag"></span>`;
  button.querySelector('.case-name').textContent = label;
  button.querySelector('.case-tag').textContent = status;
  button.addEventListener('click', () => submitMessage(`Process ${id}`));
  caseList.append(button);
}

for (const button of document.querySelectorAll('[data-prompt]')) {
  button.addEventListener('click', () => submitMessage(button.dataset.prompt));
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  submitMessage(input.value);
});

input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    submitMessage(input.value);
  }
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 125)}px`;
});

document.querySelector('#new-chat').addEventListener('click', () => {
  sessionId = undefined;
  pendingConfirmation = false;
  localStorage.removeItem('po-session-id');
  turns.replaceChildren();
  welcome.classList.remove('hidden');
  input.focus();
});

fetch('/api/health').then((response) => response.json()).then((health) => {
  providerStatus.textContent = `${health.provider} · ${health.model}`;
}).catch(() => { providerStatus.textContent = 'Offline'; });

if (sessionId) {
  fetch(`/api/sessions/${encodeURIComponent(sessionId)}`).then((response) => response.ok ? response.json() : null).then((session) => {
    if (!session) return;
    for (const turn of session.turns || []) appendTurn(turn);
    pendingConfirmation = Boolean(session.pendingConfirmation);
    if (turns.childElementCount) welcome.classList.add('hidden');
  }).catch(() => {});
}

async function submitMessage(message) {
  const value = String(message || '').trim();
  if (!value || sendButton.disabled) return;
  welcome.classList.add('hidden');
  input.value = '';
  input.style.height = 'auto';
  appendTurn({ role: 'user', content: value, createdAt: new Date().toISOString() });
  sendButton.disabled = true;
  thinking.classList.remove('hidden');
  conversation.scrollTop = conversation.scrollHeight;
  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, message: value }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'The request could not be completed.');
    sessionId = result.sessionId;
    localStorage.setItem('po-session-id', sessionId);
    pendingConfirmation = Boolean(result.needsConfirmation);
    appendTurn({ role: 'assistant', content: result.reply, toolCalls: result.toolCalls || [], needsConfirmation: pendingConfirmation, createdAt: new Date().toISOString() });
  } catch (error) {
    appendTurn({ role: 'assistant', content: error.message || 'Connection problem. Please retry.', createdAt: new Date().toISOString() });
  } finally {
    thinking.classList.add('hidden');
    sendButton.disabled = false;
    input.focus();
    conversation.scrollTop = conversation.scrollHeight;
  }
}

function appendTurn(turn) {
  const article = document.createElement('article');
  article.className = `turn ${turn.role === 'user' ? 'user' : 'assistant'}`;
  const avatar = document.createElement('div');
  avatar.className = 'turn-avatar';
  avatar.textContent = turn.role === 'user' ? 'HA' : 'AI';
  const content = document.createElement('div');
  content.className = 'turn-content';
  const bubble = document.createElement('div');
  bubble.className = 'turn-bubble';
  bubble.textContent = turn.content;
  content.append(bubble);

  for (const call of turn.toolCalls || []) content.append(makeToolCard(call));
  if (turn.needsConfirmation) content.append(makeConfirmationBanner());
  const time = document.createElement('div');
  time.className = 'turn-time';
  time.textContent = formatTime(turn.createdAt);
  content.append(time);
  article.append(avatar, content);
  turns.append(article);
  conversation.scrollTop = conversation.scrollHeight;
}

function makeToolCard(call) {
  const details = document.createElement('details');
  details.className = 'tool-card';
  const summary = document.createElement('summary');
  const badge = document.createElement('span');
  badge.className = 'tool-badge';
  badge.textContent = 'TOOL';
  const name = document.createElement('strong');
  name.textContent = call.name;
  const arrow = document.createElement('span');
  arrow.className = 'tool-chevron';
  arrow.textContent = '⌄';
  summary.append(badge, name, arrow);
  const grid = document.createElement('div');
  grid.className = 'tool-content';
  grid.append(jsonColumn('ARGUMENTS', call.arguments), jsonColumn('RESULT', call.result));
  details.append(summary, grid);
  return details;
}

function jsonColumn(label, value) {
  const block = document.createElement('div');
  const heading = document.createElement('h4');
  heading.textContent = label;
  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(value, null, 2);
  block.append(heading, pre);
  return block;
}

function makeConfirmationBanner() {
  const banner = document.createElement('div');
  banner.className = 'confirmation-banner';
  const heading = document.createElement('strong');
  heading.textContent = 'Your confirmation is required';
  const note = document.createElement('p');
  note.textContent = 'The order will only be created after your explicit approval in the next message.';
  const actions = document.createElement('div');
  actions.className = 'confirmation-actions';
  const yes = document.createElement('button');
  yes.type = 'button';
  yes.className = 'confirm-button';
  yes.textContent = 'Confirm creation';
  yes.addEventListener('click', () => submitMessage('I confirm'));
  const no = document.createElement('button');
  no.type = 'button';
  no.className = 'cancel-button';
  no.textContent = 'Cancel';
  no.addEventListener('click', () => submitMessage('Cancel'));
  actions.append(yes, no);
  banner.append(heading, note, actions);
  return banner;
}

function formatTime(value) {
  const date = new Date(value || Date.now());
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date);
}
