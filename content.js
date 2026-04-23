// content.js — runs on en.wikipedia.org/wiki/* at document_idle.
// Extracts the current article's metadata and sends one ARTICLE_VISIT message.

(async function () {
  const KNOWN_NS = new Set([
    'Special', 'Talk', 'User', 'User_talk', 'Wikipedia', 'Wikipedia_talk',
    'File', 'File_talk', 'MediaWiki', 'MediaWiki_talk', 'Template', 'Template_talk',
    'Help', 'Help_talk', 'Category', 'Category_talk', 'Portal', 'Portal_talk',
    'Draft', 'Draft_talk', 'Module', 'Module_talk', 'Book', 'Book_talk',
    'TimedText', 'TimedText_talk'
  ]);

  async function sendWithRetry(message, retries = 3, delayMs = 150) {
    for (let i = 0; i < retries; i++) {
      const ok = await new Promise((resolve) => {
        chrome.runtime.sendMessage(message, () => {
          resolve(!chrome.runtime.lastError);
        });
      });
      if (ok) return;
      if (i < retries - 1) await new Promise((r) => setTimeout(r, delayMs));
    }
    console.warn('[wikimind] failed to deliver ARTICLE_VISIT after retries');
  }

  try {
    // Skip non-article namespaces (Special:, Talk:, File:, Help:, etc.).
    const path = location.pathname;
    const match = path.match(/^\/wiki\/([^#?]+)/);
    if (!match) return;
    const slug = decodeURIComponent(match[1]);
    if (slug.includes(':') && KNOWN_NS.has(slug.split(':')[0])) return;

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

    // Detect which article the user navigated from.
    let navigatedFrom = null;
    try {
      if (document.referrer) {
        const refUrl = new URL(document.referrer);
        if (refUrl.hostname.endsWith('.wikipedia.org')) {
          const rm = refUrl.pathname.match(/^\/wiki\/([^#?]+)/);
          if (rm) {
            const refSlug = decodeURIComponent(rm[1]);
            if (!KNOWN_NS.has(refSlug.split(':')[0])) {
              navigatedFrom = refSlug.replace(/_/g, ' ');
            }
          }
        }
      }
    } catch (_) {}

    await sendWithRetry({
      type: 'ARTICLE_VISIT',
      payload: { title, url: location.href, summary, categories, navigatedFrom }
    });
  } catch (err) {
    console.warn('[wikimind] content script error', err);
  }
})();
