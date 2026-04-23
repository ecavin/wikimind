(async function () {
  const { getArticles, getStats, getArticle, updateStatus } = window.WikimindStorage;

  const [articles, stats] = await Promise.all([getArticles(), getStats()]);
  document.getElementById('stat-articles').textContent = stats.totalArticles;
  document.getElementById('stat-connections').textContent = stats.totalConnections;
  document.getElementById('stat-streak').textContent = stats.readingStreak || 0;

  const list = document.getElementById('recent-list');
  const all = Object.values(articles).sort((a, b) => b.lastVisited - a.lastVisited);
  const recent = all.slice(0, 5);
  document.getElementById('recent-count').textContent = all.length ? `${all.length} total` : '';

  function relTime(ts) {
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  if (recent.length) {
    list.innerHTML = '';
    for (const a of recent) {
      const li = document.createElement('li');
      const link = document.createElement('a');
      link.href = a.url;
      link.textContent = a.title;
      link.title = a.summary || a.title;
      li.appendChild(link);

      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.innerHTML = `<span>${a.visitCount} visit${a.visitCount === 1 ? '' : 's'}</span><span class="dot"></span><span>${relTime(a.lastVisited)}</span>`;
      li.appendChild(meta);

      li.addEventListener('click', () => {
        chrome.tabs.create({ url: a.url });
      });
      list.appendChild(li);
    }
  }

  // Status marking for currently active Wikipedia article
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const wikiMatch = tab?.url?.match(/^https:\/\/en\.wikipedia\.org\/wiki\/([^#?]+)/);
  if (wikiMatch) {
    const slug = decodeURIComponent(wikiMatch[1]).replace(/_/g, ' ');
    const article = await getArticle(slug);
    if (article) {
      const section = document.getElementById('current-article-section');
      document.getElementById('current-article-name').textContent = article.title;
      section.classList.remove('hidden');
      const btns = section.querySelectorAll('.status-btn');
      const refresh = (status) => btns.forEach((b) => b.classList.toggle('status-btn--active', b.dataset.status === status));
      refresh(article.status || '');
      btns.forEach((btn) => btn.addEventListener('click', async () => {
        const next = btn.dataset.status === article.status ? null : btn.dataset.status;
        await updateStatus(article.title, next);
        article.status = next;
        refresh(next || '');
      }));
    }
  }

  document.getElementById('open-dashboard').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html') });
    window.close();
  });

  document.getElementById('open-settings').addEventListener('click', () => {
    if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
    else chrome.tabs.create({ url: chrome.runtime.getURL('settings/settings.html') });
    window.close();
  });
})();
