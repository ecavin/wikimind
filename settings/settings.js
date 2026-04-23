(async function () {
  const { getSettings, setSettings, exportAll, clearAll, getStats } = window.WikimindStorage;

  const apiKeyInput = document.getElementById('api-key');
  const autoFetch = document.getElementById('auto-fetch');
  const notifications = document.getElementById('notifications');
  const keyStatus = document.getElementById('key-status');
  const toggleVis = document.getElementById('toggle-visibility');
  const confirmModal = document.getElementById('confirm-modal');

  const settings = await getSettings();
  apiKeyInput.value = settings.apiKey || '';
  autoFetch.checked = !!settings.autoFetchLinks;
  notifications.checked = !!settings.showNotifications;

  function flash(msg, cls) {
    keyStatus.textContent = msg;
    keyStatus.className = 'status ' + (cls || '');
    setTimeout(() => { keyStatus.textContent = ''; keyStatus.className = 'status'; }, 2200);
  }

  apiKeyInput.addEventListener('blur', async () => {
    const v = apiKeyInput.value.replace(/[^\u0000-\u00FF]/g, '').trim();
    await setSettings({ apiKey: v });
    flash(v ? 'API key saved' : 'API key cleared', 'success');
  });

  toggleVis.addEventListener('click', () => {
    apiKeyInput.type = apiKeyInput.type === 'password' ? 'text' : 'password';
  });

  autoFetch.addEventListener('change', async () => {
    await setSettings({ autoFetchLinks: autoFetch.checked });
  });

  notifications.addEventListener('change', async () => {
    await setSettings({ showNotifications: notifications.checked });
  });

  document.getElementById('export-btn').addEventListener('click', async () => {
    const payload = await exportAll();
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `wikimind-export-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  function openModal() { confirmModal.classList.remove('hidden'); }
  function closeModal() { confirmModal.classList.add('hidden'); }

  document.getElementById('clear-btn').addEventListener('click', openModal);
  document.getElementById('cancel-clear').addEventListener('click', closeModal);
  confirmModal.querySelector('.modal-backdrop').addEventListener('click', closeModal);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  document.getElementById('confirm-clear').addEventListener('click', async () => {
    await clearAll();
    closeModal();
    await renderStats();
    apiKeyInput.value = '';
    autoFetch.checked = false;
    notifications.checked = false;
    flash('All data cleared', 'success');
  });

  async function renderStats() {
    const s = await getStats();
    document.getElementById('s-articles').textContent = s.totalArticles;
    document.getElementById('s-connections').textContent = s.totalConnections;
    document.getElementById('s-mostvisited').textContent = s.mostVisited
      ? `${s.mostVisited.title} (${s.mostVisited.visitCount})` : '—';
    document.getElementById('s-category').textContent = s.mostCommonCategory || '—';
    document.getElementById('s-streak').textContent = s.readingStreak
      ? `${s.readingStreak} day${s.readingStreak === 1 ? '' : 's'}` : '0 days';
  }

  await renderStats();
})();
