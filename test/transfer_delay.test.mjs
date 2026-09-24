import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {calculate} from '../src/calc.mjs';
const base = JSON.parse(fs.readFileSync(new URL('../config/default_25mm.json', import.meta.url)));

test('zero delay preserves baseline fan and mass', () => {
  const r=calculate({...base,tank:{...base.tank,transferStartDelayS:0}});
  assert.ok(Math.abs(r.ventilation.derived.fanNm3H-5021.138776129302)<1e-7);
  assert.ok(Math.abs(r.release.summary.leakedKg-41652.78959726478)<1e-7);
});
test('30 s startup within 20 s grid matches constant-rate analytic balance', () => {
  const c=structuredClone(base); c.physical.gravityMS2=0; c.tank.transferStartDelayS=30;
  const r=calculate(c), s=r.release.summary, d=r.release.derived;
  const q=s.initialLeakRateKgS, p=d.transferPumpKgS;
  const end=30+(d.initialLiquidMassKg-q*30)/(q+p);
  assert.ok(Math.abs(s.leakDurationS-end)<1e-6);
  assert.ok(Math.abs(s.leakedKg-q*end)<1e-6);
  assert.equal(r.release.rows[0].transferredKg,0);
  assert.ok(Math.abs(r.release.rows[1].transferredKg-p*10)<1e-8);
  for(const x of r.release.rows) assert.ok(Math.abs(x.cumulativeLeakKg+x.cumulativeTransferredKg+x.remainingLiquidMassKg-d.initialLiquidMassKg)<1e-6);
});
test('startup after tank empties transfers nothing; invalid delay rejected', () => {
  const c=structuredClone(base); c.tank.transferStartDelayS=86400;
  const r=calculate(c);
  assert.equal(r.release.summary.transferredKg,0);
  assert.ok(Math.abs(r.release.summary.leakedKg-r.release.derived.initialLiquidMassKg)<1e-6);
  c.tank.transferStartDelayS=-1;
  assert.throws(()=>calculate(c),/transferStartDelayS/);
});
