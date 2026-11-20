import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PI = Math.PI;

// Saturated-chlorine table (CoolProp 8.0.0, Thol et al. 2021), used only by the
// closed-tank pressure option. Loaded lazily so the default model has no dependency.
let SATURATION = null;
function saturationTable() {
  if (!SATURATION) {
    const t = JSON.parse(readFileSync(new URL("../config/chlorine_saturation_table.json", import.meta.url), "utf8"));
    SATURATION = { t0: t.rows[0][0], step: t.tempStepC, rows: t.rows, source: t.source };
  }
  return SATURATION;
}

function saturationAt(tempC) {
  const s = saturationTable();
  const x = (tempC - s.t0) / s.step;
  const i = Math.floor(x);
  if (i < 0 || i >= s.rows.length - 1) throw new Error(`Tank temperature ${tempC} C outside saturation table`);
  const f = x - i;
  const a = s.rows[i], b = s.rows[i + 1];
  const lerp = (k) => a[k] + (b[k] - a[k]) * f;
  return { pressurePa: lerp(1), rhoL: lerp(2), rhoV: lerp(3), uL: lerp(4), uV: lerp(5), hL: lerp(6) };
}

function saturationTempFromPressure(pressurePa) {
  const s = saturationTable();
  let lo = s.t0, hi = s.t0 + s.step * (s.rows.length - 1) - 1e-9;
  for (let i = 0; i < 100; i += 1) {
    const mid = (lo + hi) / 2;
    if (saturationAt(mid).pressurePa < pressurePa) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// Two-phase split of a closed vessel of fixed volume at saturation temperature T.
function closedVesselState(totalMassKg, tempC, volumeM3, wallHeatCapacityJK, referenceTempC) {
  const s = saturationAt(tempC);
  const liquidKg = (volumeM3 - totalMassKg / s.rhoV) / (1 / s.rhoL - 1 / s.rhoV);
  const vaporKg = totalMassKg - liquidKg;
  return { s, liquidKg, vaporKg,
    energyJ: liquidKg * s.uL + vaporKg * s.uV + wallHeatCapacityJK * (tempC - referenceTempC) };
}

function solveClosedVesselTemp(totalMassKg, energyJ, volumeM3, wallHeatCapacityJK, referenceTempC, guessC) {
  const s = saturationTable();
  let lo = s.t0 + 1e-6, hi = Math.min(guessC + 5, s.t0 + s.step * (s.rows.length - 1) - 1e-6);
  for (let i = 0; i < 100; i += 1) {
    const mid = (lo + hi) / 2;
    if (closedVesselState(totalMassKg, mid, volumeM3, wallHeatCapacityJK, referenceTempC).energyJ < energyJ) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

function areaSegment(depth, radius) {
  const y = Math.max(0, Math.min(2 * radius, depth));
  if (y <= 0) return 0;
  if (y >= 2 * radius) return PI * radius * radius;
  return radius * radius * Math.acos((radius - y) / radius) -
    (radius - y) * Math.sqrt(Math.max(0, 2 * radius * y - y * y));
}

function depthFromArea(targetArea, radius) {
  let lo = 0;
  let hi = 2 * radius;
  for (let i = 0; i < 80; i += 1) {
    const mid = (lo + hi) / 2;
    if (areaSegment(mid, radius) < targetArea) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

function storageTempFromPressureC(absPressurePa, ant) {
  const pressureBar = absPressurePa / 100000;
  const tempK = ant.B / (ant.A - Math.log10(pressureBar)) - ant.C;
  return tempK - 273.15;
}

function q3Coefficient(input, liquidSurfaceWindMS) {
  const ph = input.physical;
  const eu = (2 - ph.stabilityN) / (2 + ph.stabilityN);
  const er = (4 + ph.stabilityN) / (2 + ph.stabilityN);
  const molarMassKgMol = ph.chlorineMolarMassKgKmol / 1000;
  const tempK = ph.groundInitialTempC + 273.15;
  const base = ph.stabilityA * ph.poolSurfaceVaporPressurePa * molarMassKgMol /
    (ph.gasConstantJmolK * tempK);
  return {
    windExponent: eu,
    radiusExponent: er,
    areaCoefficient: base * Math.pow(liquidSurfaceWindMS, eu) /
      Math.pow(PI, er / 2)
  };
}

function poolHeatCoefficient(input) {
  const ph = input.physical;
  return ph.concreteConductivityWmK * (ph.groundInitialTempC - ph.boilingPointC) /
    (ph.latentHeatJkg * Math.sqrt(PI * ph.concreteThermalDiffusivityM2s));
}

function preliminaryQ1Q2Peak(input, release) {
  const tk = input.tank;
  const ph = input.physical;
  const beta = release.derived.heatCoefficientKgM2SqrtS;
  const maxAreaM2 = release.derived.maxPoolAreaM2;
  const initialLeakRateKgS = release.summary.initialLeakRateKgS;
  const totalInitialOutflowKgS = initialLeakRateKgS + release.derived.transferPumpKgS;
  const preTransferS = initialLeakRateKgS > 0
    ? Math.min(tk.transferStartDelayS ?? 0, release.derived.initialLiquidMassKg / initialLeakRateKgS) : 0;
  const approximateLeakDurationS = totalInitialOutflowKgS > 0
    ? preTransferS + Math.max(0, release.derived.initialLiquidMassKg - initialLeakRateKgS * preTransferS) / totalInitialOutflowKgS : 0;
  if (approximateLeakDurationS <= 0) return {peakKgS: 0, noEvaporationAreaM2: 0,
    approximateLeakDurationS: 0};
  const approximateLeakedKg = initialLeakRateKgS * approximateLeakDurationS;
  const noEvaporationAreaM2 = Math.min(maxAreaM2,
    approximateLeakedKg * release.derived.effectivePoolFraction / (tk.liquidDensityKgM3 * ph.poolThicknessM));
  // Linear-spreading estimate: integrating successively wetted surface patches
  // gives q2,pre = 2 beta A_end / sqrt(t_leak).
  const preliminaryHeatRateKgS = 2 * beta * noEvaporationAreaM2 / Math.sqrt(approximateLeakDurationS);
  return {
    peakKgS: initialLeakRateKgS * release.derived.directGasFraction + preliminaryHeatRateKgS,
    noEvaporationAreaM2,
    approximateLeakDurationS
  };
}

function buildLeakAndPoolSeries(input, liquidSurfaceWindMS) {
  const tk = input.tank;
  const ph = input.physical;
  const sim = input.simulation;
  const maxPoolAreaM2 = input.ventilation.roomLengthM * input.ventilation.roomWidthM;
  const radius = tk.diameterM / 2;
  const tankLength = tk.volumeM3 / (PI * radius * radius);
  const initialLiquidDepth = tk.initialLiquidLevelM;
  const leakElevation = tk.leakElevationM;
  const initialLiquidVolume = areaSegment(initialLiquidDepth, radius) * tankLength;
  const residualVolume = areaSegment(leakElevation, radius) * tankLength;
  const pumpCapacityKgS = (tk.transferPumpM3H ?? 0) * tk.liquidDensityKgM3 / 3600;
  let leakDurationS = initialLiquidVolume <= residualVolume ? 0 : null;
  const holeArea = PI * tk.holeDiameterM * tk.holeDiameterM / 4;
  const absPressurePa = tk.pressureGaugePa + tk.atmosphericPressurePa;
  const instantVaporFraction = ph.dropletInstantVaporFraction ?? 0;
  const depositToPoolFraction = ph.dropletDepositToPoolFraction ?? 0;
  // Source partition at a given tank absolute pressure. Storage temperature always
  // follows the Antoine relation, so the closed-tank option and the constant-pressure
  // baseline share the same flash-fraction basis.
  const sourceFractions = (pressureAbsPa) => {
    const storageTempC = storageTempFromPressureC(pressureAbsPa, input.antoine);
    const flashFraction = ph.liquidCpKJkgK * 1000 * (storageTempC - ph.boilingPointC) / ph.latentHeatJkg;
    if(!Number.isFinite(flashFraction) || flashFraction<0 || flashFraction>1)
      throw new Error("Calculated flash fraction must lie in [0,1]");
    // GB/T 37243-2019 D.31/D.32: for Fv<=0.2, total airborne carry is
    // 5*Fv; for Fv>0.2, all released liquid is carried and no pool forms.
    const airCarryFraction = flashFraction<=0.2 ? 5 * flashFraction : 1;
    const dropletFraction = Math.max(0, airCarryFraction - flashFraction);
    const poolFraction = Math.max(0, 1 - airCarryFraction);
    return { storageTempC, flashFraction, airCarryFraction, dropletFraction, poolFraction,
      suspendedDropletFraction: dropletFraction * (1-instantVaporFraction-depositToPoolFraction),
      directGasFraction: flashFraction + dropletFraction * instantVaporFraction,
      effectivePoolFraction: poolFraction + dropletFraction * depositToPoolFraction };
  };
  const initialFractions = sourceFractions(absPressurePa);
  const { storageTempC, flashFraction, airCarryFraction, dropletFraction, poolFraction,
    suspendedDropletFraction, directGasFraction, effectivePoolFraction } = initialFractions;

  // Tank pressure option. "constant" (default): fixed gauge pressure and liquid density.
  // "closedSaturated": closed vessel of pure saturated chlorine; each step conserves
  // vessel mass and internal energy (saturated-liquid outflow, optional wall heat
  // capacity and heat ingress), giving the step-start pressure and liquid density.
  const pressureModel = tk.pressureModel ?? "constant";
  if (!["constant", "closedSaturated"].includes(pressureModel)) throw new Error(`Unknown pressureModel ${pressureModel}`);
  const closed = pressureModel === "closedSaturated";
  let vessel = null;
  if (closed) {
    const wallHeatCapacityJK = (tk.wallMassKg ?? 0) * (tk.wallSpecificHeatJkgK ?? 0);
    const t0C = saturationTempFromPressure(absPressurePa);
    const s0 = saturationAt(t0C);
    const liquidKg = initialLiquidVolume * s0.rhoL;
    const vaporKg = (tk.volumeM3 - liquidKg / s0.rhoL) * s0.rhoV;
    const state0 = closedVesselState(liquidKg + vaporKg, t0C, tk.volumeM3, wallHeatCapacityJK, t0C);
    vessel = { wallHeatCapacityJK, referenceTempC: t0C, tempC: t0C, totalKg: liquidKg + vaporKg,
      energyJ: state0.energyJ, liquidKg: state0.liquidKg, vaporKg: state0.vaporKg, s: state0.s,
      heatIngressW: tk.heatIngressW ?? 0, initialTempC: t0C, initialPressurePa: s0.pressurePa,
      minPressurePa: s0.pressurePa, initialTotalKg: liquidKg + vaporKg, initialEnergyJ: state0.energyJ,
      outflowEnthalpyJ: 0, heatAddedJ: 0 };
  }
  const beta = poolHeatCoefficient(input);
  const q3 = q3Coefficient(input, liquidSurfaceWindMS);
  const kgSToNm3H = 3600 * ph.standardMolarVolumeNm3Kmol / ph.chlorineMolarMassKgKmol;

  let liquidVolumeM3 = initialLiquidVolume;
  let poolMassKg = 0;
  let poolAreaM2 = 0;
  const heatPatches = [];
  const rows = [];

  const totals = {
    leakedKg: 0,
    transferredKg: 0,
    transferredM3: 0,
    flashKg: 0,
    airCarryKg: 0,
    dropletsKg: 0,
    rawDropletsKg: 0,
    instantDropletVaporizedKg: 0,
    dropletDepositedKg: 0,
    intoPoolKg: 0,
    heatEvapKg: 0,
    massEvapKg: 0,
    gasKg: 0
  };

  for (let step = 0; step * sim.timeStepS < sim.maxTimeS; step += 1) {
    const t0 = step * sim.timeStepS;
    const dt = Math.min(sim.timeStepS, sim.maxTimeS - t0);
    // Step-start tank state: constant by default, or from the closed-vessel balance.
    const stepRho = closed ? vessel.s.rhoL : tk.liquidDensityKgM3;
    const stepGaugePa = closed ? vessel.s.pressurePa - tk.atmosphericPressurePa : tk.pressureGaugePa;
    const fr = closed ? sourceFractions(vessel.s.pressurePa) : initialFractions;
    const stepTempC = closed ? vessel.tempC : null;
    if (closed && !vessel.drained) liquidVolumeM3 = Math.max(residualVolume, vessel.liquidKg / stepRho);
    const liquidDepth = depthFromArea(Math.max(0, liquidVolumeM3 / tankLength), radius);
    const headM = Math.max(0, liquidDepth - leakElevation);
    const isLeak = liquidVolumeM3 > residualVolume && headM > 0;
    const leakRateKgS = isLeak
      ? tk.dischargeCoefficient * holeArea *
        Math.sqrt(2 * stepRho * (Math.max(0, stepGaugePa) + stepRho * ph.gravityMS2 * headM))
      : 0;
    const availableKg = Math.max(0, liquidVolumeM3 - residualVolume) * stepRho;
    const beforePumpS = Math.min(dt, Math.max(0, (tk.transferStartDelayS ?? 0) - t0));
    const preLeakS = leakRateKgS > 0 ? Math.min(beforePumpS, availableKg / leakRateKgS) : 0;
    const afterPreKg = Math.max(0, availableKg - leakRateKgS * preLeakS);
    const stepPumpKgS = closed ? (tk.transferPumpM3H ?? 0) * stepRho / 3600 : pumpCapacityKgS;
    const transferRateKgS = isLeak && beforePumpS < dt && afterPreKg > 0 ? stepPumpKgS : 0;
    const totalOutflowKgS = leakRateKgS + transferRateKgS;
    // Split the interval at pump startup, including non-grid delays such as 30 s.
    // Rates use the existing step-start head approximation.
    const concurrentS = totalOutflowKgS > 0 ? Math.min(dt - beforePumpS, afterPreKg / totalOutflowKgS) : 0;
    let stepLeakTimeS = preLeakS + concurrentS;
    let leakedKg = Math.min(leakRateKgS * stepLeakTimeS, availableKg);
    let transferredKg = transferRateKgS * concurrentS;
    liquidVolumeM3 = Math.max(residualVolume, liquidVolumeM3 - (leakedKg + transferredKg) / stepRho);
    let drained = isLeak && availableKg <= leakRateKgS * beforePumpS + totalOutflowKgS * (dt - beforePumpS);
    if (closed && leakedKg + transferredKg > 0) {
      // Saturated liquid leaves at the step-start enthalpy; the vessel then relaxes to the
      // saturation temperature that conserves its remaining mass, internal energy and volume.
      const heatJ = vessel.heatIngressW * dt;
      const after = (outKg) => {
        const totalKg = vessel.totalKg - outKg;
        const energyJ = vessel.energyJ - outKg * vessel.s.hL + heatJ;
        const tempC = solveClosedVesselTemp(totalKg, energyJ, tk.volumeM3,
          vessel.wallHeatCapacityJK, vessel.referenceTempC, vessel.tempC);
        return { totalKg, energyJ, tempC,
          st: closedVesselState(totalKg, tempC, tk.volumeM3, vessel.wallHeatCapacityJK, vessel.referenceTempC) };
      };
      // Outflow after leaking for tau seconds of this step (pump only after the pre-start phase).
      const outflowAt = (tau) => ({ leak: leakRateKgS * tau,
        transfer: transferRateKgS * Math.max(0, tau - preLeakS) });
      let res = after(leakedKg + transferredKg);
      if (res.st.liquidKg <= 0) {
        // Part of the remaining liquid flashes to refill the vacated volume, so the liquid
        // runs out slightly before the step-start inventory would suggest. Locate the time
        // at which the vessel reaches zero liquid, leaving saturated vapor only.
        let lo = 0, hi = stepLeakTimeS;
        for (let i = 0; i < 100; i += 1) {
          const mid = (lo + hi) / 2, o = outflowAt(mid);
          if (after(o.leak + o.transfer).st.liquidKg > 0) lo = mid; else hi = mid;
        }
        stepLeakTimeS = hi;
        const o = outflowAt(hi);
        leakedKg = o.leak; transferredKg = o.transfer;
        res = after(leakedKg + transferredKg);
        drained = true;
      }
      vessel.outflowEnthalpyJ += (leakedKg + transferredKg) * vessel.s.hL;
      vessel.heatAddedJ += heatJ;
      // When the step-start liquid is fully withdrawn, the expanding saturated vapor (chlorine is a
      // wet fluid) may recondense a trace of liquid; it is kept in the vessel inventory, and the
      // liquid-release phase ends. Vessel blowdown after drainage is outside the model domain.
      Object.assign(vessel, { totalKg: res.totalKg, energyJ: res.energyJ, tempC: res.tempC, s: res.st.s,
        liquidKg: Math.max(0, res.st.liquidKg), vaporKg: res.totalKg - Math.max(0, res.st.liquidKg),
        minPressurePa: Math.min(vessel.minPressurePa, res.st.s.pressurePa), drained });
      if (!drained) liquidVolumeM3 = Math.max(residualVolume, vessel.liquidKg / res.st.s.rhoL);
    }
    totals.transferredM3 += transferredKg / stepRho;
    if (drained) {
      liquidVolumeM3 = residualVolume;
      leakDurationS = t0 + stepLeakTimeS;
    }

    const flashKg = fr.flashFraction * leakedKg;
    const airCarryKg = fr.airCarryFraction * leakedKg;
    const rawDropletsKg = fr.dropletFraction * leakedKg;
    const instantDropletVaporizedKg = rawDropletsKg * instantVaporFraction;
    const dropletDepositedKg = rawDropletsKg * depositToPoolFraction;
    const dropletsKg = rawDropletsKg - instantDropletVaporizedKg - dropletDepositedKg;
    const intoPoolKg = fr.poolFraction * leakedKg + dropletDepositedKg;
    poolMassKg += intoPoolKg;

    let candidateArea = Math.min(maxPoolAreaM2, poolMassKg / (tk.liquidDensityKgM3 * ph.poolThicknessM));
    const newAreaM2 = Math.max(0, candidateArea - poolAreaM2);
    if (newAreaM2 > 0) {
      heatPatches.push({ areaM2: newAreaM2, tauS: t0 + dt / 2 });
      poolAreaM2 += newAreaM2;
    }

    const q3PotentialKg = poolMassKg > 0
      ? q3.areaCoefficient * Math.pow(poolAreaM2, q3.radiusExponent / 2) * dt
      : 0;
    const massEvapKg = Math.min(poolMassKg, q3PotentialKg);
    poolMassKg -= massEvapKg;

    let heatPotentialKg = 0;
    for (const patch of heatPatches) {
      if (t0 + dt <= patch.tauS) continue;
      const age0 = Math.max(0, t0 - patch.tauS);
      const age1 = Math.max(0, t0 + dt - patch.tauS);
      heatPotentialKg += 2 * beta * patch.areaM2 * (Math.sqrt(age1) - Math.sqrt(age0));
    }
    const heatEvapKg = Math.min(poolMassKg, heatPotentialKg);
    poolMassKg -= heatEvapKg;
    if (poolMassKg <= 1e-9) {
      poolMassKg = 0;
      poolAreaM2 = 0;
      heatPatches.length = 0;
    } else if (!isLeak) {
      poolAreaM2 = Math.min(maxPoolAreaM2, poolMassKg / (tk.liquidDensityKgM3 * ph.poolThicknessM));
    }

    const gasKg = flashKg + instantDropletVaporizedKg + heatEvapKg + massEvapKg;
    totals.leakedKg += leakedKg;
    totals.transferredKg += transferredKg;
    totals.flashKg += flashKg;
    totals.airCarryKg += airCarryKg;
    totals.dropletsKg += dropletsKg;
    totals.rawDropletsKg += rawDropletsKg;
    totals.instantDropletVaporizedKg += instantDropletVaporizedKg;
    totals.dropletDepositedKg += dropletDepositedKg;
    totals.intoPoolKg += intoPoolKg;
    totals.heatEvapKg += heatEvapKg;
    totals.massEvapKg += massEvapKg;
    totals.gasKg += gasKg;

    rows.push({
      step,
      timeS: t0 + dt,
      durationS: dt,
      stepLeakTimeS,
      stage: isLeak ? "泄漏期" : poolMassKg > 0 ? "泄漏后蒸发" : "结束",
      liquidDepthM: depthFromArea(Math.max(0, liquidVolumeM3 / tankLength), radius),
      headM,
      leakRateKgS,
      leakedKg,
      cumulativeLeakKg: totals.leakedKg,
      transferRateKgS,
      transferredKg,
      cumulativeTransferredKg: totals.transferredKg,
      remainingLiquidMassKg: closed ? vessel.liquidKg : liquidVolumeM3 * tk.liquidDensityKgM3,
      // Rates in this row use the step-start tank state; the step-end state follows the balance.
      tankGaugePressureStepStartPa: stepGaugePa,
      tankTempStepStartC: stepTempC,
      tankGaugePressureStepEndPa: closed ? vessel.s.pressurePa - tk.atmosphericPressurePa : tk.pressureGaugePa,
      tankTempStepEndC: closed ? vessel.tempC : null,
      flashFraction: fr.flashFraction,
      flashKg,
      flashRateKgS: flashKg / dt,
      airCarryKg,
      rawDropletsKg,
      instantDropletVaporizedKg,
      dropletDepositedKg,
      dropletsKg,
      intoPoolKg,
      newAreaM2,
      poolAreaM2,
      heatEvapKg,
      heatEvapRateKgS: heatEvapKg / dt,
      massEvapKg,
      massEvapRateKgS: massEvapKg / dt,
      poolMassKg,
      gasKg,
      gasRateKgS: gasKg / dt,
      gasNm3H: gasKg / dt * kgSToNm3H
    });
  }

  const leakRows = rows.filter((r) => r.leakedKg > 0);
  const postRows = rows.filter((r) => r.leakedKg === 0);
  const leakEnd = leakRows.at(-1) ?? rows[0];
  const finalGasRow = [...rows].reverse().find((r) => r.gasKg > 1e-9) ?? leakEnd;

  return {
    derived: {
      radiusM: radius,
      tankLengthM: tankLength,
      initialLiquidDepthM: initialLiquidDepth,
      initialLiquidVolumeM3: initialLiquidVolume,
      initialLiquidMassKg: initialLiquidVolume * tk.liquidDensityKgM3,
      transferPumpKgS: pumpCapacityKgS,
      fillFraction: initialLiquidVolume / tk.volumeM3,
      leakElevationM: leakElevation,
      holeAreaM2: holeArea,
      storageTempC,
      flashFraction,
      airCarryFraction,
      dropletFraction,
      poolFraction,
      instantVaporFraction,
      depositToPoolFraction,
      suspendedDropletFraction,
      directGasFraction,
      effectivePoolFraction,
      maxPoolAreaM2,
      liquidSurfaceWindMS,
      heatCoefficientKgM2SqrtS: beta,
      q3AreaCoefficient: q3.areaCoefficient,
      q3WindExponent: q3.windExponent,
      q3RadiusExponent: q3.radiusExponent,
      kgSToNm3H
    },
    rows,
    summary: {
      leakDurationS,
      leakCompleted: leakDurationS !== null,
      remainingLiquidMassKg: liquidVolumeM3 * tk.liquidDensityKgM3,
      evaporationCompleted: leakDurationS !== null && poolMassKg === 0,
      initialLeakRateKgS: rows[0]?.leakRateKgS ?? 0,
      leakEndLeakRateKgS: leakEnd?.leakRateKgS ?? 0,
      leakedKg: totals.leakedKg,
      transferredKg: totals.transferredKg,
      transferredM3: totals.transferredM3,
      flashKg: totals.flashKg,
      dropletsKg: totals.dropletsKg,
      rawDropletsKg: totals.rawDropletsKg,
      instantDropletVaporizedKg: totals.instantDropletVaporizedKg,
      dropletDepositedKg: totals.dropletDepositedKg,
      intoPoolKg: totals.intoPoolKg,
      leakPeriodHeatEvapKg: leakRows.reduce((s, r) => s + r.heatEvapKg, 0),
      leakPeriodMassEvapKg: leakRows.reduce((s, r) => s + r.massEvapKg, 0),
      postLeakHeatEvapKg: postRows.reduce((s, r) => s + r.heatEvapKg, 0),
      postLeakMassEvapKg: postRows.reduce((s, r) => s + r.massEvapKg, 0),
      leakEndPoolMassKg: leakEnd?.poolMassKg ?? 0,
      leakEndPoolAreaM2: leakEnd?.poolAreaM2 ?? 0,
      finalGasTimeS: finalGasRow?.timeS ?? 0,
      maxLeakPeriodGasRateKgS: Math.max(...leakRows.map((r) => r.gasRateKgS), 0),
      maxGasRateKgS: Math.max(...rows.map((r) => r.gasRateKgS), 0),
      pressureModel,
      closedTank: closed ? {
        propertySource: saturationTable().source,
        initialSaturationTempC: vessel.initialTempC,
        finalSaturationTempC: vessel.tempC,
        temperatureDropK: vessel.initialTempC - vessel.tempC,
        initialGaugePressurePa: vessel.initialPressurePa - tk.atmosphericPressurePa,
        minGaugePressurePa: vessel.minPressurePa - tk.atmosphericPressurePa,
        leakEndFlashFraction: leakEnd?.flashFraction ?? null,
        initialVesselMassKg: vessel.initialTotalKg,
        residualInventoryAtDrainageKg: vessel.totalKg,
        vaporLeftAtDrainageKg: vessel.vaporKg,
        recondensedLiquidAtDrainageKg: vessel.liquidKg,
        drainagePhaseVolumeM3: vessel.vaporKg / vessel.s.rhoV + vessel.liquidKg / vessel.s.rhoL,
        // Final state rebuilt from (mass, T, V) minus the running energy account.
        energyClosureJ: closedVesselState(vessel.totalKg, vessel.tempC, tk.volumeM3, vessel.wallHeatCapacityJK,
          vessel.referenceTempC).energyJ - (vessel.initialEnergyJ - vessel.outflowEnthalpyJ + vessel.heatAddedJ),
        wallHeatCapacityJK: vessel.wallHeatCapacityJK,
        heatIngressW: vessel.heatIngressW
      } : null,
      // Chlorine vapor in the tank. Its release after liquid drainage is outside the model
      // domain in both pressure options; the constant option holds the initial saturation state.
      tankVapor: (() => {
        const rhoV0 = saturationAt(saturationTempFromPressure(absPressurePa)).rhoV;
        return { initialKg: (tk.volumeM3 - initialLiquidVolume) * rhoV0,
          atDrainageKg: leakDurationS === null ? null : closed ? vessel.totalKg : tk.volumeM3 * rhoV0 };
      })()
    }
  };
}

function buildVentilationSeries(input, release) {
  // Droplet fate is applied in the release model before room transport.
  const dropletEvaporationFraction = release.derived.instantVaporFraction;
  const v = input.ventilation;
  const ph = input.physical;
  const sim = input.simulation;
  if (!Number.isFinite(v.fanMargin) || v.fanMargin < 1) {
    throw new Error("fanMargin must be at least 1 for the balanced makeup-air model");
  }
  const roomVolumeM3 = v.roomVolumeM3 ?? v.roomLengthM * v.roomWidthM * v.roomHeightM;
  if (!Number.isFinite(roomVolumeM3) || roomVolumeM3 <= 0) {
    throw new Error("roomVolumeM3 must be positive");
  }
  const wallAreaM2 = 2 * (v.roomLengthM + v.roomWidthM) * v.roomHeightM;
  const roofAreaM2 = v.roomLengthM * v.roomWidthM;
  const floorAreaM2 = roofAreaM2;
  const uaWK = v.wallUWM2K * wallAreaM2 + v.roofUWM2K * roofAreaM2 + v.floorUWM2K * floorAreaM2 + v.additionalUAWK;
  const roomInventoryKmol = v.roomPressurePa / 1000 * roomVolumeM3 /
    (ph.gasConstantJmolK * (v.initialTempC + 273.15));
  const maxLeakGasKgS = release.summary.maxLeakPeriodGasRateKgS;
  const maxLeakGasNm3H = maxLeakGasKgS * release.derived.kgSToNm3H;
  const maxEffectiveGasKgS = Math.max(...release.rows.map(r => r.gasRateKgS));
  const fanNm3H = maxEffectiveGasKgS * release.derived.kgSToNm3H * v.fanMargin;
  const fanKmolH = fanNm3H / ph.standardMolarVolumeNm3Kmol;
  const dtVentS = sim.timeStepS;
  const rows = [];
  let y = 0;
  let tempC = v.initialTempC;
  let suspendedDropletsKg = 0;
  let cumulativeGasInputKg = 0;
  let cumulativeDropletInputKg = 0;
  let cumulativeGasExtractedKg = 0;
  let cumulativeDropletsExtractedKg = 0;
  let cumulativeDropletsEvaporatedKg = 0;
  const inventoryGasKg = roomInventoryKmol * ph.chlorineMolarMassKgKmol;

  for (let i = 0; i < release.rows.length; i += 1) {
    const src = release.rows[i];
    const dtS = src.durationS;
    const dropletsEvaporatedKg = src.instantDropletVaporizedKg ?? 0;
    const dropletsInputKg = src.dropletsKg;
    const gasInputKg = src.gasKg;
    const sourceKmolH = gasInputKg / dtS * 3600 / ph.chlorineMolarMassKgKmol;
    const makeupAirKmolH = Math.max(0, fanKmolH - sourceKmolH);
    const decay = Math.exp(-fanKmolH * (dtS / 3600) / roomInventoryKmol);
    const previousGasKg = y * inventoryGasKg;
    const previousDropletsKg = suspendedDropletsKg;
    const exchangeS = fanKmolH / 3600 / roomInventoryKmol;
    const integratedRetentionS = exchangeS > 0 ? -Math.expm1(-exchangeS * dtS) / exchangeS : dtS;
    // Uniformly suspended droplets follow the same box exchange as the gas.
    // No settling/deposition, duct holdup or additional duct evaporation is assumed.
    suspendedDropletsKg = previousDropletsKg * decay + dropletsInputKg / dtS * integratedRetentionS;
    y = y * decay + (fanKmolH > 0 ? sourceKmolH / fanKmolH * (1 - decay) : 0);
    const gasExtractedKg = previousGasKg + gasInputKg - y * inventoryGasKg;
    const dropletsExtractedKg = previousDropletsKg + dropletsInputKg - suspendedDropletsKg;
    cumulativeGasInputKg += gasInputKg;
    cumulativeDropletInputKg += dropletsInputKg;
    cumulativeGasExtractedKg += gasExtractedKg;
    cumulativeDropletsExtractedKg += dropletsExtractedKg;
    cumulativeDropletsEvaporatedKg += dropletsEvaporatedKg;
    const dropletVaporizationDemandKW = dropletsEvaporatedKg / dtS * ph.latentHeatJkg / 1000;
    const cpMix = y * v.chlorineCpKJkmolK + (1 - y) * v.airCpKJkmolK;
    const heatTerm = sourceKmolH * v.chlorineCpKJkmolK * (ph.boilingPointC - tempC) +
      makeupAirKmolH * v.airCpKJkmolK * (v.makeupAirTempC - tempC) +
      uaWK * 3.6 * (v.envelopeTempC - tempC) - dropletVaporizationDemandKW * 3600;
    tempC += (dtS / 3600) * heatTerm / (roomInventoryKmol * Math.max(cpMix, 1e-9));
    const actualFlowM3H = fanNm3H * (tempC + 273.15) / 273.15 * 101325 / v.absorberInletPressurePa;
    const chlorineLoadKgH = y * fanKmolH * ph.chlorineMolarMassKgKmol;
    const dropletsLoadKgH = suspendedDropletsKg * exchangeS * 3600;
    rows.push({
      timeS: src.timeS,
      timeMin: src.timeS / 60,
      durationS: dtS,
      sourceKgS: gasInputKg / dtS,
      leakPeriodSourceKgS: src.leakedKg > 0 ? src.gasRateKgS : 0,
      sourceKmolH,
      sourceNm3H: sourceKmolH * ph.standardMolarVolumeNm3Kmol,
      makeupAirKmolH,
      chlorineMolFraction: y,
      airMolFraction: 1 - y,
      chlorineKmolH: y * fanKmolH,
      airKmolH: (1 - y) * fanKmolH,
      chlorineNm3H: y * fanNm3H,
      airNm3H: (1 - y) * fanNm3H,
      chlorineAirMolRatio: y < 1 ? y / (1 - y) : null,
      mixedTempC: tempC,
      cpMixKJkmolK: cpMix,
      absorberActualFlowM3H: actualFlowM3H,
      chlorineActualFlowM3H: y * actualFlowM3H,
      airActualFlowM3H: (1 - y) * actualFlowM3H,
      chlorineLoadKgH,
      dropletsLoadKgH,
      totalChlorineLoadKgH: chlorineLoadKgH + dropletsLoadKgH,
      suspendedDropletsKg,
      roomGasChlorineKg: y * inventoryGasKg,
      dropletsEvaporatedKg,
      dropletVaporizationDemandKW,
      gasExtractedKg,
      dropletsExtractedKg,
      intervalMeanTotalChlorineLoadKgH: (gasExtractedKg + dropletsExtractedKg) / dtS * 3600,
      cumulativeGasInputKg,
      cumulativeDropletInputKg,
      cumulativeGasExtractedKg,
      cumulativeDropletsExtractedKg,
      chlorineBalanceErrorKg: cumulativeGasInputKg + cumulativeDropletInputKg -
        cumulativeGasExtractedKg - cumulativeDropletsExtractedKg - y * inventoryGasKg - suspendedDropletsKg
    });
  }

  const leakRows = rows.filter((r) => r.timeS <= (release.summary.leakDurationS ?? sim.maxTimeS));
  const maxYRow = rows.reduce((a, b) => b.chlorineMolFraction > a.chlorineMolFraction ? b : a, rows[0]);
  const minTRow = rows.reduce((a, b) => b.mixedTempC < a.mixedTempC ? b : a, rows[0]);
  const maxTotalLoadRow = rows.reduce((a, b) => b.totalChlorineLoadKgH > a.totalChlorineLoadKgH ? b : a, rows[0]);

  return {
    derived: {
      roomVolumeM3,
      dropletEvaporationFraction,
      maxEffectiveGasKgS,
      assumptions: {
        dropletEvaporation: `${(release.derived.instantVaporFraction*100).toFixed(1)}% of initially entrained droplets vaporize immediately`,
        transport: `${(release.derived.depositToPoolFraction*100).toFixed(1)}% of initially entrained droplets deposit into the pool; the remainder uses the same fixed-inventory exchange rate as gas`,
        thermal: "Legacy fixed gas inventory approximation; liquid sensible heat and phase equilibrium not solved",
        fanSizing: "Configured fanMargin times peak gas flow after applying the specified immediate droplet-vaporization fraction"
      },
      wallAreaM2,
      roofAreaM2,
      floorAreaM2,
      uaWK,
      roomInventoryKmol,
      maxLeakGasKgS,
      maxLeakGasNm3H,
      fanNm3H,
      fanKmolH,
      initialActualFlowM3H: fanNm3H * (v.initialTempC + 273.15) / 273.15 * 101325 / v.absorberInletPressurePa,
      dtVentS
    },
    initialState: {
      timeS: 0,
      chlorineMolFraction: 0,
      airMolFraction: 1,
      suspendedDropletsKg: 0,
      chlorineLoadKgH: 0,
      dropletsLoadKgH: 0,
      totalChlorineLoadKgH: 0,
      airNm3H: fanNm3H,
      chlorineNm3H: 0,
      mixedTempC: v.initialTempC
    },
    rows,
    summary: {
      leakEndMolFraction: leakRows.at(-1)?.chlorineMolFraction ?? 0,
      leakPeriodMaxMolFraction: Math.max(...leakRows.map((r) => r.chlorineMolFraction), 0),
      maxMolFraction: maxYRow.chlorineMolFraction,
      maxMolFractionTimeMin: maxYRow.timeMin,
      maxChlorineAirMolRatio: maxYRow.chlorineAirMolRatio,
      minMixedTempC: minTRow.mixedTempC,
      minMixedTempTimeMin: minTRow.timeMin,
      actualFlowAtMaxMolFractionM3H: maxYRow.absorberActualFlowM3H,
      maxActualFlowM3H: Math.max(...rows.map((r) => r.absorberActualFlowM3H), 0),
      maxChlorineLoadKgH: Math.max(...rows.map((r) => r.chlorineLoadKgH), 0),
      maxDropletsLoadKgH: Math.max(...rows.map(r => r.dropletsLoadKgH), 0),
      maxTotalChlorineLoadKgH: Math.max(...rows.map(r => r.totalChlorineLoadKgH), 0),
      atMaxTotalChlorineLoad: {
        timeS: maxTotalLoadRow.timeS,
        chlorineMolFraction: maxTotalLoadRow.chlorineMolFraction,
        airMolFraction: maxTotalLoadRow.airMolFraction,
        chlorineLoadKgH: maxTotalLoadRow.chlorineLoadKgH,
        dropletsLoadKgH: maxTotalLoadRow.dropletsLoadKgH,
        totalChlorineLoadKgH: maxTotalLoadRow.totalChlorineLoadKgH,
        absorberActualFlowM3H: maxTotalLoadRow.absorberActualFlowM3H,
        mixedTempC: maxTotalLoadRow.mixedTempC
      },
      cumulativeGasExtractedKg,
      cumulativeDropletsExtractedKg,
      cumulativeDropletsEvaporatedKg,
      remainingGasChlorineKg: y * inventoryGasKg,
      remainingSuspendedDropletsKg: suspendedDropletsKg,
      vaporizationEnergyDemandMJ: cumulativeDropletsEvaporatedKg * ph.latentHeatJkg / 1e6,
      thermalFeasibilityValidated: false,
      maxAbsoluteChlorineBalanceErrorKg: Math.max(...rows.map(r => Math.abs(r.chlorineBalanceErrorKg)))
    }
  };
}

export function calculate(input) {
  const tk = input.tank;
  const pumpM3H = tk.transferPumpM3H ?? 0;
  if (!Number.isFinite(tk.transferStartDelayS ?? 0) || (tk.transferStartDelayS ?? 0) < 0) throw new Error("transferStartDelayS must be nonnegative");
  if (!Number.isFinite(pumpM3H) || pumpM3H < 0) throw new Error("transferPumpM3H must be nonnegative");
  if (pumpM3H > 0 && tk.leakElevationM !== 0) throw new Error("Simultaneous transfer currently requires a bottom leak (leakElevationM = 0)");
  for (const [key, value] of Object.entries({volumeM3: tk.volumeM3, diameterM: tk.diameterM,
    liquidDensityKgM3: tk.liquidDensityKgM3, holeDiameterM: tk.holeDiameterM,
    dischargeCoefficient: tk.dischargeCoefficient, timeStepS: input.simulation.timeStepS,
    maxTimeS: input.simulation.maxTimeS})) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${key} must be positive`);
  }
  if (!Number.isFinite(tk.initialLiquidLevelM) || tk.initialLiquidLevelM < 0 || tk.initialLiquidLevelM > tk.diameterM ||
      !Number.isFinite(tk.leakElevationM) || tk.leakElevationM < 0 || tk.leakElevationM > tk.initialLiquidLevelM) {
    throw new Error("Liquid level and leak elevation must lie within the tank, with leak elevation <= liquid level");
  }
  if (!Number.isFinite(tk.pressureGaugePa) || tk.pressureGaugePa < 0) throw new Error("pressureGaugePa must be nonnegative");
  const instantVaporFraction=input.physical.dropletInstantVaporFraction ?? 0;
  const depositToPoolFraction=input.physical.dropletDepositToPoolFraction ?? 0;
  if(!Number.isFinite(instantVaporFraction) || !Number.isFinite(depositToPoolFraction) ||
      instantVaporFraction<0 || depositToPoolFraction<0 || instantVaporFraction+depositToPoolFraction>1)
    throw new Error("Droplet fate fractions must be nonnegative and sum to at most 1");
  const v = input.ventilation;
  for (const [key, value] of Object.entries({roomLengthM: v.roomLengthM,
    roomWidthM: v.roomWidthM, roomHeightM: v.roomHeightM,
    absorberInletPressurePa: v.absorberInletPressurePa})) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${key} must be positive`);
  }
  if (!Number.isFinite(v.fanMargin) || v.fanMargin < 1) {
    throw new Error("fanMargin must be at least 1 for the balanced makeup-air model");
  }
  const surfaceWindFactor=v.surfaceWindFactor ?? 1;
  if(!Number.isFinite(surfaceWindFactor) || surfaceWindFactor<=0)
    throw new Error("surfaceWindFactor must be positive");
  // One-pass wind estimate: size a preliminary fan from Q1+Q2, convert it at the
  // initial room condition, and divide by the room cross-section normal to flow.
  // Flow is conservatively assumed along the longer plan dimension.
  const preliminaryRelease = buildLeakAndPoolSeries(input, 0);
  const preliminary = preliminaryQ1Q2Peak(input, preliminaryRelease);
  const preliminaryPeakGasKgS = preliminary.peakKgS;
  const preliminaryFanNm3H = preliminaryPeakGasKgS *
    preliminaryRelease.derived.kgSToNm3H * v.fanMargin;
  const preliminaryActualFlowM3H = preliminaryFanNm3H * (v.initialTempC + 273.15) / 273.15 *
    101325 / v.absorberInletPressurePa;
  const effectiveFlowAreaM2 = Math.min(v.roomLengthM, v.roomWidthM) * v.roomHeightM;
  const baseEquivalentSurfaceWindMS = preliminaryActualFlowM3H / (3600 * effectiveFlowAreaM2);
  const equivalentSurfaceWindMS = baseEquivalentSurfaceWindMS * surfaceWindFactor;
  const release = buildLeakAndPoolSeries(input, equivalentSurfaceWindMS);
  Object.assign(release.derived, {
    preliminaryFanNm3H,
    preliminaryPeakGasKgS,
    preliminaryNoEvaporationAreaM2: preliminary.noEvaporationAreaM2,
    preliminaryApproximateLeakDurationS: preliminary.approximateLeakDurationS,
    preliminaryActualFlowM3H,
    effectiveFlowAreaM2,
    baseEquivalentSurfaceWindMS,
    surfaceWindFactor,
    equivalentSurfaceWindMS,
    assumedAirflowLengthM: Math.max(v.roomLengthM, v.roomWidthM)
  });
  const ventilation = buildVentilationSeries(input, release);
  return {
    caseName: input.caseName,
    input,
    release,
    ventilation,
    generatedAt: new Date().toISOString()
  };
}

function toCsv(rows) {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const esc = (value) => {
    if (value === null || value === undefined) return "";
    const s = String(value);
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return [headers.join(","), ...rows.map((row) => headers.map((h) => esc(row[h])).join(","))].join("\n");
}

export async function run(inputPath) {
  const absInput = path.resolve(inputPath);
  const input = JSON.parse(await fs.readFile(absInput, "utf8"));
  const result = calculate(input);
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const outputDir = path.join(projectRoot, "outputs", "data");
  await fs.mkdir(outputDir, { recursive: true });
  const baseName = path.basename(absInput, ".json");
  const resultPath = path.join(outputDir, `${baseName}_results.json`);
  await fs.writeFile(resultPath, JSON.stringify(result, null, 2));
  await fs.writeFile(path.join(outputDir, `${baseName}_release_timeseries.csv`), toCsv(result.release.rows));
  await fs.writeFile(path.join(outputDir, `${baseName}_ventilation_timeseries.csv`), toCsv(result.ventilation.rows));
  return { resultPath, result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const inputPath = process.argv[2] ?? "config/default_25mm.json";
  const { resultPath, result } = await run(inputPath);
  console.log(JSON.stringify({
    resultPath,
    maxLeakPeriodGasRateKgS: result.release.summary.maxLeakPeriodGasRateKgS,
    fanNm3H: result.ventilation.derived.fanNm3H,
    maxMolFraction: result.ventilation.summary.maxMolFraction,
    minMixedTempC: result.ventilation.summary.minMixedTempC
  }, null, 2));
}
