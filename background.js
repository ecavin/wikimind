// background.js — MV3 service worker.
// Receives ARTICLE_VISIT messages from content.js, persists the visit, and
// (optionally) fetches outbound Wikipedia links to build the graph.

importScripts('lib/storage.js', 'lib/wikipedia.js');

const { upsertVisit, getSettings, getArticles, updateLinks, addLink } = self.WikimindStorage;
const { fetchArticleLinks } = self.WikimindWikipedia;

async function handleArticleVisit(payload) {
  if (!payload || !payload.title) return { ok: false, error: 'missing title' };
  const { article, isNew } = await upsertVisit(payload);
  const settings = await getSettings();

  if (settings.showNotifications) {
    try {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: isNew ? 'WikiMind: new article logged' : 'WikiMind: visit updated',
        message: article.title
      });
    } catch (_) { /* notifications permission may be missing */ }
  }

  if (isNew && settings.autoFetchLinks) {
    await refreshArticleLinks(article.title);
  }
  return { ok: true, isNew };
}

// Fetch one article's outbound links, intersect with the user's library,
// persist, and wire up back-edges for any already-linked peers.
async function refreshArticleLinks(title) {
  const raw = await fetchArticleLinks(title);
  const library = await getArticles();
  const librarySet = new Set(Object.keys(library));
  const filtered = raw.filter((t) => librarySet.has(t) && t !== title);
  await updateLinks(title, filtered);
  for (const other of filtered) {
    await addLink(other, title);
  }
  return filtered;
}

// Full sweep: re-fetch links for every article and rebuild the edge set.
async function refetchAllLinks(progressPort) {
  const library = await getArticles();
  const titles = Object.keys(library);
  // Reset all link arrays so we can rebuild from scratch.
  for (const t of titles) library[t].links = [];
  const librarySet = new Set(titles);

  let i = 0;
  for (const title of titles) {
    i++;
    try {
      const raw = await fetchArticleLinks(title);
      const filtered = raw.filter((t) => librarySet.has(t) && t !== title);
      library[title].links = filtered;
      // Also add back-edges in-memory so we only write once at the end.
      for (const other of filtered) {
        if (!library[other].links.includes(title)) library[other].links.push(title);
      }
    } catch (err) {
      console.warn('[wikimind] sweep failed for', title, err);
    }
    if (progressPort) {
      try { progressPort.postMessage({ type: 'PROGRESS', done: i, total: titles.length, title }); } catch (_) {}
    }
    // Throttle: ~4 req/s.
    await new Promise((r) => setTimeout(r, 250));
  }
  await self.WikimindStorage.setArticles(library);
  return { ok: true, count: titles.length };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return;
  if (msg.type === 'ARTICLE_VISIT') {
    handleArticleVisit(msg.payload)
      .then((r) => sendResponse(r))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // async response
  }
  if (msg.type === 'REFETCH_ALL_LINKS') {
    refetchAllLinks()
      .then((r) => sendResponse(r))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
});

// Long-running port for progress updates during full sweeps.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'refetch-all-links') return;
  refetchAllLinks(port)
    .then((r) => { try { port.postMessage({ type: 'DONE', ...r }); } catch (_) {} port.disconnect(); })
    .catch((err) => { try { port.postMessage({ type: 'ERROR', error: String(err) }); } catch (_) {} port.disconnect(); });
});
