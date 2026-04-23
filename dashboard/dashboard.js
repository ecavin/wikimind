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

  // State
  let articles = {};               // title -> article record
  let nodes = [];                  // d3 nodes (copies of article records)
  let links = [];                  // {source, target}
  let simulation = null;
  let colorMode = 'category';      // 'category' | 'cluster'
  let clusterMap = null;           // title -> clusterName
  let clusterColors = null;
  let categoryColors = null;
  let dateRange = { from: null, to: null };

  const rootG = svg.append('g').attr('class', 'root');
  const linkLayer = rootG.append('g').attr('class', 'links');
  const nodeLayer = rootG.append('g').attr('class', 'nodes');
  const labelLayer = rootG.append('g').attr('class', 'labels');

  const zoom = d3.zoom()
    .scaleExtent([0.2, 6])
    .on('zoom', (event) => rootG.attr('transform', event.transform));
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

  async function loadData() {
    articles = await getArticles();
    const list = Object.values(articles);
    buildGraph(list);
    renderList(list);

    emptyState.classList.toggle('hidden', list.length > 0);
    if (list.length >= 50) {
      document.getElementById('large-count').textContent = list.length;
      largeWarning.classList.remove('hidden');
    } else {
      largeWarning.classList.add('hidden');
    }
  }

  function buildGraph(list) {
    // Build nodes + dedup edges.
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

    // Color scales.
    const categories = Array.from(new Set(nodes.map((n) => n.categories[0] || 'Uncategorized')));
    categoryColors = d3.scaleOrdinal(d3.schemeTableau10).domain(categories);

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

  function render() {
    sizeSvg();

    // Visit-count threshold for always-on labels (top 20% or visitCount >= 3).
    const counts = nodes.map((n) => n.visitCount).sort((a, b) => b - a);
    const labelThreshold = counts[Math.floor(counts.length * 0.2)] || 3;

    const linkSel = linkLayer.selectAll('line').data(links, (d) => `${d.source.id || d.source}-${d.target.id || d.target}`);
    linkSel.exit().remove();
    const linkEnter = linkSel.enter().append('line').attr('class', 'link').attr('stroke-width', 1);
    const allLinks = linkEnter.merge(linkSel);

    const nodeSel = nodeLayer.selectAll('circle').data(nodes, (d) => d.id);
    nodeSel.exit().remove();
    const nodeEnter = nodeSel.enter().append('circle').attr('class', 'node');
    const allNodes = nodeEnter.merge(nodeSel)
      .attr('r', radiusFor)
      .attr('fill', colorFor)
      .on('click', (event, d) => openInfo(d))
      .on('mouseenter', (event, d) => highlightNeighborhood(d))
      .on('mouseleave', () => clearHighlight())
      .call(d3.drag()
        .on('start', (event, d) => { if (!event.active) simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
        .on('drag', (event, d) => { d.fx = event.x; d.fy = event.y; })
        .on('end', (event, d) => { if (!event.active) simulation.alphaTarget(0); d.fx = null; d.fy = null; }));

    const labelSel = labelLayer.selectAll('text').data(nodes, (d) => d.id);
    labelSel.exit().remove();
    const labelEnter = labelSel.enter().append('text').attr('class', 'node-label');
    const allLabels = labelEnter.merge(labelSel)
      .text((d) => d.title)
      .attr('dx', 8)
      .attr('dy', 4)
      .attr('opacity', (d) => d.visitCount >= labelThreshold ? 1 : 0);

    // Apply date-range dim.
    allNodes.classed('dim', (d) => !inDateRange(d));
    allLabels.classed('dim', (d) => !inDateRange(d));

    if (simulation) simulation.stop();

    const r = graphContainer.getBoundingClientRect();
    simulation = d3.forceSimulation(nodes)
      .force('link', d3.forceLink(links).id((d) => d.id).distance(80).strength(0.4))
      .force('charge', d3.forceManyBody().strength(-260))
      .force('center', d3.forceCenter(r.width / 2, r.height / 2))
      .force('collide', d3.forceCollide().radius((d) => radiusFor(d) + 4));

    if (colorMode === 'cluster' && clusterMap) {
      const clusterCenters = computeClusterCenters(r.width, r.height);
      simulation
        .force('clusterX', d3.forceX((d) => (clusterCenters[clusterMap[d.id]] || {}).x || r.width / 2).strength(0.05))
        .force('clusterY', d3.forceY((d) => (clusterCenters[clusterMap[d.id]] || {}).y || r.height / 2).strength(0.05));
    }

    simulation.on('tick', () => {
      allLinks
        .attr('x1', (d) => d.source.x)
        .attr('y1', (d) => d.source.y)
        .attr('x2', (d) => d.target.x)
        .attr('y2', (d) => d.target.y);
      allNodes.attr('cx', (d) => d.x).attr('cy', (d) => d.y);
      allLabels.attr('x', (d) => d.x).attr('y', (d) => d.y);
    });

    // Hover-only labels: show on mouseenter, restore on mouseleave.
    allNodes.on('mouseover.label', (event, d) => {
      labelLayer.selectAll('text').filter((x) => x.id === d.id).attr('opacity', 1);
    });
    allNodes.on('mouseout.label', (event, d) => {
      labelLayer.selectAll('text').filter((x) => x.id === d.id)
        .attr('opacity', d.visitCount >= labelThreshold ? 1 : 0);
    });
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
    nodeLayer.selectAll('circle').classed('dim', (x) => !neighborIds.has(x.id));
    nodeLayer.selectAll('circle').classed('highlight', (x) => x.id === d.id);
    labelLayer.selectAll('text').classed('dim', (x) => !neighborIds.has(x.id));
    linkLayer.selectAll('line')
      .classed('highlight', (l) => (l.source.id === d.id) || (l.target.id === d.id))
      .classed('dim', (l) => !(l.source.id === d.id || l.target.id === d.id));
  }

  function clearHighlight() {
    nodeLayer.selectAll('circle').classed('highlight', false).classed('dim', (d) => !inDateRange(d));
    labelLayer.selectAll('text').classed('dim', (d) => !inDateRange(d));
    linkLayer.selectAll('line').classed('highlight', false).classed('dim', false);
  }

  function openInfo(d) {
    infoPanel.classList.remove('hidden');
    document.getElementById('info-title').textContent = d.title;
    document.getElementById('info-summary').textContent = d.summary || '(No summary captured.)';
    document.getElementById('info-visits').textContent = d.visitCount;
    document.getElementById('info-first').textContent = new Date(d.firstVisited).toLocaleString();
    document.getElementById('info-last').textContent = new Date(d.lastVisited).toLocaleString();
    const open = document.getElementById('info-open');
    open.href = d.url;

    const chipsEl = document.getElementById('info-links');
    chipsEl.innerHTML = '';
    const neighbors = d.links.filter((t) => articles[t]);
    if (neighbors.length === 0) {
      chipsEl.innerHTML = '<span style="color: var(--muted); font-size:12px;">No connections yet. Try "Fetch Links".</span>';
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

  function focusNode(title) {
    const n = nodes.find((x) => x.id === title);
    if (!n) return;
    openInfo(n);
    const r = graphContainer.getBoundingClientRect();
    const scale = 2;
    const tx = r.width / 2 - n.x * scale;
    const ty = r.height / 2 - n.y * scale;
    svg.transition().duration(700)
      .call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
    // Briefly highlight.
    nodeLayer.selectAll('circle').classed('highlight', (x) => x.id === title);
    setTimeout(() => nodeLayer.selectAll('circle').classed('highlight', false), 1400);
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
      tdVisits.textContent = a.visitCount;
      const tdLast = document.createElement('td');
      tdLast.textContent = new Date(a.lastVisited).toLocaleString();
      const tdCats = document.createElement('td');
      tdCats.textContent = (a.categories || []).slice(0, 3).join(', ');
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

  function applyDateFilter() {
    const fromStr = document.getElementById('date-from').value;
    const toStr = document.getElementById('date-to').value;
    dateRange.from = fromStr ? new Date(fromStr).getTime() : null;
    dateRange.to = toStr ? new Date(toStr + 'T23:59:59').getTime() : null;
    nodeLayer.selectAll('circle').classed('dim', (d) => !inDateRange(d));
    labelLayer.selectAll('text').classed('dim', (d) => !inDateRange(d));
  }
  document.getElementById('date-from').addEventListener('change', applyDateFilter);
  document.getElementById('date-to').addEventListener('change', applyDateFilter);

  document.getElementById('btn-fetch-links').addEventListener('click', () => {
    const btn = document.getElementById('btn-fetch-links');
    btn.disabled = true;
    btn.textContent = 'Fetching…';
    const port = chrome.runtime.connect({ name: 'refetch-all-links' });
    port.onMessage.addListener((msg) => {
      if (msg.type === 'PROGRESS') btn.textContent = `Fetching ${msg.done}/${msg.total}…`;
      if (msg.type === 'DONE') {
        btn.textContent = 'Fetch Links';
        btn.disabled = false;
        loadData();
      }
      if (msg.type === 'ERROR') {
        btn.textContent = 'Fetch Links';
        btn.disabled = false;
        alert('Error: ' + msg.error);
      }
    });
  });

  document.getElementById('btn-toggle-view').addEventListener('click', () => {
    const showingList = !listView.classList.contains('hidden');
    if (showingList) {
      listView.classList.add('hidden');
      document.getElementById('graph-container').classList.remove('hidden');
      infoPanel.classList.add('hidden');
      document.getElementById('btn-toggle-view').textContent = 'List View';
    } else {
      listView.classList.remove('hidden');
      document.getElementById('graph-container').classList.add('hidden');
      infoPanel.classList.add('hidden');
      document.getElementById('btn-toggle-view').textContent = 'Graph View';
    }
  });

  document.getElementById('info-close').addEventListener('click', () => infoPanel.classList.add('hidden'));

  document.getElementById('btn-dismiss-warning').addEventListener('click', () => largeWarning.classList.add('hidden'));
  document.getElementById('btn-filter-30').addEventListener('click', () => {
    const now = new Date();
    const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    document.getElementById('date-from').value = from.toISOString().slice(0, 10);
    document.getElementById('date-to').value = now.toISOString().slice(0, 10);
    applyDateFilter();
    largeWarning.classList.add('hidden');
  });

  // --- Cluster mode ---

  document.getElementById('btn-cluster').addEventListener('click', async () => {
    const btn = document.getElementById('btn-cluster');
    if (colorMode === 'cluster') {
      colorMode = 'category';
      clusterMap = null;
      btn.classList.remove('active');
      legendEl.classList.add('hidden');
      render();
      return;
    }
    const settings = await getSettings();
    if (!settings.apiKey) { alert('Set your Gemini API key in Settings first.'); return; }
    const list = Object.values(articles);
    if (list.length === 0) return;
    btn.disabled = true;
    btn.textContent = 'Clustering…';
    try {
      const clusters = await clusterArticles(list, settings.apiKey);
      clusterMap = {};
      for (const c of clusters) {
        for (const t of c.articles) clusterMap[t] = c.clusterName;
      }
      // Fill in any unmapped articles.
      for (const a of list) if (!clusterMap[a.title]) clusterMap[a.title] = 'Unclustered';
      const names = Array.from(new Set(Object.values(clusterMap)));
      clusterColors = d3.scaleOrdinal(d3.schemeSet3.concat(d3.schemeTableau10)).domain(names);
      colorMode = 'cluster';
      btn.classList.add('active');
      renderLegend(names);
      render();
    } catch (err) {
      alert('Clustering failed: ' + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Cluster';
    }
  });

  function renderLegend(names) {
    legendEl.innerHTML = '<h3>Clusters</h3>' + names.map((n) => {
      const color = clusterColors(n);
      return `<div class="legend-item"><span class="legend-swatch" style="background:${color}"></span>${escapeHtml(n)}</div>`;
    }).join('');
    legendEl.classList.remove('hidden');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // --- Recommendations modal ---

  document.getElementById('btn-recommend').addEventListener('click', async () => {
    const settings = await getSettings();
    if (!settings.apiKey) { alert('Set your Gemini API key in Settings first.'); return; }
    const list = Object.values(articles);
    if (list.length < 2) { alert('Read a few articles first.'); return; }

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
