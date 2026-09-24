import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { run } from "./calc.mjs";
import { buildOutletTarget } from "./outlet_target.mjs";
import { buildThermalStudy, buildTailDesign } from "./tank_thermal.mjs";

export function sizeTower(settings, maxActualGasM3H, flowWindowComplete) {
  const velocity=settings.superficialGasVelocityMS ?? null;
  const fluctuation=settings.loadFluctuationFactor ?? null;
  const increment=settings.diameterIncrementMm ?? 100;
  const sprayDensity=settings.sprayDensityM3M2H ?? null;
  for(const [key,value] of Object.entries({superficialGasVelocityMS:velocity,loadFluctuationFactor:fluctuation,diameterIncrementMm:increment,sprayDensityM3M2H:sprayDensity})) {
    if(value!==null && (!Number.isFinite(value) || value<=0)) throw new Error(key+" must be positive");
  }
  const designGasM3H = fluctuation !== null ? maxActualGasM3H * fluctuation : null;
  const calculatedDiameterM = designGasM3H !== null && velocity !== null
    ? Math.sqrt(4 * designGasM3H / (3600 * Math.PI * velocity)) : null;
  const selectedDiameterMm = calculatedDiameterM !== null
    ? Math.ceil(calculatedDiameterM * 1000 / increment) * increment : null;
  const selectedAreaM2 = selectedDiameterMm > 0 ? Math.PI * (selectedDiameterMm / 1000) ** 2 / 4 : null;
  return {
    superficialGasVelocityMS: velocity, loadFluctuationFactor: fluctuation,
    diameterIncrementMm: increment, maxActualGasM3H, designGasM3H,
    calculatedDiameterM, selectedDiameterMm, selectedAreaM2,
    sprayDensityM3M2H: sprayDensity,
    circulationM3H: selectedAreaM2 !== null && sprayDensity !== null ? selectedAreaM2 * sprayDensity : null,
    selectedSuperficialGasVelocityMS: selectedAreaM2 !== null ? designGasM3H / (3600 * selectedAreaM2) : null,
    basis: "Maximum inlet actual gas volume including t=0, multiplied by load fluctuation factor; rounded upward",
    flowWindowComplete
  };
}

