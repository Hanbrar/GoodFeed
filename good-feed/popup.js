document.addEventListener('DOMContentLoaded', async () => {
  const intentInput = document.getElementById('intentInput');
  const setFeedBtn  = document.getElementById('setFeedBtn');
  const toggleBtn   = document.getElementById('toggleBtn');
  const statusDot   = document.getElementById('statusDot');
  const statusText  = document.getElementById('statusText');
  const modeBtns    = document.querySelectorAll('.mode-btn');

  // ── Load persisted state ──────────────────────────────────────────────────
  const { intent, active, mode } = await getStorage(['intent', 'active', 'mode']);
  if (intent) intentInput.value = intent;
  setActiveMode(mode || 'recent');
  renderStatus(!!active, intent || null);

  // ── Mode toggle ───────────────────────────────────────────────────────────
  modeBtns.forEach(btn => {
    btn.addEventListener('click', async () => {
      const newMode = btn.dataset.mode;
      setActiveMode(newMode);
      await chrome.storage.local.set({ mode: newMode });

      // If the feed is currently active, broadcast the change immediately
      const { intent: cur, active: cur_active } = await getStorage(['intent', 'active']);
      if (cur_active && cur) {
        broadcastToXTabs({ action: 'updateIntent', intent: cur, active: true, mode: newMode });
      }
    });
  });

  // ── Set My Feed ───────────────────────────────────────────────────────────
  setFeedBtn.addEventListener('click', async () => {
    const newIntent = intentInput.value.trim();
    if (!newIntent) { intentInput.focus(); return; }

    const currentMode = getSelectedMode();

    setFeedBtn.disabled = true;
    setFeedBtn.textContent = 'Setting…';

    await chrome.storage.local.set({ intent: newIntent, active: true, mode: currentMode });
    renderStatus(true, newIntent);
    broadcastToXTabs({ action: 'updateIntent', intent: newIntent, active: true, mode: currentMode });

    setFeedBtn.textContent = 'Feed Set!';
    setTimeout(() => {
      setFeedBtn.textContent = 'Set My Feed';
      setFeedBtn.disabled = false;
    }, 1500);
  });

  intentInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') setFeedBtn.click();
  });

  // ── On/Off toggle ─────────────────────────────────────────────────────────
  toggleBtn.addEventListener('click', async () => {
    const { active: cur, intent: cur_intent, mode: cur_mode } =
      await getStorage(['active', 'intent', 'mode']);
    const next = !cur;
    await chrome.storage.local.set({ active: next });
    renderStatus(next, cur_intent || null);
    broadcastToXTabs({
      action: 'updateIntent',
      intent: cur_intent,
      active: next,
      mode: cur_mode || 'recent',
    });
  });

  // ── Helpers ───────────────────────────────────────────────────────────────
  function getStorage(keys) {
    return new Promise(resolve => chrome.storage.local.get(keys, resolve));
  }

  function setActiveMode(modeValue) {
    modeBtns.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === modeValue);
    });
  }

  function getSelectedMode() {
    for (const btn of modeBtns) {
      if (btn.classList.contains('active')) return btn.dataset.mode;
    }
    return 'recent';
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
      url: ['https://x.com/*', 'https://twitter.com/*'],
    });
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, message).catch(() => {});
    }
  }
});
