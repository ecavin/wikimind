(async function () {
  const { getArticles, getStats } = window.WikimindStorage;

  const [articles, stats] = await Promise.all([getArticles(), getStats()]);
  document.getElementById('stat-articles').textContent = stats.totalArticles;
  document.getElementById('stat-connections').textContent = stats.totalConnections;

  const list = document.getElementById('recent-list');
  const recent = Object.values(articles)
    .sort((a, b) => b.lastVisited - a.lastVisited)
    .slice(0, 5);

  if (recent.length === 0) {
    list.innerHTML = '<li class="empty">No articles tracked yet.</li>';
  } else {
    list.innerHTML = '';
    for (const a of recent) {
      const li = document.createElement('li');
      const link = document.createElement('a');
      link.href = a.url;
      link.textContent = a.title;
      link.title = a.summary || a.title;
      link.addEventListener('click', (e) => {
        e.preventDefault();
        chrome.tabs.create({ url: a.url });
      });
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = `${a.visitCount} visit${a.visitCount === 1 ? '' : 's'} · ${new Date(a.lastVisited).toLocaleDateString()}`;
      li.appendChild(link);
      li.appendChild(meta);
      list.appendChild(li);
    }
  }

  document.getElementById('open-dashboard').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html') });
    window.close();
  });

  document.getElementById('open-settings').addEventListener('click', (e) => {
    e.preventDefault();
    if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
    else chrome.tabs.create({ url: chrome.runtime.getURL('settings/settings.html') });
    window.close();
  });
})();
