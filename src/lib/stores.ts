import { writable, get } from 'svelte/store'
import { browser } from '$app/environment'
import type { GraphNode, Mapping, ReviewItem } from './seed'
import { seedState } from './seed'
import {
  commitEdges,
  migrateGraph,
  newCommitId,
  describeConflicts,
  type EdgeCommit,
  type EdgeConflict,
  type GraphState,
} from './graph'

type CurriculumState = GraphState & {
  reviewItems: ReviewItem[]
  revision: string
  locked: boolean
  draft: string
  /** 写入失败、整批留着重试的提交 */
  pendingCommits: EdgeCommit[]
  lastCommit: EdgeCommit | null
  commitError: string | null
  hydrated: boolean
}

const STORAGE_KEY = 'curriculum-map-draft-v2'

function loadInitial(): CurriculumState {
  const fallback = migrateGraph({
    nodes: seedState.nodes,
    mappings: seedState.mappings,
    graphVersion: 1,
  })
  if (!browser) {
    return {
      ...fallback,
      reviewItems: seedState.reviewItems,
      revision: seedState.revision,
      locked: seedState.locked,
      draft: 'C-308 对 GR-06 的案例证据不足，需补充评分记录。',
      pendingCommits: [],
      lastCommit: null,
      commitError: null,
      hydrated: false,
    }
  }
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')
    if (raw && Array.isArray(raw.nodes) && Array.isArray(raw.mappings)) {
      const migrated = migrateGraph(raw)
      return {
        ...migrated,
        reviewItems: Array.isArray(raw.reviewItems) ? raw.reviewItems : seedState.reviewItems,
        revision: raw.revision ?? seedState.revision,
        locked: raw.locked ?? seedState.locked,
        draft: raw.draft ?? 'C-308 对 GR-06 的案例证据不足，需补充评分记录。',
        pendingCommits: Array.isArray(raw.pendingCommits) ? raw.pendingCommits : [],
        lastCommit: null,
        commitError: null,
        hydrated: false,
      }
    }
  } catch {
    /* 落盘数据损坏时回退到种子 */
  }
  return {
    ...fallback,
    reviewItems: seedState.reviewItems,
    revision: seedState.revision,
    locked: seedState.locked,
    draft: 'C-308 对 GR-06 的案例证据不足，需补充评分记录。',
    pendingCommits: [],
    lastCommit: null,
    commitError: null,
    hydrated: false,
  }
}

function graphOf(state: CurriculumState): GraphState {
  return { nodes: state.nodes, mappings: state.mappings, graphVersion: state.graphVersion }
}

