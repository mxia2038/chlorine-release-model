// Heat inputs are NET heat delivered to the liquid relative to initialTempC.
// No heat-release, specific-heat or stage-efficiency value is silently assumed.
export function simulateTankBank(intervals, p) {
  for (const key of ["initialSolutionKg", "solutionCpKJkgK", "naohKgPerKgChlorine", "switchRiseK", "circulationKgS"]) {
    if (!Number.isFinite(p[key]) || p[key] <= 0) throw new Error(`${key} must be positive`);
  }
  if (!Number.isInteger(p.count) || p.count < 1) throw new Error("count must be a positive integer");
  if (!(p.initialNaohFraction > p.switchNaohFraction && p.switchNaohFraction >= 0 && p.initialNaohFraction <= 1)) throw new Error("Invalid NaOH fractions");
  if (!Number.isFinite(p.initialTempC)) throw new Error("initialTempC required");
  if (p.coolerCapacityKW !== null && (!Number.isFinite(p.coolerCapacityKW) || p.coolerCapacityKW < 0)) throw new Error("coolerCapacityKW must be null (ideal control) or nonnegative");
  const tanks = Array.from({length:p.count}, (_,i)=>({id:i+1, liquidKg:p.initialSolutionKg,
    naohKg:p.initialSolutionKg*p.initialNaohFraction, energyKJ:0, absorbedKg:0,
    generatedKJ:0, removedKJ:0, startedAtS:null, endedAtS:null, reason:null}));
  let active=0, inputKg=0, unhandledKg=0;
  const segments=[], events=[];
  for (const r of intervals) {
    if (!Number.isFinite(r.durationS) || r.durationS<=0 || !Number.isFinite(r.timeS) || r.timeS<r.durationS ||
        !Number.isFinite(r.chlorineKg) || r.chlorineKg<0 || !Number.isFinite(r.netHeatKJ) || r.netHeatKJ<0) throw new Error("Invalid thermal interval");
    inputKg+=r.chlorineKg;
    const kgS=r.chlorineKg/r.durationS, heatKW=r.netHeatKJ/r.durationS;
    let left=r.durationS, now=r.timeS-r.durationS;
    while(left>1e-9) {
      if(active>=p.count) { unhandledKg+=kgS*left; break; }
      const t=tanks[active];
      if(t.startedAtS===null) t.startedAtS=now;
      const coolerKW=p.coolerCapacityKW===null ? heatKW : Math.min(heatKW,p.coolerCapacityKW);
      const storedKW=heatKW-coolerKW;
      const chemicalRoom=t.naohKg-p.switchNaohFraction*t.liquidKg;
      const chemicalRate=kgS*(p.naohKgPerKgChlorine+p.switchNaohFraction);
      const chemicalTime=chemicalRate>0 ? Math.max(0,chemicalRoom/chemicalRate) : Infinity;
      const thermalRoom=t.liquidKg*p.solutionCpKJkgK*p.switchRiseK-t.energyKJ;
      const thermalRate=storedKW-kgS*p.solutionCpKJkgK*p.switchRiseK;
      const thermalTime=thermalRate>0 ? Math.max(0,thermalRoom/thermalRate) : Infinity;
      const elapsed=Math.min(left,chemicalTime,thermalTime);
      const inletTemp=p.initialTempC+t.energyKJ/(t.liquidKg*p.solutionCpKJkgK);
      const absorbed=kgS*elapsed;
      t.liquidKg+=absorbed;
      t.naohKg-=absorbed*p.naohKgPerKgChlorine;
      t.absorbedKg+=absorbed;
      t.energyKJ+=storedKW*elapsed;
      t.generatedKJ+=heatKW*elapsed;
      t.removedKJ+=coolerKW*elapsed;
      const tankTemp=p.initialTempC+t.energyKJ/(t.liquidKg*p.solutionCpKJkgK);
      if(elapsed>0) segments.push({tankId:t.id,startS:now,endS:now+elapsed,durationS:elapsed,
        absorbedKg:absorbed,netHeatKW:heatKW,coolerKW,liquidKg:t.liquidKg,
        naohMassFraction:t.naohKg/t.liquidKg,tankTemperatureC:tankTemp,
        towerInletTemperatureC:inletTemp,
        // Neglect single-pass mass increase and holdup in this temperature estimate.
        towerOutletTemperatureC:inletTemp+heatKW/(p.circulationKgS*p.solutionCpKJkgK)});
      const reachedChemical=chemicalTime<=elapsed+1e-8;
      const reachedThermal=thermalTime<=elapsed+1e-8;
      now+=elapsed;left-=elapsed;
      if(reachedChemical || reachedThermal) {
        t.endedAtS=now;
        t.reason=reachedChemical && reachedThermal ? "temperature_and_concentration" : reachedChemical ? "concentration" : "temperature";
        events.push({timeS:now,retiredTank:t.id,nextTank:active+1<p.count ? t.id+1 : null,reason:t.reason});
        active++;
      }
    }
  }
  const max=(key)=>segments.reduce((a,r)=>Math.max(a,r[key]),0);
  return {tanks,segments,events,inputKg,unhandledKg,
    absorbedKg:tanks.reduce((s,t)=>s+t.absorbedKg,0),
    massBalanceErrorKg:inputKg-unhandledKg-tanks.reduce((s,t)=>s+t.absorbedKg,0),
    peakCoolerKW:max("coolerKW"),peakNetHeatKW:max("netHeatKW"),
    peakTowerOutletTemperatureC:segments.length ? max("towerOutletTemperatureC") : null,
    energyBalanceErrorKJ:tanks.reduce((s,t)=>s+t.generatedKJ-t.removedKJ-t.energyKJ,0)};
}

