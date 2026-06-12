const APP_URL = 'http://localhost:5173/';
const CHAT_TAB_URLS = ['https://chat.google.com/*', 'https://mail.google.com/chat/*'];

async function refreshStatus() {
  const dot = document.getElementById('dot-tab');
  const txt = document.getElementById('txt-tab');
  const tabs = await chrome.tabs.query({ url: CHAT_TAB_URLS });
  if (tabs.length) {
    dot.className = 'dot ok';
    txt.textContent = `已連到 Google Chat 分頁 (${tabs.length})`;
  } else {
    dot.className = 'dot bad';
    txt.textContent = '尚未開啟 Google Chat 分頁';
  }
}

document.getElementById('open-chat').addEventListener('click', async () => {
  const tabs = await chrome.tabs.query({ url: CHAT_TAB_URLS });
  if (tabs.length) await chrome.tabs.update(tabs[0].id, { active: true });
  else await chrome.tabs.create({ url: 'https://chat.google.com/' });
  window.close();
});

// Built-in (no server): the bundled app page at chrome-extension://<id>/app/index.html
document.getElementById('open-app-ext').addEventListener('click', async () => {
  const url = chrome.runtime.getURL('app/index.html');
  const existing = await chrome.tabs.query({ url: chrome.runtime.getURL('app/*') });
  if (existing.length) await chrome.tabs.update(existing[0].id, { active: true });
  else await chrome.tabs.create({ url });
  window.close();
});

// Dev (HMR): the Vite server on localhost.
document.getElementById('open-app-dev').addEventListener('click', async () => {
  const existing = await chrome.tabs.query({ url: 'http://localhost:5173/*' });
  if (existing.length) await chrome.tabs.update(existing[0].id, { active: true });
  else await chrome.tabs.create({ url: APP_URL });
  window.close();
});

refreshStatus();
