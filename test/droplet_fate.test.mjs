import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {calculate} from '../src/calc.mjs';

const base=JSON.parse(await fs.readFile(new URL('../config/default_25mm.json',import.meta.url),'utf8'));

test('default droplet fate preserves suspended-droplet baseline',()=>{
  const r=calculate(structuredClone(base));
  assert.equal(r.release.derived.instantVaporFraction,0);
  assert.equal(r.release.derived.depositToPoolFraction,0);
  assert.equal(r.release.summary.dropletsKg,r.release.summary.rawDropletsKg);
  assert.equal(r.release.summary.instantDropletVaporizedKg,0);
});

test('full immediate vaporization moves droplets into gas source',()=>{
  const c=structuredClone(base);
  c.physical.dropletInstantVaporFraction=1;
  const r=calculate(c);
  assert.ok(r.release.summary.rawDropletsKg>0);
  assert.ok(Math.abs(r.release.summary.instantDropletVaporizedKg-r.release.summary.rawDropletsKg)<1e-7);
  assert.ok(r.release.summary.dropletsKg<1e-7);
  assert.ok(r.ventilation.derived.fanNm3H>calculate(structuredClone(base)).ventilation.derived.fanNm3H);
});

test('full deposition adds entrained droplets to the pool',()=>{
  const c=structuredClone(base);
  c.physical.dropletDepositToPoolFraction=1;
  const r=calculate(c);
  assert.ok(Math.abs(r.release.summary.dropletDepositedKg-r.release.summary.rawDropletsKg)<1e-7);
  assert.ok(r.release.summary.dropletsKg<1e-7);
  assert.ok(r.release.summary.intoPoolKg>calculate(structuredClone(base)).release.summary.intoPoolKg);
});

test('invalid droplet fate fractions are rejected',()=>{
  const c=structuredClone(base);
  c.physical.dropletInstantVaporFraction=.7;
  c.physical.dropletDepositToPoolFraction=.4;
  assert.throws(()=>calculate(c),/Droplet fate fractions/);
});
