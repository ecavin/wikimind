// lib/wikipedia.js — Wikipedia REST + Action API calls. No API key needed.

(function () {
if ((typeof self !== 'undefined' && self.WikimindWikipedia) ||
    (typeof window !== 'undefined' && window.WikimindWikipedia)) return;

const WP_REST = 'https://en.wikipedia.org/api/rest_v1';
const WP_API = 'https://en.wikipedia.org/w/api.php';

function encodeTitle(title) {
  return encodeURIComponent(title.replace(/ /g, '_'));
}

async function fetchSummary(title) {
  try {
    const res = await fetch(`${WP_REST}/page/summary/${encodeTitle(title)}`);
    if (!res.ok) return null;
    const data = await res.json();
    return {
      title: data.title,
      extract: data.extract || '',
      thumbnail: data.thumbnail ? data.thumbnail.source : null,
      contentUrl: data.content_urls ? data.content_urls.desktop.page : null
    };
  } catch (err) {
    console.warn('[wikimind] fetchSummary failed', title, err);
    return null;
  }
}

async function fetchArticleLinks(title) {
  try {
    const params = new URLSearchParams({
      action: 'query',
      titles: title,
      prop: 'links',
      pllimit: '100',
      plnamespace: '0',
      format: 'json',
      origin: '*'
    });
    const res = await fetch(`${WP_API}?${params.toString()}`);
    if (!res.ok) return [];
    const data = await res.json();
    const pages = data.query && data.query.pages ? data.query.pages : {};
    const out = [];
    for (const pageId of Object.keys(pages)) {
      const page = pages[pageId];
      if (page.links) {
        for (const l of page.links) {
          if (l.title) out.push(l.title);
        }
      }
    }
    return out;
  } catch (err) {
    console.warn('[wikimind] fetchArticleLinks failed', title, err);
    return [];
  }
}

const WikimindWikipedia = { fetchSummary, fetchArticleLinks };
if (typeof self !== 'undefined') self.WikimindWikipedia = WikimindWikipedia;
if (typeof window !== 'undefined') window.WikimindWikipedia = WikimindWikipedia;
})();
