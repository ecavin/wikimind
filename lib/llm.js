// lib/llm.js — Google Gemini 3 Flash calls.
// Endpoint: https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent
// Auth: x-goog-api-key header. Structured JSON via responseMimeType + responseJsonSchema.

const GEMINI_MODEL = 'gemini-3-flash-preview';
const GEMINI_ENDPOINT =
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

function compactArticles(articles, limit, includeStatus = false) {
  const arr = Array.isArray(articles) ? articles : Object.values(articles);
  const sliced = typeof limit === 'number' ? arr.slice(0, limit) : arr;
  return sliced.map((a) => {
    const out = {
      title: a.title,
      categories: (a.categories || []).slice(0, 3),
      summary: (a.summary || '').slice(0, 150)
    };
    if (includeStatus) out.status = a.status || null;
    return out;
  });
}

function extractJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) { /* fall through */ }
  // Fallback: strip code fences and locate the first [...] or {...}.
  const cleaned = text.replace(/```json|```/g, '').trim();
  try { return JSON.parse(cleaned); } catch (_) { /* fall through */ }
  const firstArr = cleaned.indexOf('[');
  const lastArr = cleaned.lastIndexOf(']');
  if (firstArr !== -1 && lastArr > firstArr) {
    try { return JSON.parse(cleaned.slice(firstArr, lastArr + 1)); } catch (_) {}
  }
  const firstObj = cleaned.indexOf('{');
  const lastObj = cleaned.lastIndexOf('}');
  if (firstObj !== -1 && lastObj > firstObj) {
    try { return JSON.parse(cleaned.slice(firstObj, lastObj + 1)); } catch (_) {}
  }
  return null;
}

