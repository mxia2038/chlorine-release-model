import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { calculate } from "../src/calc.mjs";
const base = JSON.parse(fs.readFileSync(new URL("../config/default_25mm.json", import.meta.url)));
const closed = (mod = () => {}) => { const c = structuredClone(base); c.tank.pressureModel = "closedSaturated"; mod(c); return calculate(c); };

test("closed tank starts from the constant-pressure state", () => {
  const a = calculate(base).release.rows[0], b = closed().release.rows[0];
  // Liquid density comes from linear interpolation of the 0.05 K table (~5e-9 relative).
  assert.ok(Math.abs(b.leakRateKgS / a.leakRateKgS - 1) < 1e-7);
  assert.ok(Math.abs(b.flashFraction / a.flashFraction - 1) < 1e-9);
  assert.ok(Math.abs(b.tankGaugePressureStepStartPa - base.tank.pressureGaugePa) < 1e-3);
});

test("closed tank conserves vessel mass and drains to vapor only", () => {
  for (const pump of [0, 25]) {
    const s = closed(c => { c.tank.transferPumpM3H = pump; }).release.summary;
    const ct = s.closedTank;
    assert.ok(s.leakCompleted);
    assert.ok(Math.abs(ct.initialVesselMassKg - s.leakedKg - s.transferredKg - ct.residualInventoryAtDrainageKg) < 1e-6);
    assert.ok(ct.recondensedLiquidAtDrainageKg < 1, `trace liquid ${ct.recondensedLiquidAtDrainageKg}`);
    // Final saturated state fills the vessel and matches the energy account.
    assert.ok(Math.abs(ct.drainagePhaseVolumeM3 / base.tank.volumeM3 - 1) < 1e-6);
    assert.ok(Math.abs(ct.energyClosureJ) < 1, `energy closure ${ct.energyClosureJ} J`);
  }
});

test("transferred volume integrates the step liquid density", () => {
  const s = closed(c => { c.tank.transferPumpM3H = 25; }).release.summary;
  const pumpOn = s.transferredM3 / 25 * 3600;
  assert.ok(s.transferredM3 < s.transferredKg / base.tank.liquidDensityKgM3);
  assert.ok(Math.abs(pumpOn / s.leakDurationS - 1) < 1e-3);
});

test("closed-tank pressure falls monotonically while liquid leaks", () => {
  const rows = closed().release.rows.filter(r => r.leakedKg > 0);
  for (let i = 1; i < rows.length; i += 1) assert.ok(rows[i].tankGaugePressureStepStartPa <= rows[i - 1].tankGaugePressureStepStartPa + 1e-9);
  assert.ok(rows.at(-1).tankGaugePressureStepEndPa < base.tank.pressureGaugePa);
});

test("adiabatic cooling at half inventory matches the vapor-backfill estimate", () => {
  // dT ~ (rho_v * h_fg / (rho_l * c_p)) * ln(M0/M); at M = M0/2 this is about 1.27 K.
  const r = closed();
  const m0 = r.release.derived.initialLiquidMassKg;
  const half = r.release.rows.find(x => x.remainingLiquidMassKg <= m0 / 2);
  const drop = r.release.summary.closedTank.initialSaturationTempC - half.tankTempStepEndC;
  assert.ok(drop > 1.0 && drop < 1.6, `drop ${drop}`);
});

test("wall heat capacity and heat ingress reduce depressurization", () => {
  const adiabatic = closed().release.summary.closedTank;
  const wall = closed(c => { c.tank.wallMassKg = 21000; c.tank.wallSpecificHeatJkgK = 434; }).release.summary.closedTank;
  const heated = closed(c => { c.tank.heatIngressW = 50000; }).release.summary.closedTank;
  assert.ok(wall.temperatureDropK < adiabatic.temperatureDropK);
  assert.ok(heated.temperatureDropK < adiabatic.temperatureDropK);
});

test("unknown pressure model is rejected", () => {
  const c = structuredClone(base); c.tank.pressureModel = "linearDecay";
  assert.throws(() => calculate(c), /pressureModel/);
});
