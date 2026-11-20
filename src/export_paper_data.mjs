import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {calculate} from './calc.mjs';
import {buildDesignBasis} from './design_basis.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const out=path.join(root,'data','paper');
const base=JSON.parse(await fs.readFile(path.join(root,'config','default_25mm.json'),'utf8'));

for(const script of [
  'research_scan.mjs','research_hole_scan.mjs',
  'research_assumption_sensitivity.mjs','research_droplet_bounds.mjs',
  'research_convergence.mjs','research_transfer_pairs.mjs',
  'research_revision_pairs.mjs','research_tank_pressure.mjs','research_thermal_terms.mjs',
  'research_absorber_checks.mjs'
]) await import(new URL(script,import.meta.url));

await fs.mkdir(out,{recursive:true});
const write=async(name,data)=>fs.writeFile(path.join(out,name),JSON.stringify(data,null,2)+'\n');
const read=async(name)=>JSON.parse(await fs.readFile(path.join(root,'outputs','research',name),'utf8'));

const result=calculate(base);
const design=buildDesignBasis(result);
if(!result.release.summary.leakCompleted||!result.release.summary.evaporationCompleted)
  throw new Error('Baseline calculation did not finish');
const figureEndS=9000;
await write('baseline_case.json',{
  config:'config/default_25mm.json',stepS:base.simulation.timeStepS,
  summary:{
    leakedKg:result.release.summary.leakedKg,
    leakDurationS:result.release.summary.leakDurationS,
    fanNm3H:design.fanNm3H,
    maxRoomChlorineMolFraction:result.ventilation.summary.maxMolFraction,
    mainCoolingKW:design.thermalStudy.peakDesignCoolerKW,
    tailCoolingKW:design.tailDesign.peakReactionKW,
    mainTankM3PerTank:design.stageCapacity.mainFinalGrossVolumeM3PerTank,
    sourcePeakKgS:result.release.summary.maxLeakPeriodGasRateKgS
  },
  figure2:{
    endS:figureEndS,
    release:result.release.rows.filter(r=>r.timeS<=figureEndS).map(r=>({
      timeS:r.timeS,leakRateKgS:r.leakRateKgS,transferRateKgS:r.transferRateKgS,
      flashRateKgS:r.flashRateKgS,heatEvapRateKgS:r.heatEvapRateKgS,
      massEvapRateKgS:r.massEvapRateKgS
    })),
    absorberInlet:result.ventilation.rows.filter(r=>r.timeS<=figureEndS).map(r=>({
      timeS:r.timeS,chlorineLoadKgH:r.chlorineLoadKgH,
      dropletsLoadKgH:r.dropletsLoadKgH,totalChlorineLoadKgH:r.totalChlorineLoadKgH
    }))
  }
});

for(const [source,target,fields] of [
  ['transfer_delay_scan.json','transfer_delay_scan.json',['stepS','rows']],
  ['hole_size_scan.json','hole_size_scan.json',['stepS','holeDiametersMm','scenarios','summary','rows']],
  ['assumption_sensitivity.json','assumption_sensitivity.json',['rows']],
  ['droplet_fate_bounds.json','droplet_fate_bounds.json',['rows']],
  ['time_step_convergence.json','time_step_convergence.json',['rows']],
  ['revision_pairs.json','scenario_pairs.json',['pumpM3H','rows','stepCheck']],
  ['tank_pressure_comparison.json','tank_pressure_comparison.json',['rows','pairs','vsConstant','stepCheck']],
  ['absorber_checks.json','absorber_checks.json',['packing','liquidViscosityPaS','hydraulicCorrelation','cases']],
  ['thermal_terms.json','thermal_terms.json',['cases','paired']]
]){
  const raw=await read(source);
  await write(target,Object.fromEntries(fields.map(key=>[key,raw[key]])));
}

const approximateLeak=(release,pumpKgS,delayS)=>{
  const initialLeakKgS=release.summary.initialLeakRateKgS;
  const initialMassKg=release.derived.initialLiquidMassKg;
  const beforePumpS=Math.min(delayS,initialMassKg/initialLeakKgS);
  return initialLeakKgS*beforePumpS+
    initialLeakKgS*(initialMassKg-initialLeakKgS*beforePumpS)/(initialLeakKgS+pumpKgS);
};
const constantRateCases=[];
for(const [holeDiameterMm,pumpM3H,delayS] of [
  [25,25,0],[25,12.5,0],[25,50,0],[25,25,300],[25,25,1800],[25,25,2400],[15,25,0],[35,25,0]
]){
  const input=structuredClone(base);
  input.tank.holeDiameterM=holeDiameterMm/1000;
  input.tank.transferPumpM3H=pumpM3H;
  input.tank.transferStartDelayS=delayS;
  const r=calculate(input);
  const approximateKg=approximateLeak(r.release,r.release.derived.transferPumpKgS,delayS);
  constantRateCases.push({holeDiameterMm,pumpM3H,delayS,
    modeledLeakKg:r.release.summary.leakedKg,constantRateApproxKg:approximateKg,
    approximationErrorPct:100*(approximateKg/r.release.summary.leakedKg-1)});
}
const pressurePumpCases=[];
for(const pressureGaugeKPa of [150,200,300])for(const pumpM3H of [0,25,50]){
  const input=structuredClone(base);
  input.tank.pressureGaugePa=pressureGaugeKPa*1000;
  input.tank.transferPumpM3H=pumpM3H;
  const r=calculate(input);
  pressurePumpCases.push({pressureGaugeKPa,pumpM3H,
    leakedKg:r.release.summary.leakedKg,
    fanNm3H:r.ventilation.derived.fanNm3H,
    gasSourcePeakKgS:r.release.summary.maxLeakPeriodGasRateKgS,
    maxRoomChlorineMolFraction:r.ventilation.summary.maxMolFraction});
}
// Algebraic checks used in the response-time and ventilation discussion.
const initialMassKg=result.release.derived.initialLiquidMassKg;
const initialLeakKgS=result.release.summary.initialLeakRateKgS;
const piQ=result.release.derived.transferPumpKgS/initialLeakKgS;
const transferScreening=[600,2400].map(delayS=>{
  const thetaD=initialLeakKgS*delayS/initialMassKg;
  const equivalentZeroDelayPiQ=piQ*(1-thetaD)/(1+piQ*thetaD);
  return {delayS,piQ,thetaD,equivalentZeroDelayPiQ,
    equivalentCapacityReductionPct:100*(1-equivalentZeroDelayPiQ/piQ)};
});
await write('additional_checks.json',{
  config:'config/default_25mm.json',stepS:base.simulation.timeStepS,
  constantRateFormula:'mL0*t* + mL0*(M0-mL0*t*)/(mL0+mT); t*=min(delay,M0/mL0)',
  constantRateCases,pressurePumpCases,transferScreening,
  pressureStudyBasis:'Fixed baseline density, liquid heat capacity, boiling point and latent heat; Antoine temperature and flash fraction vary with pressure.'
});

console.log(`Wrote 12 paper data files to ${path.relative(root,out)}`);