export function buildMainReactionHeat(result) {
  const a=result.input.absorption ?? {}, p=a.process ?? {}, h=a.thermal ?? {};
  const eta=p.mainCaptureFraction, gasHeat=h.gasNetHeatKJkg, liquidHeat=h.dropletNetHeatKJkg;
  if ([eta,gasHeat,liquidHeat].some(x=>x===null || x===undefined)) return null;
  if (!Number.isFinite(eta) || eta<0 || eta>1) throw new Error("mainCaptureFraction must lie in [0,1]");
  if (![gasHeat,liquidHeat].every(x=>Number.isFinite(x) && x>=0)) throw new Error("Reaction heat coefficients must be nonnegative");
  let gasEnergyKJ=0, liquidEnergyKJ=0;
  const rows=result.ventilation.rows.map(r=>{
    const gasKJ=r.gasExtractedKg*eta*gasHeat, liquidKJ=r.dropletsExtractedKg*eta*liquidHeat;
    gasEnergyKJ+=gasKJ;liquidEnergyKJ+=liquidKJ;
    // Endpoint rates locate the instantaneous peak; interval masses integrate heat.
    const gasKW=(r.chlorineLoadKgH ?? r.gasExtractedKg/r.durationS*3600)*eta*gasHeat/3600;
    const liquidKW=(r.dropletsLoadKgH ?? r.dropletsExtractedKg/r.durationS*3600)*eta*liquidHeat/3600;
    return {timeS:r.timeS,timeMin:r.timeS/60,durationS:r.durationS,gasReactionKW:gasKW,
      dropletReactionKW:liquidKW,totalReactionKW:gasKW+liquidKW,
      intervalHeatKJ:gasKJ+liquidKJ,intervalMeanReactionKW:(gasKJ+liquidKJ)/r.durationS};
  });
  const peak=rows.reduce((a,r)=>a===null || r.totalReactionKW>a.totalReactionKW ? r : a,null);
  return {status:"calculated",source:h.heatSourceUrl ?? null,
    basis:h.heatBasis ?? "Specified net heat coefficients",
    assumesContinuousMainCapture:true,mainCaptureFraction:eta,gasHeatKJkg:gasHeat,dropletHeatKJkg:liquidHeat,
    gasEnergyKJ,dropletEnergyKJ:liquidEnergyKJ,totalEnergyKJ:gasEnergyKJ+liquidEnergyKJ,
    peak,rows};
}

