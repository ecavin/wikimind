# WikiMind

A Manifest V3 Chrome extension that tracks your Wikipedia reading, visualizes article connections as an interactive D3 graph, and uses **Google Gemini 3 Flash** for recommendations, gap analysis, and semantic clustering.

Everything runs locally. The only network calls are:
- `en.wikipedia.org` — public REST + Action API, no key.
- `generativelanguage.googleapis.com` — only when you click **Recommend** or **Cluster**, using the key you paste into Settings.

## How to install

1. Clone or download this folder.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select this folder (the one containing `manifest.json`).
5. Pin the WikiMind toolbar icon if you want quick access.
6. Open **Settings** (via the popup's "Settings" link, or right-click the icon → Options) and paste your Gemini API key. Get one at https://aistudio.google.com/app/apikey.

That's it — browse Wikipedia and articles will start tracking automatically.

## How to use

- **Popup** (click the toolbar icon): total article / connection counts, recent list, button to open the Dashboard.
- **Dashboard** (button in the popup): full-page graph. Nodes are visited articles; edges are Wikipedia hyperlinks between them. Click a node for details, hover to highlight its neighbors, drag to rearrange, zoom/pan with scroll.
  - **Search** — jumps to a node by title prefix.
  - **Date filter** — dims nodes outside the range.
  - **List View** — sortable table.
  - **Fetch Links** — rebuilds all edges from scratch using the Wikipedia Action API. Use this after importing or when you think edges are stale.
  - **Cluster** — asks Gemini to group your articles thematically and recolors the graph accordingly; a legend appears in the top-right.
  - **Recommend** — asks Gemini for 8 articles you haven't read, plus a Gap Analysis of topics you've been circling around.
- **Settings**: API key, auto-fetch toggle, notifications toggle, Export / Clear, and stats (total articles, connections, most visited, most common category, reading streak).

## Data model

Storage is a flat map keyed by article title:

```json
{
  "articles": {
    "Quantum mechanics": {
      "title": "Quantum mechanics",
      "url": "https://en.wikipedia.org/wiki/Quantum_mechanics",
      "summary": "Quantum mechanics is a fundamental theory...",
      "categories": ["Physics", "Quantum theory"],
      "firstVisited": 1700000000000,
      "lastVisited": 1700000500000,
      "visitCount": 3,
      "links": ["Wave function", "Schrödinger equation"]
    }
  },
  "settings": {
    "apiKey": "AIza...",
    "autoFetchLinks": true,
    "showNotifications": false
  }
}
```

The `links` array contains only titles that also appear in your history. No raw Wikipedia link lists are persisted.

## Notes and limitations

- **Model**: uses `gemini-3-flash-preview`. When the stable `gemini-3-flash` model rolls out, change the constant at the top of `lib/llm.js`.
- **D3 is vendored** in `dashboard/vendor/d3.min.js`. MV3 disallows remote code in extension pages, so we can't load D3 from a CDN.
- **Back-edges**: when you visit a new article, we fetch its outbound links. Articles you visited in the past won't automatically know about the new one — click **Fetch Links** to do a full sweep (throttled to ~4 requests/second to stay polite to Wikipedia).
- **LLM costs**: Recommendation, Gap Analysis, and Cluster calls only fire on explicit button clicks. Article summaries are truncated to 150 characters before being sent to keep tokens low. Clustering batches at 60 articles per call for libraries over 80.
- **Namespaces**: tracking skips Special:, Talk:, File:, Category:, etc. Only `/wiki/<Article>` pages in the article namespace are logged.
- **Icon**: `icons/icon128.png` is a generated placeholder — replace with your own if you like.

## Debugging

- Service worker logs: `chrome://extensions` → WikiMind → **Inspect views: service worker**.
- Content script logs: open DevTools on any Wikipedia tab.
- Dashboard / popup / settings logs: DevTools on the respective page.
