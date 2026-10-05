<script lang="ts">
  import { createQuery } from '@tanstack/svelte-query'
  import { browser } from '$app/environment'
  import { curriculumStore, validateCurriculum } from '$lib/stores'
  import { findPrereqCycle, type Adjudication, type Mapping, type PublicGraphState } from '$lib/graph'
  import type { GraphNode, ReviewItem } from '$lib/seed'

  type CurriculumResponse = PublicGraphState & { nodes: GraphNode[]; reviewItems: ReviewItem[]; updatedAt: string }

  let dragging = $state<string | null>(null)
  let offset = $state({ x: 0, y: 0 })
  let selectedNode = $state('C-308')
  let source = $state('GR-03')
  let target = $state('C-308')
  let relation = $state<Mapping['relation']>('前置')
  let weight = $state(1)
  let query = $state('')
  let simulateFailure = $state(false)
  let submitting = $state(false)

  // 轮询图谱服务：他人提交的边并进来，而不是被本地覆盖
  const syncQuery = createQuery<CurriculumResponse>(() => ({
    queryKey: ['curriculum'],
    enabled: browser,
    refetchInterval: 5000,
    queryFn: async () => {
      const response = await fetch('/api/curriculum')
      return response.json()
    },
  }))

  $effect(() => {
    if (syncQuery.data) curriculumStore.syncFromServer(syncQuery.data)
  })

  // 图谱版本一变，覆盖矩阵与校验提示随之重算
  const issues = $derived(validateCurriculum($curriculumStore))
  const coverageRows = $derived(
    $curriculumStore.nodes
      .filter((node) => node.type === '毕业要求')
      .map((requirement) => ({
        requirement,
        cells: $curriculumStore.nodes
          .filter((node) => node.type === '课程')
          .map((course) => ({
            course,
            links: $curriculumStore.mappings.filter((mapping) => mapping.source === requirement.id && mapping.target === course.id),
          })),
      })),
  )
  const visibleIds = $derived(new Set($curriculumStore.nodes.filter((node) => !query || node.label.includes(query) || node.id.includes(query)).map((node) => node.id)))
  const selected = $derived($curriculumStore.nodes.find((item) => item.id === selectedNode))
  // 提交前预检：暂存边与当前图谱整体重放，提前暴露成环
  const stagedCycle = $derived(findPrereqCycle([...$curriculumStore.mappings, ...$curriculumStore.staged]))
  const conflictEdgeIds = $derived(new Set($curriculumStore.conflicts.map((conflict) => conflict.edgeId)))
  const pendingAdjudications = $derived($curriculumStore.adjudications.filter((item) => item.status === '待裁决'))

  function startDrag(event: MouseEvent, id: string) {
    const node = $curriculumStore.nodes.find((item) => item.id === id)
    if (!node) return
    const svg = (event.currentTarget as SVGElement).ownerSVGElement
    const rect = svg?.getBoundingClientRect()
    if (!rect) return
    dragging = id
    offset = { x: ((event.clientX - rect.left) / rect.width) * 1200 - node.x, y: ((event.clientY - rect.top) / rect.height) * 520 - node.y }
  }

  function drag(event: MouseEvent) {
    if (!dragging) return
    const svg = event.currentTarget as SVGSVGElement
    const rect = svg.getBoundingClientRect()
    curriculumStore.moveNode(dragging, Math.max(50, Math.min(1140, ((event.clientX - rect.left) / rect.width) * 1200 - offset.x)), Math.max(30, Math.min(480, ((event.clientY - rect.top) / rect.height) * 520 - offset.y)))
  }

  function stageEdge() {
    if (source === target) return
    curriculumStore.stageEdge(source, target, relation, weight)
  }

  async function commitStaged() {
    submitting = true
    await curriculumStore.commitStaged(simulateFailure)
    submitting = false
  }

  function nodeLabel(id: string) {
    return $curriculumStore.nodes.find((node) => node.id === id)?.label.split('\n')[0] ?? id
  }

  function exportMap() {
    const blob = new Blob([JSON.stringify($curriculumStore, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `课程地图-${$curriculumStore.revision}-R${$curriculumStore.version}.json`
    link.click()
    URL.revokeObjectURL(url)
  }
</script>

<svelte:head><title>映射图谱与覆盖矩阵</title></svelte:head>

<section class="page">
  <div class="page-head">
    <div>
      <p class="eyebrow">CURRICULUM MAP / 映射图谱</p>
      <h1>有向关系与覆盖矩阵 <span class="version-chip">图谱基线 R{$curriculumStore.version}</span></h1>
      <p class="muted">连边先暂存、再按基线号整批提交；提交前服务端按当前图谱整体重放，成环或重复边整批退回。</p>
    </div>
    <div class="actions"><button class="btn-secondary" onclick={exportMap}>导出课程地图</button><button class="btn-primary" onclick={() => curriculumStore.lock(`R${Number($curriculumStore.revision.slice(1)) + 1}`)}>锁定当前版本</button></div>
  </div>

  {#if $curriculumStore.migrationPending}
    <div class="notice migrating">检测到旧数据缺少图谱基线号，正在自动迁移并接入图谱……</div>
  {/if}
  {#if $curriculumStore.notice}
    <div class="notice" class:error={$curriculumStore.conflicts.length > 0}>{$curriculumStore.notice}</div>
  {/if}

  <div class="matrix-toolbar panel">
    <input bind:value={query} placeholder="搜索目标、课程或单元" />
    <select bind:value={source}>{#each $curriculumStore.nodes as node}<option value={node.id}>{node.id} · {node.label.split('\n')[0]}</option>{/each}</select>
    <span>→</span>
    <select bind:value={target}>{#each $curriculumStore.nodes as node}<option value={node.id}>{node.id} · {node.label.split('\n')[0]}</option>{/each}</select>
    <select bind:value={relation}><option>支撑</option><option>前置</option><option>教学</option><option>考核</option></select>
    <input bind:value={weight} type="number" min="0" max="1" step="0.1" />
    <button class="btn-secondary" onclick={stageEdge}>暂存连边</button>
    <span class="muted">{issues.length} 项校验提示 · 按 R{$curriculumStore.version} 重算</span>
  </div>

  {#if $curriculumStore.staged.length > 0}
    <section class="panel batch-panel">
      <div class="panel-head">
        <h3>待提交批次（{$curriculumStore.staged.length} 条）</h3>
        <span class="muted">提交基线 R{$curriculumStore.version} · 整批重放，冲突即整批退回</span>
      </div>
      {#if stagedCycle}
        <div class="precheck">预检：暂存边与当前图谱重放后前置成环（{stagedCycle.join(' → ')}），提交将被整批退回。</div>
      {/if}
      <div class="batch-list">
        {#each $curriculumStore.staged as edge}
          <div class:conflict={conflictEdgeIds.has(edge.id)}>
            <span class="edge-id">{edge.id}</span>
            <span>{nodeLabel(edge.source)} → {nodeLabel(edge.target)}</span>
            <b>{edge.relation}</b>
            <small>权重 {Math.round(edge.weight * 100)}%</small>
            {#if conflictEdgeIds.has(edge.id)}
              <em>{$curriculumStore.conflicts.find((conflict) => conflict.edgeId === edge.id)?.detail}</em>
            {/if}
            <button class="btn-secondary" onclick={() => curriculumStore.unstageEdge(edge.id)}>移除</button>
          </div>
        {/each}
      </div>
      <div class="batch-actions">
        <label class="simulate"><input type="checkbox" bind:checked={simulateFailure} /> 模拟写入失败（演示整批留存与重试）</label>
        <button class="btn-secondary" onclick={() => curriculumStore.clearStaged()}>清空批次</button>
        <button class="btn-primary" disabled={submitting} onclick={commitStaged}>{submitting ? '提交中…' : `按基线 R${$curriculumStore.version} 提交批次`}</button>
      </div>
    </section>
  {/if}

  {#if $curriculumStore.outbox.length > 0}
    <section class="panel outbox-panel">
      <div class="panel-head"><h3>写入失败待重试（{$curriculumStore.outbox.length} 批）</h3><span class="muted">重试沿用原边号，已生效部分自动跳过</span></div>
      <div class="batch-list">
        {#each $curriculumStore.outbox as batch}
          <div>
            <span class="edge-id">{batch.batchId}</span>
            <span>{batch.edges.length} 条边 · 基于 R{batch.baseVersion}</span>
            <small>已试 {batch.attempts} 次 · {batch.lastError}</small>
            <button class="btn-primary" onclick={() => curriculumStore.retryBatch(batch.batchId)}>重试</button>
            <button class="btn-secondary" onclick={() => curriculumStore.discardBatch(batch.batchId)}>放弃</button>
          </div>
        {/each}
      </div>
    </section>
  {/if}

  {#if pendingAdjudications.length > 0}
    <section class="panel adjudication-panel">
      <div class="panel-head"><h3>待裁决：同一条边关系不同（{pendingAdjudications.length}）</h3><span class="muted">他人已基于同一基线写入该边</span></div>
      <div class="batch-list">
        {#each pendingAdjudications as item}
          <div>
            <span class="edge-id">{item.edge.id}</span>
            <span>{nodeLabel(item.edge.source)} → {nodeLabel(item.edge.target)}</span>
            <b>图谱现有：{item.existingRelation} {Math.round(item.existingWeight * 100)}%</b>
            <b>本批提交：{item.edge.relation} {Math.round(item.edge.weight * 100)}%</b>
            <button class="btn-primary" onclick={() => curriculumStore.resolveAdjudication(item.id, '采用新边')}>采用新边</button>
            <button class="btn-secondary" onclick={() => curriculumStore.resolveAdjudication(item.id, '保留现有')}>保留现有</button>
          </div>
        {/each}
      </div>
    </section>
  {/if}

  <div class="matrix-layout">
    <section class="panel graph-panel">
      <div class="panel-head"><h3>课程改革有向图</h3><span class="muted">实线已生效 · 虚线待提交 · 拖拽节点重排</span></div>
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <svg role="application" aria-label="课程映射拖拽图" viewBox="0 0 1200 520" onmousemove={drag} onmouseup={() => (dragging = null)} onmouseleave={() => (dragging = null)}>
        <defs><marker id="arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 z" fill="#688086" /></marker></defs>
        {#each $curriculumStore.mappings as mapping}
          {@const from = $curriculumStore.nodes.find((node) => node.id === mapping.source)}
          {@const to = $curriculumStore.nodes.find((node) => node.id === mapping.target)}
          {#if from && to && visibleIds.has(from.id) && visibleIds.has(to.id)}
            <line x1={from.x + 80} y1={from.y + 28} x2={to.x} y2={to.y + 28} class:relation={true} marker-end="url(#arrow)" />
            <text x={(from.x + to.x) / 2 + 80} y={(from.y + to.y) / 2 + 22} class="edge-label">{mapping.relation}</text>
          {/if}
        {/each}
        {#each $curriculumStore.staged as edge}
          {@const from = $curriculumStore.nodes.find((node) => node.id === edge.source)}
          {@const to = $curriculumStore.nodes.find((node) => node.id === edge.target)}
          {#if from && to && visibleIds.has(from.id) && visibleIds.has(to.id)}
            <line x1={from.x + 80} y1={from.y + 28} x2={to.x} y2={to.y + 28} class="staged-edge" class:conflict-edge={conflictEdgeIds.has(edge.id)} marker-end="url(#arrow)" />
            <text x={(from.x + to.x) / 2 + 80} y={(from.y + to.y) / 2 + 34} class="edge-label staged-label">{edge.relation}（待提交）</text>
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
      <div class="panel-head"><h3>覆盖矩阵</h3><span class="muted">Σ 权重 · R{$curriculumStore.version} 重算</span></div>
      <div class="coverage-matrix">
        {#each coverageRows as row}
          <div class="matrix-row">
            <strong>{row.requirement.label.split('\n')[0]}</strong>
            {#each row.cells as cell}
              <span class:covered={cell.links.length}>{cell.links.length ? Math.round(cell.links.reduce((sum, link) => sum + link.weight, 0) * 100) : '—'}</span>
            {/each}
          </div>
        {/each}
      </div>
      <div class="legend"><span><i class="covered-dot"></i>已有映射</span><span><i class="gap-dot"></i>覆盖缺口</span></div>
      {#if issues.length > 0}
        <div class="issue-list">
          {#each issues as issue}
            <article class:error={issue.severity === '错误'}><strong>{issue.title}</strong><p>{issue.detail}</p></article>
          {/each}
        </div>
      {/if}
      <div class="node-detail">
        {#if selected}
          <strong>{selected.label.split('\n')[0]}</strong><p>{selected.id} · {selected.type}</p><button class="btn-secondary">编辑节点信息</button>
        {/if}
      </div>
    </aside>
  </div>
</section>

<style>
  .actions { display: flex; gap: 8px; }
  .version-chip { padding: 3px 9px; border-radius: 999px; color: #2c5f63; background: #e2efee; font-size: 12px; font-weight: 700; vertical-align: middle; }
  .notice { margin-bottom: 12px; padding: 11px 14px; border-left: 3px solid #2f6f72; color: #28555a; background: #ecf4f3; font-size: 12px; }
  .notice.error { border-color: #bd4d35; color: #913c2b; background: #fff1ec; }
  .notice.migrating { border-color: #c98a2e; color: #8a5c1d; background: #fff6e7; }
  .matrix-toolbar { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; margin-bottom: 12px; padding: 12px; }
  .matrix-toolbar > input:first-child { max-width: 220px; }
  .matrix-toolbar select { max-width: 230px; }
  .batch-panel, .outbox-panel, .adjudication-panel { margin-bottom: 12px; }
  .outbox-panel { border-color: #e3c9a1; }
  .adjudication-panel { border-color: #c9b6e0; }
  .precheck { margin: 12px 16px 0; padding: 10px 12px; border-left: 3px solid #bd4d35; color: #913c2b; background: #fff1ec; font-size: 12px; }
  .batch-list { display: grid; gap: 7px; padding: 14px 16px; }
  .batch-list > div { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 9px 11px; border: 1px solid #e0e6e6; border-radius: 7px; font-size: 12px; }
  .batch-list > div.conflict { border-color: #d88a75; background: #fff4f0; }
  .batch-list em { flex-basis: 100%; color: #a94430; font-size: 11px; font-style: normal; }
  .edge-id { padding: 2px 7px; border-radius: 4px; color: #3b6970; background: #e7eff0; font-size: 10px; font-weight: 700; }
  .batch-list b { color: #2d7375; }
  .batch-list small { color: #79868c; }
  .batch-actions { display: flex; align-items: center; justify-content: flex-end; gap: 10px; padding: 0 16px 14px; }
  .simulate { display: flex; align-items: center; gap: 6px; margin-right: auto; font-weight: 400; }
  .simulate input { width: auto; }
  .matrix-layout { display: grid; grid-template-columns: minmax(0,1fr) 360px; gap: 14px; align-items: start; }
  svg { display: block; width: 100%; min-width: 900px; background: radial-gradient(circle,#dce2e2 1px,transparent 1px); background-size: 22px 22px; }
  .graph-panel { overflow: auto; }
  line { stroke: #688086; stroke-width: 1.8; opacity: .65; }
  line.staged-edge { stroke: #2f6f72; stroke-dasharray: 6 4; opacity: .9; }
  line.conflict-edge { stroke: #bd4d35; }
  .edge-label { fill: #60757b; font-size: 9px; }
  .staged-label { fill: #2f6f72; }
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
  .issue-list { padding: 0 14px 12px; }
  .issue-list article { padding: 8px 0; border-top: 1px solid #edf0f0; }
  .issue-list strong { color: #9c6d25; font-size: 12px; }
  .issue-list article.error strong { color: #ac4433; }
  .issue-list p { margin: 4px 0 0; color: #68767d; font-size: 11px; }
  .node-detail { margin: 0 14px 14px; padding: 13px; border-left: 3px solid #377c7b; background: #f3f7f6; }
  .node-detail strong { display: block; }
  .node-detail p { margin: 5px 0 10px; color: #748188; font-size: 11px; }
  @media (max-width: 1050px) { .matrix-layout { grid-template-columns: 1fr; } }
</style>