export function coolerTemperatureBasis(h, dutyKW, hotInletC) {
  const coldInletC=h.coolantSupplyTempC, coldOutletC=h.coolantReturnTempC;
  if(coldInletC==null || coldOutletC==null) return {status:"needs_temperatures"};
  if(![coldInletC,coldOutletC].every(Number.isFinite) || coldOutletC<=coldInletC)
    throw new Error("Coolant return temperature must exceed supply temperature");
  const d1=hotInletC-coldOutletC, d2=h.initialLiquidTempC-coldInletC;
  if(d1<=0 || d2<=0) return {status:"infeasible_temperature_approach",hotEndDifferenceK:d1,coldEndDifferenceK:d2};
  const lmtdK=Math.abs(d1-d2)<1e-9 ? (d1+d2)/2 : (d1-d2)/Math.log(d1/d2);
  const coefficient=h.overallHeatTransferCoefficientWm2K;
  if(coefficient!=null && (!Number.isFinite(coefficient) || coefficient<=0)) throw new Error("overallHeatTransferCoefficientWm2K must be positive");
  return {status:coefficient==null ? "needs_heat_transfer_coefficient" : "calculated",
    flowBasis:"Ideal countercurrent, correction factor 1; no area margin",
    hotInletC,hotOutletC:h.initialLiquidTempC,coldInletC,coldOutletC,
    hotEndDifferenceK:d1,coldEndDifferenceK:d2,lmtdK,
    requiredUAWK:dutyKW*1000/lmtdK,
    areaM2:coefficient==null ? null : dutyKW*1000/(coefficient*lmtdK)};
}

export function buildThermalStudy(result, basis) {
  const a=result.input.absorption, p=a.process ?? {}, h=a.thermal ?? {};
  const initialSolutionKg=p.mainInitialSolutionKgPerTank ??
    (p.mainTankSizingBasis === "chemical_capacity" ? basis.stageCapacity?.mainInitialSolutionKgPerTank : null);
  const required={"process.mainCaptureFraction":p.mainCaptureFraction,
    "process.mainInitialSolutionKgPerTank":initialSolutionKg,
    "thermal.solutionCpKJkgK":h.solutionCpKJkgK,
    "thermal.gasNetHeatKJkg":h.gasNetHeatKJkg,
    "thermal.dropletNetHeatKJkg":h.dropletNetHeatKJkg};
  const missing=Object.entries(required).filter(([,v])=>v===null || v===undefined).map(([k])=>k);
  const reactionHeat=buildMainReactionHeat(result);
  const assumptions=["One main absorber with two sequential tanks, one tail tower with its own tank; retired tanks are not reused",
    "Main capture fraction is an input, applied equally to gas and droplets; no efficiency prediction",
    "Ideal cooled case removes net reaction heat to retain the 18 C initial temperature; no existing cooler rating is inferred",
    "Adiabatic comparison is separate and is not the operating temperature of a cooled tank",
    "Constant solution Cp; specified heat basis applies, no extra latent heat subtraction",
    "Tower outlet temperature neglects single-pass mass gain and tower holdup; cooler uses ideal countercurrent temperature basis"];
  if(missing.length) return {status:"needs_inputs",missing,assumptions,reactionHeat,cooled:null,adiabatic:null};
  if(!Number.isFinite(p.mainCaptureFraction) || p.mainCaptureFraction<0 || p.mainCaptureFraction>1) throw new Error("mainCaptureFraction must lie in [0,1]");
  for(const k of ["gasNetHeatKJkg","dropletNetHeatKJkg"]) if(!Number.isFinite(h[k]) || h[k]<0) throw new Error(`${k} must be nonnegative`);
  const intervals=result.ventilation.rows.map(r=>({timeS:r.timeS,durationS:r.durationS,
    chlorineKg:(r.gasExtractedKg+r.dropletsExtractedKg)*p.mainCaptureFraction,
    netHeatKJ:(r.gasExtractedKg*h.gasNetHeatKJkg+r.dropletsExtractedKg*h.dropletNetHeatKJkg)*p.mainCaptureFraction}));
  const params={count:p.mainTankCount,initialSolutionKg,
    initialNaohFraction:a.naohMassFraction,switchNaohFraction:a.finalNaohMassFraction,
    naohKgPerKgChlorine:basis.naohKgPerKgChlorine,solutionCpKJkgK:h.solutionCpKJkgK,
    switchRiseK:h.switchTemperatureRiseK,initialTempC:h.initialLiquidTempC,
    circulationKgS:basis.tower.circulationM3H*a.solutionDensityKgM3/3600};
  const cooled=simulateTankBank(intervals,{...params,coolerCapacityKW:null});
  const adiabatic=simulateTankBank(intervals,{...params,coolerCapacityKW:0});
  const coolantCp=h.coolantCpKJkgK ?? null;
  const delta=h.coolantSupplyTempC!=null && h.coolantReturnTempC!=null
    ? h.coolantReturnTempC-h.coolantSupplyTempC : h.coolantTemperatureRiseK;
  if(!Number.isFinite(delta) || delta<=0) throw new Error("coolantTemperatureRiseK must be positive");
  if(coolantCp!==null && (!Number.isFinite(coolantCp) || coolantCp<=0)) throw new Error("coolantCpKJkgK must be positive");
  const peakDesignCoolerKW=reactionHeat.peak?.totalReactionKW ?? 0;
  const peakDesignOutletTemperatureC=h.initialLiquidTempC+peakDesignCoolerKW/(params.circulationKgS*h.solutionCpKJkgK);
  return {status:"calculated",missing,assumptions,reactionHeat,cooled,adiabatic,
    cooler:coolerTemperatureBasis(h,peakDesignCoolerKW,peakDesignOutletTemperatureC),
    coolantTemperatureRiseK:delta,
    initialSolutionKgPerMainTank:initialSolutionKg,
    solutionCpKJkgK:h.solutionCpKJkgK,
    peakDesignCoolerKW,
    peakDesignOutletTemperatureC,
    designCoolingBasis:"Continuous 90% capture (configured mainCaptureFraction), instantaneous source peak; no tank-unavailability credit",
    coolantDesignPeakKgH:coolantCp!==null ? peakDesignCoolerKW*3600/(coolantCp*delta) : null,
    coolantPeakKgH:coolantCp!==null ? cooled.peakCoolerKW*3600/(coolantCp*delta) : null,
    // Includes main-tank exhaustion breakthrough, without crediting tail removal.
    tailInletChlorineWithinWindowKg:result.ventilation.summary.cumulativeGasExtractedKg+
      result.ventilation.summary.cumulativeDropletsExtractedKg-cooled.absorbedKg,
    tailAbsorptionCalculated:false};
}

