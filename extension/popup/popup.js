const app = document.getElementById('app');
const errorEl = document.getElementById('error');
const footer = document.getElementById('footer');

let windowId;
let view = null; // last 'get' reply
let mode = 'list'; // 'list' | 'new' | 'rename'

async function send(msg) {
  const reply = await chrome.runtime.sendMessage(msg);
  if (!reply?.ok) throw new Error(reply?.error ?? 'No reply from Focus Bars');
  return reply.result;
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) if (c != null) node.append(c);
  return node;
}

function showError(e) {
  errorEl.textContent = e ? String(e.message ?? e) : '';
  errorEl.hidden = !e;
}

async function act(fn) {
  showError(null);
  try {
    await fn();
    await refresh();
  } catch (e) {
    showError(e);
  }
}

function focusRadios(name, checkedId, onPick) {
  const list = el('ul', { className: 'focus-list', role: 'radiogroup' });
  for (const f of view.focuses) {
    const input = el('input', { type: 'radio', name, value: f.id, checked: f.id === checkedId });
    input.addEventListener('change', () => onPick(f.id));
    list.append(el('li', {}, el('label', {}, input, el('span', { className: 'name', textContent: f.name }))));
  }
  return list;
}

function renderRecovery() {
  let picked = null;
  const confirm = el('button', { className: 'primary', textContent: 'Confirm', disabled: true });
  confirm.addEventListener('click', () => act(() => send({ type: 'resolveRecovery', focusId: picked })));
  app.replaceChildren(
    el('h1', { textContent: 'Focus Bars' }),
    el('p', { className: 'question', textContent: 'Which focus is on your bookmark bar right now?' }),
    focusRadios('recover', null, (id) => {
      picked = id;
      confirm.disabled = false;
    }),
    el('div', { className: 'actions' }, confirm),
  );
}

function nameForm({ label, initial, withCopy, submitText, onSubmit }) {
  const input = el('input', { type: 'text', value: initial, required: true, maxLength: 60, ariaLabel: label, placeholder: label });
  const copy = el('input', { type: 'checkbox' });
  const cancel = el('button', { type: 'button', textContent: 'Cancel' });
  cancel.addEventListener('click', () => { mode = 'list'; render(); });
  const form = el('form', {},
    input,
    withCopy ? el('label', { className: 'check' }, copy, 'Start with a copy of the current bar') : null,
    el('div', { className: 'row' }, cancel, el('button', { type: 'submit', className: 'primary', textContent: submitText })),
  );
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const name = input.value.trim();
    if (!name) return;
    mode = 'list';
    act(() => onSubmit(name, copy.checked));
  });
  setTimeout(() => input.select(), 0);
  return form;
}

function renderList() {
  const current = view.focuses.find((f) => f.id === view.current);
  const parts = [
    el('h1', { textContent: 'Focus for this window' }),
    focusRadios('focus', view.current, (id) => act(() => send({ type: 'assign', windowId, focusId: id }))),
  ];

  if (mode === 'new') {
    parts.push(nameForm({
      label: 'Name of new focus',
      initial: '',
      withCopy: true,
      submitText: 'Create',
      onSubmit: (name, copyCurrent) => send({ type: 'create', windowId, name, copyCurrent }),
    }));
  } else if (mode === 'rename' && current) {
    parts.push(nameForm({
      label: 'New name',
      initial: current.name,
      withCopy: false,
      submitText: 'Rename',
      onSubmit: (name) => send({ type: 'rename', focusId: current.id, name }),
    }));
  } else {
    const add = el('button', { textContent: '+ New focus…' });
    add.addEventListener('click', () => { mode = 'new'; render(); });
    const rename = el('button', { textContent: 'Rename…', disabled: !current });
    rename.addEventListener('click', () => { mode = 'rename'; render(); });
    const actions = el('div', { className: 'actions' }, add, rename);
    if (current && current.id !== view.generalId) {
      const del = el('button', { className: 'danger', textContent: 'Delete…' });
      del.addEventListener('click', () => {
        const ok = confirm(`Delete the focus “${current.name}”?\n\nIts bookmarks are kept in a folder named “Removed – ${current.name}”, and windows using it switch to General.`);
        if (ok) act(() => send({ type: 'delete', focusId: current.id }));
      });
      actions.append(del);
    }
    parts.push(actions);
    const toggle = el('input', { type: 'checkbox', checked: view.showSwitcher !== false });
    toggle.addEventListener('change', () => act(() => send({ type: 'setShowSwitcher', value: toggle.checked })));
    parts.push(el('label', { className: 'setting' }, toggle, 'Show focus menu on bookmark bar'));
  }
  app.replaceChildren(...parts);
}

function render() {
  if (view.needsRecovery) renderRecovery();
  else renderList();
  footer.textContent = view.lastSwapMs != null ? `Last swap: ${view.lastSwapMs} ms` : '';
}

async function refresh() {
  view = await send({ type: 'get', windowId });
  render();
}

(async () => {
  try {
    windowId = (await chrome.windows.getCurrent()).id;
    await refresh();
  } catch (e) {
    app.replaceChildren();
    showError(e);
  }
})();
