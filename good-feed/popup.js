document.addEventListener('DOMContentLoaded', async () => {
  const intentInput = document.getElementById('intentInput');
  const setFeedBtn  = document.getElementById('setFeedBtn');
  const toggleBtn   = document.getElementById('toggleBtn');
  const statusDot   = document.getElementById('statusDot');
  const statusText  = document.getElementById('statusText');

  // ── Load persisted state ──────────────────────────────────────────────────
  const { intent, active } = await getStorage(['intent', 'active']);
  if (intent) intentInput.value = intent;
  renderStatus(!!active, intent || null);

  // ── Set My Feed ───────────────────────────────────────────────────────────
  setFeedBtn.addEventListener('click', async () => {
    const newIntent = intentInput.value.trim();
    if (!newIntent) {
      intentInput.focus();
      return;
    }

    setFeedBtn.disabled = true;
    setFeedBtn.textContent = 'Setting…';

    await chrome.storage.local.set({ intent: newIntent, active: true });
    renderStatus(true, newIntent);
    broadcastToXTabs({ action: 'updateIntent', intent: newIntent, active: true });

    setFeedBtn.textContent = 'Feed Set!';
    setTimeout(() => {
      setFeedBtn.textContent = 'Set My Feed';
      setFeedBtn.disabled = false;
    }, 1500);
  });

  // Allow Enter key in the input
  intentInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') setFeedBtn.click();
  });

  // ── Toggle ────────────────────────────────────────────────────────────────
  toggleBtn.addEventListener('click', async () => {
    const { active: cur, intent: cur_intent } = await getStorage(['active', 'intent']);
    const next = !cur;
    await chrome.storage.local.set({ active: next });
    renderStatus(next, cur_intent || null);
    broadcastToXTabs({ action: 'updateIntent', intent: cur_intent, active: next });
  });

  // ── Helpers ───────────────────────────────────────────────────────────────
  function getStorage(keys) {
    return new Promise(resolve => chrome.storage.local.get(keys, resolve));
  }

  function renderStatus(isActive, currentIntent) {
    if (isActive && currentIntent) {
      statusDot.className  = 'status-dot active';
      statusText.className = 'status-text active';
      statusText.textContent = `Active — "${currentIntent}"`;
      toggleBtn.textContent  = 'Disable';
      toggleBtn.className    = 'btn-secondary disable-btn';
    } else {
      statusDot.className  = 'status-dot';
      statusText.className = 'status-text';
      statusText.textContent = 'Inactive';
      toggleBtn.textContent  = 'Enable';
      toggleBtn.className    = 'btn-secondary';
    }
  }

  async function broadcastToXTabs(message) {
    const tabs = await chrome.tabs.query({
      url: ['https://x.com/*', 'https://twitter.com/*']
    });
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, message).catch(() => {
        // Tab may not have content script ready yet — safe to ignore
      });
    }
  }
});
