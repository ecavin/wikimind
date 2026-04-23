// dashboard/dashboard.js — D3 force graph, list view, cluster + recommendation UI.

(async function () {
  const { getArticles, getSettings } = window.WikimindStorage;
  const { fetchSummary } = window.WikimindWikipedia;
  const { getRecommendations, getGapAnalysis, clusterArticles } = window.WikimindLLM;

  const svg = d3.select('#graph');
  const graphContainer = document.getElementById('graph-container');
  const emptyState = document.getElementById('empty-state');
  const largeWarning = document.getElementById('large-warning');
  const legendEl = document.getElementById('cluster-legend');
  const listView = document.getElementById('list-view');
  const infoPanel = document.getElementById('info-panel');
  const hud = document.getElementById('graph-hud');
  const zoomControls = document.getElementById('zoom-controls');
  const toastHost = document.getElementById('toast-host');

  // State
  let articles = {};
  let nodes = [];
  let links = [];
  let simulation = null;
  let colorMode = 'category';
  let clusterMap = null;
  let clusterColors = null;
  let categoryColors = null;
  let dateRange = { from: null, to: null };
  let selectedId = null;
  let currentTransform = d3.zoomIdentity;

  // --- SVG defs (gradients, filters) ---
  const defs = svg.append('defs');
  defs.html(`
    <linearGradient id="link-grad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#a78bfa" stop-opacity="0.8"/>
      <stop offset="100%" stop-color="#f472b6" stop-opacity="0.8"/>
    </linearGradient>
    <radialGradient id="node-sheen" cx="35%" cy="30%" r="70%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.35"/>
      <stop offset="60%" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
  `);

  const rootG = svg.append('g').attr('class', 'root');
  const linkLayer = rootG.append('g').attr('class', 'links');
  const nodeLayer = rootG.append('g').attr('class', 'nodes');
  const labelLayer = rootG.append('g').attr('class', 'labels');

  const zoom = d3.zoom()
    .scaleExtent([0.2, 6])
    .on('zoom', (event) => {
      rootG.attr('transform', event.transform);
      currentTransform = event.transform;
      const z = document.getElementById('hud-zoom');
      if (z) z.textContent = Math.round(event.transform.k * 100) + '%';
    });
  svg.call(zoom);

  function sizeSvg() {
    const r = graphContainer.getBoundingClientRect();
    svg.attr('width', r.width).attr('height', r.height);
    if (simulation) {
      simulation.force('center', d3.forceCenter(r.width / 2, r.height / 2));
      simulation.alpha(0.3).restart();
    }
  }
  window.addEventListener('resize', sizeSvg);

  // --- Toasts ---
  function toast(msg, variant = '') {
    const el = document.createElement('div');
    el.className = 'toast-msg ' + variant;
    el.textContent = msg;
    toastHost.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .25s, transform .25s';
      el.style.opacity = '0';
      el.style.transform = 'translateY(6px)';
      setTimeout(() => el.remove(), 300);
    }, 3200);
  }

  async function loadData() {
    articles = await getArticles();
    const list = Object.values(articles);
    buildGraph(list);
    renderList(list);

    emptyState.classList.toggle('hidden', list.length > 0);
    hud.classList.toggle('hidden', list.length === 0);
    zoomControls.classList.toggle('hidden', list.length === 0);

    if (list.length >= 50) {
      document.getElementById('large-count').textContent = list.length;
      largeWarning.classList.remove('hidden');
    } else {
      largeWarning.classList.add('hidden');
    }

    document.getElementById('list-count').textContent = `${list.length} article${list.length === 1 ? '' : 's'}`;
    updateHud();
  }

  function updateHud() {
    document.getElementById('hud-nodes').textContent = nodes.length;
    document.getElementById('hud-edges').textContent = links.length;
  }

  function buildGraph(list) {
    nodes = list.map((a) => ({
      id: a.title,
      title: a.title,
      url: a.url,
      summary: a.summary,
      categories: a.categories || [],
      visitCount: a.visitCount || 1,
      firstVisited: a.firstVisited,
      lastVisited: a.lastVisited,
      links: a.links || []
    }));

    const present = new Set(nodes.map((n) => n.id));
    const edgeSet = new Set();
    links = [];
    for (const n of nodes) {
      for (const other of n.links) {
        if (!present.has(other) || other === n.id) continue;
        const key = [n.id, other].sort().join('\u0001');
        if (edgeSet.has(key)) continue;
        edgeSet.add(key);
        links.push({ source: n.id, target: other });
      }
    }

    const palette = [
      '#a78bfa', '#f472b6', '#5eead4', '#fbbf24', '#60a5fa',
      '#f87171', '#c084fc', '#34d399', '#fb923c', '#818cf8',
      '#e879f9', '#22d3ee'
    ];
    const categories = Array.from(new Set(nodes.map((n) => n.categories[0] || 'Uncategorized')));
    categoryColors = d3.scaleOrdinal(palette).domain(categories);

    render();
  }

  function radiusFor(n) { return 4 + Math.sqrt(n.visitCount) * 3; }

  function colorFor(n) {
    if (colorMode === 'cluster' && clusterMap && clusterColors) {
      const c = clusterMap[n.id] || 'Unclustered';
      return clusterColors(c);
    }
    return categoryColors(n.categories[0] || 'Uncategorized');
  }

  function inDateRange(n) {
    if (!dateRange.from && !dateRange.to) return true;
    const t = n.lastVisited;
    if (dateRange.from && t < dateRange.from) return false;
    if (dateRange.to && t > dateRange.to) return false;
    return true;
  }

  function degreeOf(id) {
    let d = 0;
    for (const l of links) {
      const sId = l.source.id || l.source;
      const tId = l.target.id || l.target;
      if (sId === id || tId === id) d++;
    }
    return d;
  }

  function render() {
    sizeSvg();

    const counts = nodes.map((n) => n.visitCount).sort((a, b) => b - a);
    const labelThreshold = counts[Math.floor(counts.length * 0.2)] || 3;

    // Links
    const linkSel = linkLayer.selectAll('line').data(
      links,
      (d) => `${d.source.id || d.source}-${d.target.id || d.target}`
    );
    linkSel.exit().remove();
    const linkEnter = linkSel.enter().append('line').attr('class', 'link').attr('stroke-width', 1);
    const allLinks = linkEnter.merge(linkSel);

    // Node groups (halo + circle)
    const nodeSel = nodeLayer.selectAll('g.node').data(nodes, (d) => d.id);
    nodeSel.exit().remove();
    const nodeEnter = nodeSel.enter().append('g').attr('class', 'node');
    nodeEnter.append('circle').attr('class', 'node-halo');
    nodeEnter.append('circle').attr('class', 'node-core');

    const allNodes = nodeEnter.merge(nodeSel);
    allNodes
      .attr('color', colorFor)
      .style('color', colorFor)
      .on('click', (event, d) => { event.stopPropagation(); selectNode(d); })
      .on('mouseenter', (event, d) => highlightNeighborhood(d))
      .on('mouseleave', () => clearHighlight())
      .call(d3.drag()
        .on('start', (event, d) => { if (!event.active) simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
        .on('drag', (event, d) => { d.fx = event.x; d.fy = event.y; })
        .on('end', (event, d) => { if (!event.active) simulation.alphaTarget(0); d.fx = null; d.fy = null; }));

    allNodes.select('circle.node-core')
      .attr('r', radiusFor)
      .attr('fill', colorFor)
      .attr('stroke', 'rgba(7, 6, 14, 0.85)')
      .attr('stroke-width', 1.5);

    allNodes.select('circle.node-halo')
      .attr('r', (d) => radiusFor(d) + 5);

    // Labels
    const labelSel = labelLayer.selectAll('text').data(nodes, (d) => d.id);
    labelSel.exit().remove();
    const labelEnter = labelSel.enter().append('text').attr('class', 'node-label');
    const allLabels = labelEnter.merge(labelSel)
      .text((d) => d.title)
      .attr('dx', 10)
      .attr('dy', 4)
      .attr('opacity', (d) => d.visitCount >= labelThreshold ? 1 : 0);

    // Apply date-range dim.
    allNodes.classed('dim', (d) => !inDateRange(d));
    allLabels.classed('dim', (d) => !inDateRange(d));

    if (simulation) simulation.stop();

    const r = graphContainer.getBoundingClientRect();
    simulation = d3.forceSimulation(nodes)
      .force('link', d3.forceLink(links).id((d) => d.id).distance(85).strength(0.45))
      .force('charge', d3.forceManyBody().strength(-280))
      .force('center', d3.forceCenter(r.width / 2, r.height / 2))
      .force('collide', d3.forceCollide().radius((d) => radiusFor(d) + 5));

    if (colorMode === 'cluster' && clusterMap) {
      const clusterCenters = computeClusterCenters(r.width, r.height);
      simulation
        .force('clusterX', d3.forceX((d) => (clusterCenters[clusterMap[d.id]] || {}).x || r.width / 2).strength(0.06))
        .force('clusterY', d3.forceY((d) => (clusterCenters[clusterMap[d.id]] || {}).y || r.height / 2).strength(0.06));
    }

    simulation.on('tick', () => {
      allLinks
        .attr('x1', (d) => d.source.x)
        .attr('y1', (d) => d.source.y)
        .attr('x2', (d) => d.target.x)
        .attr('y2', (d) => d.target.y);
      allNodes.attr('transform', (d) => `translate(${d.x}, ${d.y})`);
      allLabels.attr('x', (d) => d.x).attr('y', (d) => d.y);
    });

    allNodes.on('mouseover.label', (event, d) => {
      labelLayer.selectAll('text').filter((x) => x.id === d.id).attr('opacity', 1);
    });
    allNodes.on('mouseout.label', (event, d) => {
      labelLayer.selectAll('text').filter((x) => x.id === d.id)
        .attr('opacity', d.visitCount >= labelThreshold ? 1 : 0);
    });

    updateHud();
  }

  function computeClusterCenters(width, height) {
    const names = Array.from(new Set(Object.values(clusterMap)));
    const out = {};
    const n = names.length;
    const cx = width / 2, cy = height / 2;
    const radius = Math.min(width, height) * 0.3;
    names.forEach((name, i) => {
      const angle = (i / n) * 2 * Math.PI;
      out[name] = { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) };
    });
    return out;
  }

  function highlightNeighborhood(d) {
    const neighborIds = new Set([d.id]);
    for (const l of links) {
      const sId = l.source.id || l.source;
      const tId = l.target.id || l.target;
      if (sId === d.id) neighborIds.add(tId);
      if (tId === d.id) neighborIds.add(sId);
    }
    nodeLayer.selectAll('g.node')
      .classed('dim', (x) => !neighborIds.has(x.id))
      .classed('highlight', (x) => x.id === d.id);
    labelLayer.selectAll('text').classed('dim', (x) => !neighborIds.has(x.id));
    linkLayer.selectAll('line')
      .classed('highlight', (l) => (l.source.id === d.id) || (l.target.id === d.id))
      .classed('dim', (l) => !(l.source.id === d.id || l.target.id === d.id));
  }

  function clearHighlight() {
    nodeLayer.selectAll('g.node')
      .classed('highlight', false)
      .classed('dim', (d) => !inDateRange(d));
    labelLayer.selectAll('text').classed('dim', (d) => !inDateRange(d));
    linkLayer.selectAll('line').classed('highlight', false).classed('dim', false);
  }

  function selectNode(d) {
    selectedId = d.id;
    nodeLayer.selectAll('g.node').classed('selected', (x) => x.id === d.id);
    openInfo(d);
  }

  function openInfo(d) {
    infoPanel.classList.remove('hidden');
    document.getElementById('info-title').textContent = d.title;
    document.getElementById('info-summary').textContent = d.summary || '(No summary captured.)';
    document.getElementById('info-visits').textContent = d.visitCount;
    document.getElementById('info-age').textContent = formatRelative(d.firstVisited);
    document.getElementById('info-degree').textContent = degreeOf(d.id);

    const badge = document.getElementById('info-badge');
    const firstCat = (d.categories || [])[0];
    badge.textContent = firstCat || 'Article';

    document.getElementById('info-open').href = d.url;

    const chipsEl = document.getElementById('info-links');
    chipsEl.innerHTML = '';
    const neighbors = d.links.filter((t) => articles[t]);
    if (neighbors.length === 0) {
      chipsEl.innerHTML = '<span style="color: var(--muted); font-size:12px;">No connections yet. Try Refresh.</span>';
    } else {
      for (const t of neighbors) {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.textContent = t;
        chip.addEventListener('click', () => focusNode(t));
        chipsEl.appendChild(chip);
      }
    }
  }

  function formatRelative(ts) {
    if (!ts) return '—';
    const diff = Date.now() - ts;
    const days = Math.floor(diff / 86400000);
    if (days < 1) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 7) return `${days}d ago`;
    if (days < 30) return `${Math.floor(days / 7)}w ago`;
    if (days < 365) return `${Math.floor(days / 30)}mo ago`;
    return `${Math.floor(days / 365)}y ago`;
  }

  function focusNode(title) {
    const n = nodes.find((x) => x.id === title);
    if (!n) return;
    selectNode(n);
    const r = graphContainer.getBoundingClientRect();
    const scale = 2;
    const tx = r.width / 2 - n.x * scale;
    const ty = r.height / 2 - n.y * scale;
    svg.transition().duration(700)
      .call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
  }

  function renderList(list) {
    const body = document.getElementById('list-body');
    body.innerHTML = '';
    const sorted = [...list].sort((a, b) => b.lastVisited - a.lastVisited);
    for (const a of sorted) {
      const tr = document.createElement('tr');
      const tdTitle = document.createElement('td');
      const link = document.createElement('a');
      link.href = a.url;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = a.title;
      tdTitle.appendChild(link);

      const tdVisits = document.createElement('td');
      tdVisits.className = 'num';
      tdVisits.textContent = a.visitCount;

      const tdLast = document.createElement('td');
      tdLast.textContent = new Date(a.lastVisited).toLocaleString();

      const tdCats = document.createElement('td');
      (a.categories || []).slice(0, 3).forEach((c) => {
        const chip = document.createElement('span');
        chip.className = 'cat-chip';
        chip.textContent = c;
        tdCats.appendChild(chip);
      });

      tr.appendChild(tdTitle);
      tr.appendChild(tdVisits);
      tr.appendChild(tdLast);
      tr.appendChild(tdCats);
      body.appendChild(tr);
    }
  }

  // --- Top-bar wiring ---

  document.getElementById('search').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    if (!q) return;
    const hit = nodes.find((n) => n.title.toLowerCase().startsWith(q))
      || nodes.find((n) => n.title.toLowerCase().includes(q));
    if (hit) focusNode(hit.id);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
      e.preventDefault();
      document.getElementById('search').focus();
    }
    if (e.key === 'Escape') {
      document.getElementById('recommend-modal').classList.add('hidden');
      infoPanel.classList.add('hidden');
      nodeLayer.selectAll('g.node').classed('selected', false);
      selectedId = null;
    }
  });

  function applyDateFilter() {
    const fromStr = document.getElementById('date-from').value;
    const toStr = document.getElementById('date-to').value;
    dateRange.from = fromStr ? new Date(fromStr).getTime() : null;
    dateRange.to = toStr ? new Date(toStr + 'T23:59:59').getTime() : null;
    nodeLayer.selectAll('g.node').classed('dim', (d) => !inDateRange(d));
    labelLayer.selectAll('text').classed('dim', (d) => !inDateRange(d));
  }
  document.getElementById('date-from').addEventListener('change', applyDateFilter);
  document.getElementById('date-to').addEventListener('change', applyDateFilter);

  document.getElementById('btn-fetch-links').addEventListener('click', () => {
    const btn = document.getElementById('btn-fetch-links');
    const label = btn.querySelector('span');
    const originalLabel = label.textContent;
    btn.disabled = true;
    label.textContent = 'Fetching…';
    const port = chrome.runtime.connect({ name: 'refetch-all-links' });
    port.onMessage.addListener((msg) => {
      if (msg.type === 'PROGRESS') label.textContent = `${msg.done}/${msg.total}`;
      if (msg.type === 'DONE') {
        label.textContent = originalLabel;
        btn.disabled = false;
        loadData();
        toast(`Refreshed ${msg.total || 'all'} articles`, 'success');
      }
      if (msg.type === 'ERROR') {
        label.textContent = originalLabel;
        btn.disabled = false;
        toast('Error: ' + msg.error, 'error');
      }
    });
  });

  document.getElementById('btn-toggle-view').addEventListener('click', () => {
    const btn = document.getElementById('btn-toggle-view');
    const label = btn.querySelector('span');
    const showingList = !listView.classList.contains('hidden');
    if (showingList) {
      listView.classList.add('hidden');
      document.getElementById('graph-container').classList.remove('hidden');
      infoPanel.classList.add('hidden');
      label.textContent = 'List';
      btn.classList.remove('active');
    } else {
      listView.classList.remove('hidden');
      document.getElementById('graph-container').classList.add('hidden');
      infoPanel.classList.add('hidden');
      label.textContent = 'Graph';
      btn.classList.add('active');
    }
  });

  document.getElementById('info-close').addEventListener('click', () => {
    infoPanel.classList.add('hidden');
    nodeLayer.selectAll('g.node').classed('selected', false);
    selectedId = null;
  });

  document.getElementById('btn-dismiss-warning').addEventListener('click', () => largeWarning.classList.add('hidden'));
  document.getElementById('btn-filter-30').addEventListener('click', () => {
    const now = new Date();
    const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    document.getElementById('date-from').value = from.toISOString().slice(0, 10);
    document.getElementById('date-to').value = now.toISOString().slice(0, 10);
    applyDateFilter();
    largeWarning.classList.add('hidden');
  });

  // --- Zoom controls ---
  document.getElementById('zoom-in').addEventListener('click', () => {
    svg.transition().duration(250).call(zoom.scaleBy, 1.4);
  });
  document.getElementById('zoom-out').addEventListener('click', () => {
    svg.transition().duration(250).call(zoom.scaleBy, 0.7);
  });
  document.getElementById('zoom-reset').addEventListener('click', () => {
    svg.transition().duration(400).call(zoom.transform, d3.zoomIdentity);
  });

  // --- Cluster mode ---

  document.getElementById('btn-cluster').addEventListener('click', async () => {
    const btn = document.getElementById('btn-cluster');
    const label = btn.querySelector('span');
    if (colorMode === 'cluster') {
      colorMode = 'category';
      clusterMap = null;
      btn.classList.remove('active');
      legendEl.classList.add('hidden');
      render();
      return;
    }
    const settings = await getSettings();
    if (!settings.apiKey) { toast('Set your Gemini API key in Settings first.', 'error'); return; }
    const list = Object.values(articles);
    if (list.length === 0) return;
    btn.disabled = true;
    label.textContent = 'Clustering…';
    try {
      const clusters = await clusterArticles(list, settings.apiKey);
      clusterMap = {};
      for (const c of clusters) {
        for (const t of c.articles) clusterMap[t] = c.clusterName;
      }
      for (const a of list) if (!clusterMap[a.title]) clusterMap[a.title] = 'Unclustered';
      const names = Array.from(new Set(Object.values(clusterMap)));
      const richPalette = [
        '#a78bfa', '#f472b6', '#5eead4', '#fbbf24', '#60a5fa',
        '#f87171', '#c084fc', '#34d399', '#fb923c', '#818cf8',
        '#e879f9', '#22d3ee', '#fde047', '#4ade80'
      ];
      clusterColors = d3.scaleOrdinal(richPalette).domain(names);
      colorMode = 'cluster';
      btn.classList.add('active');
      renderLegend(names);
      render();
      toast(`Found ${names.length} clusters`, 'success');
    } catch (err) {
      toast('Clustering failed: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      label.textContent = 'Cluster';
    }
  });

  function renderLegend(names) {
    legendEl.innerHTML = '<h3>Clusters</h3>' + names.map((n) => {
      const color = clusterColors(n);
      return `<div class="legend-item" style="color:${color}"><span class="legend-swatch" style="background:${color}"></span><span style="color:var(--fg)">${escapeHtml(n)}</span></div>`;
    }).join('');
    legendEl.classList.remove('hidden');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // --- Recommendations modal ---

  document.getElementById('btn-recommend').addEventListener('click', async () => {
    const settings = await getSettings();
    if (!settings.apiKey) { toast('Set your Gemini API key in Settings first.', 'error'); return; }
    const list = Object.values(articles);
    if (list.length < 2) { toast('Read a few articles first.', 'error'); return; }

    const modal = document.getElementById('recommend-modal');
    const loading = document.getElementById('modal-loading');
    const recList = document.getElementById('rec-list');
    const gapList = document.getElementById('gap-list');
    modal.classList.remove('hidden');
    loading.classList.remove('hidden');
    recList.innerHTML = '';
    gapList.innerHTML = '';

    try {
      const [recs, gaps] = await Promise.all([
        getRecommendations(list, settings.apiKey),
        getGapAnalysis(list, settings.apiKey)
      ]);
      recList.innerHTML = '';
      for (const r of recs) recList.appendChild(renderRec(r));
      gapList.innerHTML = '';
      if (!gaps.length) gapList.innerHTML = '<div style="color: var(--muted); font-size: 13px;">No gaps identified.</div>';
      for (const g of gaps) {
        const div = document.createElement('div');
        div.className = 'gap-item';
        div.innerHTML = `<div class="topic">${escapeHtml(g.topic)}</div><div class="reason">${escapeHtml(g.reason)}</div>`;
        gapList.appendChild(div);
      }
    } catch (err) {
      recList.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
    } finally {
      loading.classList.add('hidden');
    }
  });

  function renderRec(rec) {
    const div = document.createElement('div');
    div.className = 'rec-item';
    const wikiUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(rec.title.replace(/ /g, '_'))}`;
    div.innerHTML = `
      <div class="title"><a href="${wikiUrl}" target="_blank" rel="noopener">${escapeHtml(rec.title)}</a></div>
      <div class="reason">${escapeHtml(rec.reason)}</div>
      <div class="actions"><button class="preview-btn">Preview</button></div>
    `;
    const previewBtn = div.querySelector('.preview-btn');
    previewBtn.addEventListener('click', async () => {
      previewBtn.disabled = true;
      previewBtn.textContent = 'Loading…';
      const s = await fetchSummary(rec.title);
      previewBtn.remove();
      const p = document.createElement('div');
      p.className = 'preview';
      p.textContent = s && s.extract ? s.extract : 'No preview available.';
      div.appendChild(p);
    });
    return div;
  }

  document.getElementById('modal-close').addEventListener('click', () => {
    document.getElementById('recommend-modal').classList.add('hidden');
  });
  document.querySelector('#recommend-modal .modal-backdrop').addEventListener('click', () => {
    document.getElementById('recommend-modal').classList.add('hidden');
  });

  // --- Init ---
  await loadData();
})();
