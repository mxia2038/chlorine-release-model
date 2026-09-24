import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { calculate } from "../src/calc.mjs";
import { buildDesignBasis } from "../src/design_basis.mjs";
const base=JSON.parse(fs.readFileSync(new URL("../config/default_25mm.json",import.meta.url)));
test("capacity includes all leaked chlorine but excludes transferred inventory",()=>{
 const r=calculate(base), b=buildDesignBasis(r);
 assert.equal(b.chlorineCapacityKg,r.release.summary.leakedKg);
 assert.ok(b.chlorineCapacityKg<r.release.derived.initialLiquidMassKg);
 assert.ok(b.solutionKg>b.theoreticalSolutionKg);
 assert.ok(Math.abs(b.remainingNaohKg/b.finalSolutionKg-0.05)<1e-12);
 assert.ok(Math.abs(b.solutionKg*0.18-b.theoreticalNaohKg-b.remainingNaohKg)<1e-8);
 assert.equal(b.finalSolutionKg,b.solutionKg+b.chlorineCapacityKg);
 assert.ok(Math.abs(b.theoreticalSolutionKg * 0.18 - b.theoreticalNaohKg)<1e-8);
 assert.equal(b.solutionM3,b.solutionKg/1236.49);
 assert.ok(b.chlorineCapacityKg>b.chlorineExtractedWithinWindowKg);
 for(const c of b.inletCases) assert.equal(c.totalChlorineKgH,c.gasChlorineKgH+c.dropletsKgH);
});
test("reagent concentration and excess convert capacity to solution mass and volume",()=>{
 const c=structuredClone(base);
 c.absorption={naohMassFraction:0.2,naohExcessFactor:1.1,solutionDensityKgM3:1200};
 const b=buildDesignBasis(calculate(c));
 assert.ok(Math.abs(b.solutionKg-b.theoreticalNaohKg*1.1/0.2)<1e-8);
 assert.equal(b.solutionM3,b.solutionKg/1200);
});
test("incomplete leak and missing design inputs do not yield full-accident capacity",()=>{
 const c=structuredClone(base);c.simulation.maxTimeS=10;
 const r=calculate(c);assert.equal(buildDesignBasis(r).theoreticalNaohKg,null);
 r.input.absorption.naohMassFraction=20;
 assert.throws(()=>buildDesignBasis(r),/naohMassFraction/);
});
test("final free caustic target must be below initial concentration",()=>{
 const r=calculate(structuredClone(base));r.input.absorption.finalNaohMassFraction=0.18;
 assert.throws(()=>buildDesignBasis(r),/finalNaohMassFraction/);
});
test("tower diameter uses actual maximum including startup and rounds safely",()=>{
 const r=calculate(structuredClone(base)), t=buildDesignBasis(r).tower;
 assert.equal(t.selectedDiameterMm,1900);
 assert.equal(t.selectedDiameterMm%100,0);
 assert.ok(t.selectedDiameterMm/1000>=t.calculatedDiameterM);
 assert.ok(t.selectedSuperficialGasVelocityMS<=0.55);
 const smallerArea=Math.PI*((t.selectedDiameterMm-100)/1000)**2/4;
 assert.ok(t.designGasM3H/(3600*smallerArea)>0.55);
 r.ventilation.derived.initialActualFlowM3H=6000;
 assert.equal(buildDesignBasis(r).tower.maxActualGasM3H,6000);
 r.input.absorption.loadFluctuationFactor=1.2;
 assert.equal(buildDesignBasis(r).tower.designGasM3H,7200);
 r.input.absorption.superficialGasVelocityMS=0;
 assert.throws(()=>buildDesignBasis(r),/superficialGasVelocityMS/);
});
test("three circulation tanks split liquid with 85 percent working fraction",()=>{
 const b=buildDesignBasis(calculate(structuredClone(base))),t=b.circulationTanks;
 assert.equal(t.count,3);
 assert.ok(Math.abs(t.initialBasisGrossVolumePerTankM3*3*0.85*1236.49-b.solutionKg)<1e-7);
 assert.ok(Math.abs(t.finalBasisGrossVolumePerTankM3*3*0.85*1236.49-b.finalSolutionKg)<1e-7);
 assert.ok(t.finalBasisGrossVolumePerTankM3>t.initialBasisGrossVolumePerTankM3);
});
test("90 percent main-stage chemical allocation preserves total chlorine and solution",()=>{
 const b=buildDesignBasis(calculate(structuredClone(base))),s=b.stageCapacity;
 assert.equal(s.mainCaptureFraction,0.9);
 assert.ok(Math.abs(s.mainChlorineKg+s.tailInletChlorineKg-b.chlorineCapacityKg)<1e-8);
 assert.ok(Math.abs(s.mainInitialSolutionKgPerTank*2+s.tailInitialSolutionKg-b.solutionKg)<1e-8);
 assert.equal(b.thermalStudy.status,"calculated");
 assert.equal(b.thermalStudy.initialSolutionKgPerMainTank,s.mainInitialSolutionKgPerTank);
 assert.ok(!b.thermalStudy.missing.includes("process.mainCaptureFraction"));
});

