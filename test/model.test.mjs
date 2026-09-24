import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { calculate } from "../src/calc.mjs";
const base = JSON.parse(fs.readFileSync(new URL("../config/default_25mm.json", import.meta.url)));
test("explicit room volume controls mixing inventory independently of dimensions", () => {
 const c=structuredClone(base); c.simulation.maxTimeS=10;
 const r=calculate(c);
 c.ventilation.roomVolumeM3 *= 2;
 const larger=calculate(c);
 assert.equal(larger.ventilation.derived.roomInventoryKmol,2*r.ventilation.derived.roomInventoryKmol);
 assert.ok(larger.ventilation.rows[0].chlorineMolFraction<r.ventilation.rows[0].chlorineMolFraction);
 assert.equal(larger.ventilation.derived.fanNm3H,r.ventilation.derived.fanNm3H);
 delete c.ventilation.roomVolumeM3;
 assert.equal(calculate(c).ventilation.derived.roomVolumeM3,8640);
 c.ventilation.roomVolumeM3=0;
 assert.throws(()=>calculate(c),/roomVolumeM3/);
});
test("pool spreading limit is derived from room plan dimensions", () => {
 const c=structuredClone(base); c.ventilation.roomLengthM=10; c.ventilation.roomWidthM=8;
 const r=calculate(c);
 assert.equal(r.release.derived.maxPoolAreaM2,80);
 assert.ok(Math.max(...r.release.rows.map(x=>x.poolAreaM2))<=80);
});
test("surface wind is derived once from the Q1 plus Q2 preliminary fan", () => {
 const r=calculate(base);
 const d=r.release.derived;
 assert.equal(d.effectiveFlowAreaM2,Math.min(base.ventilation.roomLengthM,base.ventilation.roomWidthM)*base.ventilation.roomHeightM);
 assert.ok(Math.abs(d.equivalentSurfaceWindMS-d.preliminaryActualFlowM3H/(3600*d.effectiveFlowAreaM2))<1e-12);
 assert.equal(d.liquidSurfaceWindMS,d.equivalentSurfaceWindMS);
 assert.ok(d.preliminaryFanNm3H>0);
 assert.ok(d.preliminaryNoEvaporationAreaM2<=d.maxPoolAreaM2);
});

test("surface wind sensitivity factor changes Q3 without changing the default", () => {
 const original=calculate(structuredClone(base));
 const explicit=structuredClone(base);explicit.ventilation.surfaceWindFactor=1;
 const doubled=structuredClone(base);doubled.ventilation.surfaceWindFactor=2;
 const same=calculate(explicit),high=calculate(doubled);
 assert.equal(same.release.derived.equivalentSurfaceWindMS,original.release.derived.equivalentSurfaceWindMS);
 assert.equal(high.release.derived.equivalentSurfaceWindMS,2*original.release.derived.equivalentSurfaceWindMS);
 assert.ok(high.release.summary.maxGasRateKgS>original.release.summary.maxGasRateKgS);
});

