// Hydraulic and absorption checks for the two packed towers
// at the selected diameters, circulation rates and packing.
// 1. Caustic delivered per pass: the circulating liquor must carry at least the sodium
//    hydroxide consumed by the chlorine absorbed in one pass (O'Brien and White, 1992).
// 2. Transfer units required by the main-stage capture and by the tail outlet target,
//    against the installed packed height.
// 3. Hydraulics: Robbins pressure drop; flooding at a pressure drop of 0.12 Fp^0.7 in. H2O/ft
//    (Kister and Gill), both as given in Perry's Chemical Engineers' Handbook, Section 14.
// Gas load is followed through the event so that flow and density belong to the same instant.
import fs from 'node:fs/promises';
import {calculate} from './calc.mjs';
import {buildDesignBasis} from './design_basis.mjs';

const base=JSON.parse(await fs.readFile(new URL('../config/default_25mm.json',import.meta.url),'utf8'));
const out=new URL('../outputs/research/',import.meta.url);
const R=8.314462618, M_CL2=70.906e-3, M_AIR=28.965e-3, IN_H2O_PER_FT=817.22083; // Pa/m per in. H2O/ft
const LIQUID_VISCOSITY_PAS=0.0046;     // 20 wt% NaOH near 20 °C
// Project packing: two 2.5 m beds per tower. Properties of the 51 mm plastic rosette packing from
// HG/T 3986-2016, Table D.2; its dry packing factor of 255 1/m equals a/eps^3.
const PACKING={name:'51 mm x 19 mm CPVC rosette',source:'HG/T 3986-2016, Table D.2',specificAreaM2M3:180,voidFraction:0.89,
  bulkDensityKgM3:99,piecesPerM3:25000,dryPackingFactorM:255,bedHeightM:5};
if(Math.abs(PACKING.specificAreaM2M3/PACKING.voidFraction**3-PACKING.dryPackingFactorM)>1) throw new Error('dry packing factor is not a/eps^3');
PACKING.packingFactorM=PACKING.dryPackingFactorM;
PACKING.packingFactorFt=PACKING.packingFactorM*0.3048;

// Robbins pressure drop in Pa per m of packing; L, G in kg/(m2 s)
function robbins(L,G,rhoL,rhoG,muL,fp){
  const l=L*737.33812,g=G*737.33812,rl=rhoL*0.062427961,rg=rhoG*0.062427961,mu=muL*1000;
  const root=Math.sqrt(0.05*fp),Lf=l*(62.4/rl)*root*mu**0.1,Gf=g*Math.sqrt(0.075/rg)*root;
  const a=7.4e-8*Gf*Gf*10**(2.7e-5*Lf);
  return (a+0.4*(5e-5*Lf)**0.1*a**4)*IN_H2O_PER_FT;
}
const floodDp=fp=>0.12*fp**0.7*IN_H2O_PER_FT;
// gas rate at which the pressure drop reaches the flood value, at the same liquid rate
function percentOfFlood(L,G,rhoL,rhoG,muL,fp){
  let lo=G,hi=G*50;
  for(let i=0;i<80;i+=1){const mid=(lo+hi)/2;if(robbins(L,mid,rhoL,rhoG,muL,fp)<floodDp(fp))lo=mid;else hi=mid;}
  return 100*G/lo;
}

function hydraulics(c,r,d){
  const rhoL=d.circulationTanks.densityKgM3,p=c.ventilation.absorberInletPressurePa,fp=PACKING.packingFactorFt,result={};
  for(const [key,t] of Object.entries({main:d.tower,tail:d.tailTower})){
    const L=t.sprayDensityM3M2H*rhoL/3600;
    let worst=null;
    for(const row of r.ventilation.rows){
      const T=row.mixedTempC+273.15,yRoom=row.chlorineMolFraction,eta=d.stageCapacity.mainCaptureFraction;
      // main tower: room gas; tail tower: same gas after the main-stage capture, at the same flow basis
      const y=key==='main'?yRoom:yRoom*(1-eta)/(1-yRoom*eta);
      const rhoG=p*(y*M_CL2+(1-y)*M_AIR)/(R*T),u=row.absorberActualFlowM3H/3600/t.selectedAreaM2,G=u*rhoG;
      const pct=percentOfFlood(L,G,rhoL,rhoG,LIQUID_VISCOSITY_PAS,fp);
      if(!worst||pct>worst.percentOfFlood)worst={timeS:row.timeS,gasVelocityMS:u,gasDensityKgM3:rhoG,molFraction:y,
        percentOfFlood:pct,pressureDropPaM:robbins(L,G,rhoL,rhoG,LIQUID_VISCOSITY_PAS,fp)};
    }
    result[key]={diameterMm:t.selectedDiameterMm,circulationM3H:t.circulationM3H,liquidKgM2S:L,
      floodPressureDropPaM:floodDp(fp),...worst,bedPressureDropPa:worst.pressureDropPaM*PACKING.bedHeightM};
  }
  return result;
}