test("tail tower uses its own velocity and spray density with shared fan flow",()=>{
 const r=calculate(structuredClone(base)),b=buildDesignBasis(r),t=b.tailTower;
 assert.equal(t.maxActualGasM3H,b.tower.maxActualGasM3H);
 assert.equal(t.selectedDiameterMm,1700);
 assert.ok(t.selectedSuperficialGasVelocityMS<=0.7);
 assert.ok(t.designGasM3H/(3600*Math.PI*1.6**2/4)>0.7);
 assert.ok(Math.abs(t.circulationM3H-Math.PI*1.7**2/4*30)<1e-10);
 r.input.absorption.tailTower.loadFluctuationFactor=1.2;
 const changed=buildDesignBasis(r);
 assert.equal(changed.tailTower.designGasM3H,t.designGasM3H*1.2);
 assert.equal(changed.tower.selectedDiameterMm,b.tower.selectedDiameterMm);
 r.input.absorption.tailTower.superficialGasVelocityMS=0;
 assert.throws(()=>buildDesignBasis(r),/superficialGasVelocityMS/);
});

test("nominal tail design closes capacity and simultaneous reaction heat",()=>{
 const r=calculate(structuredClone(base)),b=buildDesignBasis(r),t=b.tailDesign;
 assert.equal(t.status,"calculated");
 assert.ok(t.peakReactionKW*9<b.thermalStudy.peakDesignCoolerKW);
 assert.ok(Math.abs(t.chlorineCapacityKg+b.outletTarget.emittedWithinWindowKg-b.stageCapacity.tailInletChlorineKg)<1e-8);
 assert.ok(Math.abs(t.initialSolutionKg*0.18-t.chlorineCapacityKg*b.naohKgPerKgChlorine-t.finalSolutionKg*0.05)<1e-8);
 assert.ok(t.finalBasisGrossVolumeM3>t.initialBasisGrossVolumeM3);
 assert.ok(Math.abs(t.finalBasisGrossVolumeM3*0.85*1236.49-t.finalSolutionKg)<1e-8);
 assert.equal(t.designInletTemperatureC,38);
 assert.equal(t.outletReferenceC,43);
 assert.equal(t.outletLimitC,45);
 assert.equal(t.outletLimitSatisfied,true);
 assert.equal(t.coolantReturnTempC,t.predictedPeakOutletTemperatureC-4);
 assert.ok(Math.abs(t.coolantPeakKgH*4.184*(t.coolantReturnTempC-32)/3600-t.peakReactionKW)<1e-8);
 assert.equal(t.cooler.status,"vendor_scope");
 assert.ok(t.requiredCirculationM3H>t.circulationM3H);
 assert.ok(t.predictedPeakOutletTemperatureC>43);
 assert.equal(t.temperatureBalanceSatisfied,false);
 assert.equal(t.removalEfficiencyValidated,false);
 r.input.absorption.process.mainCaptureFraction=1;
 const zero=buildDesignBasis(r).tailDesign;
 assert.equal(zero.peakReactionKW,0);
 assert.equal(zero.chlorineCapacityKg,0);
});