export function buildDesignBasis(result) {
  const { release, ventilation: v, input } = result;
  const a = input.absorption ?? {};
  const concentration = a.naohMassFraction ?? null;
  const excess = a.naohExcessFactor ?? null;
  const finalConcentration = a.finalNaohMassFraction ?? null;
  const density = a.solutionDensityKgM3 ?? null;
  const tankCount = a.circulationTankCount ?? null;
  const workingFraction = a.tankWorkingVolumeFraction ?? null;
  if (tankCount !== null && (!Number.isInteger(tankCount) || tankCount <= 0)) throw new Error("circulationTankCount must be a positive integer");
  if (workingFraction !== null && (!Number.isFinite(workingFraction) || workingFraction <= 0 || workingFraction > 1)) throw new Error("tankWorkingVolumeFraction must be in (0,1]");
  const velocity = a.superficialGasVelocityMS ?? null;
  const fluctuation = a.loadFluctuationFactor ?? null;
  const increment = a.diameterIncrementMm ?? 100;
  const sprayDensity = a.sprayDensityM3M2H ?? null;
  for (const [key, value] of Object.entries({superficialGasVelocityMS: velocity, loadFluctuationFactor: fluctuation, diameterIncrementMm: increment, sprayDensityM3M2H: sprayDensity})) {
    if (value !== null && (!Number.isFinite(value) || value <= 0)) throw new Error(`${key} must be positive`);
  }
  if (concentration !== null && (!Number.isFinite(concentration) || concentration <= 0 || concentration > 1)) throw new Error("naohMassFraction must be in (0,1]");
  if (excess !== null && (!Number.isFinite(excess) || excess < 1)) throw new Error("naohExcessFactor must be >= 1");
  if (density !== null && (!Number.isFinite(density) || density <= 0)) throw new Error("solutionDensityKgM3 must be positive");
  if (finalConcentration !== null && (!Number.isFinite(finalConcentration) || finalConcentration < 0 || concentration === null || finalConcentration >= concentration)) throw new Error("finalNaohMassFraction must be nonnegative and below initial concentration");
  const peak = key => v.rows.reduce((a,b) => b[key] > a[key] ? b : a);
  const snapshot = (name, r) => ({ name, timeMin: r.timeMin,
    chlorineMolFraction: r.chlorineMolFraction, airMolFraction: r.airMolFraction,
    actualGasM3H: r.absorberActualFlowM3H, temperatureC: r.mixedTempC,
    gasChlorineKgH: r.chlorineLoadKgH, dropletsKgH: r.dropletsLoadKgH,
    totalChlorineKgH: r.totalChlorineLoadKgH });
  // Capacity basis includes chlorine still in the pool and room, not just
  // material already extracted by the end of the finite simulation window.
  const chlorineCapacityKg = release.summary.leakCompleted ? release.summary.leakedKg : null;
  const ratio = 2 * 39.997 / input.physical.chlorineMolarMassKgKmol;
  const theoreticalNaohKg = chlorineCapacityKg === null ? null : chlorineCapacityKg * ratio;
  const theoreticalSolutionKg = theoreticalNaohKg !== null && concentration !== null ? theoreticalNaohKg / concentration : null;
  const residualBasisSolutionKg = theoreticalNaohKg !== null && finalConcentration !== null
    ? (theoreticalNaohKg + finalConcentration * chlorineCapacityKg) / (concentration - finalConcentration) : null;
  const excessBasisSolutionKg = theoreticalSolutionKg !== null && excess !== null ? theoreticalSolutionKg * excess : null;
  const solutionKg = residualBasisSolutionKg !== null || excessBasisSolutionKg !== null
    ? Math.max(residualBasisSolutionKg ?? 0, excessBasisSolutionKg ?? 0) : null;
  const designNaohKg = solutionKg !== null ? solutionKg * concentration : null;
  const finalSolutionKg = solutionKg !== null ? solutionKg + chlorineCapacityKg : null;
  const remainingNaohKg = designNaohKg !== null ? designNaohKg - theoreticalNaohKg : null;
  const mainFraction = a.process?.mainCaptureFraction ?? null;
  if (mainFraction !== null && (!Number.isFinite(mainFraction) || mainFraction < 0 || mainFraction > 1)) throw new Error("mainCaptureFraction must lie in [0,1]");
  const mainCount = a.process?.mainTankCount ?? null;
  const mainInitialPerTank = mainFraction !== null && solutionKg !== null && Number.isInteger(mainCount) && mainCount > 0
    ? solutionKg * mainFraction / mainCount : null;
  const stageCapacity = {
    mainCaptureFraction: mainFraction,
    mainChlorineKg: chlorineCapacityKg !== null && mainFraction !== null ? chlorineCapacityKg * mainFraction : null,
    tailInletChlorineKg: chlorineCapacityKg !== null && mainFraction !== null ? chlorineCapacityKg * (1-mainFraction) : null,
    mainInitialSolutionKgPerTank: mainInitialPerTank,
    tailInitialSolutionKg: solutionKg !== null && mainFraction !== null ? solutionKg * (1-mainFraction) : null,
    mainInitialGrossVolumeM3PerTank: mainInitialPerTank !== null && density !== null && workingFraction !== null ? mainInitialPerTank/density/workingFraction : null,
    basis: "Chemical-capacity allocation only, same initial/final NaOH concentrations in both stages; assumes tail treats all main-stage remainder; no thermal early-switch allowance",
    phaseBasis: "Main capture fraction applied equally to gas and droplets; operating tank masses are not automatically assigned"
  };
  const initialLiquidVolumeM3 = solutionKg !== null && density !== null ? solutionKg / density : null;
  const finalLiquidVolumeM3 = finalSolutionKg !== null && density !== null ? finalSolutionKg / density : null;
  const tankReady = initialLiquidVolumeM3 !== null && tankCount !== null && workingFraction !== null;
  const circulationTanks = {
    count: tankCount, workingVolumeFraction: workingFraction, densityKgM3: density,
    initialLiquidVolumeM3, finalLiquidVolumeM3,
    initialLiquidPerTankM3: tankReady ? initialLiquidVolumeM3 / tankCount : null,
    initialBasisGrossVolumePerTankM3: tankReady ? initialLiquidVolumeM3 / tankCount / workingFraction : null,
    finalBasisGrossVolumePerTankM3: tankReady ? finalLiquidVolumeM3 / tankCount / workingFraction : null,
    densityBasis: "User-provided provisional mixture density, used for both endpoints; composition formula not yet supplied",
    allocation: "Previous equal-volume preliminary basis only; allocation to two main tanks and one tail tank is not yet confirmed",
    allocationStatus: "preliminary_equal_split",
    mainTankCount: a.process?.mainTankCount ?? null,
    tailTankCount: a.process?.tailTankCount ?? null
  };
  const maxActualGasM3H = Math.max(v.derived.initialActualFlowM3H, v.summary.maxActualFlowM3H);
  const tower = sizeTower(a,maxActualGasM3H,release.summary.evaporationCompleted);
  const tailTower = sizeTower(a.tailTower ?? {},maxActualGasM3H,release.summary.evaporationCompleted);
  tailTower.basis = "Same fan maximum actual flow as main tower; no main-stage gas shrinkage or tail inlet temperature/pressure correction; rounded upward";
  const vaporPct=(release.derived.instantVaporFraction??0)*100;
  const depositPct=(release.derived.depositToPoolFraction??0)*100;
  const suspendedPct=Math.max(0,100-vaporPct-depositPct);
  const dropletFateDescription=vaporPct===0&&depositPct===0
    ? "液滴在塔前不蒸发、不沉降，按完全混合随排风进入吸收塔"
    : `初始夹带液滴中${vaporPct.toFixed(1)}%立即汽化、${depositPct.toFixed(1)}%沉降入液池、${suspendedPct.toFixed(1)}%保持悬浮并随排风进入塔`;
  const basis = {
    caseName: result.caseName,
    assumptions: ["Whole-room perfect mixing",dropletFateDescription,
      "All leaked chlorine eventually requires treatment, including liquid droplets; transferred chlorine excluded",
      "All absorbed chlorine retained in solution; no water evaporation, makeup or liquid loss",
      "Reagent capacity and inlet-velocity diameter estimate only; removal efficiency, packing height and cooling not calculated"],
    reaction: "Cl2 + 2 NaOH -> NaCl + NaClO + H2O",
    dropletFateDescription,
    reactionSource: "https://halogenvalve.com/downloads/chemical-safety/hypochlorite/Hypo_Handbook_Oxy_Chem.pdf",
    fanNm3H: v.derived.fanNm3H,
    initialActualGasM3H: v.derived.initialActualFlowM3H,
    tower,
    tailTower,
    outletChlorineRequirement: {
      ...(a.outletChlorineRequirement ?? {}),
      predictedMgNm3: null,
      compliance: "not_evaluated",
      basis: "User-specified outlet requirement; nominal complete tail capture is only a capacity/heat basis, not evidence of compliance"
    },
    designScope: a.designScope ?? {},
    stageCapacity,
    circulationTanks,
    inletCases: [snapshot("总氯负荷峰值",peak("totalChlorineLoadKgH")),
      snapshot("气相浓度峰值",peak("chlorineMolFraction")),
      snapshot("气态氯负荷峰值",peak("chlorineLoadKgH")),
      snapshot("液滴负荷峰值",peak("dropletsLoadKgH")),
      snapshot("采样实际气量峰值",peak("absorberActualFlowM3H"))],
    chlorineCapacityKg, theoreticalNaohKg, theoreticalSolutionKg, naohKgPerKgChlorine: ratio,
    naohMassFraction: concentration, naohExcessFactor: excess,
    finalNaohMassFraction: finalConcentration,
    residualBasisSolutionKg, finalSolutionKg, remainingNaohKg,
    calculatedFinalNaohMassFraction: finalSolutionKg > 0 ? remainingNaohKg / finalSolutionKg : null,
    solutionDensityKgM3: density, designNaohKg, solutionKg,
    solutionM3: solutionKg !== null && density !== null ? solutionKg / density : null,
    peakTheoreticalNaohConsumptionKgH: v.summary.maxTotalChlorineLoadKgH * ratio,
    chlorineExtractedWithinWindowKg: v.summary.cumulativeGasExtractedKg + v.summary.cumulativeDropletsExtractedKg,
    remainingRoomChlorineKg: v.summary.remainingGasChlorineKg + v.summary.remainingSuspendedDropletsKg,
    limitations: ["Temperature and actual flow retain the existing approximate heat balance",
      "Liquid-pool evaporation and droplet partition assumptions remain as documented in README",
      "Mixture density is a provisional input; initial and final densities are not yet calculated from composition"]
  };
  basis.outletTarget = buildOutletTarget(result);
  basis.thermalStudy = buildThermalStudy(result, basis);
  basis.tailDesign = buildTailDesign(result, basis);
  return basis;
}