test("flash fractions above 0.2 cap airborne carry at one and preserve mass", () => {
 const c=structuredClone(base);
 c.physical.liquidCpKJkgK=2.2;
 const r=calculate(c);
 assert.ok(r.release.derived.flashFraction>0.2);
 assert.equal(r.release.derived.airCarryFraction,1);
 assert.equal(r.release.derived.poolFraction,0);
 for(const row of r.release.rows.filter(x=>x.leakedKg>0)){
  const partition=row.flashKg+row.dropletsKg+row.intoPoolKg;
  assert.ok(Math.abs(partition-row.leakedKg)<1e-8);
 }
});
test("bottom leak empties geometric inventory and completes pool evaporation", () => {
 const r=calculate(base);
 assert.equal(r.release.summary.leakCompleted,true);
 assert.equal(r.release.summary.evaporationCompleted,true);
 assert.equal(r.release.summary.remainingLiquidMassKg,0);
 assert.ok(Math.abs(r.release.summary.leakedKg+r.release.summary.transferredKg-r.release.derived.initialLiquidMassKg)<1e-6);
 for (const row of r.release.rows) {
  assert.ok(Math.abs(row.cumulativeLeakKg+row.cumulativeTransferredKg+row.remainingLiquidMassKg-r.release.derived.initialLiquidMassKg)<1e-6);
  assert.ok(Math.abs(row.flashKg+row.dropletsKg+row.intoPoolKg-row.leakedKg)<1e-8);
 }
 assert.ok(Math.abs(r.release.summary.transferredKg-r.release.derived.transferPumpKgS*r.release.summary.leakDurationS)<1e-6);
 assert.equal(r.release.rows.at(-1).timeS,base.simulation.maxTimeS);
 assert.equal(r.ventilation.rows[0].timeS,r.release.rows[0].durationS);
 assert.ok(Math.abs(r.ventilation.derived.fanNm3H-r.release.summary.maxGasRateKgS*r.release.derived.kgSToNm3H*1.1)<1e-8);
});
test("short window reports incomplete leakage and handles fractional final interval",()=>{
 const c=structuredClone(base); c.simulation.maxTimeS=2*c.simulation.timeStepS+5;
 const r=calculate(c);
 assert.equal(r.release.summary.leakDurationS,null);
 assert.equal(r.release.summary.leakCompleted,false);
 assert.equal(r.release.rows.at(-1).durationS,5);
 assert.equal(r.ventilation.rows.at(-1).timeS,c.simulation.maxTimeS);
});
test("constant pressure without gravity has analytic emptying time",()=>{
 const c=structuredClone(base); c.physical.gravityMS2=0;
 const r=calculate(c);
 const expected=r.release.derived.initialLiquidMassKg/(r.release.summary.initialLeakRateKgS+r.release.derived.transferPumpKgS);
 assert.ok(Math.abs(r.release.summary.leakDurationS-expected)<1e-6);
});
test("zero pump recovers leak-only inventory and takes longer",()=>{
 const c=structuredClone(base); c.tank.transferPumpM3H=0;
 const r=calculate(c), pumping=calculate(base);
 assert.equal(r.release.summary.transferredKg,0);
 assert.ok(Math.abs(r.release.summary.leakedKg-r.release.derived.initialLiquidMassKg)<1e-6);
 assert.ok(r.release.summary.leakDurationS>pumping.release.summary.leakDurationS);
});
test("invalid pump capacity is rejected",()=>{
 const c=structuredClone(base); c.tank.transferPumpM3H=-1;
 assert.throws(()=>calculate(c),/transferPumpM3H/);
});
test("leak duration converges as time step decreases",()=>{
 const coarse=calculate(base);
 const c=structuredClone(base); c.simulation.timeStepS=5;
 const fine=calculate(c);
 assert.ok(Math.abs(coarse.release.summary.leakDurationS-fine.release.summary.leakDurationS)<1);
});
test("whole-room gas and droplets conserve chlorine without direct source capture",()=>{
 const r=calculate(base), v=r.ventilation;
 assert.equal(v.initialState.airMolFraction,1);
 assert.equal(v.initialState.totalChlorineLoadKgH,0);
 assert.equal(v.summary.cumulativeDropletsEvaporatedKg,0);
 for (const row of v.rows) {
  assert.ok(Math.abs(row.chlorineBalanceErrorKg)<1e-6);
  assert.ok(row.chlorineMolFraction>=0 && row.chlorineMolFraction<=1);
  assert.equal(row.airMolFraction+row.chlorineMolFraction,1);
  assert.ok(Math.abs(row.airNm3H+row.chlorineNm3H-v.derived.fanNm3H)<1e-8);
  assert.ok(row.suspendedDropletsKg>=0);
  assert.ok(row.gasExtractedKg>=-1e-8 && row.dropletsExtractedKg>=-1e-8);
  assert.equal(row.totalChlorineLoadKgH,row.chlorineLoadKgH+row.dropletsLoadKgH);
 }
 const last=v.rows.at(-1);
 assert.ok(Math.abs(last.cumulativeDropletInputKg-r.release.summary.dropletsKg)<1e-6);
 assert.ok(Math.abs(last.cumulativeDropletsExtractedKg+last.suspendedDropletsKg-r.release.summary.dropletsKg)<1e-6);
 assert.ok(v.rows[0].dropletsLoadKgH<r.release.rows[0].dropletsKg/r.release.rows[0].durationS*3600);
 const peak=v.summary.atMaxTotalChlorineLoad;
 assert.equal(peak.totalChlorineLoadKgH,v.summary.maxTotalChlorineLoadKgH);
});
test("suspended droplets wash out exponentially after leakage ends",()=>{
 const r=calculate(base), v=r.ventilation;
 const i=r.release.rows.findIndex(x=>x.timeS>r.release.summary.leakDurationS+20);
 const before=v.rows[i-1],after=v.rows[i];
 const decay=Math.exp(-v.derived.fanKmolH/3600/v.derived.roomInventoryKmol*after.durationS);
 assert.ok(Math.abs(after.suspendedDropletsKg-before.suspendedDropletsKg*decay)<1e-8);
 assert.ok(after.dropletsLoadKgH>0);
});
