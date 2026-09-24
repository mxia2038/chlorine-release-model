
import test from "node:test";
import assert from "node:assert/strict";
import {buildOutletTarget} from "../src/outlet_target.mjs";
test("target uses contracted dry outlet volume, conserves chlorine and caps low loads",()=>{
 const r={input:{absorption:{process:{mainCaptureFraction:0.9},outletChlorineRequirement:{designTargetMgNm3:4,limitMgNm3:5}},
 physical:{standardMolarVolumeNm3Kmol:22.414,chlorineMolarMassKgKmol:70.906}},
 ventilation:{derived:{fanNm3H:1000},rows:[{timeS:3600,durationS:3600,airNm3H:900,chlorineLoadKgH:100,gasExtractedKg:100,dropletsLoadKgH:10,dropletsExtractedKg:10}]}};
 const t=buildOutletTarget(r),p=t.rows[0];
 assert.ok(Math.abs(p.outletGasKgH*1e6/p.outletDryNm3H-4)<1e-12);
 assert.ok(Math.abs(t.tailGasAbsorbedWithinWindowKg+t.emittedWithinWindowKg-10)<1e-12);
 assert.ok(p.outletDryNm3H<1000);
 r.ventilation.rows[0].chlorineLoadKgH=1e-8;
 assert.equal(buildOutletTarget(r).rows[0].requiredGasRemovalFraction,0);
 r.input.absorption.outletChlorineRequirement.designTargetMgNm3=5;
 assert.throws(()=>buildOutletTarget(r),/strictly below/);
});