// Sodium hydroxide carried by the liquor per pass against that consumed at the configured main-stage capture.
function causticPerPass(r,d){
  const eta=d.stageCapacity.mainCaptureFraction,k=d.naohKgPerKgChlorine;
  const circulationKgH=d.tower.circulationM3H*d.circulationTanks.densityKgM3,segments=d.thermalStudy.cooled.segments;
  const rows=r.ventilation.rows,peak=rows.reduce((a,b)=>b.totalChlorineLoadKgH>a.totalChlorineLoadKgH?b:a);
  let index=0,shortfallNaohKg=0,first=null,last=null,tightest=null,atPeak=null;
  for(const row of rows){
    while(index<segments.length-1&&segments[index].endS<row.timeS-1e-6)index+=1;
    const liquor=segments[index].naohMassFraction,required=k*eta*row.totalChlorineLoadKgH/circulationKgH;
    const point={timeS:row.timeS,tankId:segments[index].tankId,loadKgH:row.totalChlorineLoadKgH,
      liquorNaohMassFraction:liquor,requiredNaohMassFraction:required,marginMassFraction:liquor-required};
    if(row===peak)atPeak=point;
    if(row.totalChlorineLoadKgH>0&&(!tightest||point.marginMassFraction<tightest.marginMassFraction))tightest=point;
    if(required>liquor){shortfallNaohKg+=(required-liquor)*circulationKgH*row.durationS/3600;first??=row.timeS;last=row.timeS;}
  }
  const event=d.thermalStudy.cooled.events[0];
  return {circulationKgH,switchNaohMassFraction:d.stageCapacity.mainSwitchNaohMassFraction,
    firstTankSwitchS:event?.timeS??null,atPeakLoad:atPeak,tightest,
    shortfallWindowS:first===null?null:[first,last],shortfallChlorineKg:shortfallNaohKg/k};
}

function transferUnits(d){
  const main=-Math.log(1-d.stageCapacity.mainCaptureFraction);
  const demanding=d.outletTarget.mostDemanding,tail=-Math.log(1-demanding.requiredGasRemovalFraction);
  return {main:{captureFraction:d.stageCapacity.mainCaptureFraction,transferUnits:main,allowableTransferUnitHeightM:PACKING.bedHeightM/main},
    tail:{timeS:demanding.timeS,requiredGasRemovalFraction:demanding.requiredGasRemovalFraction,transferUnits:tail,
      allowableTransferUnitHeightM:PACKING.bedHeightM/tail}};
}

function evaluate(label,mod){
  const c=structuredClone(base);mod(c);
  const r=calculate(c),d=buildDesignBasis(r);
  return {case:label,fanNm3H:d.fanNm3H,leakedKg:r.release.summary.leakedKg,causticPerPass:causticPerPass(r,d),
    transferUnits:transferUnits(d),hydraulics:hydraulics(c,r,d)};
}

const first=calculate(base).ventilation.rows[0];
if(!('mixedTempC' in first)||!('chlorineMolFraction' in first)||!('absorberActualFlowM3H' in first)) throw new Error(`ventilation row fields changed: ${Object.keys(first).join(',')}`);
const cases=[evaluate('baseline',()=>{}),evaluate('no transfer',c=>{c.tank.transferPumpM3H=0;})];
await fs.mkdir(out,{recursive:true});
await fs.writeFile(new URL('absorber_checks.json',out),JSON.stringify({createdAt:new Date().toISOString(),
  packing:PACKING,liquidViscosityPaS:LIQUID_VISCOSITY_PAS,
  hydraulicCorrelation:'Robbins pressure drop; flood at 0.12 Fp^0.7 in. H2O/ft',cases},null,2));
const pct=x=>(100*x).toFixed(2)+'%';
for(const c of cases){
  const p=c.causticPerPass,t=c.transferUnits;
  console.log(`${c.case} | per pass: peak ${p.atPeakLoad.loadKgH.toFixed(0)} kg/h at ${p.atPeakLoad.timeS} s needs ${pct(p.atPeakLoad.requiredNaohMassFraction)}, liquor ${pct(p.atPeakLoad.liquorNaohMassFraction)}; tightest ${pct(p.tightest.marginMassFraction)} at ${p.tightest.timeS} s; switch ${p.firstTankSwitchS?.toFixed(0)} s; shortfall ${p.shortfallWindowS?p.shortfallWindowS.join('-')+' s, '+p.shortfallChlorineKg.toFixed(0)+' kg Cl2':'none'}`);
  console.log(`${c.case} | transfer units: main ${t.main.transferUnits.toFixed(2)} (H_OG <= ${t.main.allowableTransferUnitHeightM.toFixed(2)} m), tail ${t.tail.transferUnits.toFixed(1)} (H_OG <= ${t.tail.allowableTransferUnitHeightM.toFixed(2)} m)`);
  for(const k of ['main','tail']){const h=c.hydraulics[k];console.log(`${c.case} | ${k} D=${h.diameterMm} mm u=${h.gasVelocityMS.toFixed(3)} m/s rhoG=${h.gasDensityKgM3.toFixed(2)} | ${h.percentOfFlood.toFixed(0)}% of flood, ${h.pressureDropPaM.toFixed(0)} Pa/m, ${(h.bedPressureDropPa/1000).toFixed(2)} kPa over the bed`);}
}
