// lib/llm.js — Google Gemini 3 Flash calls.
// Endpoint: https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent
// Auth: x-goog-api-key header. Structured JSON via responseMimeType + responseJsonSchema.

const GEMINI_MODEL = 'gemini-3-flash-preview';
const GEMINI_ENDPOINT =
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

function compactArticles(articles, limit) {
  const arr = Array.isArray(articles) ? articles : Object.values(articles);
  const sliced = typeof limit === 'number' ? arr.slice(0, limit) : arr;
  return sliced.map((a) => ({
    title: a.title,
    categories: (a.categories || []).slice(0, 3),
    summary: (a.summary || '').slice(0, 150)
  }));
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
      'x-goog-api-key': apiKey
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

const CLUSTER_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      clusterName: { type: 'string' },
      articles: { type: 'array', items: { type: 'string' } }
    },
    required: ['clusterName', 'articles']
  }
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

function mergeClusters(batches) {
  const byName = new Map();
  for (const batch of batches) {
    for (const c of batch) {
      if (!c || !c.clusterName || !Array.isArray(c.articles)) continue;
      const key = c.clusterName.trim().toLowerCase();
      if (!byName.has(key)) byName.set(key, { clusterName: c.clusterName, articles: [] });
      const target = byName.get(key);
      for (const t of c.articles) {
        if (t && !target.articles.includes(t)) target.articles.push(t);
      }
    }
  }
  return Array.from(byName.values());
}

async function clusterArticles(articles, apiKey) {
  const arr = Array.isArray(articles) ? articles : Object.values(articles);
  if (arr.length === 0) return [];
  const system =
    'You are a taxonomy expert. Group Wikipedia articles into coherent thematic clusters. ' +
    'Each article should appear in exactly one cluster. Use short, descriptive cluster names (1-4 words).';

  const BATCH = 60;
  if (arr.length <= 80) {
    const payload = compactArticles(arr);
    const user =
      `Articles (JSON):\n${JSON.stringify(payload)}\n\n` +
      'Return a JSON array of {clusterName, articles: [title, ...]}. ' +
      'Every article title above must appear in exactly one cluster.';
    const result = await callGemini({ apiKey, system, user, schema: CLUSTER_SCHEMA });
    return Array.isArray(result) ? result : [];
  }

  const batches = [];
  for (let i = 0; i < arr.length; i += BATCH) batches.push(arr.slice(i, i + BATCH));
  const results = [];
  for (const b of batches) {
    const payload = compactArticles(b);
    const user =
      `Articles (JSON):\n${JSON.stringify(payload)}\n\n` +
      'Return a JSON array of {clusterName, articles: [title, ...]}. ' +
      'Every article title above must appear in exactly one cluster.';
    const result = await callGemini({ apiKey, system, user, schema: CLUSTER_SCHEMA });
    if (Array.isArray(result)) results.push(result);
  }
  return mergeClusters(results);
}

const WikimindLLM = { getRecommendations, getGapAnalysis, clusterArticles };
if (typeof self !== 'undefined') self.WikimindLLM = WikimindLLM;
if (typeof window !== 'undefined') window.WikimindLLM = WikimindLLM;
