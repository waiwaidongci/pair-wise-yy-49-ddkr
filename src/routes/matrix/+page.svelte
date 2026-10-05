<script lang="ts">
  import { curriculumStore } from '$lib/stores'
  import { validateGraph, coverageMatrix, newEdgeId, type EdgeCommit, type Mapping } from '$lib/graph'

  let staged = $state<Mapping[]>([])
  let source = $state('GR-03')
  let target = $state('C-308')
  let relation = $state<Mapping['relation']>('支撑')
  let weight = $state(1)
  let query = $state('')
  let flash = $state<{ ok: boolean; text: string } | null>(null)
  let selectedNode = $state('C-308')
  let dragging = $state<string | null>(null)
  let offset = $state({ x: 0, y: 0 })

  const graphVersion = $derived($curriculumStore.graphVersion)
  const issues = $derived(validateGraph($curriculumStore))
  const coverage = $derived(coverageMatrix($curriculumStore))
  const pending = $derived($curriculumStore.pendingCommits)
  const visibleIds = $derived(
    new Set(
      $curriculumStore.nodes
        .filter((node) => !query || node.label.includes(query) || node.id.includes(query))
        .map((node) => node.id),
    ),
  )
  const selected = $derived($curriculumStore.nodes.find((item) => item.id === selectedNode))

  function startDrag(event: MouseEvent, id: string) {
    const node = $curriculumStore.nodes.find((item) => item.id === id)
    if (!node) return
    const svg = (event.currentTarget as SVGElement).ownerSVGElement
    const rect = svg?.getBoundingClientRect()
    if (!rect) return
    dragging = id
    offset = {
      x: ((event.clientX - rect.left) / rect.width) * 1200 - node.x,
      y: ((event.clientY - rect.top) / rect.height) * 520 - node.y,
    }
  }

  function drag(event: MouseEvent) {
    if (!dragging) return
    const svg = event.currentTarget as SVGSVGElement
    const rect = svg.getBoundingClientRect()
    curriculumStore.moveNode(
      dragging,
      Math.max(50, Math.min(1140, ((event.clientX - rect.left) / rect.width) * 1200 - offset.x)),
      Math.max(30, Math.min(480, ((event.clientY - rect.top) / rect.height) * 520 - offset.y)),
    )
  }

  function stageEdge() {
    if (source === target) return
    staged = [...staged, { id: newEdgeId(), source, target, relation, weight }]
  }

  function removeStaged(id: string) {
    staged = staged.filter((edge) => edge.id !== id)
  }

  async function submitBatch() {
    if (!staged.length) return
    const edges = staged
    staged = []
    const result = await curriculumStore.commitBatch(edges)
    flash = result.ok
      ? { ok: true, text: `批次已生效，图谱基线推进到 v${$curriculumStore.graphVersion}` }
      : { ok: false, text: `整批退回：${result.conflicts.map((c) => c.message).join('；')}` }
    setTimeout(() => (flash = null), 6000)
  }

  async function retry(commitId: string, force = false) {
    await curriculumStore.retryCommit(commitId, force)
  }

  function discard(commitId: string) {
    curriculumStore.discardCommit(commitId)
  }

  async function withdraw(commitId: string, edgeId: string) {
    await curriculumStore.withdrawEdge(commitId, edgeId)
  }

  function exportMap() {
    const blob = new Blob([JSON.stringify($curriculumStore, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `课程地图-${$curriculumStore.revision}.json`
    link.click()
    URL.revokeObjectURL(url)
  }

  function edgeLabel(m: Mapping) {
    const s = $curriculumStore.nodes.find((n) => n.id === m.source)?.label.split('\n')[0] ?? m.source
    const t = $curriculumStore.nodes.find((n) => n.id === m.target)?.label.split('\n')[0] ?? m.target
    return `${s} → ${t}`
  }
</script>

<svelte:head><title>映射图谱与覆盖矩阵</title></svelte:head>

<section class="page">
  <div class="page-head">
    <div>
      <p class="eyebrow">CURRICULUM MAP / 映射图谱</p>
      <h1>有向关系与覆盖矩阵</h1>
      <p class="muted">连边以图谱基线号提交，提交前整体重放；成环或撞重复边整批退回，图谱保持原样。</p>
    </div>
    <div class="actions">
      <span class="baseline-badge">图谱基线 <b>v{graphVersion}</b></span>
      <button class="btn-secondary" onclick={exportMap}>导出课程地图</button>
      <button class="btn-primary" onclick={() => curriculumStore.lock(`R${Number($curriculumStore.revision.slice(1)) + 1}`)}
        >锁定当前版本</button
      >
    </div>
  </div>

  {#if flash}
    <div class="notice {flash.ok ? 'success' : 'error'}">{flash.text}</div>
  {/if}

  <div class="matrix-toolbar panel">
    <input bind:value={query} placeholder="搜索目标、课程或单元" />
    <select bind:value={source}>{#each $curriculumStore.nodes as node}<option value={node.id}>{node.id} · {node.label.split('\n')[0]}</option>{/each}</select>
    <span>→</span>
    <select bind:value={target}>{#each $curriculumStore.nodes as node}<option value={node.id}>{node.id} · {node.label.split('\n')[0]}</option>{/each}</select>
    <select bind:value={relation}><option>支撑</option><option>前置</option><option>教学</option><option>考核</option></select>
    <input bind:value={weight} type="number" min="0" max="1" step="0.1" />
    <button class="btn-secondary" onclick={stageEdge}>加入批次</button>
    <button class="btn-primary" onclick={submitBatch} disabled={staged.length === 0}
      >提交批次{staged.length ? `（${staged.length} 条）` : ''}</button
    >
    <span class="muted">{issues.length} 项校验提示</span>
  </div>

  {#if staged.length}
    <div class="panel staged-panel">
      <div class="panel-head"><h3>待提交批次</h3><span class="muted">{staged.length} 条连边，基线 v{graphVersion}</span></div>
      <div class="chip-row">
        {#each staged as edge (edge.id)}
          <span class="chip">{edgeLabel(edge)} · <b>{edge.relation}</b> · {Math.round(edge.weight * 100)}% <button onclick={() => removeStaged(edge.id)}>×</button></span>
        {/each}
      </div>
    </div>
  {/if}

  {#if pending.length}
    <div class="panel pending-panel">
      <div class="panel-head"><h3>写入失败 · 整批留待重试</h3><span class="muted">{pending.length} 个批次</span></div>
      {#each pending as commit (commit.id)}
        <article class="commit-card">
          <div class="commit-head">
            <strong>{commit.id}</strong>
            <span class="muted">基线 v{commit.baseline} → 当前 v{graphVersion}</span>
            <span class="status status-{commit.status}">{commit.status}</span>
          </div>
          <ul class="conflict-list">
            {#each commit.conflicts as c (c.edgeId + c.kind)}
              <li class="conflict-{c.kind}">
                <span class="conflict-kind">{c.kind}</span>
                <code>{c.edgeId}</code>
                <span>{edgeLabel({ id: c.edgeId, source: c.source, target: c.target, relation: c.relation, weight: 0 })} · {c.relation}</span>
                <p>{c.message}</p>
                {#if c.kind === 'relation-mismatch'}
                  <div class="conflict-actions">
                    <button class="btn-secondary" onclick={() => retry(commit.id, true)}>强制覆盖为「{c.relation}」</button>
                    <button class="btn-secondary" onclick={() => withdraw(commit.id, c.edgeId)}>撤回本边后重试</button>
                  </div>
                {/if}
              </li>
            {/each}
          </ul>
          <div class="commit-actions">
            <button class="btn-primary" onclick={() => retry(commit.id)}>整批重试（跳过已生效边）</button>
            <button class="btn-secondary" onclick={() => discard(commit.id)}>放弃批次</button>
          </div>
        </article>
      {/each}
    </div>
  {/if}

  <div class="matrix-layout">
    <section class="panel graph-panel">
      <div class="panel-head"><h3>课程改革有向图</h3><span class="muted">拖拽节点重排 · 前置成环会整批退回</span></div>
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <svg role="application" aria-label="课程映射拖拽图" viewBox="0 0 1200 520" onmousemove={drag} onmouseup={() => (dragging = null)} onmouseleave={() => (dragging = null)}>
        <defs><marker id="arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 z" fill="#688086" /></marker></defs>
        {#each $curriculumStore.mappings as mapping}
          {@const from = $curriculumStore.nodes.find((node) => node.id === mapping.source)}
          {@const to = $curriculumStore.nodes.find((node) => node.id === mapping.target)}
          {#if from && to && visibleIds.has(from.id) && visibleIds.has(to.id)}
            <line x1={from.x + 80} y1={from.y + 28} x2={to.x} y2={to.y + 28} class:relation={true} marker-end="url(#arrow)" />
            <text x={(from.x + to.x) / 2 + 22} y={(from.y + to.y) / 2 + 22} class="edge-label">{mapping.relation}</text>
          {/if}
        {/each}
        {#each $curriculumStore.nodes as node}
          {#if visibleIds.has(node.id)}
            <g
              class:selected={selectedNode === node.id}
              class:coverage-gap={issues.some((issue) => issue.id === `coverage-${node.id}`)}
              onmousedown={(event) => startDrag(event, node.id)}
              onclick={() => (selectedNode = node.id)}
              onkeydown={(event) => { if (event.key === 'Enter' || event.key === ' ') selectedNode = node.id }}
              role="button"
              tabindex="0"
            >
              <rect x={node.x} y={node.y} width="160" height="58" rx="9" class={`node node-${node.type}`} />
              <text x={node.x + 80} y={node.y + 24} text-anchor="middle" class="node-label">{node.label.split('\n')[0]}</text>
              <text x={node.x + 80} y={node.y + 42} text-anchor="middle" class="node-id">{node.id} · {node.type}</text>
            </g>
          {/if}
        {/each}
      </svg>
    </section>

    <aside class="panel">
      <div class="panel-head"><h3>覆盖矩阵</h3><span class="muted">Σ 权重 · v{graphVersion}</span></div>
      <div class="coverage-matrix">
        {#each coverage as row}
          <div class="matrix-row">
            <strong>{row.requirement.label.split('\n')[0]}</strong>
            {#each row.cells as cell}
              <span class:covered={cell.count}>{cell.count ? Math.round(cell.weight * 100) : '—'}</span>
            {/each}
          </div>
        {/each}
      </div>
      <div class="legend"><span><i class="covered-dot"></i>已有映射</span><span><i class="gap-dot"></i>覆盖缺口</span></div>
      <div class="issue-panel">
        <div class="panel-head"><h3>校验提示</h3><span class="muted">{issues.length} 项 · v{graphVersion}</span></div>
        {#if issues.length === 0}<div class="empty">未发现覆盖缺口、重复映射或前置成环。</div>{/if}
        {#each issues as issue}
          <article class:error={issue.severity === '错误'}>
            <strong>{issue.title}</strong><p>{issue.detail}</p><span>{issue.severity}</span>
          </article>
        {/each}
      </div>
      <div class="node-detail">
        {#if selected}
          <strong>{selected.label.split('\n')[0]}</strong><p>{selected.id} · {selected.type}</p><button class="btn-secondary">编辑节点信息</button>
        {/if}
      </div>
    </aside>
  </div>
</section>

<style>
  .actions { display: flex; gap: 8px; align-items: center; }
  .baseline-badge { padding: 6px 12px; border: 1px solid #cddede; border-radius: 999px; background: #f0f7f6; color: #3b6a6b; font-size: 12px; }
  .baseline-badge b { color: #2d7375; }
  .notice { margin-bottom: 12px; padding: 12px 14px; border-left: 3px solid #3f8869; color: #27634d; background: #ebf6f0; }
  .notice.error { border-color: #bd4d35; color: #913c2b; background: #fff1ec; }
  .matrix-toolbar { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; margin-bottom: 12px; padding: 12px; }
  .matrix-toolbar > input:first-child { max-width: 220px; }
  .matrix-toolbar select { max-width: 230px; }
  .staged-panel { margin-bottom: 12px; padding: 12px 14px; }
  .chip-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
  .chip { display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px; border: 1px solid #d4e2e1; border-radius: 999px; background: #f5f9f8; font-size: 12px; }
  .chip b { color: #2d7375; }
  .chip button { border: 0; background: transparent; color: #9aa8ab; cursor: pointer; font-size: 14px; line-height: 1; }
  .pending-panel { margin-bottom: 12px; padding: 12px 14px; border-left: 4px solid #cd813a; }
  .commit-card { padding: 10px 0; border-bottom: 1px dashed #e4e7e7; }
  .commit-card:last-child { border-bottom: 0; }
  .commit-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
  .commit-head strong { font-size: 13px; }
  .status { padding: 2px 8px; border-radius: 999px; font-size: 11px; }
  .status-已退回 { color: #a54431; background: #ffebe6; }
  .status-待裁决 { color: #9b5a25; background: #fff0de; }
  .status-已生效 { color: #2e7359; background: #e7f4ec; }
  .conflict-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
  .conflict-list li { display: grid; grid-template-columns: auto auto 1fr; gap: 8px; align-items: center; padding: 7px 10px; border: 1px solid #e8eded; border-radius: 6px; background: #fafcfc; font-size: 12px; }
  .conflict-list li p { grid-column: 1 / -1; margin: 0; color: #68767d; font-size: 11px; }
  .conflict-kind { padding: 2px 6px; border-radius: 4px; font-size: 10px; color: #fff; background: #8a979b; }
  .conflict-cycle .conflict-kind { background: #c14932; }
  .conflict-duplicate .conflict-kind { background: #cd813a; }
  .conflict-relation-mismatch .conflict-kind { background: #50758a; }
  .conflict-list code { color: #7a5a8a; font-size: 11px; }
  .conflict-actions { grid-column: 1 / -1; display: flex; gap: 8px; }
  .commit-actions { display: flex; gap: 8px; margin-top: 10px; }
  .matrix-layout { display: grid; grid-template-columns: minmax(0,1fr) 360px; gap: 14px; align-items: start; }
  svg { display: block; width: 100%; min-width: 900px; background: radial-gradient(circle,#dce2e2 1px,transparent 1px); background-size: 22px 22px; }
  .graph-panel { overflow: auto; }
  line { stroke: #688086; stroke-width: 1.8; opacity: .65; }
  .edge-label { fill: #60757b; font-size: 9px; }
  g { cursor: grab; }
  g.selected .node { stroke-width: 3; }
  g.coverage-gap .node { stroke: #c14932; stroke-dasharray: 7 4; }
  .node { fill: white; stroke: #3c7c7d; stroke-width: 1.5; }
  .node-目标 { fill: #edf7f4; stroke: #3d7e70; }
  .node-课程 { fill: #fff5e9; stroke: #bd7437; }
  .node-毕业要求 { fill: #edf3f6; stroke: #50758a; }
  .node-单元 { fill: #f5f1f8; stroke: #806a9d; }
  .node-label { fill: #263b42; font-size: 12px; font-weight: 700; pointer-events: none; }
  .node-id { fill: #75848a; font-size: 9px; pointer-events: none; }
  .coverage-matrix { padding: 14px; overflow-x: auto; }
  .matrix-row { display: grid; grid-template-columns: 110px repeat(3,50px); gap: 6px; align-items: center; min-width: 310px; margin-bottom: 8px; }
  .matrix-row strong { font-size: 11px; }
  .matrix-row span { display: grid; height: 32px; place-items: center; border-radius: 5px; color: #8b969b; background: #f1f3f3; font-size: 11px; }
  .matrix-row span.covered { color: #276a55; background: #e4f3eb; font-weight: 800; }
  .legend { display: flex; gap: 14px; padding: 0 14px 14px; color: #6e7c82; font-size: 10px; }
  .legend i { display: inline-block; width: 8px; height: 8px; margin-right: 4px; border-radius: 50%; }
  .covered-dot { background: #3f8c6b; }
  .gap-dot { background: #c14932; }
  .issue-panel { padding: 0 14px 14px; }
  .issue-panel .panel-head { padding: 0 0 8px; }
  .issue-panel article { position: relative; padding: 10px 0; border-bottom: 1px solid #edf0f0; }
  .issue-panel article strong { color: #9c6d25; font-size: 12px; }
  .issue-panel article.error strong { color: #ac4433; }
  .issue-panel article p { margin: 4px 0 0; color: #68767d; font-size: 11px; line-height: 1.5; }
  .issue-panel article > span { position: absolute; top: 10px; right: 0; color: #809096; font-size: 10px; }
  .issue-panel .empty { padding: 12px 0; color: #3d7b63; font-size: 12px; }
  .node-detail { margin: 0 14px 14px; padding: 13px; border-left: 3px solid #377c7b; background: #f3f7f6; }
  .node-detail strong { display: block; }
  .node-detail p { margin: 5px 0 10px; color: #748188; font-size: 11px; }
  @media (max-width: 1050px) { .matrix-layout { grid-template-columns: 1fr; } }
</style>