function report(b) {
  const f = (v, digits=2) => v === null ? "待定" : v.toFixed(digits);
  const thermal = b.thermalStudy;
  const reasonLabel=reason=>({concentration:"NaOH降至5 wt%",temperature:"温升达到20℃",temperature_and_concentration:"温度和浓度同时达到限值"}[reason]??reason);
  const heat=thermal.reactionHeat;
  const heatText=heat ? `## 主塔反应放热\n\n气态氯 ${f(heat.gasHeatKJkg)} kJ/kg，液滴氯 ${f(heat.dropletHeatKJkg)} kJ/kg。按主塔持续吸收${f(heat.mainCaptureFraction*100)}%分别计算，不重复扣汽化热。参考：[OxyChem手册第6–7页](${heat.source ?? b.reactionSource})。\n\n` +
    `主塔峰值反应放热 **${f(heat.peak.totalReactionKW)} kW**，发生在 ${f(heat.peak.timeMin)} min；该时刻气态氯贡献 ${f(heat.peak.gasReactionKW)} kW，液滴贡献 ${f(heat.peak.dropletReactionKW)} kW。窗口内累计放热 ${f(heat.totalEnergyKJ/1e6,3)} GJ。\n\n` +
    `瞬时负荷用于取峰值，每步实际抽出质量用于积分；不需要吸收液比热。采用手册参考状态近似，未加入低温进料显热、稀释热及水蒸发修正，故这是反应热基准，不是已完成校核的冷却器净负荷。尚未扣除槽停用导致的吸收中断。\n\n` : "";
  const labels={"process.mainCaptureFraction":"主塔吸收率",
    "process.mainInitialSolutionKgPerTank":"主塔单槽实际初始装液质量",
    "thermal.solutionCpKJkgK":"混合吸收液比热",
    "thermal.gasNetHeatKJkg":"气态氯单位净放热",
    "thermal.dropletNetHeatKJkg":"液滴氯单位净放热"};
  const thermalText = thermal.status === "needs_inputs"
    ? `当前待定：${thermal.missing.map(k=>labels[k]??k).join("、")}。尚未输出项目切槽时刻或塔出口温度。`
    : `主塔每槽初始液量 ${f(thermal.initialSolutionKgPerMainTank)} kg，吸收液比热 ${f(thermal.solutionCpKJkgK,3)} kJ/(kg·K)。维持18℃进液的理想冷却工况，按持续吸收的瞬时峰值反算移热负荷 ${f(thermal.peakDesignCoolerKW)} kW，塔出液峰值温度 ${f(thermal.peakDesignOutletTemperatureC)} ℃；冷冻水按${f(thermal.coolantTemperatureRiseK)}℃温差、输入比热近似，所需峰值质量流量 ${f(thermal.coolantDesignPeakKgH)} kg/h。以上沿用反应热近似，不代表已完成净热负荷或冷却器性能验证。\n\n` +
      `实际递推采用各步平均热负荷；冷却工况主塔未处理氯量 ${f(thermal.cooled.unhandledKg)} kg。切换事件：${thermal.cooled.events.map(e=>`${f(e.timeS/60)} min，${e.retiredTank}号槽因${reasonLabel(e.reason)}退出，下一槽${e.nextTank??"无"}`).join("；") || "窗口内未触发"}。\n\n` +
      `不冷却对照切换事件：${thermal.adiabatic.events.map(e=>`${f(e.timeS/60)} min，${e.retiredTank}号槽因${reasonLabel(e.reason)}退出`).join("；") || "窗口内未触发"}；主塔未处理氯量 ${f(thermal.adiabatic.unhandledKg)} kg。不冷却对照的时间不能作为有冷却工况的实际切换时间。`;
  return `# 吸收系统入口条件与理论耗碱量\n\n${b.caseName}\n\n` +
    `厂房整体完全混合；${b.dropletFateDescription}。标准排风量 ${f(b.fanNm3H)} Nm³/h；启动瞬间实际气量 ${f(b.initialActualGasM3H)} m³/h，此时气相为空气。\n\n` +
    `| 工况 | 时间 min | 气相 Cl2 % | 气相空气 % | 实际气量 m³/h | 温度 ℃ | 气态氯 kg/h | 液滴 kg/h | 总氯 kg/h |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|\n` +
    b.inletCases.map(r=>`| ${r.name} | ${f(r.timeMin)} | ${f(r.chlorineMolFraction*100)} | ${f(r.airMolFraction*100)} | ${f(r.actualGasM3H)} | ${f(r.temperatureC)} | ${f(r.gasChlorineKgH)} | ${f(r.dropletsKgH)} | ${f(r.totalChlorineKgH)} |`).join("\n") +
    `\n\n各行均为同一时刻的参数组合，不将不同时刻的分项峰值直接相加。\n\n` +
    `## NaOH 容量基准\n\n反应：${b.reaction}。依据：[OxyChem Sodium Hypochlorite Handbook](${b.reactionSource})。\n\n` +
    `- 总待处理氯量：${f(b.chlorineCapacityKg)} kg，含气态氯和液滴，不含倒槽量。\n` +
    `- 理论纯 NaOH：${f(b.theoreticalNaohKg)} kg（${f(b.naohKgPerKgChlorine,4)} kg NaOH/kg Cl2）。\n` +
    `- 峰值理论纯 NaOH 消耗速率：${f(b.peakTheoreticalNaohConsumptionKgH)} kg/h，不是循环液流量。\n` +
    `- 初始浓度：${f(b.naohMassFraction === null ? null : b.naohMassFraction * 100)} wt%；过量系数：${f(b.naohExcessFactor)}。\n` +
    `- 不含过量的理论初始溶液质量：${f(b.theoreticalSolutionKg)} kg。\n` +
    `- 终态游离 NaOH 目标：${f(b.finalNaohMassFraction === null ? null : b.finalNaohMassFraction * 100)} wt%；按该目标所需初始碱液：${f(b.residualBasisSolutionKg)} kg。\n` +
    `- 含过量的纯 NaOH：${f(b.designNaohKg)} kg；初始溶液质量：${f(b.solutionKg)} kg；初始溶液体积：${f(b.solutionM3)} m³。\n\n` +
    `- 吸收后溶液质量：${f(b.finalSolutionKg)} kg；剩余游离 NaOH：${f(b.remainingNaohKg)} kg；终态质量分数：${f(b.calculatedFinalNaohMassFraction === null ? null : b.calculatedFinalNaohMassFraction * 100)} wt%。\n\n` +
    `终态约束：初始液量=(理论耗碱量+终态质量分数×吸收氯量)/(初始质量分数-终态质量分数)。最终液量=初始液量+吸收氯量；反应生成水已包含于质量守恒，不再次加算。假设无水蒸发、补水、排液或夹带损失。若另设过量系数，取两种容量要求较大值，不叠乘。体积需对应碱液密度，未知输入保持待定。\n\n` +
    `## 吸收塔直径\n\n取含启动瞬间的最大入口实际气量 ${f(b.tower.maxActualGasM3H)} m³/h；负荷波动系数 ${f(b.tower.loadFluctuationFactor)}；计算气量 ${f(b.tower.designGasM3H)} m³/h。已有风机 1.1 倍系数包含在气量内，不重复乘入。\n\n` +
    `D=√[4Q/(3600πu)]；空塔气速 ${f(b.tower.superficialGasVelocityMS)} m/s；计算内径 ${f(b.tower.calculatedDiameterM,4)} m；按 ${f(b.tower.diameterIncrementMm,0)} mm 向上圆整，选用内径 **${f(b.tower.selectedDiameterMm,0)} mm**。圆整后设计气量下空塔气速 ${f(b.tower.selectedSuperficialGasVelocityMS,4)} m/s。\n\n` +
    `## 循环液量\n\n喷淋密度 ${f(b.tower.sprayDensityM3M2H)} m³/(m²·h)，按圆整后内径对应截面积 ${f(b.tower.selectedAreaM2,4)} m² 计算：L=喷淋密度×截面积=**${f(b.tower.circulationM3H)} m³/h**。这是循环喷淋流量，不是新鲜碱液补充量；尚未加泵选型裕量，也未指定分段喷淋。\n\n` +
    `## 循环槽容积（此前均分初算）\n\n最新流程为1台主吸收塔配2槽切换、1台尾气塔配1槽。以下保留此前 ${f(b.circulationTanks.count,0)} 槽均分液量的对照，不能直接作为两级流程的最终槽容分配。有效装液率 ${f(b.circulationTanks.workingVolumeFraction === null ? null : b.circulationTanks.workingVolumeFraction*100)}%。密度暂取 ${f(b.solutionDensityKgM3)} kg/m³，初末态均暂用此值；混合物密度公式尚未提供。\n\n` +
    `- 初始总液体体积：${f(b.circulationTanks.initialLiquidVolumeM3)} m³。\n` +
    `- 单槽初始装液体积：${f(b.circulationTanks.initialLiquidPerTankM3)} m³。\n` +
    `- 按初始液量所需单槽几何容积：**${f(b.circulationTanks.initialBasisGrossVolumePerTankM3)} m³**。\n` +
    `- 吸收后总液体体积：${f(b.circulationTanks.finalLiquidVolumeM3)} m³；若终态也满足85%装液率，对应单槽几何容积 ${f(b.circulationTanks.finalBasisGrossVolumePerTankM3)} m³。\n\n` +
    `公式：单槽几何容积=液体质量/密度/槽数/有效装液率。初始装液基准和吸收后增重校核分别列出，尚未圆整或确定设备规格；未另扣塔和管道持液量。\n\n` +
    `## 两级氯负荷与化学容量分配\n\n主塔吸收率 ${f(b.stageCapacity.mainCaptureFraction === null ? null : b.stageCapacity.mainCaptureFraction*100)}%，当前对气态氯与液滴合计应用同一比例。主塔累计吸收 ${f(b.stageCapacity.mainChlorineKg)} kg，尾塔累计入口 ${f(b.stageCapacity.tailInletChlorineKg)} kg；该比例以主塔有可用槽为前提，主塔槽提前失效时进入尾塔的量会增加。\n\n` +
    `仅按18→5 wt%化学容量分配：主塔每槽初始碱液 ${f(b.stageCapacity.mainInitialSolutionKgPerTank)} kg（主塔两槽均分），按85%装液率对应初始几何容积 ${f(b.stageCapacity.mainInitialGrossVolumeM3PerTank)} m³；尾塔初始碱液 ${f(b.stageCapacity.tailInitialSolutionKg)} kg。尾塔用量以处理主塔全部剩余氯为容量目标，并非已验证尾塔去除率。这些量本身未考虑温升提前切槽；配置选择chemical_capacity时，将主塔单槽化学容量液量作为热计算初始装液量，实际采用值见下文。\n\n` +
    `## 尾气塔塔径与循环量\n\n沿用主塔风机最大实际气量 ${f(b.tailTower.maxActualGasM3H)} m³/h，未扣除主塔吸收后的气量收缩，未修正尾塔入口温压。空塔气速 ${f(b.tailTower.superficialGasVelocityMS)} m/s，负荷波动系数 ${f(b.tailTower.loadFluctuationFactor)}，计算塔径 ${f(b.tailTower.calculatedDiameterM,3)} m；向上按 ${f(b.tailTower.diameterIncrementMm,0)} mm圆整，选径 ${f(b.tailTower.selectedDiameterMm,0)} mm。圆整后截面积 ${f(b.tailTower.selectedAreaM2,3)} m²、空塔气速 ${f(b.tailTower.selectedSuperficialGasVelocityMS,3)} m/s。喷淋密度 ${f(b.tailTower.sprayDensityM3M2H)} m³/(m²·h)，循环量 ${f(b.tailTower.circulationM3H)} m³/h。循环量未加泵选型裕量；此处不代表已验证尾塔吸收效率。\n\n` +
    (b.tailDesign.status === "calculated" ? `## 尾气塔槽容与冷却初算\n\n以主塔持续吸收90%、尾塔气相出口4 mg/Nm³及液滴全捕集为设计目标，不代表尾塔去除率或出口浓度已验证。沿用主塔吸收液性质；尾塔独立采用循环水冷却，进塔液温=循环水上水+6℃，出塔液温由反应热和固定循环量计算，气液相分别计算反应热，未计级间蒸发与气体显热。\n\n尾塔需处理氯 ${f(b.tailDesign.chlorineCapacityKg)} kg；18→5 wt%对应初始碱液 ${f(b.tailDesign.initialSolutionKg)} kg，初始液体积 ${f(b.tailDesign.initialLiquidM3)} m³，吸收后 ${f(b.tailDesign.finalLiquidM3)} m³。按85%装液率，初始基准槽容 ${f(b.tailDesign.initialBasisGrossVolumeM3)} m³；按吸收后增重校核所需槽容 ${f(b.tailDesign.finalBasisGrossVolumeM3)} m³，尚未圆整、未另扣管道与塔内持液。\n\n峰值反应热 ${f(b.tailDesign.peakReactionKW)} kW（${f(b.tailDesign.peakTimeMin)} min）；设计循环液进/出塔温度 ${f(b.tailDesign.designInletTemperatureC)}/${f(b.tailDesign.designOutletTemperatureC)} ℃；循环水上/回水 ${f(b.tailDesign.coolantSupplyTempC)}/${f(b.tailDesign.coolantReturnTempC)} ℃。出塔参考温度 ${f(b.tailDesign.outletReferenceC)} ℃，上限 ${f(b.tailDesign.outletLimitC)} ℃，上限校核 ${b.tailDesign.outletLimitSatisfied ? '满足' : '不满足'}，温度余量 ${f(b.tailDesign.outletLimitMarginK)} ℃。循环水回水=计算出塔液温−${f(b.tailDesign.coolantReturnApproachK)} ℃，水温升 ${f(b.tailDesign.coolantTemperatureRiseK)} ℃，峰值负荷下所需循环水质量流量 ${f(b.tailDesign.coolantPeakKgH)} kg/h。换热面积及传热系数由厂家确定，本模型提供热负荷、流量和温度条件。主塔停用穿透负荷及尾塔动态浓度、温度尚未纳入本项初算。\n\n` : '') +
    (b.outletTarget.status === "calculated_design_target" ? `## 出口设计目标\n\n设计4 mg/Nm³，验收严格<5 mg/Nm³。暂按干气标况（0℃、101.325 kPa），出口体积=空气体积+残余氯体积，液滴按全捕集。窗口内目标残余氯 ${f(b.outletTarget.emittedWithinWindowKg,4)} kg；尾塔最严格气态氯所需去除率 ${f(b.outletTarget.mostDemanding.requiredGasRemovalFraction*100,5)}%，发生于 ${f(b.outletTarget.mostDemanding.timeS/60)} min。低负荷时出口不超过入口可用氯量。数值为达到目标所需性能，不是传质预测或达标证明。\n\n` : '') +
    heatText +
    (thermal.cooler?.lmtdK ? `## 冷却器换热温差\n\n冷冻水 ${f(thermal.cooler.coldInletC)}→${f(thermal.cooler.coldOutletC)} ℃；循环液 ${f(thermal.cooler.hotInletC)}→${f(thermal.cooler.hotOutletC)} ℃。按理想逆流计算，对数平均温差 ${f(thermal.cooler.lmtdK)} K，所需UA为 ${f(thermal.cooler.requiredUAWK)} W/K。换热面积由厂家确定（本项目不计算）。未计实际流型温差修正或面积裕量。\n\n` : '') +
    `## 单槽温度、浓度与切换\n\n主塔按1号槽→2号槽，无重复投用。任何一槽温升达到20℃或游离NaOH达到5 wt%即退出；最后一槽退出后继续统计未处理负荷。槽温升与循环液单次通过塔的温升分别计算。\n\n${thermalText}\n\n` +
    `不预设反应时间：逐步累计实际吸收氯质量和净热量，在步内求达到温度或浓度限值的最早时刻。冷却工况目前为反算维持18℃所需负荷，表示理想调节而非已选冷却器性能；另计算不冷却对照。使用区间平均源项，忽略塔内持液与单次质量增量；冷冻水温差不能单独确定换热面积。\n\n` +
    `## 计算范围\n\n本表完成入口负荷、碱液总容量、主塔入口气速塔径和循环液量估算；单槽温度切换模块已建立，数值结果取决于完整输入，尾塔按指定捕集分配计算容量与峰值热负荷，不预测实际移除效率。填料高度不在本模型计算范围内，换热面积由厂家确定。出口氯气要求为严格低于 ${f(b.outletChlorineRequirement.limitMgNm3 ?? null)} mg/Nm³（项目输入要求）；当前未预测实际出口浓度，达标状态为未验证。本轮暂采用干基计算出口设计目标；干湿基口径需与验收条件保持一致。尾塔承担全部剩余氯的容量假设不等于实际零排放。未校核泛点。温度与实际气量沿用现有近似热衡算；液池蒸发假设见 README。\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { resultPath, result } = await run(process.argv[2] ?? "config/default_25mm.json");
  const basis = buildDesignBasis(result);
  const stem = resultPath.replace(/_results\.json$/, "_absorption_design_basis");
  await fs.writeFile(`${stem}.json`, JSON.stringify(basis,null,2));
  await fs.writeFile(`${stem}.md`, report(basis));
  console.log(JSON.stringify({reportPath:`${stem}.md`, theoreticalNaohKg:basis.theoreticalNaohKg,solutionKg:basis.solutionKg},null,2));
}
