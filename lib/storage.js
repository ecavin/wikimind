// lib/storage.js — Promise-wrapped wrapper over chrome.storage.local.
// Loaded into extension pages via <script> and into the service worker via importScripts().

(function () {
if ((typeof self !== 'undefined' && self.WikimindStorage) ||
    (typeof window !== 'undefined' && window.WikimindStorage)) return;

const STORAGE_KEY_ARTICLES = 'articles';
const STORAGE_KEY_SETTINGS = 'settings';
const STORAGE_KEY_NAV_EDGES = 'navEdges';
const STORAGE_KEY_CLUSTER_STATE = 'clusterState';

const DEFAULT_SETTINGS = {
  apiKey: '',
  autoFetchLinks: true,
  showNotifications: false
};

function storageGet(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (result) => {
      if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
      resolve(result);
    });
  });
}

function storageSet(obj) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(obj, () => {
      if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
      resolve();
    });
  });
}

function storageClear() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.clear(() => {
      if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
      resolve();
    });
  });
}

async function getArticles() {
  const res = await storageGet(STORAGE_KEY_ARTICLES);
  return res[STORAGE_KEY_ARTICLES] || {};
}

async function getArticle(title) {
  const articles = await getArticles();
  return articles[title] || null;
}

async function setArticles(articles) {
  await storageSet({ [STORAGE_KEY_ARTICLES]: articles });
}

async function setArticle(title, data) {
  const articles = await getArticles();
  articles[title] = data;
  await setArticles(articles);
}

// Dedup + bump visitCount + lastVisited. Returns {article, isNew}.
async function upsertVisit(meta) {
  const articles = await getArticles();
  const now = Date.now();
  const existing = articles[meta.title];
  let article;
  let isNew = false;
  if (existing) {
    article = {
      ...existing,
      url: meta.url || existing.url,
      summary: meta.summary || existing.summary,
      categories: (meta.categories && meta.categories.length) ? meta.categories : existing.categories,
      lastVisited: now,
      visitCount: (existing.visitCount || 0) + 1
    };
  } else {
    isNew = true;
    article = {
      title: meta.title,
      url: meta.url,
      summary: meta.summary || '',
      categories: meta.categories || [],
      firstVisited: now,
      lastVisited: now,
      visitCount: 1,
      links: []
    };
  }
  articles[meta.title] = article;
  await setArticles(articles);
  return { article, isNew };
}

async function updateStatus(title, status) {
  const articles = await getArticles();
  if (!articles[title]) return;
  articles[title].status = status || null;
  await setArticles(articles);
}

async function updateLinks(title, linkedTitles) {
  const articles = await getArticles();
  if (!articles[title]) return;
  const unique = Array.from(new Set(linkedTitles.filter((t) => t && t !== title)));
  articles[title].links = unique;
  await setArticles(articles);
}

// Adds `linkedTitle` to article[title].links if not already present.
async function addLink(title, linkedTitle) {
  if (!title || !linkedTitle || title === linkedTitle) return;
  const articles = await getArticles();
  if (!articles[title]) return;
  const set = new Set(articles[title].links || []);
  if (set.has(linkedTitle)) return;
  set.add(linkedTitle);
  articles[title].links = Array.from(set);
  await setArticles(articles);
}

async function getNavEdges() {
  const res = await storageGet(STORAGE_KEY_NAV_EDGES);
  return res[STORAGE_KEY_NAV_EDGES] || {};
}

// Stores a directed navigation edge from→to. Keys are "from\x01to".
// Idempotent: duplicate edges are silently ignored.
async function addNavEdge(from, to) {
  if (!from || !to || from === to) return;
  const edges = await getNavEdges();
  const key = from + '\x01' + to;
  if (edges[key]) return;
  edges[key] = 1;
  await storageSet({ [STORAGE_KEY_NAV_EDGES]: edges });
}

async function getClusterState() {
  const res = await storageGet(STORAGE_KEY_CLUSTER_STATE);
  return res[STORAGE_KEY_CLUSTER_STATE] || null;
}

async function setClusterState(state) {
  if (!state) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.remove(STORAGE_KEY_CLUSTER_STATE, () => {
        if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
        resolve();
      });
    });
  }
  await storageSet({ [STORAGE_KEY_CLUSTER_STATE]: state });
}

async function getSettings() {
  const res = await storageGet(STORAGE_KEY_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...(res[STORAGE_KEY_SETTINGS] || {}) };
}

async function setSettings(partial) {
  const current = await getSettings();
  const next = { ...current, ...partial };
  await storageSet({ [STORAGE_KEY_SETTINGS]: next });
  return next;
}

async function exportAll() {
  const all = await storageGet([STORAGE_KEY_ARTICLES, STORAGE_KEY_SETTINGS]);
  // Scrub API key before export.
  const settings = { ...(all[STORAGE_KEY_SETTINGS] || {}) };
  delete settings.apiKey;
  return {
    exportedAt: new Date().toISOString(),
    articles: all[STORAGE_KEY_ARTICLES] || {},
    settings
  };
}

async function clearAll() {
  await storageClear();
}

async function getStats() {
  const articles = await getArticles();
  const list = Object.values(articles);
  const totalArticles = list.length;
  let edgeCount = 0;
  const categoryCounts = {};
  let mostVisited = null;
  for (const a of list) {
    edgeCount += (a.links || []).length;
    for (const c of (a.categories || [])) {
      categoryCounts[c] = (categoryCounts[c] || 0) + 1;
    }
    if (!mostVisited || a.visitCount > mostVisited.visitCount) mostVisited = a;
  }
  // Edges counted once per direction; divide by 2 for undirected display.
  const totalConnections = Math.round(edgeCount / 2);
  let mostCommonCategory = null;
  let maxCatCount = 0;
  for (const [k, v] of Object.entries(categoryCounts)) {
    if (v > maxCatCount) { maxCatCount = v; mostCommonCategory = k; }
  }
  // Reading streak: consecutive days ending today with at least one visit.
  const dayKeys = new Set();
  for (const a of list) {
    const d = new Date(a.lastVisited);
    dayKeys.add(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`);
    const d2 = new Date(a.firstVisited);
    dayKeys.add(`${d2.getFullYear()}-${d2.getMonth()}-${d2.getDate()}`);
  }
  let streak = 0;
  const today = new Date();
  for (let i = 0; i < 3650; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    if (dayKeys.has(key)) streak++;
    else break;
  }
  return {
    totalArticles,
    totalConnections,
    mostVisited: mostVisited ? { title: mostVisited.title, visitCount: mostVisited.visitCount } : null,
    mostCommonCategory,
    readingStreak: streak
  };
}

// Expose for non-module contexts.
const WikimindStorage = {
  getArticles,
  getArticle,
  setArticle,
  setArticles,
  upsertVisit,
  updateStatus,
  updateLinks,
  addLink,
  getNavEdges,
  addNavEdge,
  getClusterState,
  setClusterState,
  getSettings,
  setSettings,
  exportAll,
  clearAll,
  getStats
};

if (typeof self !== 'undefined') self.WikimindStorage = WikimindStorage;
if (typeof window !== 'undefined') window.WikimindStorage = WikimindStorage;
})();