async function callGemini({ apiKey, system, user, schema, thinkingLevel = 'low' }) {
  if (!apiKey) throw new Error('Missing Gemini API key. Set it in WikiMind Settings.');
  // Strip any non-ISO-8859-1 characters (invisible Unicode, etc.) that would cause fetch to reject the header.
  const safeKey = apiKey.replace(/[^\u0000-\u00FF]/g, '').trim();
  if (!safeKey) throw new Error('API key contains only invalid characters. Please re-enter it in Settings.');
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      thinkingConfig: { thinkingLevel }
    }
  };
  if (schema) body.generationConfig.responseJsonSchema = schema;

  const res = await fetch(GEMINI_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': safeKey
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Gemini API ${res.status}: ${errText.slice(0, 300)}`);
  }
  const data = await res.json();
  const text =
    (data.candidates && data.candidates[0] && data.candidates[0].content &&
     data.candidates[0].content.parts && data.candidates[0].content.parts[0] &&
     data.candidates[0].content.parts[0].text) || '';
  const parsed = extractJson(text);
  if (parsed === null) throw new Error('Could not parse JSON from Gemini response.');
  return parsed;
}

const RECOMMEND_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      reason: { type: 'string' }
    },
    required: ['title', 'reason']
  }
};

const GAP_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      topic: { type: 'string' },
      reason: { type: 'string' }
    },
    required: ['topic', 'reason']
  }
};

const TUTOR_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      concept:          { type: 'string' },
      reason:           { type: 'string' },
      relatesToArticle: { type: 'string' },
      type: { type: 'string', enum: ['prerequisite', 'supporting'] }
    },
    required: ['concept', 'reason', 'relatesToArticle', 'type']
  }
};

const CLUSTER_SCHEMA = {
  type: 'object',
  properties: {
    clusters: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          clusterName: { type: 'string' },
          articles: { type: 'array', items: { type: 'string' } }
        },
        required: ['clusterName', 'articles']
      }
    },
    connections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          connectedTo: { type: 'array', items: { type: 'string' } }
        },
        required: ['title', 'connectedTo']
      }
    },
    superClusters: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          children: { type: 'array', items: { type: 'string' } },
          parent: { type: ['string', 'null'] }
        },
        required: ['name', 'children']
      }
    }
  },
  required: ['clusters']
};

async function getRecommendations(articles, apiKey) {
  const payload = compactArticles(articles, 120);
  const system =
    'You are a knowledgeable reading advisor specializing in Wikipedia. ' +
    'Given a reader\'s history, suggest high-quality Wikipedia articles they have NOT yet read. ' +
    'Prefer real, commonly-existing Wikipedia article titles. Keep reasons concise (one sentence).';
  const user =
    `Reading history (JSON):\n${JSON.stringify(payload)}\n\n` +
    'Return exactly 8 recommendations as a JSON array of {title, reason}. ' +
    'Do NOT recommend any title already present in the reading history.';
  const result = await callGemini({ apiKey, system, user, schema: RECOMMEND_SCHEMA });
  return Array.isArray(result) ? result.slice(0, 8) : [];
}

async function getGapAnalysis(articles, apiKey) {
  const payload = compactArticles(articles, 120);
  const system =
    'You are an analytical reading advisor. Identify topics or subtopics the reader appears to be ' +
    'circling around based on their Wikipedia reading history but has not directly read yet. ' +
    'Be specific — prefer named concepts over vague themes.';
  const user =
    `Reading history (JSON):\n${JSON.stringify(payload)}\n\n` +
    'Return 3-6 gap topics as a JSON array of {topic, reason}, where reason explains which of the ' +
    'already-read articles hint at this gap.';
  const result = await callGemini({ apiKey, system, user, schema: GAP_SCHEMA });
  return Array.isArray(result) ? result : [];
}

function truncateWords(s, maxWords) {
  if (!s) return '';
  const words = String(s).trim().split(/\s+/);
  if (words.length <= maxWords) return words.join(' ');
  return words.slice(0, maxWords).join(' ');
}

function normalizeClusterResponse(raw) {
  const out = { clusters: [], connections: [], superClusters: [] };
  if (!raw) return out;
  // Allow older array-shape responses.
  if (Array.isArray(raw)) {
    out.clusters = raw.filter((c) => c && c.clusterName && Array.isArray(c.articles));
    return out;
  }
  if (Array.isArray(raw.clusters)) {
    out.clusters = raw.clusters.filter((c) => c && c.clusterName && Array.isArray(c.articles));
  }
  if (Array.isArray(raw.connections)) {
    out.connections = raw.connections
      .filter((c) => c && c.title && Array.isArray(c.connectedTo))
      .map((c) => ({ title: c.title, connectedTo: c.connectedTo.filter(Boolean) }));
  }
  if (Array.isArray(raw.superClusters)) {
    // Enforce strict tree: each name keeps at most one parent.
    const seen = new Map();
    for (const s of raw.superClusters) {
      if (!s || !s.name || !Array.isArray(s.children)) continue;
      if (seen.has(s.name)) continue;
      seen.set(s.name, {
        name: s.name,
        children: s.children.filter(Boolean),
        parent: s.parent || null
      });
    }
    out.superClusters = Array.from(seen.values());
  }
  return out;
}

function mergeClusterBatches(batches) {
  const byName = new Map();
  const connMap = new Map();
  for (const batch of batches) {
    for (const c of batch.clusters || []) {
      const key = c.clusterName.trim().toLowerCase();
      if (!byName.has(key)) byName.set(key, { clusterName: c.clusterName, articles: [] });
      const target = byName.get(key);
      for (const t of c.articles) {
        if (t && !target.articles.includes(t)) target.articles.push(t);
      }
    }
    for (const c of batch.connections || []) {
      if (!c || !c.title) continue;
      const set = connMap.get(c.title) || new Set();
      for (const t of (c.connectedTo || [])) if (t) set.add(t);
      connMap.set(c.title, set);
    }
  }
  return {
    clusters: Array.from(byName.values()),
    connections: Array.from(connMap.entries()).map(([title, set]) => ({ title, connectedTo: Array.from(set) })),
    superClusters: []
  };
}

const CLUSTER_SYSTEM_BASE =
  'You are a taxonomy expert organizing Wikipedia articles into a layered knowledge map. ' +
  'Tasks: ' +
  '(1) Group articles into coherent thematic clusters. Each article appears in exactly one cluster. ' +
  'Cluster names are short (1-4 words). ' +
  '(2) For each article, list the other articles from the provided list that it is meaningfully ' +
  'connected to. Include non-obvious conceptual connections — you are NOT limited to explicit ' +
  'Wikipedia links. Return this as a "connections" array where each entry is ' +
  '{title: string, connectedTo: [string]}. Each connectedTo list should contain 1-5 other article ' +
  'titles from the input. Articles across different clusters may be connected if conceptually related. ' +
  '(3) Optionally group clusters into super-clusters (higher-level themes), which may themselves be ' +
  'nested inside other super-clusters. This forms a strict tree: each cluster or super-cluster has ' +
  'at most one parent super-cluster. Super-cluster names are short (1-3 words). ' +
  'Return JSON with keys: clusters, connections, superClusters.';

async function clusterArticles(articles, apiKey, opts = {}) {
  const arr = Array.isArray(articles) ? articles : Object.values(articles);
  if (arr.length === 0) return { clusters: [], relationships: [], superClusters: [] };
  const prior = opts.prior || null;

  // Incremental mode: extend prior taxonomy over only the new articles.
  if (prior && Array.isArray(prior.clusteredTitles)) {
    const priorTitles = new Set(prior.clusteredTitles);
    const newArticles = arr.filter((a) => !priorTitles.has(a.title));
    const system = CLUSTER_SYSTEM_BASE + ' ' +
      'You are EXTENDING an existing taxonomy. Preserve existing cluster assignments, super-cluster ' +
      'structure, and connections unless clearly wrong. Place the NEW articles below into existing ' +
      'clusters when they fit; create new small clusters only when necessary. Add connections for ' +
      'newly relevant relationships (including between new and prior articles). Preserve the ' +
      'super-cluster tree.';
    const priorPayload = {
      clusters: prior.clusters || [],
      superClusters: prior.superClusters || [],
      connections: prior.connections || []
    };
    const newPayload = compactArticles(newArticles);
    const user =
      `Existing taxonomy (JSON):\n${JSON.stringify(priorPayload)}\n\n` +
      `New articles to integrate (JSON):\n${JSON.stringify(newPayload)}\n\n` +
      'Return the UPDATED taxonomy as JSON: {clusters, connections, superClusters}. ' +
      'Include ALL articles (existing + new) across the cluster list. ' +
      'Every new article must appear in exactly one cluster.';
    const result = await callGemini({ apiKey, system, user, schema: CLUSTER_SCHEMA });
    return normalizeClusterResponse(result);
  }

  // Full cluster path.
  const BATCH = 60;
  if (arr.length <= 80) {
    const payload = compactArticles(arr);
    const user =
      `Articles (JSON):\n${JSON.stringify(payload)}\n\n` +
      'Return JSON with keys {clusters, relationships, superClusters}. ' +
      'Every article title above must appear in exactly one cluster.';
    const result = await callGemini({ apiKey, system: CLUSTER_SYSTEM_BASE, user, schema: CLUSTER_SCHEMA });
    return normalizeClusterResponse(result);
  }

  const batches = [];
  for (let i = 0; i < arr.length; i += BATCH) batches.push(arr.slice(i, i + BATCH));
  const results = [];
  for (const b of batches) {
    const payload = compactArticles(b);
    const user =
      `Articles (JSON):\n${JSON.stringify(payload)}\n\n` +
      'Return JSON with keys {clusters, relationships, superClusters}. ' +
      'Every article title above must appear in exactly one cluster.';
    const result = await callGemini({ apiKey, system: CLUSTER_SYSTEM_BASE, user, schema: CLUSTER_SCHEMA });
    const normalized = normalizeClusterResponse(result);
    if (normalized) results.push(normalized);
  }
  return mergeClusterBatches(results);
}

async function getTreeRecommendations(articles, apiKey) {
  const payload = compactArticles(articles);
  const system =
    'You are a knowledgeable reading advisor specializing in Wikipedia. ' +
    'Given a focused reading session (a subtree of related articles), suggest Wikipedia articles ' +
    'the reader has NOT yet read that would deepen their understanding of this specific topic cluster. ' +
    'Prefer real, commonly-existing Wikipedia article titles. Keep reasons concise (one sentence).';
  const user =
    `Articles in this reading tree (JSON):\n${JSON.stringify(payload)}\n\n` +
    'Return exactly 6 recommendations as a JSON array of {title, reason}. ' +
    'Do NOT recommend any title already present above.';
  const result = await callGemini({ apiKey, system, user, schema: RECOMMEND_SCHEMA });
  return Array.isArray(result) ? result.slice(0, 6) : [];
}

async function getTreeGapAnalysis(articles, apiKey) {
  const payload = compactArticles(articles);
  const system =
    'You are an analytical reading advisor. Given a focused reading subtree, identify specific ' +
    'topics or concepts the reader appears to be circling but has not directly studied. ' +
    'Be specific to the topic cluster — prefer named concepts over vague themes.';
  const user =
    `Articles in this reading tree (JSON):\n${JSON.stringify(payload)}\n\n` +
    'Return 3-5 gap topics as a JSON array of {topic, reason}, where reason explains which of the ' +
    'already-read articles hint at this gap.';
  const result = await callGemini({ apiKey, system, user, schema: GAP_SCHEMA });
  return Array.isArray(result) ? result : [];
}

async function getTutorRecommendations(articles, apiKey) {
  const withStatus = (Array.isArray(articles) ? articles : Object.values(articles))
    .filter((a) => a.status === 'learning' || a.status === 'confused');
  if (withStatus.length === 0) return [];
  const payload = compactArticles(articles, undefined, true);
  const system =
    'You are a Socratic tutor helping someone understand Wikipedia topics. ' +
    'You will receive a list of articles a student has been reading, some marked with their comprehension status: ' +
    '"confused" (they find it difficult) or "learning" (still developing understanding). ' +
    'For "confused" articles, suggest simpler prerequisite concepts they should study first to build the necessary foundation. ' +
    'For "learning" articles, suggest related supporting concepts that reinforce and deepen understanding. ' +
    'Do NOT suggest articles already present in the list.';
  const user =
    `Articles with comprehension status (JSON):\n${JSON.stringify(payload)}\n\n` +
    'Return up to 8 tutor suggestions as a JSON array of ' +
    '{concept, reason, relatesToArticle, type} where type is "prerequisite" or "supporting".';
  const result = await callGemini({ apiKey, system, user, schema: TUTOR_SCHEMA });
  return Array.isArray(result) ? result.slice(0, 8) : [];
}

const WikimindLLM = { getRecommendations, getGapAnalysis, clusterArticles,
                      getTreeRecommendations, getTreeGapAnalysis, getTutorRecommendations };
if (typeof self !== 'undefined') self.WikimindLLM = WikimindLLM;
if (typeof window !== 'undefined') window.WikimindLLM = WikimindLLM;
