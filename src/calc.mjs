import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PI = Math.PI;

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
  const storageTempC = storageTempFromPressureC(absPressurePa, input.antoine);
  const flashFraction = ph.liquidCpKJkgK * 1000 * (storageTempC - ph.boilingPointC) / ph.latentHeatJkg;
  if(!Number.isFinite(flashFraction) || flashFraction<0 || flashFraction>1)
    throw new Error("Calculated flash fraction must lie in [0,1]");
  // GB/T 37243-2019 D.31/D.32: for Fv<=0.2, total airborne carry is
  // 5*Fv; for Fv>0.2, all released liquid is carried and no pool forms.
  const airCarryFraction = flashFraction<=0.2 ? 5 * flashFraction : 1;
  const dropletFraction = Math.max(0, airCarryFraction - flashFraction);
  const poolFraction = Math.max(0, 1 - airCarryFraction);
  const instantVaporFraction = ph.dropletInstantVaporFraction ?? 0;
  const depositToPoolFraction = ph.dropletDepositToPoolFraction ?? 0;
  const suspendedDropletFraction = dropletFraction * (1-instantVaporFraction-depositToPoolFraction);
  const directGasFraction = flashFraction + dropletFraction * instantVaporFraction;
  const effectivePoolFraction = poolFraction + dropletFraction * depositToPoolFraction;
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
    const liquidDepth = depthFromArea(Math.max(0, liquidVolumeM3 / tankLength), radius);
    const headM = Math.max(0, liquidDepth - leakElevation);
    const isLeak = liquidVolumeM3 > residualVolume && headM > 0;
    const leakRateKgS = isLeak
      ? tk.dischargeCoefficient * holeArea *
        Math.sqrt(2 * tk.liquidDensityKgM3 * (tk.pressureGaugePa + tk.liquidDensityKgM3 * ph.gravityMS2 * headM))
      : 0;
    const availableKg = Math.max(0, liquidVolumeM3 - residualVolume) * tk.liquidDensityKgM3;
    const beforePumpS = Math.min(dt, Math.max(0, (tk.transferStartDelayS ?? 0) - t0));
    const preLeakS = leakRateKgS > 0 ? Math.min(beforePumpS, availableKg / leakRateKgS) : 0;
    const afterPreKg = Math.max(0, availableKg - leakRateKgS * preLeakS);
    const transferRateKgS = isLeak && beforePumpS < dt && afterPreKg > 0 ? pumpCapacityKgS : 0;
    const totalOutflowKgS = leakRateKgS + transferRateKgS;
    // Split the interval at pump startup, including non-grid delays such as 30 s.
    // Rates use the existing step-start head approximation.
    const concurrentS = totalOutflowKgS > 0 ? Math.min(dt - beforePumpS, afterPreKg / totalOutflowKgS) : 0;
    const stepLeakTimeS = preLeakS + concurrentS;
    const leakedKg = Math.min(leakRateKgS * stepLeakTimeS, availableKg);
    const transferredKg = transferRateKgS * concurrentS;
    liquidVolumeM3 = Math.max(residualVolume, liquidVolumeM3 - (leakedKg + transferredKg) / tk.liquidDensityKgM3);
    if (isLeak && availableKg <= leakRateKgS * beforePumpS + totalOutflowKgS * (dt - beforePumpS)) {
      liquidVolumeM3 = residualVolume;
      leakDurationS = t0 + stepLeakTimeS;
    }

    const flashKg = flashFraction * leakedKg;
    const airCarryKg = airCarryFraction * leakedKg;
    const rawDropletsKg = dropletFraction * leakedKg;
    const instantDropletVaporizedKg = rawDropletsKg * instantVaporFraction;
    const dropletDepositedKg = rawDropletsKg * depositToPoolFraction;
    const dropletsKg = rawDropletsKg - instantDropletVaporizedKg - dropletDepositedKg;
    const intoPoolKg = poolFraction * leakedKg + dropletDepositedKg;
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
      remainingLiquidMassKg: liquidVolumeM3 * tk.liquidDensityKgM3,
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
      transferredM3: totals.transferredKg / tk.liquidDensityKgM3,
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
      maxGasRateKgS: Math.max(...rows.map((r) => r.gasRateKgS), 0)
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
