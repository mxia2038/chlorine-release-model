// Estimate of the thermal effects that the
// reaction-heat duty omits, evaluated at the main- and tail-tower peak-duty times.
// Tower energy balance with a 25 °C reaction-heat reference (CI Pamphlet 89, §2.5):
//  - gas sensible heat: air and unabsorbed Cl2 enter at the room temperature estimate and
//    leave at the circulation-liquid inlet temperature; absorbed Cl2 is referred to 25 °C;
//  - droplet subcooling: entrained liquid at the normal boiling point instead of 25 °C;
//  - water evaporation: dry inlet air leaving saturated (an upper estimate; humid room air
//    reduces it towards zero);
//  - hypochlorite decomposition, per 10% of the formed NaOCl (CI Pamphlet 89, §2.5).
// Negative values reduce the cooling duty.
import fs from 'node:fs/promises';
import {calculate} from './calc.mjs';
import {buildDesignBasis} from './design_basis.mjs';

const base=JSON.parse(await fs.readFile(new URL('../config/default_25mm.json',import.meta.url),'utf8'));
const out=new URL('../outputs/research/',import.meta.url);

const MW_AIR=28.965, MW_NAOCL=74.442;
const DH_LIQ_TB_TO_25=56.8;      // kJ/kg, saturated-liquid Cl2 enthalpy from -33.95 to 25 °C (CoolProp 8.0.0)
const WATER={18:{pSatPa:2064.7,hfgKJkg:2458.3},38:{pSatPa:6632.8,hfgKJkg:2410.8}}; // CoolProp 8.0.0
const DH_DECOMP_O2=336*2.326;    // kJ/kg NaOCl, NaOCl -> NaCl + 1/2 O2 (CI Pamphlet 89 [E2-6])
const DH_DECOMP_CLO3=188*2.326;  // kJ/kg NaOCl, 3 NaOCl -> NaClO3 + 2 NaCl (CI Pamphlet 89 [E2-2])
const ySat=(t,p=101325)=>0.622*WATER[t].pSatPa/(p-WATER[t].pSatPa);

function evaluate(pump){
  const c=structuredClone(base); c.tank.transferPumpM3H=pump;
  const r=calculate(c), d=buildDesignBasis(r), v=r.ventilation;
  const eta=c.absorption.process.mainCaptureFraction, cpA=c.ventilation.airCpKJkmolK, cpC=c.ventilation.chlorineCpKJkmolK;
  const fanKmolH=v.derived.fanKmolH, mw=c.physical.chlorineMolarMassKgKmol;
  const tMainIn=d.thermalStudy.heatParameters?.initialLiquidTempC ?? 18;
  const tTailIn=d.tailDesign.designInletTemperatureC;
  const at=timeS=>v.rows.find(x=>Math.abs(x.timeS-timeS)<1e-6);

  const m=at(d.thermalStudy.reactionHeat.peak.timeS);
  const nCl=m.chlorineMolFraction*fanKmolH, nAir=(1-m.chlorineMolFraction)*fanKmolH, tR=m.mixedTempC;
  const absorbedKgH=eta*(m.chlorineLoadKgH+m.dropletsLoadKgH);
  const main={dutyKW:d.thermalStudy.peakDesignCoolerKW,timeS:m.timeS,roomTempC:tR,gasOutletC:tMainIn,
    gasSensibleKW:(nAir*cpA*(tR-tMainIn)+nCl*cpC*((1-eta)*(tR-tMainIn)+eta*(tR-25)))/3600,
    dropletSubcoolingKW:-eta*m.dropletsLoadKgH*DH_LIQ_TB_TO_25/3600,
    waterEvaporationKW:-nAir*MW_AIR*ySat(18)*WATER[18].hfgKJkg/3600,
    decompositionO2Per10PctKW:0.1*absorbedKgH*MW_NAOCL/mw*DH_DECOMP_O2/3600,
    decompositionChlorateper10PctKW:0.1*absorbedKgH*MW_NAOCL/mw*DH_DECOMP_CLO3/3600};

  const t=at(d.tailDesign.peakTimeMin*60);
  const nAirT=(1-t.chlorineMolFraction)*fanKmolH;
  const tailAbsorbedKgH=(1-eta)*(t.chlorineLoadKgH+t.dropletsLoadKgH);
  const tail={dutyKW:d.tailDesign.peakReactionKW,timeS:t.timeS,gasInletC:tMainIn,gasOutletC:tTailIn,
    gasSensibleKW:nAirT*cpA*(tMainIn-tTailIn)/3600,
    waterEvaporationKW:-nAirT*MW_AIR*(ySat(38)-ySat(18))*WATER[38].hfgKJkg/3600,
    decompositionO2Per10PctKW:0.1*tailAbsorbedKgH*MW_NAOCL/mw*DH_DECOMP_O2/3600};
  for(const s of [main,tail]){
    s.sensibleAndEvaporationKW=(s.gasSensibleKW+(s.dropletSubcoolingKW??0)+s.waterEvaporationKW);
    s.sensibleAndEvaporationPct=100*s.sensibleAndEvaporationKW/s.dutyKW;
  }
  return {pumpM3H:pump,main,tail};
}

