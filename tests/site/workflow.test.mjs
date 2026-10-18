import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';

const workflow = parse(await readFile(new URL('../../.github/workflows/monitor.yml', import.meta.url), 'utf8'));
const job = workflow.jobs.monitor;
const steps = job.steps;
const indexOf = (predicate) => steps.findIndex(predicate);

test('the workflow runs only on schedule and manual default-branch invocations', () => {
  assert.deepEqual(Object.keys(workflow.on).sort(), ['schedule', 'workflow_dispatch']);
  assert.equal(workflow.on.schedule[0].cron, '*/5 * * * *');
  assert.match(job.if, /refs\/heads\/main/);
  assert.equal(job.env.UPP_DEFAULT_BRANCH, 'main');
  assert.equal(JSON.stringify(workflow).includes('pull_request'), false);
});

test('permissions are read-only and concurrency never cancels a checkpoint writer', () => {
  assert.deepEqual(workflow.permissions, { contents: 'read', actions: 'read' });
  assert.equal(workflow.concurrency.group, 'site-availability-monitor');
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
});

test('runtime, actions and install are pinned and lockfile-based', () => {
  assert.equal(String(steps.find((step) => step.uses?.startsWith('actions/setup-node')).with['node-version']), '24');
  assert.ok(steps.some((step) => step.run === 'npm ci'));
  for (const step of steps.filter((item) => item.uses)) {
    assert.match(step.uses, /@v\d+$/, step.uses);
  }
  assert.ok(job['timeout-minutes'] > 0);
});

test('the monitor runs before the build, and the artifact is staged and uploaded only after both', () => {
  const monitor = indexOf((step) => step.run === 'npm run monitor');
  const build = indexOf((step) => step.run === 'npm run build');
  const stage = indexOf((step) => typeof step.run === 'string' && step.run.includes('artifact/checkpoint.json'));
  const upload = indexOf((step) => step.uses?.startsWith('actions/upload-artifact'));
  assert.ok(monitor >= 0 && build > monitor && stage > build && upload > stage);
  assert.equal(upload, steps.length - 1);
  assert.equal(steps[upload].if, 'success()');
  assert.equal(steps[upload].with.name, 'site-availability-${{ github.run_id }}-${{ github.run_attempt }}');
});

test('no step continues after a failure, so infrastructure errors fail the workflow', () => {
  assert.equal(steps.some((step) => step['continue-on-error']), false);
});
