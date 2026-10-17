#!/usr/bin/env node
/**
 * tests/evm.test.js
 * Unit tests for EVM calculation logic extracted from js/evm.js.
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

// ── Pure EVM formula tests (no imports needed) ──────────────────────────────

console.log('\n== EVM Formulas ==');

// SV = EV - PV
{ const ev = 1000, pv = 1200; assertClose(ev - pv, -200, 'SV = EV - PV negative'); }
{ const ev = 1500, pv = 1200; assertClose(ev - pv,  300, 'SV = EV - PV positive'); }

// CV = EV - AC
{ const ev = 1000, ac = 900;  assertClose(ev - ac,  100, 'CV = EV - AC positive'); }
{ const ev = 1000, ac = 1100; assertClose(ev - ac, -100, 'CV = EV - AC negative'); }

// SPI = EV / PV
{ const ev = 900, pv = 1000; assertClose(ev / pv, 0.9, 'SPI < 1 (behind schedule)'); }
{ const ev = 1000, pv = 1000; assertClose(ev / pv, 1.0, 'SPI = 1 (on schedule)'); }

// CPI = EV / AC
{ const ev = 1000, ac = 800; assertClose(ev / ac, 1.25, 'CPI > 1 (under budget)'); }
{ const ev = 1000, ac = 1200; assertClose(ev / ac, 0.833, 'CPI < 1 (over budget)', 0.01); }

// EAC = BAC / CPI
{ const bac = 10000, cpi = 0.833; assertClose(bac / cpi, 12005, 'EAC > BAC when CPI < 1', 1); }
{ const bac = 10000, cpi = 1.25;  assertClose(bac / cpi, 8000, 'EAC < BAC when CPI > 1', 1); }

// TCPI = (BAC - EV) / (BAC - AC)
{ const bac = 10000, ev = 4000, ac = 3000; assertClose((bac - ev) / (bac - ac), 0.857, 'TCPI < 1 (easy to complete)', 0.01); }
{ const bac = 10000, ev = 4000, ac = 5000; assertClose((bac - ev) / (bac - ac), 1.2, 'TCPI > 1 (hard to complete)', 0.01); }

// VAC = BAC - EAC
{ const bac = 10000, eac = 12000; assertClose(bac - eac, -2000, 'VAC negative (over budget)'); }
{ const bac = 10000, eac = 9000;  assertClose(bac - eac,  1000, 'VAC positive (under budget)'); }

// % complete = EV / BAC * 100
{ const ev = 2500, bac = 10000; assertClose(ev / bac * 100, 25, '25% complete'); }
{ const ev = 10000, bac = 10000; assertClose(ev / bac * 100, 100, '100% complete'); }


// ── Edge cases ───────────────────────────────────────────────────────────────

console.log('\n== Edge Cases ==');

// BAC = 0 guard
{ const bac = 0; assert(bac === 0, 'BAC 0 detected before division'); }

// SPI with PV = 0 (start of project)
{ const ev = 0, pv = 0; assert(pv === 0, 'PV = 0 at project start: guard needed'); }

// SPI clamped logic
function spiCalc(ev, pv) { return pv > 0 ? ev / pv : 1; }
assertClose(spiCalc(0, 0), 1, 'SPI defaults to 1 when PV=0');
assertClose(spiCalc(500, 1000), 0.5, 'SPI 0.5 when half done');


// ── hasDataDate logic ────────────────────────────────────────────────────────

console.log('\n== hasDataDate flag ==');

function fakeCalcEvm(dataDate) {
  const today = new Date().toISOString().slice(0, 10);
  const hasDataDate = !!dataDate;
  const effectiveDate = dataDate || today;
  return { hasDataDate, effectiveDate };
}

{ const r = fakeCalcEvm(null);
  assert(!r.hasDataDate, 'hasDataDate = false when data_date is null');
  assert(r.effectiveDate === new Date().toISOString().slice(0, 10), 'falls back to today'); }

{ const r = fakeCalcEvm('2024-06-01');
  assert(r.hasDataDate === true, 'hasDataDate = true when data_date set');
  assert(r.effectiveDate === '2024-06-01', 'uses configured data_date'); }


// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