// Nominal downstream capacity/heat target, not a tail removal-efficiency prediction.
export function buildTailDesign(result, basis) {
  const a=result.input.absorption ?? {}, h=a.thermal ?? {};
  const eta=a.process?.mainCaptureFraction;
  const target=basis.outletTarget;
  const residual=target?.emittedWithinWindowKg ?? 0;
  const chlorine=basis.stageCapacity.tailInletChlorineKg==null ? null : Math.max(0,basis.stageCapacity.tailInletChlorineKg-residual);
  // Only deduct modeled emissions; remaining inventory outside the window retains full capacity.
  const mass=chlorine==null || basis.stageCapacity.tailInitialSolutionKg==null ? null :
    basis.stageCapacity.tailInletChlorineKg>0 ? basis.stageCapacity.tailInitialSolutionKg*chlorine/basis.stageCapacity.tailInletChlorineKg : 0;
  const flow=basis.tailTower.circulationM3H;
  if(eta==null || mass==null || chlorine==null || !flow || !a.solutionDensityKgM3 ||
     !a.tankWorkingVolumeFraction || !h.solutionCpKJkgK ||
     h.gasNetHeatKJkg==null || h.dropletNetHeatKJkg==null || !Number.isFinite(h.initialLiquidTempC))
    return {status:"needs_inputs"};
  const density=a.solutionDensityKgM3, fill=a.tankWorkingVolumeFraction;
  const rows=result.ventilation.rows.map((r,i)=>({
    timeS:r.timeS,
    heatKW:((1-eta)*(r.chlorineLoadKgH*h.gasNetHeatKJkg+r.dropletsLoadKgH*h.dropletNetHeatKJkg)-
      (target?.rows?.[i]?.outletGasKgH ?? 0)*h.gasNetHeatKJkg)/3600
  }));
  const peak=rows.reduce((best,r)=>r.heatKW>best.heatKW ? r : best,{timeS:0,heatKW:0});
  const th=a.tailTower?.thermal ?? {};
  if(![th.coolantSupplyTempC,th.solutionInletApproachK,th.solutionOutletReferenceC].every(Number.isFinite))
    return {status:"needs_inputs"};
  const inletC=th.coolantSupplyTempC+th.solutionInletApproachK;
  const outletC=th.solutionOutletReferenceC;
  const solutionRiseK=outletC-inletC;
  if(th.solutionInletApproachK<=0 || solutionRiseK<=0) throw new Error("Tail solution temperature approach and rise must be positive");
  const specifiedTemperatureDutyKW=flow*density/3600*h.solutionCpKJkgK*solutionRiseK;
  const requiredCirculationM3H=peak.heatKW*3600/(density*h.solutionCpKJkgK*solutionRiseK);
  if(!Number.isFinite(th.solutionOutletLimitC) || th.solutionOutletLimitC<=inletC) throw new Error("Tail outlet limit must exceed inlet temperature");
  if(!Number.isFinite(th.coolantReturnApproachK) || th.coolantReturnApproachK<=0) throw new Error("Tail coolant return approach must be positive");
  const predictedOutletC=inletC+peak.heatKW/(flow*density/3600*h.solutionCpKJkgK);
  const returnC=predictedOutletC-th.coolantReturnApproachK;
  const delta=returnC-th.coolantSupplyTempC;
  if(delta!==null && (!Number.isFinite(delta) || delta<=0)) throw new Error("Tail coolant return must exceed supply temperature");
  if(th.coolantCpKJkgK!=null && (!Number.isFinite(th.coolantCpKJkgK) || th.coolantCpKJkgK<=0)) throw new Error("Tail coolant Cp must be positive");
  return {status:"calculated",
    basis:"Target outlet gas concentration, full droplet capture; modeled-window residual deducted, outside-window remainder fully covered; main continuously operating; required performance not validated",
    thermalBasis:"Tail uses independent cooling-water temperatures; computed tower outlet and inlet=supply+approach; coolant return=computed outlet-return approach. Reference and upper limit are checked independently; neglects interstage evaporation, gas sensible heat and dilution",
    chlorineCapacityKg:chlorine,initialSolutionKg:mass,finalSolutionKg:mass+chlorine,
    initialLiquidM3:mass/density,finalLiquidM3:(mass+chlorine)/density,
    initialBasisGrossVolumeM3:mass/density/fill,
    finalBasisGrossVolumeM3:(mass+chlorine)/density/fill,
    peakReactionKW:peak.heatKW,peakTimeMin:peak.timeS/60,
    circulationM3H:flow,designInletTemperatureC:inletC,designOutletTemperatureC:predictedOutletC,
    outletReferenceC:outletC,outletLimitC:th.solutionOutletLimitC,
    outletLimitSatisfied:predictedOutletC<=th.solutionOutletLimitC,
    outletReferenceSatisfied:predictedOutletC<=outletC,
    outletLimitMarginK:th.solutionOutletLimitC-predictedOutletC,
    coolantSupplyTempC:th.coolantSupplyTempC,coolantReturnTempC:returnC,
    coolantReturnApproachK:th.coolantReturnApproachK,coolantTemperatureRiseK:delta,
    specifiedTemperatureDutyKW,requiredCirculationM3H,
    requiredSprayDensityM3M2H:requiredCirculationM3H/basis.tailTower.selectedAreaM2,
    temperatureBalanceSatisfied:specifiedTemperatureDutyKW+1e-8>=peak.heatKW,
    predictedPeakOutletTemperatureC:predictedOutletC,
    coolantPeakKgH:th.coolantCpKJkgK>0 && delta>0 ? peak.heatKW*3600/(th.coolantCpKJkgK*delta) : null,
    cooler:{status:"vendor_scope",hotInletC:predictedOutletC,hotOutletC:inletC,coldInletC:th.coolantSupplyTempC,coldOutletC:returnC},
    removalEfficiencyValidated:false};
}
