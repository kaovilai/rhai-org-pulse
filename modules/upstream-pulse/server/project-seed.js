/**
 * Declarative project seeding for the standalone upstream-pulse backend.
 *
 * The seed list (seed-projects.json) is version-controlled in this repo and
 * pushed to the upstream-pulse service: repositories missing from the backend
 * are registered with collection started from the repo's creation date (full
 * history), and already-tracked projects that have never been collected get a
 * one-time full-history backfill. The sync is idempotent — a 409 "already
 * tracked" response counts as success — so it is safe to re-run.
 */
const SEED_PROJECTS = require('./seed-projects.json');

const REQUEST_TIMEOUT = 90_000;

function projectKey(githubOrg, githubRepo) {
  return String(githubOrg).toLowerCase() + '/' + String(githubRepo).toLowerCase();
}

async function fetchJson(url, options) {
  const response = await fetch(url, {
    ...options,
    // Last so a caller-provided signal cannot silently drop the timeout.
    signal: AbortSignal.timeout(REQUEST_TIMEOUT),
  });
  const body = await response.json().catch(function() { return {}; });
  return { response, body };
}

async function createProject(baseUrl, headers, seed) {
  const { response, body } = await fetchJson(baseUrl + '/api/projects', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: seed.name,
      githubOrg: seed.githubOrg,
      githubRepo: seed.githubRepo,
      ecosystem: seed.ecosystem,
      // Collect from the repo's creation date so existing contributions are
      // captured, not just future activity.
      startCollection: true,
      fullHistory: true,
    }),
  });
  if (response.status === 409) return 'already-tracked';
  if (!response.ok) {
    throw new Error('create failed (' + response.status + '): ' + (body.error || 'unknown'));
  }
  // Job queuing is best-effort on the backend: a 200 can come back without a
  // collection job (collection: null + jobErrors). Queue one ourselves so the
  // project does not sit uncollected until some later run notices it.
  if (body.project && !body.collection) {
    await backfillProject(baseUrl, headers, body.project.id);
  }
  return 'created';
}

async function backfillProject(baseUrl, headers, projectId) {
  const { response, body } = await fetchJson(baseUrl + '/api/admin/collect', {
    method: 'POST',
    headers,
    body: JSON.stringify({ projectId, fullHistory: true }),
  });
  if (!response.ok) {
    throw new Error('backfill failed (' + response.status + '): ' + (body.error || 'unknown'));
  }
}

/**
 * Project IDs with a collection job already pending or running. Re-queueing a
 * full-history backfill while one is still in flight would duplicate the
 * backend's GitHub work (lastSyncAt only advances when a job completes).
 */
async function getInFlightProjectIds(baseUrl, headers) {
  const { response, body } = await fetchJson(baseUrl + '/api/system/status', { headers });
  if (!response.ok) {
    throw new Error('failed to fetch system status (' + response.status + '): ' + (body.error || 'unknown'));
  }
  const inFlight = new Set();
  for (const job of body.recentJobs || []) {
    if ((job.status === 'pending' || job.status === 'running') && job.projectId) {
      inFlight.add(job.projectId);
    }
  }
  return inFlight;
}

/**
 * Ensure every seed-listed repository is tracked by the upstream-pulse backend.
 * Per-project failures are collected in `errors` instead of aborting the run,
 * so one unreachable repository does not block the others; the next sync
 * retries whatever is still missing.
 */
async function ensureProjectsSeeded({ baseUrl, headers = {} }) {
  const list = await fetchJson(baseUrl + '/api/projects', { headers });
  if (!list.response.ok) {
    throw new Error('failed to list projects (' + list.response.status + '): ' + (list.body.error || 'unknown'));
  }
  const existing = new Map(
    (list.body.projects || []).map(function(p) {
      return [projectKey(p.githubOrg, p.githubRepo), p];
    })
  );

  // Fetched lazily: only needed when a tracked project has never been collected.
  let inFlightProjectIds = null;

  const summary = { created: [], alreadyTracked: [], backfilled: [], errors: [] };

  for (const seed of SEED_PROJECTS) {
    const key = projectKey(seed.githubOrg, seed.githubRepo);
    try {
      const match = existing.get(key);
      if (!match) {
        if (await createProject(baseUrl, headers, seed) === 'created') {
          summary.created.push(key);
        } else {
          summary.alreadyTracked.push(key);
        }
        continue;
      }
      summary.alreadyTracked.push(key);
      // Already tracked but never collected (e.g. registered before this seed
      // existed): trigger a one-time full-history backfill — unless a
      // collection job is already in flight for it.
      if (!match.lastSyncAt) {
        if (inFlightProjectIds === null) {
          inFlightProjectIds = await getInFlightProjectIds(baseUrl, headers);
        }
        if (!inFlightProjectIds.has(match.id)) {
          await backfillProject(baseUrl, headers, match.id);
          summary.backfilled.push(key);
        }
      }
    } catch (err) {
      summary.errors.push({ project: key, error: err.message });
    }
  }

  summary.seeded = summary.errors.length === 0;
  summary.total = SEED_PROJECTS.length;
  return summary;
}

module.exports = { SEED_PROJECTS, REQUEST_TIMEOUT, ensureProjectsSeeded };
