// dashboard/dashboard.js — D3 force graph, list view, cluster + recommendation UI.

(async function () {
  const { getArticles, getSettings, getNavEdges, updateStatus, addNavEdge,
          getClusterState, setClusterState } = window.WikimindStorage;
  const { fetchSummary } = window.WikimindWikipedia;
  const { getRecommendations, getGapAnalysis, clusterArticles,
          getTreeRecommendations, getTreeGapAnalysis, getTutorRecommendations } = window.WikimindLLM;

  const STATUS_COLORS = { understood: '#4ade80', learning: '#fbbf24', confused: '#f87171' };

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
  let baseLinks = [];          // links derived from article.links (Wikipedia-explicit)
  let aiEdges = [];            // AI-inferred edges (cluster mode only)
  let simulation = null;
  let colorMode = 'category';
  let clusterMap = null;
  let clusterColors = null;
  let categoryColors = null;
  let dateRange = { from: null, to: null };
  let selectedId = null;
  let currentTransform = d3.zoomIdentity;
  let currentView = 'graph';
  let treeRootTitle = null;
  let treeDepthVal = 99;
  let navChildrenMap = {}; // title → [child titles] from recorded navigation
  const treeInsightsCache = new Map(); // treeRootTitle → {recs, gaps, tutorItems, hasTutor}
  let degreeMap = {};          // id → connection count
  let relationshipMap = new Map();  // "from\x01to" → description
  let superClusters = [];      // [{name, children, parent}]
  let priorClusterState = null; // persisted snapshot for incremental clustering

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
  const superLayer = rootG.append('g').attr('class', 'super-clusters');
  const linkLayer = rootG.append('g').attr('class', 'links');
  const linkHitLayer = rootG.append('g').attr('class', 'link-hits');
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
    const navEdges = await getNavEdges();
    priorClusterState = await getClusterState();

    // Build children map from stored navigation edges.
    navChildrenMap = {};
    for (const key of Object.keys(navEdges)) {
      const sep = key.indexOf('\x01');
      if (sep === -1) continue;
      const from = key.slice(0, sep);
      const to = key.slice(sep + 1);
      if (!navChildrenMap[from]) navChildrenMap[from] = [];
      if (!navChildrenMap[from].includes(to)) navChildrenMap[from].push(to);
    }

    const list = Object.values(articles);
    buildGraph(list);

    // Hydrate cluster visualization from persisted snapshot.
    if (priorClusterState && priorClusterState.clusterMap) {
      applyClusterState(priorClusterState, /*activate=*/true);
    }

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
    if (currentView === 'tree') renderTreeView();
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
      links: a.links || [],
      status: a.status || null
    }));

    const present = new Set(nodes.map((n) => n.id));
    const edgeSet = new Set();
    baseLinks = [];
    for (const n of nodes) {
      for (const other of n.links) {
        if (!present.has(other) || other === n.id) continue;
        const key = [n.id, other].sort().join('\u0001');
        if (edgeSet.has(key)) continue;
        edgeSet.add(key);
        baseLinks.push({ source: n.id, target: other });
      }
    }
    recomputeLinks();

    const palette = [
      '#a78bfa', '#f472b6', '#5eead4', '#fbbf24', '#60a5fa',
      '#f87171', '#c084fc', '#34d399', '#fb923c', '#818cf8',
      '#e879f9', '#22d3ee'
    ];
    const categories = Array.from(new Set(nodes.map((n) => n.categories[0] || 'Uncategorized')));
    categoryColors = d3.scaleOrdinal(palette).domain(categories);

    render();
  }

  function radiusFor(n) { return 4 + Math.sqrt(degreeMap[n.id] || 0) * 3; }

  function recomputeLinks() {
    // Merge AI-inferred edges into display link set when cluster mode is active.
    const present = new Set(nodes.map((n) => n.id));
    const merged = baseLinks.slice();
    if (colorMode === 'cluster' && aiEdges.length) {
      const have = new Set(baseLinks.map((l) => {
        const s = l.source.id || l.source;
        const t = l.target.id || l.target;
        return [s, t].sort().join('\u0001');
      }));
      for (const e of aiEdges) {
        const s = e.source.id || e.source;
        const t = e.target.id || e.target;
        if (!present.has(s) || !present.has(t)) continue;
        const key = [s, t].sort().join('\u0001');
        if (have.has(key)) continue;
        have.add(key);
        merged.push({ source: s, target: t, aiOnly: true });
      }
    }
    links = merged;
    computeDegreeMap();
  }

  function computeDegreeMap() {
    degreeMap = {};
    for (const l of links) {
      const s = l.source.id || l.source;
      const t = l.target.id || l.target;
      degreeMap[s] = (degreeMap[s] || 0) + 1;
      degreeMap[t] = (degreeMap[t] || 0) + 1;
    }
  }

  function relKey(a, b) { return a + '\u0001' + b; }

  function lookupRelationship(a, b) {
    const ab = relationshipMap.get(relKey(a, b));
    if (ab) return { description: ab, from: a, to: b };
    const ba = relationshipMap.get(relKey(b, a));
    if (ba) return { description: ba, from: b, to: a };
    return null;
  }

  function computeAiEdgesFromRelationships() {
    const present = new Set(Object.keys(articles));
    const seen = new Set();
    aiEdges = [];
    for (const [key] of relationshipMap) {
      const sep = key.indexOf('\u0001');
      if (sep === -1) continue;
      const from = key.slice(0, sep);
      const to = key.slice(sep + 1);
      if (!present.has(from) || !present.has(to) || from === to) continue;
      const canon = [from, to].sort().join('\u0001');
      if (seen.has(canon)) continue;
      seen.add(canon);
      aiEdges.push({ source: from, target: to, aiOnly: true });
    }
  }

  function colorFor(n) {
    if (n.status && STATUS_COLORS[n.status]) return STATUS_COLORS[n.status];
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

  function degreeOf(id) { return degreeMap[id] || 0; }

  function render() {
    sizeSvg();

    const counts = nodes.map((n) => n.visitCount).sort((a, b) => b - a);
    const labelThreshold = counts[Math.floor(counts.length * 0.2)] || 3;

    // Links
    const linkKey = (d) => `${d.source.id || d.source}-${d.target.id || d.target}`;
    const linkSel = linkLayer.selectAll('line').data(links, linkKey);
    linkSel.exit().remove();
    const linkEnter = linkSel.enter().append('line').attr('class', 'link').attr('stroke-width', 1);
    const allLinks = linkEnter.merge(linkSel);
    allLinks.classed('ai-only', (d) => !!d.aiOnly);

    // Invisible wider hit targets for edge hover tooltips.
    const hitSel = linkHitLayer.selectAll('line').data(links, linkKey);
    hitSel.exit().remove();
    const hitEnter = hitSel.enter().append('line').attr('class', 'link-hit');
    const allHits = hitEnter.merge(hitSel);
    allHits
      .on('mouseenter', (event, d) => {
        const s = d.source.id || d.source;
        const t = d.target.id || d.target;
        const rel = lookupRelationship(s, t);
        if (!rel) return;
        const tip = document.getElementById('edge-tooltip');
        tip.textContent = `${rel.from} → ${rel.to}: ${rel.description}`;
        tip.classList.remove('hidden');
        positionEdgeTooltip(event);
      })
      .on('mousemove', (event) => positionEdgeTooltip(event))
      .on('mouseleave', () => {
        document.getElementById('edge-tooltip').classList.add('hidden');
      });

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

    renderSuperRings();

    simulation.on('tick', () => {
      allLinks
        .attr('x1', (d) => d.source.x)
        .attr('y1', (d) => d.source.y)
        .attr('x2', (d) => d.target.x)
        .attr('y2', (d) => d.target.y);
      allHits
        .attr('x1', (d) => d.source.x)
        .attr('y1', (d) => d.source.y)
        .attr('x2', (d) => d.target.x)
        .attr('y2', (d) => d.target.y);
      allNodes.attr('transform', (d) => `translate(${d.x}, ${d.y})`);
      allLabels.attr('x', (d) => d.x).attr('y', (d) => d.y);
      updateSuperRings();
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

  function positionEdgeTooltip(event) {
    const tip = document.getElementById('edge-tooltip');
    const rect = graphContainer.getBoundingClientRect();
    tip.style.left = (event.clientX - rect.left) + 'px';
    tip.style.top = (event.clientY - rect.top) + 'px';
  }

  // --- Super-cluster rendering ---

  function getSuperClusterArticles(name, visited = new Set()) {
    if (visited.has(name)) return new Set();
    visited.add(name);
    const sc = superClusters.find((s) => s.name === name);
    if (!sc) return new Set();
    const out = new Set();
    for (const child of sc.children) {
      // Child could be a cluster name (articles via clusterMap) or a nested super-cluster.
      if (superClusters.some((s) => s.name === child)) {
        for (const a of getSuperClusterArticles(child, visited)) out.add(a);
      } else if (clusterMap) {
        for (const [title, cname] of Object.entries(clusterMap)) {
          if (cname === child) out.add(title);
        }
      }
    }
    return out;
  }

  function superClusterDepth(name, memo = {}) {
    if (memo[name] != null) return memo[name];
    const sc = superClusters.find((s) => s.name === name);
    if (!sc || !sc.parent) return (memo[name] = 0);
    return (memo[name] = 1 + superClusterDepth(sc.parent, memo));
  }

  function renderSuperRings() {
    if (colorMode !== 'cluster' || !superClusters.length) {
      superLayer.selectAll('g.super-group').remove();
      return;
    }
    // Build a render list sorted by depth (shallow first → deep on top).
    const depthMemo = {};
    const sorted = superClusters
      .map((s) => ({ ...s, _depth: superClusterDepth(s.name, depthMemo) }))
      .sort((a, b) => a._depth - b._depth);

    const groupSel = superLayer.selectAll('g.super-group').data(sorted, (d) => d.name);
    groupSel.exit().remove();
    const groupEnter = groupSel.enter().append('g').attr('class', 'super-group');
    groupEnter.append('circle').attr('class', 'super-ring');
    groupEnter.append('text').attr('class', 'super-ring-label').attr('text-anchor', 'middle');
  }

  function updateSuperRings() {
    if (colorMode !== 'cluster' || !superClusters.length) {
      superLayer.selectAll('g.super-group').remove();
      return;
    }
    const ringColors = ['#a78bfa', '#f472b6', '#5eead4', '#fbbf24', '#60a5fa', '#c084fc'];
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const padByDepth = [36, 24, 16, 10];

    superLayer.selectAll('g.super-group').each(function (d) {
      const memberIds = getSuperClusterArticles(d.name);
      const pts = [];
      for (const id of memberIds) {
        const n = byId.get(id);
        if (n && typeof n.x === 'number') pts.push(n);
      }
      const g = d3.select(this);
      if (pts.length < 2) {
        g.style('display', 'none');
        return;
      }
      g.style('display', null);
      const cx = d3.mean(pts, (p) => p.x);
      const cy = d3.mean(pts, (p) => p.y);
      let maxR = 0;
      for (const p of pts) {
        const dx = p.x - cx, dy = p.y - cy;
        const r = Math.sqrt(dx * dx + dy * dy) + radiusFor(p);
        if (r > maxR) maxR = r;
      }
      const depth = d._depth || 0;
      const pad = padByDepth[Math.min(depth, padByDepth.length - 1)];
      const R = maxR + pad;
      const color = ringColors[depth % ringColors.length];
      g.select('circle.super-ring')
        .attr('cx', cx).attr('cy', cy).attr('r', R)
        .attr('stroke', color)
        .attr('stroke-width', 1.5 + depth * 0.2);
      g.select('text.super-ring-label')
        .attr('x', cx).attr('y', cy - R - 6)
        .attr('fill', color)
        .text(d.name);
    });
  }

  function applyClusterState(state, activate) {
    clusterMap = state.clusterMap || {};
    superClusters = Array.isArray(state.superClusters) ? state.superClusters : [];
    relationshipMap = new Map();
    for (const r of (state.relationships || [])) {
      if (r && r.from && r.to && r.description) {
        relationshipMap.set(relKey(r.from, r.to), r.description);
      }
    }
    computeAiEdgesFromRelationships();

    const names = Array.from(new Set(Object.values(clusterMap)));
    const richPalette = [
      '#a78bfa', '#f472b6', '#5eead4', '#fbbf24', '#60a5fa',
      '#f87171', '#c084fc', '#34d399', '#fb923c', '#818cf8',
      '#e879f9', '#22d3ee', '#fde047', '#4ade80'
    ];
    clusterColors = d3.scaleOrdinal(richPalette).domain(names);

    if (activate) {
      colorMode = 'cluster';
      const btn = document.getElementById('btn-cluster');
      if (btn) btn.classList.add('active');
      renderLegend(names);
    }
    recomputeLinks();
    renderSuperRings();
    render();
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
    selectedId = d.id;
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
      document.getElementById('tree-rec-modal').classList.add('hidden');
      infoPanel.classList.add('hidden');
      nodeLayer.selectAll('g.node').classed('selected', false);
      d3.select('#tree-canvas').selectAll('.tree-node').classed('tree-node--selected', false);
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

  function switchView(mode) {
    currentView = mode;
    document.getElementById('graph-container').classList.toggle('hidden', mode !== 'graph');
    listView.classList.toggle('hidden', mode !== 'list');
    document.getElementById('tree-view').classList.toggle('hidden', mode !== 'tree');
    infoPanel.classList.add('hidden');
    nodeLayer.selectAll('g.node').classed('selected', false);
    selectedId = null;

    const sel = document.getElementById('view-select');
    if (sel && sel.value !== mode) sel.value = mode;

    if (mode === 'tree') renderTreeView();
  }

  document.getElementById('view-select').addEventListener('change', (e) => {
    switchView(e.target.value);
  });

  // --- Tree view ---

  // Build a tree from actual navigation edges. The same article can appear in
  // multiple branches (if navigated to from different parents). Cycles within
  // a single path are broken by the per-path ancestor set.
  function buildTreeData(rootTitle, maxDepth) {
    function recurse(title, ancestors, depth) {
      if (depth > maxDepth) return null;
      const art = articles[title];
      if (!art) return null;
      const node = {
        id: title,
        name: title,
        visitCount: art.visitCount || 1,
        categories: art.categories || [],
        url: art.url,
        summary: art.summary || '',
        firstVisited: art.firstVisited,
        lastVisited: art.lastVisited,
        links: art.links || [],
        status: art.status || null
      };
      const newAncestors = new Set(ancestors);
      newAncestors.add(title);
      const childTitles = (navChildrenMap[title] || []).filter((t) => !newAncestors.has(t));
      const children = childTitles.map((t) => recurse(t, newAncestors, depth + 1)).filter(Boolean);
      if (children.length) node.children = children;
      return node;
    }
    return recurse(rootTitle, new Set(), 0);
  }

  function getTreeArticles() {
    if (!treeRootTitle || !articles[treeRootTitle]) return [];
    const treeData = buildTreeData(treeRootTitle, treeDepthVal);
    if (!treeData) return [];
    return d3.hierarchy(treeData).descendants().map((d) => articles[d.data.id]).filter(Boolean);
  }

  function populateRootSelect() {
    const sel = document.getElementById('tree-root-select');
    const prev = sel.value;
    sel.innerHTML = '';

    // Articles that are never a navigation destination are natural session roots.
    const allTargets = new Set(Object.values(navChildrenMap).flat());
    const list = Object.values(articles);
    const roots = list.filter((a) => !allTargets.has(a.title))
      .sort((a, b) => (a.firstVisited || 0) - (b.firstVisited || 0));
    const rest = list.filter((a) => allTargets.has(a.title))
      .sort((a, b) => b.visitCount - a.visitCount);

    for (const a of [...roots, ...rest]) {
      const opt = document.createElement('option');
      opt.value = a.title;
      const label = a.title.length > 48 ? a.title.slice(0, 48) + '…' : a.title;
      opt.textContent = roots.includes(a) ? '◎ ' + label : label;
      sel.appendChild(opt);
    }

    if (prev && articles[prev]) sel.value = prev;
    else if (roots.length) sel.value = roots[0].title;
    else if (rest.length) sel.value = rest[0].title;
    treeRootTitle = sel.value;
  }

  function renderTreeView() {
    const treeEmptyEl = document.getElementById('tree-empty');
    const treeCanvas = document.getElementById('tree-canvas');
    const noNav = Object.keys(navChildrenMap).length === 0;

    if (Object.keys(articles).length === 0 || noNav) {
      treeEmptyEl.querySelector('h2').textContent = noNav ? 'No navigation paths yet' : 'No articles yet';
      treeEmptyEl.querySelector('p').innerHTML = noNav
        ? 'Click through Wikipedia articles to record your path — each link you follow creates a branch in this tree.'
        : 'Start reading Wikipedia — articles and their connections will grow here.';
      treeEmptyEl.classList.remove('hidden');
      treeCanvas.style.display = 'none';
      return;
    }
    treeEmptyEl.classList.add('hidden');
    treeCanvas.style.display = '';
    populateRootSelect();
    drawTree();
  }

  function drawTree() {
    if (!treeRootTitle || !articles[treeRootTitle]) return;

    const canvasEl = document.getElementById('tree-canvas');
    const wrapEl = canvasEl.parentElement;
    const W = wrapEl.clientWidth || 900;
    const H = wrapEl.clientHeight || 600;

    const treeSvg = d3.select('#tree-canvas').attr('width', W).attr('height', H);
    treeSvg.selectAll('*').remove();

    const treeData = buildTreeData(treeRootTitle, treeDepthVal);
    if (!treeData) return;

    const hasChildren = !!(treeData.children && treeData.children.length);
    const emptyEl = document.getElementById('tree-empty');
    if (!hasChildren) {
      emptyEl.querySelector('h2').textContent = 'No paths from this article';
      emptyEl.querySelector('p').innerHTML = 'No navigation was recorded starting from here. Pick a different root, or click through links on Wikipedia to build branches.';
      emptyEl.classList.remove('hidden');
    } else {
      emptyEl.classList.add('hidden');
    }

    const root = d3.hierarchy(treeData);

    const nodeSpacingY = 44;
    const levelSpacingX = 210;
    const treeLayout = d3.tree().nodeSize([nodeSpacingY, levelSpacingX]);
    treeLayout(root);

    // Bounding box
    let x0 = Infinity, x1 = -Infinity;
    root.each((d) => { if (d.x < x0) x0 = d.x; if (d.x > x1) x1 = d.x; });

    // Zoom behaviour
    const treeZoom = d3.zoom()
      .scaleExtent([0.15, 4])
      .on('zoom', (event) => treeG.attr('transform', event.transform));
    treeSvg.call(treeZoom).on('dblclick.zoom', null);

    const treeG = treeSvg.append('g');

    const initTx = 72;
    const initTy = H / 2 - (x0 + x1) / 2;
    treeSvg.call(treeZoom.transform, d3.zoomIdentity.translate(initTx, initTy));
    treeG.attr('transform', `translate(${initTx},${initTy})`);

    // Links
    treeG.selectAll('.tree-link')
      .data(root.links())
      .enter()
      .append('path')
      .attr('class', 'tree-link')
      .attr('d', d3.linkHorizontal().x((d) => d.y).y((d) => d.x));

    // Nodes
    const nodeG = treeG.selectAll('.tree-node')
      .data(root.descendants())
      .enter()
      .append('g')
      .attr('class', (d) => 'tree-node' + (d.depth === 0 ? ' tree-node--root' : ''))
      .attr('transform', (d) => `translate(${d.y},${d.x})`)
      .style('color', (d) => colorFor(d.data))
      .on('click', (event, d) => {
        event.stopPropagation();
        treeSvg.selectAll('.tree-node').classed('tree-node--selected', false);
        d3.select(event.currentTarget).classed('tree-node--selected', true);
        const gn = nodes.find((n) => n.id === d.data.id);
        if (gn) openInfo(gn);
      })
      .on('dblclick', (event, d) => {
        event.stopPropagation();
        treeRootTitle = d.data.id;
        document.getElementById('tree-root-select').value = treeRootTitle;
        drawTree();
      })
      .on('mouseenter', (event) => {
        d3.select(event.currentTarget).select('.tree-node-halo').style('stroke-opacity', '0.55');
      })
      .on('mouseleave', (event) => {
        const el = event.currentTarget;
        if (!d3.select(el).classed('tree-node--selected')) {
          d3.select(el).select('.tree-node-halo').style('stroke-opacity', '0');
        }
      });

    nodeG.append('circle')
      .attr('class', 'tree-node-halo')
      .attr('r', (d) => radiusFor(d.data) + 5)
      .style('stroke-opacity', '0');

    nodeG.append('circle')
      .attr('class', 'tree-node-core')
      .attr('r', (d) => radiusFor(d.data))
      .attr('fill', (d) => colorFor(d.data))
      .attr('stroke', 'rgba(7,6,14,0.85)')
      .attr('stroke-width', 1.5);

    nodeG.append('text')
      .attr('class', 'tree-node-label')
      .attr('x', (d) => radiusFor(d.data) + 7)
      .attr('dy', '0.35em')
      .text((d) => {
        const t = d.data.name;
        return t.length > 30 ? t.slice(0, 30) + '…' : t;
      });
  }

  document.getElementById('tree-root-select').addEventListener('change', (e) => {
    treeRootTitle = e.target.value;
    drawTree();
  });

  document.getElementById('tree-depth-select').addEventListener('change', (e) => {
    treeDepthVal = parseInt(e.target.value, 10);
    drawTree();
  });

  document.getElementById('info-close').addEventListener('click', () => {
    infoPanel.classList.add('hidden');
    nodeLayer.selectAll('g.node').classed('selected', false);
    selectedId = null;
  });

  document.getElementById('btn-view-tree').addEventListener('click', () => {
    if (!selectedId || !articles[selectedId]) return;
    const target = selectedId;
    // Pre-set the select so populateRootSelect's "preserve previous" path keeps our target.
    const rootSel = document.getElementById('tree-root-select');
    if (rootSel) {
      if (!Array.from(rootSel.options).some((o) => o.value === target)) {
        const opt = document.createElement('option');
        opt.value = target;
        opt.textContent = target;
        rootSel.appendChild(opt);
      }
      rootSel.value = target;
    }
    treeRootTitle = target;
    switchView('tree');
    if (rootSel) rootSel.value = target;
    treeRootTitle = target;
    drawTree();
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

  async function runClustering({ forceFresh = false } = {}) {
    const btn = document.getElementById('btn-cluster');
    const label = btn.querySelector('span');
    const settings = await getSettings();
    if (!settings.apiKey) { toast('Set your Gemini API key in Settings first.', 'error'); return; }
    const list = Object.values(articles);
    if (list.length === 0) return;
    btn.disabled = true;
    label.textContent = 'Clustering…';

    const priorForCall = (!forceFresh && priorClusterState && priorClusterState.clusterMap) ? {
      clusters: Array.from(
        new Map(Array.from(new Set(Object.values(priorClusterState.clusterMap))).map((name) => [name, {
          clusterName: name,
          articles: Object.entries(priorClusterState.clusterMap)
            .filter(([, c]) => c === name).map(([t]) => t)
        }])).values()
      ),
      superClusters: priorClusterState.superClusters || [],
      relationships: priorClusterState.relationships || [],
      clusteredTitles: priorClusterState.clusteredTitles || Object.keys(priorClusterState.clusterMap)
    } : null;

    try {
      const result = await clusterArticles(list, settings.apiKey, priorForCall ? { prior: priorForCall } : {});
      const clustersArr = Array.isArray(result.clusters) ? result.clusters : [];
      const relationships = Array.isArray(result.relationships) ? result.relationships : [];
      const superClustersArr = Array.isArray(result.superClusters) ? result.superClusters : [];

      // Build cluster map from LLM output; preserve prior assignment for untouched titles.
      const newMap = {};
      for (const c of clustersArr) {
        for (const t of c.articles) newMap[t] = c.clusterName;
      }
      if (priorForCall) {
        for (const [t, c] of Object.entries(priorClusterState.clusterMap || {})) {
          if (!newMap[t] && articles[t]) newMap[t] = c;
        }
      }
      for (const a of list) if (!newMap[a.title]) newMap[a.title] = 'Unclustered';

      // Relationships: union prior + new (drop any endpoint no longer in library).
      const presentTitles = new Set(Object.keys(articles));
      const relMap = new Map();
      if (priorForCall) {
        for (const r of (priorClusterState.relationships || [])) {
          if (r && r.from && r.to && presentTitles.has(r.from) && presentTitles.has(r.to)) {
            relMap.set(relKey(r.from, r.to), r);
          }
        }
      }
      for (const r of relationships) {
        if (r && r.from && r.to && presentTitles.has(r.from) && presentTitles.has(r.to)) {
          relMap.set(relKey(r.from, r.to), r);
        }
      }

      // Super-clusters: replace returned ones by name, preserve untouched prior ones.
      const returnedNames = new Set(superClustersArr.map((s) => s.name));
      const mergedSupers = superClustersArr.slice();
      if (priorForCall) {
        for (const s of (priorClusterState.superClusters || [])) {
          if (!returnedNames.has(s.name)) mergedSupers.push(s);
        }
      }

      const snapshot = {
        clusterMap: newMap,
        superClusters: mergedSupers,
        relationships: Array.from(relMap.values()),
        clusteredTitles: Object.keys(articles),
        updatedAt: Date.now()
      };
      priorClusterState = snapshot;
      await setClusterState(snapshot);
      applyClusterState(snapshot, /*activate=*/true);

      const clusterCount = new Set(Object.values(newMap)).size;
      toast(`Clustered into ${clusterCount} group${clusterCount === 1 ? '' : 's'}${mergedSupers.length ? ' · ' + mergedSupers.length + ' super-cluster' + (mergedSupers.length === 1 ? '' : 's') : ''}`, 'success');
    } catch (err) {
      toast('Clustering failed: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      label.textContent = 'Cluster';
    }
  }

  document.getElementById('btn-cluster').addEventListener('click', async (event) => {
    const btn = document.getElementById('btn-cluster');
    // Toggle off if currently active.
    if (colorMode === 'cluster') {
      colorMode = 'category';
      aiEdges = [];
      btn.classList.remove('active');
      legendEl.classList.add('hidden');
      recomputeLinks();
      render();
      return;
    }
    // If a snapshot exists and there are no new articles since last cluster, just activate.
    if (priorClusterState && priorClusterState.clusterMap && !event.shiftKey) {
      const clustered = new Set(priorClusterState.clusteredTitles || Object.keys(priorClusterState.clusterMap));
      const hasNew = Object.keys(articles).some((t) => !clustered.has(t));
      if (!hasNew) {
        applyClusterState(priorClusterState, /*activate=*/true);
        return;
      }
    }
    await runClustering({ forceFresh: event.shiftKey });
  });

  document.getElementById('btn-cluster-rebuild').addEventListener('click', async () => {
    priorClusterState = null;
    await setClusterState(null);
    await runClustering({ forceFresh: true });
  });

  function renderLegend(names) {
    const clusterItem = (n) => {
      const color = clusterColors(n);
      return `<div class="legend-item" style="color:${color}"><span class="legend-swatch" style="background:${color}"></span><span style="color:var(--fg)">${escapeHtml(n)}</span></div>`;
    };

    let html = '<h3>Clusters</h3>';
    if (superClusters && superClusters.length) {
      const roots = superClusters.filter((s) => !s.parent);
      const assigned = new Set();

      const walkSuper = (s, depth) => {
        let out = `<div class="legend-group-title" style="margin-left:${depth * 10}px">${escapeHtml(s.name)}</div>`;
        for (const child of s.children) {
          const nestedSuper = superClusters.find((x) => x.name === child);
          if (nestedSuper) {
            out += walkSuper(nestedSuper, depth + 1);
          } else if (names.includes(child)) {
            assigned.add(child);
            out += `<div class="legend-indent" style="margin-left:${(depth + 1) * 10}px">${clusterItem(child)}</div>`;
          }
        }
        return out;
      };

      for (const r of roots) html += walkSuper(r, 0);
      const unassigned = names.filter((n) => !assigned.has(n));
      if (unassigned.length) {
        html += `<div class="legend-group-title">Other</div>`;
        html += unassigned.map(clusterItem).join('');
      }
    } else {
      html += names.map(clusterItem).join('');
    }
    legendEl.innerHTML = html;
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
      for (const g of gaps) gapList.appendChild(renderGap(g));
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

  function renderGap(g) {
    const div = document.createElement('div');
    div.className = 'gap-item';
    const wikiUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(g.topic.replace(/ /g, '_'))}`;
    div.innerHTML = `<div class="topic"><a href="${wikiUrl}" target="_blank" rel="noopener">${escapeHtml(g.topic)}</a></div><div class="reason">${escapeHtml(g.reason)}</div>`;
    return div;
  }

  document.getElementById('modal-close').addEventListener('click', () => {
    document.getElementById('recommend-modal').classList.add('hidden');
  });
  document.querySelector('#recommend-modal .modal-backdrop').addEventListener('click', () => {
    document.getElementById('recommend-modal').classList.add('hidden');
  });

  // --- Tree Insights modal ---

  function renderTutorItem(item) {
    const div = document.createElement('div');
    div.className = 'tutor-item';
    const wikiUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent((item.concept || '').replace(/ /g, '_'))}`;
    const badgeClass = item.type === 'prerequisite' ? 'prerequisite' : 'supporting';
    div.innerHTML =
      `<div class="concept"><a href="${wikiUrl}" rel="noopener">${escapeHtml(item.concept)}</a></div>` +
      `<div class="tutor-meta">` +
      `<span class="tutor-badge ${badgeClass}">${escapeHtml(item.type)}</span>` +
      `<span class="relates-to">re: ${escapeHtml(item.relatesToArticle)}</span>` +
      `</div>` +
      `<div class="reason">${escapeHtml(item.reason)}</div>`;
    div.querySelector('.concept a').addEventListener('click', (e) => {
      e.preventDefault();
      addNavEdge(item.relatesToArticle, item.concept);
      if (!navChildrenMap[item.relatesToArticle]) navChildrenMap[item.relatesToArticle] = [];
      if (!navChildrenMap[item.relatesToArticle].includes(item.concept)) {
        navChildrenMap[item.relatesToArticle].push(item.concept);
      }
      window.open(wikiUrl, '_blank', 'noopener');
    });
    return div;
  }

  function populateTreeInsightsModal({ recs, gaps, tutorItems, hasTutor }) {
    const treeRecList = document.getElementById('tree-rec-list');
    const treeGapList = document.getElementById('tree-gap-list');
    const treeTutorList = document.getElementById('tree-tutor-list');
    document.getElementById('tree-tutor-section').classList.toggle('hidden', !hasTutor);

    treeRecList.innerHTML = '';
    for (const r of recs) treeRecList.appendChild(renderRec(r));

    treeGapList.innerHTML = '';
    if (!gaps.length) treeGapList.innerHTML = '<div style="color: var(--muted); font-size: 13px;">No gaps identified.</div>';
    for (const g of gaps) treeGapList.appendChild(renderGap(g));

    if (hasTutor && tutorItems.length) {
      treeTutorList.innerHTML = '';
      for (const t of tutorItems) treeTutorList.appendChild(renderTutorItem(t));
    }
  }

  async function fetchTreeInsights(treeArticles, apiKey) {
    const hasTutor = treeArticles.some((a) => a.status === 'learning' || a.status === 'confused');
    const promises = [
      getTreeRecommendations(treeArticles, apiKey),
      getTreeGapAnalysis(treeArticles, apiKey)
    ];
    if (hasTutor) promises.push(getTutorRecommendations(treeArticles, apiKey));
    const [recs, gaps, tutorItems = []] = await Promise.all(promises);
    return { recs, gaps, tutorItems, hasTutor };
  }

  async function runTreeInsights(forceRefresh = false) {
    const settings = await getSettings();
    if (!settings.apiKey) { toast('Set your Gemini API key in Settings first.', 'error'); return; }
    const treeArticles = getTreeArticles();
    if (treeArticles.length < 2) { toast('This tree needs more articles for insights.', 'error'); return; }

    const modal = document.getElementById('tree-rec-modal');
    const loading = document.getElementById('tree-modal-loading');
    const refreshBtn = document.getElementById('btn-tree-refresh');

    document.getElementById('tree-modal-sub').textContent =
      `Based on ${treeArticles.length} articles in current tree · Gemini 3 Flash`;
    modal.classList.remove('hidden');

    if (!forceRefresh && treeInsightsCache.has(treeRootTitle)) {
      loading.classList.add('hidden');
      populateTreeInsightsModal(treeInsightsCache.get(treeRootTitle));
      return;
    }

    treeInsightsCache.delete(treeRootTitle);
    loading.classList.remove('hidden');
    refreshBtn.disabled = true;

    try {
      const data = await fetchTreeInsights(treeArticles, settings.apiKey);
      treeInsightsCache.set(treeRootTitle, data);
      populateTreeInsightsModal(data);
    } catch (err) {
      document.getElementById('tree-rec-list').innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
    } finally {
      loading.classList.add('hidden');
      refreshBtn.disabled = false;
    }
  }

  document.getElementById('btn-tree-insights').addEventListener('click', () => runTreeInsights(false));
  document.getElementById('btn-tree-refresh').addEventListener('click', () => runTreeInsights(true));

  document.getElementById('tree-modal-close').addEventListener('click', () => {
    document.getElementById('tree-rec-modal').classList.add('hidden');
  });
  document.querySelector('#tree-rec-modal .modal-backdrop').addEventListener('click', () => {
    document.getElementById('tree-rec-modal').classList.add('hidden');
  });

  // --- Init ---
  await loadData();
})();