const cases=[25,0].map(evaluate);
const [w,n]=cases;
const reduction=(a,b)=>100*(1-a/b);
const paired={reportedMainReductionPct:reduction(w.main.dutyKW,n.main.dutyKW),
  withSensibleAndEvaporationPct:reduction(w.main.dutyKW+w.main.sensibleAndEvaporationKW,n.main.dutyKW+n.main.sensibleAndEvaporationKW)};
await fs.writeFile(new URL('thermal_terms.json',out),JSON.stringify({createdAt:new Date().toISOString(),cases,paired},null,2));

const f=(x,k=0)=>Number(x).toFixed(k), pct=(x,dk)=>`${f(x)} (${f(100*x/dk,1)}%)`;
let md='# 反应热以外热效应的量级估算\n\n各项在主塔、尾塔峰值反应热时刻计算，负值表示降低冷却负荷。水分蒸发按干空气进塔估算（上限）。分解项按生成的 NaOCl 每分解10%计。\n\n';
md+='|项目|主塔 25 m³/h, kW (占比)|主塔 无倒槽|尾塔 25 m³/h|\n|---|---:|---:|---:|\n';
md+=`|反应热负荷|${f(w.main.dutyKW)}|${f(n.main.dutyKW)}|${f(w.tail.dutyKW)}|\n`;
md+=`|气体显热|${pct(w.main.gasSensibleKW,w.main.dutyKW)}|${pct(n.main.gasSensibleKW,n.main.dutyKW)}|${pct(w.tail.gasSensibleKW,w.tail.dutyKW)}|\n`;
md+=`|液滴过冷|${pct(w.main.dropletSubcoolingKW,w.main.dutyKW)}|${pct(n.main.dropletSubcoolingKW,n.main.dutyKW)}|—|\n`;
md+=`|水分蒸发（上限）|${pct(w.main.waterEvaporationKW,w.main.dutyKW)}|${pct(n.main.waterEvaporationKW,n.main.dutyKW)}|${pct(w.tail.waterEvaporationKW,w.tail.dutyKW)}|\n`;
md+=`|NaOCl 分解为 NaCl+O₂（每10%）|+${pct(w.main.decompositionO2Per10PctKW,w.main.dutyKW)}|+${pct(n.main.decompositionO2Per10PctKW,n.main.dutyKW)}|+${pct(w.tail.decompositionO2Per10PctKW,w.tail.dutyKW)}|\n`;
md+=`\n峰值时刻室温估算：${f(w.main.roomTempC,1)} °C（25 m³/h），${f(n.main.roomTempC,1)} °C（无倒槽）。显热与蒸发合计后主塔倒槽削减：${f(paired.reportedMainReductionPct,1)}% → ${f(paired.withSensibleAndEvaporationPct,1)}%。\n\n复现：\`node src/research_thermal_terms.mjs\`。\n`;
await fs.writeFile(new URL('热效应量级估算.md',out),md);
console.log(md);
