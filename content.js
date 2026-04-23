// content.js — runs on en.wikipedia.org/wiki/* at document_idle.
// Extracts the current article's metadata and sends one ARTICLE_VISIT message.

(function () {
  try {
    // Skip non-article namespaces (Special:, Talk:, File:, Help:, etc.).
    const path = location.pathname;
    const match = path.match(/^\/wiki\/([^#?]+)/);
    if (!match) return;
    const slug = decodeURIComponent(match[1]);
    if (slug.includes(':')) {
      // Article titles can legitimately contain colons (e.g. "Saint: something"),
      // but MediaWiki namespaces are a known small set. Check against them.
      const ns = slug.split(':')[0];
      const KNOWN_NS = new Set([
        'Special', 'Talk', 'User', 'User_talk', 'Wikipedia', 'Wikipedia_talk',
        'File', 'File_talk', 'MediaWiki', 'MediaWiki_talk', 'Template', 'Template_talk',
        'Help', 'Help_talk', 'Category', 'Category_talk', 'Portal', 'Portal_talk',
        'Draft', 'Draft_talk', 'Module', 'Module_talk', 'Book', 'Book_talk',
        'TimedText', 'TimedText_talk'
      ]);
      if (KNOWN_NS.has(ns)) return;
    }

    const heading = document.querySelector('#firstHeading');
    if (!heading) return;
    const title = (heading.textContent || '').trim();
    if (!title) return;

    const parser = document.querySelector('#mw-content-text .mw-parser-output');
    let summary = '';
    if (parser) {
      const ps = parser.querySelectorAll(':scope > p');
      for (const p of ps) {
        if (p.classList.contains('mw-empty-elt')) continue;
        const txt = (p.textContent || '').trim();
        if (txt.length >= 40) { summary = txt; break; }
      }
    }
    if (summary.length > 800) summary = summary.slice(0, 800) + '…';

    const catNodes = document.querySelectorAll('#mw-normal-catlinks ul li a');
    const categories = Array.from(catNodes).map((a) => (a.textContent || '').trim()).filter(Boolean);

    chrome.runtime.sendMessage({
      type: 'ARTICLE_VISIT',
      payload: {
        title,
        url: location.href,
        summary,
        categories
      }
    }, () => {
      if (chrome.runtime.lastError) {
        // Worker not ready yet, or extension reloaded. Swallow.
      }
    });
  } catch (err) {
    console.warn('[wikimind] content script error', err);
  }
})();
