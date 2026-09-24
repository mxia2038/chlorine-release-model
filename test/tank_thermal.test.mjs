import test from "node:test";
import assert from "node:assert/strict";
import { simulateTankBank, buildThermalStudy, buildMainReactionHeat, coolerTemperatureBasis } from "../src/tank_thermal.mjs";
const p={count:2,initialSolutionKg:100,solutionCpKJkgK:4,naohKgPerKgChlorine:1,
  switchRiseK:20,circulationKgS:10,initialNaohFraction:0.18,switchNaohFraction:0.05,
  initialTempC:18,coolerCapacityKW:null};
// Synthetic coefficients below test conservation/events, not chlorine properties.
test("cooled bank switches at concentration within a step and never reuses tanks",()=>{
 const r=simulateTankBank([{timeS:40,durationS:40,chlorineKg:40,netHeatKJ:4000}],p);
 const capacity=(18-5)/1.05;
 assert.ok(Math.abs(r.events[0].timeS-capacity)<1e-10);
 assert.ok(Math.abs(r.events[1].timeS-2*capacity)<1e-10);
 assert.equal(r.events[1].nextTank,null);
 assert.ok(Math.abs(r.unhandledKg-(40-2*capacity))<1e-10);
 for(const t of r.tanks) {
  assert.equal(t.reason,"concentration");
  assert.equal(t.energyKJ,0);
  assert.ok(Math.abs(t.naohKg/t.liquidKg-0.05)<1e-12);
 }
 assert.equal(r.peakTowerOutletTemperatureC,20.5);
 assert.ok(Math.abs(r.massBalanceErrorKg)<1e-10);
 assert.equal(r.energyBalanceErrorKJ,0);
});
test("adiabatic temperature triggers first and includes added chlorine mass",()=>{
 const r=simulateTankBank([{timeS:20,durationS:20,chlorineKg:20,netHeatKJ:20000}],{...p,coolerCapacityKW:0});
 const expected=100*4*20/(1000-4*20);
 assert.ok(Math.abs(r.events[0].timeS-expected)<1e-10);
 assert.equal(r.events[0].reason,"temperature");
 for(const t of r.tanks) assert.ok(Math.abs(t.energyKJ/(t.liquidKg*4)-20)<1e-10);
 assert.ok(Math.abs(r.energyBalanceErrorKJ)<1e-8);
});
test("finite cooler duty delays thermal switch without changing heat accounting",()=>{
 const row={timeS:50,durationS:50,chlorineKg:50,netHeatKJ:50000};
 const adiabatic=simulateTankBank([row],{...p,coolerCapacityKW:0});
 const cooled=simulateTankBank([row],{...p,coolerCapacityKW:300});
 assert.ok(cooled.events[0].timeS>adiabatic.events[0].timeS);
 assert.ok(Math.abs(cooled.energyBalanceErrorKJ)<1e-8);
 assert.equal(cooled.peakCoolerKW,300);
});
test("splitting a constant-source interval preserves switch time and totals",()=>{
 const one=simulateTankBank([{timeS:40,durationS:40,chlorineKg:40,netHeatKJ:4000}],p);
 const many=simulateTankBank(Array.from({length:40},(_,i)=>({timeS:i+1,durationS:1,chlorineKg:1,netHeatKJ:100})),p);
 assert.ok(Math.abs(one.absorbedKg-many.absorbedKg)<1e-10);
 assert.ok(Math.abs(one.events[0].timeS-many.events[0].timeS)<1e-10);
});
test("missing project inputs remain pending rather than inventing thermal results",()=>{
 const s=buildThermalStudy({input:{absorption:{}}},{});
 assert.equal(s.status,"needs_inputs");
 assert.equal(s.cooled,null);
 assert.ok(s.missing.includes("thermal.solutionCpKJkgK"));
});
test("main stage absorption plus downstream load preserves total inlet chlorine",()=>{
 const result={input:{absorption:{process:{mainTankCount:2,mainInitialSolutionKgPerTank:100,mainCaptureFraction:0.8},
   thermal:{solutionCpKJkgK:4,gasNetHeatKJkg:100,dropletNetHeatKJkg:80,initialLiquidTempC:18,
     switchTemperatureRiseK:20,coolantTemperatureRiseK:10,coolantCpKJkgK:4},
   naohMassFraction:0.18,finalNaohMassFraction:0.05,solutionDensityKgM3:1000}},
   ventilation:{rows:[{timeS:10,durationS:10,gasExtractedKg:8,dropletsExtractedKg:2}],
     summary:{cumulativeGasExtractedKg:8,cumulativeDropletsExtractedKg:2}}};
 const s=buildThermalStudy(result,{naohKgPerKgChlorine:1,tower:{circulationM3H:36}});
 assert.equal(s.status,"calculated");
 assert.equal(s.cooled.absorbedKg,8);
 assert.equal(s.tailInletChlorineWithinWindowKg,2);
 assert.ok(s.coolantPeakKgH>0);
});
test("reaction heat uses separate gas/liquid coefficients without needing solution Cp",()=>{
 const r={input:{absorption:{process:{mainCaptureFraction:0.9},thermal:{
   gasNetHeatKJkg:1458.402,dropletNetHeatKJkg:1204.868,solutionCpKJkgK:null}}},
   ventilation:{rows:[{timeS:10,durationS:10,gasExtractedKg:10,dropletsExtractedKg:5,
     chlorineLoadKgH:7200,dropletsLoadKgH:3600}]}};
 const s=buildThermalStudy(r,{}),h=s.reactionHeat;
 assert.equal(s.status,"needs_inputs");
 assert.equal(h.status,"calculated");
 assert.ok(Math.abs(h.totalEnergyKJ-0.9*(10*1458.402+5*1204.868))<1e-8);
 assert.ok(Math.abs(h.peak.totalReactionKW-0.9*(2*1458.402+1204.868))<1e-8);
 assert.ok(h.peak.totalReactionKW>h.peak.intervalMeanReactionKW);
 r.input.absorption.process.mainCaptureFraction=0;
 assert.equal(buildMainReactionHeat(r).totalEnergyKJ,0);
});

test("countercurrent cooler handles equal terminal differences and temperature pinch",()=>{
 const h={initialLiquidTempC:18,coolantSupplyTempC:7,coolantReturnTempC:17};
 const equal=coolerTemperatureBasis(h,100,28);
 assert.equal(equal.lmtdK,11);
 assert.equal(equal.areaM2,null);
 const sized=coolerTemperatureBasis({...h,overallHeatTransferCoefficientWm2K:500},100,28);
 assert.ok(Math.abs(sized.areaM2-100000/5500)<1e-12);
 assert.equal(coolerTemperatureBasis(h,100,17).status,"infeasible_temperature_approach");
 assert.throws(()=>coolerTemperatureBasis({...h,coolantReturnTempC:6},100,28));
});
