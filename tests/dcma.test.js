#!/usr/bin/env node
/**
 * tests/dcma.test.js
 * Unit tests for DCMA logic extracted from js/dcma.js.
 * Runs with Node.js (no browser required).
 */
'use strict';

let passed = 0, failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  ✓ ${msg}`);
    passed++;
  } else {
    console.error(`  ✗ ${msg}`);
    failed++;
  }
}

function assertClose(a, b, msg, tol = 0.001) {
  assert(Math.abs(a - b) <= tol, `${msg} (got ${a}, expected ${b})`);
}

// ── DCMA check logic (pure functions, no imports) ────────────────────────────

console.log('\n== DCMA Check 1: Logic ties (no predecessors except WBS level 1) ==');

function countMissingLogic(tasks) {
  // Tasks with no predecessors AND not level-1 WBS → logic tie missing
  return tasks.filter(t => {
    const isTopLevel = !t.parent_id;
    return !isTopLevel && (!t.predecessors || t.predecessors.length === 0);
  }).length;
}

{
  const tasks = [
    { id: 'A', parent_id: null, predecessors: [] },   // root — OK
    { id: 'B', parent_id: 'A',  predecessors: ['A'] }, // has pred — OK
    { id: 'C', parent_id: 'A',  predecessors: [] },    // no pred + not root → missing
  ];
  assert(countMissingLogic(tasks) === 1, 'Detects 1 task with missing logic tie');
}

{
  const tasks = [
    { id: 'A', parent_id: null, predecessors: [] },
    { id: 'B', parent_id: 'A',  predecessors: ['A'] },
    { id: 'C', parent_id: 'A',  predecessors: ['B'] },
  ];
  assert(countMissingLogic(tasks) === 0, 'No missing logic when all have predecessors');
}


console.log('\n== DCMA Check 2: Leads (negative lags) ==');

function countLeads(deps) {
  return deps.filter(d => (d.lag || 0) < 0).length;
}

{
  const deps = [
    { from: 'A', to: 'B', lag: 0 },
    { from: 'A', to: 'C', lag: -2 },
    { from: 'B', to: 'D', lag: 3 },
  ];
  assert(countLeads(deps) === 1, 'Detects 1 lead (negative lag)');
}

{
  const deps = [
    { from: 'A', to: 'B', lag: 0 },
    { from: 'B', to: 'C', lag: 5 },
  ];
  assert(countLeads(deps) === 0, 'No leads when all lags >= 0');
}


console.log('\n== DCMA Check 3: Lags (positive lags) ==');

function countLags(deps) {
  return deps.filter(d => (d.lag || 0) > 0).length;
}

{
  const deps = [{ from: 'A', to: 'B', lag: 5 }, { from: 'B', to: 'C', lag: 0 }];
  assert(countLags(deps) === 1, 'Detects 1 positive lag');
}


console.log('\n== DCMA Check 4: Relationships (non-FS dependencies) ==');

function countNonFS(deps) {
  return deps.filter(d => d.type && d.type !== 'FS').length;
}

{
  const deps = [
    { from: 'A', to: 'B', type: 'FS' },
    { from: 'A', to: 'C', type: 'SS' },
    { from: 'B', to: 'D', type: 'FF' },
  ];
  assert(countNonFS(deps) === 2, 'Detects 2 non-FS relationships');
}


console.log('\n== DCMA Check 5: High float (> 44 days) ==');

function countHighFloat(tasks, threshold = 44) {
  return tasks.filter(t => {
    const tf = t.totalFloat ?? t.tf ?? 0;
    return tf > threshold;
  }).length;
}

{
  const tasks = [
    { id: 'A', totalFloat: 10 },
    { id: 'B', totalFloat: 50 },
    { id: 'C', totalFloat: 44 },
    { id: 'D', totalFloat: 45 },
  ];
  assert(countHighFloat(tasks) === 2, 'Detects 2 tasks with float > 44 days (50 and 45)');
  assert(countHighFloat(tasks, 44) === 2, 'Threshold is exclusive at 44');
}


console.log('\n== DCMA Check 6: Negative float ==');

function countNegativeFloat(tasks) {
  return tasks.filter(t => {
    const tf = t.totalFloat ?? t.tf ?? 0;
    return tf < 0;
  }).length;
}

{
  const tasks = [
    { id: 'A', totalFloat: 0 },
    { id: 'B', totalFloat: -5 },
    { id: 'C', totalFloat: -1 },
  ];
  assert(countNegativeFloat(tasks) === 2, 'Detects 2 tasks with negative float');
}


console.log('\n== DCMA Scoring ==');

function computeScore(checks) {
  const applicable = checks.filter(c => !c.na);
  if (!applicable.length) return 100;
  const passing = applicable.filter(c => c.pass).length;
  return Math.round(passing / applicable.length * 100);
}

{
  const checks = [
    { na: false, pass: true },
    { na: false, pass: true },
    { na: false, pass: false },
    { na: true,  pass: false },
  ];
  assertClose(computeScore(checks), 67, 'Score 67% (2/3 applicable pass)', 1);
}

{
  const checks = [
    { na: false, pass: true },
    { na: false, pass: true },
  ];
  assertClose(computeScore(checks), 100, 'Score 100% when all pass');
}

{
  const checks = [
    { na: true, pass: false },
    { na: true, pass: false },
  ];
  assertClose(computeScore(checks), 100, 'Score 100% when all N/A');
}


console.log('\n== DCMA Check thresholds ==');

// Check 1 (missing logic): ≤ 5% threshold
function check1Pass(tasks) {
  const nonSummary = tasks.filter(t => t.parent_id);
  if (!nonSummary.length) return true;
  const missing = countMissingLogic(tasks);
  return (missing / nonSummary.length * 100) <= 5;
}

{
  const tasks = [
    { id: 'root', parent_id: null, predecessors: [] },
    ...Array.from({ length: 100 }, (_, i) => ({
      id: `T${i}`, parent_id: 'root',
      predecessors: i < 95 ? [`T${i - 1}`] : []  // last 5 have no preds = 5%
    }))
  ];
  assert(check1Pass(tasks), 'Check 1 passes at exactly 5% missing logic');
}

{
  const tasks = [
    { id: 'root', parent_id: null, predecessors: [] },
    ...Array.from({ length: 100 }, (_, i) => ({
      id: `T${i}`, parent_id: 'root',
      predecessors: i < 94 ? [`T${i - 1}`] : []  // 6% missing → fail
    }))
  ];
  assert(!check1Pass(tasks), 'Check 1 fails above 5% missing logic');
}


// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