function createCurriculumStore() {
  const { subscribe, update } = writable<CurriculumState>(loadInitial())

  /** 打开时接入图谱：从服务端拉取当前基线，覆盖本地旧草稿（旧数据已在 loadInitial 迁移） */
  async function hydrate() {
    if (!browser) return
    try {
      const res = await fetch('/api/curriculum')
      if (!res.ok) return
      const data = await res.json()
      const server = migrateGraph({ nodes: data.nodes, mappings: data.mappings, graphVersion: data.graphVersion })
      update((state) => ({
        ...state,
        // 节点布局以本地为准，连边与基线号以服务端图谱为准
        mappings: server.mappings,
        graphVersion: server.graphVersion,
        reviewItems: Array.isArray(data.reviewItems) ? data.reviewItems : state.reviewItems,
        hydrated: true,
      }))
    } catch {
      /* 离线时沿用本地迁移后的图谱，提交走本地引擎 */
      update((state) => ({ ...state, hydrated: true }))
    }
  }

  /** 提交一批连边：携带当前图谱基线号，服务端按基线号整体重放 */
  async function commitBatch(edges: Mapping[]): Promise<{ ok: boolean; conflicts: EdgeConflict[] }> {
    const state = get({ subscribe })
    const commit: EdgeCommit = {
      id: newCommitId(),
      baseline: state.graphVersion,
      edges,
      status: '已退回',
      conflicts: [],
      createdAt: new Date().toISOString(),
    }

    let result
    try {
      const res = await fetch('/api/curriculum/edges', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commit }),
      })
      result = await res.json()
    } catch {
      result = commitEdges(graphOf(state), commit) // 离线回退：本地引擎同样语义
    }

    update((s) => {
      if (result.ok) {
        return {
          ...s,
          mappings: result.graph.mappings,
          graphVersion: result.graph.graphVersion,
          pendingCommits: s.pendingCommits.filter((c) => c.id !== commit.id),
          lastCommit: result.commit,
          commitError: null,
        }
      }
      return {
        ...s,
        pendingCommits: [...s.pendingCommits.filter((c) => c.id !== commit.id), result.commit],
        lastCommit: result.commit,
        commitError: describeConflicts(result.conflicts),
      }
    })

    // 冲突后重新拉取图谱，呈现对方已写入的边与基线
    if (!result.ok) await hydrate()
    return { ok: result.ok, conflicts: result.conflicts }
  }

  /** 重试：按边号跳过已生效部分，再重放剩余边 */
  async function retryCommit(commitId: string, force = false) {
    const state = get({ subscribe })
    const commit = state.pendingCommits.find((c) => c.id === commitId)
    if (!commit) return
    let result
    try {
      const res = await fetch('/api/curriculum/edges', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commit, force }),
      })
      result = await res.json()
    } catch {
      result = commitEdges(graphOf(state), commit, { force })
    }
    update((s) => {
      if (result.ok) {
        return {
          ...s,
          mappings: result.graph.mappings,
          graphVersion: result.graph.graphVersion,
          pendingCommits: s.pendingCommits.filter((c) => c.id !== commitId),
          lastCommit: result.commit,
          commitError: null,
        }
      }
      return {
        ...s,
        pendingCommits: s.pendingCommits.map((c) => (c.id === commitId ? result.commit : c)),
        lastCommit: result.commit,
        commitError: describeConflicts(result.conflicts),
      }
    })
    if (!result.ok) await hydrate()
  }

  /** 撤回某条冲突边后整批再提交 */
  async function withdrawEdge(commitId: string, edgeId: string) {
    const state = get({ subscribe })
    const commit = state.pendingCommits.find((c) => c.id === commitId)
    if (!commit) return
    const edges = commit.edges.filter((e) => e.id !== edgeId)
    update((s) => ({
      ...s,
      pendingCommits:
        edges.length === 0
          ? s.pendingCommits.filter((c) => c.id !== commitId)
          : s.pendingCommits.map((c) =>
              c.id === commitId
                ? { ...c, edges, conflicts: c.conflicts.filter((x) => x.edgeId !== edgeId), status: '已退回' }
                : c,
            ),
    }))
    if (edges.length > 0) await retryCommit(commitId)
  }

  function discardCommit(commitId: string) {
    update((s) => ({
      ...s,
      pendingCommits: s.pendingCommits.filter((c) => c.id !== commitId),
      commitError: null,
    }))
  }

  return {
    subscribe,
    hydrate,
    commitBatch,
    retryCommit,
    withdrawEdge,
    discardCommit,
    moveNode(id: string, x: number, y: number) {
      update((state) => ({ ...state, nodes: state.nodes.map((node) => (node.id === id ? { ...node, x, y } : node)) }))
    },
    updateReview(id: string, status: ReviewItem['status'], comment: string) {
      update((state) => ({
        ...state,
        reviewItems: state.reviewItems.map((item) => (item.id === id ? { ...item, status, comment } : item)),
      }))
    },
    saveDraft(draft: string) {
      update((state) => ({ ...state, draft }))
    },
    lock(revision: string) {
      update((state) => ({ ...state, revision, locked: true }))
    },
  }
}

export const curriculumStore = createCurriculumStore()

if (browser) {
  curriculumStore.subscribe((state) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    } catch {
      /* 存储不可用时忽略 */
    }
  })
  // 打开时自动迁移并接入图谱
  curriculumStore.hydrate()
}
