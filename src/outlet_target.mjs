
export function buildOutletTarget(result) {
  const a=result.input.absorption ?? {}, target=a.outletChlorineRequirement?.designTargetMgNm3;
  const eta=a.process?.mainCaptureFraction;
  if(target==null || eta==null) return {status:"needs_inputs"};
  const limit=a.outletChlorineRequirement.limitMgNm3;
  if(!Number.isFinite(target) || target<0 || !(target<limit)) throw new Error("Outlet target must be nonnegative and strictly below limit");
  const specificVolume=result.input.physical.standardMolarVolumeNm3Kmol/result.input.physical.chlorineMolarMassKgKmol;
  const c=target/1e6;
  if(c*specificVolume>=1) throw new Error("Invalid outlet concentration");
  // C=m/(Vair+specificVolume*m), with no negative removal at low inlet loads.
  const outlet=(air,gas)=>Math.min(gas,c*Math.max(0,air)/(1-c*specificVolume));
  let emittedKg=0,tailGasInKg=0,tailGasAbsorbedKg=0,tailDropletsAbsorbedKg=0;
  const rows=result.ventilation.rows.map(r=>{
    const inletGasKgH=r.chlorineLoadKgH*(1-eta);
    const outletGasKgH=outlet(r.airNm3H,inletGasKgH);
    const outletDryNm3H=r.airNm3H+outletGasKgH*specificVolume;
    const intervalAirNm3=result.ventilation.derived.fanNm3H*r.durationS/3600-r.gasExtractedKg*specificVolume;
    const intervalGasKg=r.gasExtractedKg*(1-eta);
    const intervalOutletKg=outlet(intervalAirNm3,intervalGasKg);
    emittedKg+=intervalOutletKg;tailGasInKg+=intervalGasKg;
    tailGasAbsorbedKg+=intervalGasKg-intervalOutletKg;
    tailDropletsAbsorbedKg+=r.dropletsExtractedKg*(1-eta);
    return {timeS:r.timeS,outletDryNm3H,outletGasKgH,
      targetConcentrationMgNm3:outletDryNm3H>0 ? outletGasKgH*1e6/outletDryNm3H : 0,
      tailGasInletKgH:inletGasKgH,tailGasAbsorbedKgH:inletGasKgH-outletGasKgH,
      tailDropletsAbsorbedKgH:r.dropletsLoadKgH*(1-eta),
      requiredGasRemovalFraction:inletGasKgH>0 ? 1-outletGasKgH/inletGasKgH : 0};
  });
  const mostDemanding=rows.reduce((best,r)=>!best || r.requiredGasRemovalFraction>best.requiredGasRemovalFraction ? r:best,null);
  return {status:"calculated_design_target",designTargetMgNm3:target,acceptanceLimitMgNm3:limit,
    basis:"Dry air plus residual gaseous chlorine at standard conditions; main continuously operating; tail droplets fully captured; no interstage evaporation",
    compliance:"not_validated",intervalMethod:"Interval-mean air and gas balance; emissions capped by available chlorine",
    emittedWithinWindowKg:emittedKg,tailGasInWithinWindowKg:tailGasInKg,
    tailGasAbsorbedWithinWindowKg:tailGasAbsorbedKg,tailDropletsAbsorbedWithinWindowKg:tailDropletsAbsorbedKg,
    mostDemanding,rows};
}
