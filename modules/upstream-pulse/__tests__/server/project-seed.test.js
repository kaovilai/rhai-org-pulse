import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { SEED_PROJECTS, ensureProjectsSeeded } = await import('../../server/project-seed.js')

const BASE = 'http://upstream-test'
const HEADERS = { 'Content-Type': 'application/json', 'x-forwarded-user': 'roster-sync-service' }

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

function seedKeys() {
  return SEED_PROJECTS.map(p => `${p.githubOrg}/${p.githubRepo}`.toLowerCase())
}

function existingProject(seed, overrides = {}) {
  return {
    id: 'id-' + seed.githubRepo,
    name: seed.name,
    ecosystem: seed.ecosystem,
    githubOrg: seed.githubOrg,
    githubRepo: seed.githubRepo,
    trackingEnabled: true,
    lastSyncAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

let fetchMock

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function mockBackend({ projects = [], createStatus = 200, createFailFor = [], createWithoutCollectionJob = [], recentJobs = [] } = {}) {
  fetchMock.mockImplementation(async (url, options = {}) => {
    const method = options.method || 'GET'
    if (url === BASE + '/api/projects' && method === 'GET') {
      return jsonResponse(200, { projects, total: projects.length })
    }
    if (url === BASE + '/api/projects' && method === 'POST') {
      const body = JSON.parse(options.body)
      const key = `${body.githubOrg}/${body.githubRepo}`.toLowerCase()
      if (createFailFor.includes(key)) {
        return jsonResponse(500, { error: 'boom' })
      }
      if (createStatus === 409) {
        return jsonResponse(409, { error: 'This repository is already being tracked' })
      }
      return jsonResponse(200, {
        success: true,
        project: { ...body, id: 'new-' + key },
        // Job queuing is best-effort on the backend; simulate it being skipped.
        collection: createWithoutCollectionJob.includes(key) ? null : { jobId: 'job-' + key },
      })
    }
    if (url === BASE + '/api/system/status' && method === 'GET') {
      return jsonResponse(200, { recentJobs })
    }
    if (url === BASE + '/api/admin/collect' && method === 'POST') {
      return jsonResponse(200, { success: true, jobId: 'job-1' })
    }
    throw new Error('unexpected fetch: ' + method + ' ' + url)
  })
}

function postBodies() {
  return fetchMock.mock.calls
    .filter(([url, options]) => url === BASE + '/api/projects' && (options?.method === 'POST'))
    .map(([, options]) => JSON.parse(options.body))
}

function collectBodies() {
  return fetchMock.mock.calls
    .filter(([url]) => url === BASE + '/api/admin/collect')
    .map(([, options]) => JSON.parse(options.body))
}

describe('seed-projects list', () => {
  it('contains the OADP upstream repository set from issue #1742', () => {
    expect(seedKeys()).toEqual([
      'velero-io/velero',
      'velero-io/velero-plugin-for-aws',
      'velero-io/velero-plugin-for-gcp',
      'velero-io/velero-plugin-for-microsoft-azure',
      'broadcom/kopia',
      'kopia/kopia',
      'restic/restic',
      'filebrowser/filebrowser',
    ])
  })

  it('has name and ecosystem on every entry', () => {
    for (const seed of SEED_PROJECTS) {
      expect(seed.name).toBeTruthy()
      expect(seed.ecosystem).toBeTruthy()
    }
  })

  it('uses lowercase GitHub orgs (the backend filters orgs case-sensitively)', () => {
    for (const seed of SEED_PROJECTS) {
      expect(seed.githubOrg).toBe(seed.githubOrg.toLowerCase())
      expect(seed.githubRepo).toBe(seed.githubRepo.toLowerCase())
    }
  })
})

describe('ensureProjectsSeeded', () => {
  it('creates missing projects with full-history collection', async () => {
    mockBackend({ projects: [] })

    const result = await ensureProjectsSeeded({ baseUrl: BASE, headers: HEADERS })

    expect(result.seeded).toBe(true)
    expect(result.total).toBe(SEED_PROJECTS.length)
    expect(result.created).toEqual(seedKeys())
    expect(result.alreadyTracked).toEqual([])
    expect(result.backfilled).toEqual([])
    expect(result.errors).toEqual([])

    const bodies = postBodies()
    expect(bodies).toEqual(SEED_PROJECTS.map(seed => ({
      name: seed.name,
      githubOrg: seed.githubOrg,
      githubRepo: seed.githubRepo,
      ecosystem: seed.ecosystem,
      startCollection: true,
      fullHistory: true,
    })))
    expect(collectBodies()).toEqual([])
  })

  it('sends the service identity headers on every request', async () => {
    mockBackend({ projects: [] })

    await ensureProjectsSeeded({ baseUrl: BASE, headers: HEADERS })

    for (const [, options] of fetchMock.mock.calls) {
      expect(options.headers['x-forwarded-user']).toBe('roster-sync-service')
    }
  })

  it('skips projects that are already tracked', async () => {
    const tracked = [SEED_PROJECTS[0], SEED_PROJECTS[5]]
    mockBackend({ projects: tracked.map(s => existingProject(s)) })

    const result = await ensureProjectsSeeded({ baseUrl: BASE, headers: HEADERS })

    expect(result.created).toHaveLength(SEED_PROJECTS.length - tracked.length)
    expect(result.alreadyTracked).toEqual(tracked.map(s => `${s.githubOrg}/${s.githubRepo}`.toLowerCase()))
    expect(result.backfilled).toEqual([])
    expect(result.errors).toEqual([])
    expect(collectBodies()).toEqual([])
  })

  it('backfills tracked projects that were never collected', async () => {
    const neverCollected = existingProject(SEED_PROJECTS[0], { lastSyncAt: null })
    mockBackend({ projects: [neverCollected] })

    const result = await ensureProjectsSeeded({ baseUrl: BASE, headers: HEADERS })

    expect(result.alreadyTracked).toEqual(['velero-io/velero'])
    expect(result.backfilled).toEqual(['velero-io/velero'])
    expect(collectBodies()).toEqual([{ projectId: 'id-velero', fullHistory: true }])
  })

  it('does not backfill projects the daily scheduler already collects', async () => {
    const collected = existingProject(SEED_PROJECTS[0])
    mockBackend({ projects: [collected] })

    const result = await ensureProjectsSeeded({ baseUrl: BASE, headers: HEADERS })

    expect(result.backfilled).toEqual([])
    expect(collectBodies()).toEqual([])
  })

  it('treats a 409 create response as already tracked', async () => {
    mockBackend({ projects: [], createStatus: 409 })

    const result = await ensureProjectsSeeded({ baseUrl: BASE, headers: HEADERS })

    expect(result.seeded).toBe(true)
    expect(result.created).toEqual([])
    expect(result.alreadyTracked).toEqual(seedKeys())
    expect(result.errors).toEqual([])
  })

  it('records per-project errors and continues with the rest', async () => {
    mockBackend({ projects: [], createFailFor: ['velero-io/velero'] })

    const result = await ensureProjectsSeeded({ baseUrl: BASE, headers: HEADERS })

    expect(result.seeded).toBe(false)
    expect(result.created).toHaveLength(SEED_PROJECTS.length - 1)
    expect(result.errors).toEqual([
      { project: 'velero-io/velero', error: 'create failed (500): boom' },
    ])
  })

  it('throws when the project list cannot be fetched', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(503, { error: 'unavailable' }))

    await expect(ensureProjectsSeeded({ baseUrl: BASE, headers: HEADERS }))
      .rejects.toThrow('failed to list projects (503): unavailable')
  })

  it('queues collection itself when creation returns without a collection job', async () => {
    mockBackend({ projects: [], createWithoutCollectionJob: ['velero-io/velero'] })

    const result = await ensureProjectsSeeded({ baseUrl: BASE, headers: HEADERS })

    expect(result.seeded).toBe(true)
    expect(result.created).toEqual(seedKeys())
    expect(collectBodies()).toEqual([{ projectId: 'new-velero-io/velero', fullHistory: true }])
  })

  it('does not re-queue backfill while a collection job is in flight', async () => {
    const neverCollected = existingProject(SEED_PROJECTS[0], { lastSyncAt: null })
    mockBackend({
      projects: [neverCollected],
      recentJobs: [{ projectId: neverCollected.id, jobType: 'sync', status: 'running' }],
    })

    const result = await ensureProjectsSeeded({ baseUrl: BASE, headers: HEADERS })

    expect(result.alreadyTracked).toEqual(['velero-io/velero'])
    expect(result.backfilled).toEqual([])
    expect(collectBodies()).toEqual([])
  })

  it('re-queues backfill when the in-flight job has finished without syncing', async () => {
    const neverCollected = existingProject(SEED_PROJECTS[0], { lastSyncAt: null })
    mockBackend({
      projects: [neverCollected],
      recentJobs: [{ projectId: neverCollected.id, jobType: 'sync', status: 'failed' }],
    })

    const result = await ensureProjectsSeeded({ baseUrl: BASE, headers: HEADERS })

    expect(result.backfilled).toEqual(['velero-io/velero'])
    expect(collectBodies()).toEqual([{ projectId: 'id-velero', fullHistory: true }])
  })
})
