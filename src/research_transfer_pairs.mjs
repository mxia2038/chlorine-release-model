import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {calculate} from './calc.mjs';
import {buildMainReactionHeat} from './tank_thermal.mjs';

const base=JSON.parse(await fs.readFile(new URL('../config/default_25mm.json',import.meta.url),'utf8'));
const baseline=calculate(base);
// Inventory sensitivity, not a replacement for a coupled p-V-T model.
const inventoryFactor=(base.ventilation.initialTempC+273.15)/
  (baseline.ventilation.summary.minMixedTempC+273.15);

function replay(result,fanNm3H){
  const p=result.input, N=result.ventilation.derived.roomInventoryKmol;
  const Q=fanNm3H/p.physical.standardMolarVolumeNm3Kmol/3600;
  const k=Q/N;
  let gas=0,droplet=0,peakKW=0,extracted=0,input=0,maxBalanceErrorKg=0;
  const eta=p.absorption.process.mainCaptureFraction,h=p.absorption.thermal;
  for(const r of result.release.rows){
    const before=gas+droplet, decay=Math.exp(-k*r.durationS);
    const retention=-Math.expm1(-k*r.durationS)/k;
    gas=gas*decay+r.gasKg/r.durationS*retention;
    droplet=droplet*decay+r.dropletsKg/r.durationS*retention;
    input+=r.gasKg+r.dropletsKg;
    extracted+=before+r.gasKg+r.dropletsKg-gas-droplet;
    peakKW=Math.max(peakKW,eta*k*(gas*h.gasNetHeatKJkg+droplet*h.dropletNetHeatKJkg));
    maxBalanceErrorKg=Math.max(maxBalanceErrorKg,Math.abs(input-extracted-gas-droplet));
  }
  return {peakKW,maxBalanceErrorKg};
}

const scenarios=[
  {id:'baseline',label:'Suspended droplets; full mixing volume'},
  {id:'half_volume',label:'Suspended droplets; half mixing volume',volume:0.5},
  {id:'deposited',label:'All entrained droplets assigned to pool',deposit:1},
  {id:'gas_allocation',label:'All entrained droplets assigned to gas',vapor:1},
  {id:'inventory_check',label:'Reference inventory increased to cold-state equivalent',volume:inventoryFactor},
];
const rows=[];
for(const scenario of scenarios){
  const cases=[];
  for(const pumpM3H of [0,25]){
    const p=structuredClone(base);
    p.tank.transferPumpM3H=pumpM3H;
    p.tank.transferStartDelayS=0;
    p.physical.dropletInstantVaporFraction=scenario.vapor??0;
    p.physical.dropletDepositToPoolFraction=scenario.deposit??0;
    p.ventilation.roomVolumeM3=baseline.ventilation.derived.roomVolumeM3*(scenario.volume??1);
    const r=calculate(p),mainCoolingKW=buildMainReactionHeat(r).peak.totalReactionKW;
    const check=replay(r,r.ventilation.derived.fanNm3H);
    assert.ok(Math.abs(check.peakKW-mainCoolingKW)<1e-7,'Replay must match existing transport');
    assert.ok(check.maxBalanceErrorKg<1e-6,'Replay chlorine balance');
    cases.push({pumpM3H,leakedKg:r.release.summary.leakedKg,
      leakDurationS:r.release.summary.leakDurationS,fanNm3H:r.ventilation.derived.fanNm3H,
      mainCoolingKW,residenceTimeS:r.ventilation.derived.roomInventoryKmol/
        r.ventilation.derived.fanKmolH*3600});
  }
  const [without,withTransfer]=cases;
  rows.push({id:scenario.id,label:scenario.label,cases,reductionPct:Object.fromEntries(
    ['leakedKg','fanNm3H','mainCoolingKW'].map(k=>[k,100*(1-withTransfer[k]/without[k])]))});
}

const noTransferInput=structuredClone(base);
noTransferInput.tank.transferPumpM3H=0;
const noTransfer=calculate(noTransferInput),fixedFanNm3H=noTransfer.ventilation.derived.fanNm3H;
const fixedCases=[noTransfer,baseline].map(r=>({pumpM3H:r.input.tank.transferPumpM3H,
  ...replay(r,fixedFanNm3H)}));
const result={input:base,inventoryFactor,
  interpretation:'Paired design comparisons use the no-transfer case under each assumption as denominator. Gas allocation prescribes phase partition only; temperature is not used to establish feasibility. Inventory check perturbs a constant reference inventory, not a coupled thermodynamic solution. Fixed-fan replay holds release histories unchanged.',
  rows,fixedFan:{fanNm3H:fixedFanNm3H,cases:fixedCases,
    coolingReductionPct:100*(1-fixedCases[1].peakKW/fixedCases[0].peakKW)}};
for(const directory of ['../outputs/research/','../data/paper/']){
  await fs.mkdir(new URL(directory,import.meta.url),{recursive:true});
  await fs.writeFile(new URL(directory+'transfer_pairs.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
}
console.log(JSON.stringify({inventoryFactor,rows:rows.map(r=>({id:r.id,...r.reductionPct})),fixedFan:result.fixedFan},null,2));
