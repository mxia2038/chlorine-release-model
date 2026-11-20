// Constant tank pressure versus an adiabatic closed vessel containing saturated chlorine.
// Two specified scenarios: no wall heat capacity, and the 21 t empty-tank steel mass fully
// coupled to the liquid temperature (wall cp 434 J/(kg K), plain carbon steel at 300 K).
// Released masses cover the liquid-release phase; the tank inventory left at drainage
// (vapor plus a trace of recondensed liquid) is reported separately in both models.
import fs from 'node:fs/promises';
import {calculate} from './calc.mjs';
import {buildDesignBasis} from './design_basis.mjs';

const base=JSON.parse(await fs.readFile(new URL('../config/default_25mm.json',import.meta.url),'utf8'));
const out=new URL('../outputs/research/',import.meta.url);
await fs.mkdir(out,{recursive:true});

const models={
  constant:c=>{},
  closedAdiabatic:c=>{c.tank.pressureModel='closedSaturated';},
  closedWithWall:c=>{c.tank.pressureModel='closedSaturated';c.tank.wallMassKg=21000;c.tank.wallSpecificHeatJkgK=434;}
};
function evaluate(model,pump,delay=0,dt=base.simulation.timeStepS){
  const c=structuredClone(base); models[model](c);
  c.tank.transferPumpM3H=pump; c.tank.transferStartDelayS=delay; c.simulation.timeStepS=dt;
  const r=calculate(c), d=buildDesignBasis(r), s=r.release.summary;
  const leakRows=r.release.rows.filter(x=>x.leakedKg>0);
  return {model,pumpM3H:pump,delayS:delay,timeStepS:dt,
    leakedKg:s.leakedKg,transferredKg:s.transferredKg,leakDurationS:s.leakDurationS,
    initialLeakRateKgS:s.initialLeakRateKgS,leakEndLeakRateKgS:s.leakEndLeakRateKgS,
    endGaugePressureKPa:leakRows.at(-1).tankGaugePressureStepEndPa/1000,
    endFlashFraction:leakRows.at(-1).flashFraction,
    temperatureDropK:s.closedTank?.temperatureDropK??0,
    tankInventoryAtDrainageKg:s.tankVapor.atDrainageKg,
    liquidPlusResidualKg:s.leakedKg+s.tankVapor.atDrainageKg,
    fanNm3H:d.fanNm3H,maxGasMolFraction:r.ventilation.summary.maxMolFraction,
    mainPeakReactionHeatKW:d.thermalStudy.peakDesignCoolerKW,
    tailPeakReactionHeatKW:d.tailDesign.peakReactionKW,
    mainInitialSolutionKgPerTank:d.stageCapacity.mainInitialSolutionKgPerTank,
    history:leakRows.filter((_,i)=>i%15===0).map(x=>({timeS:x.timeS,gaugeKPa:x.tankGaugePressureStepStartPa/1000,
      tempC:x.tankTempStepStartC,leakRateKgS:x.leakRateKgS,flashFraction:x.flashFraction,remainingLiquidKg:x.remainingLiquidMassKg}))};
}

const rows=[];
for(const model of Object.keys(models)) for(const [pump,delay] of [[0,0],[12.5,0],[25,0],[50,0],[25,1800]]) rows.push(evaluate(model,pump,delay));
const find=(m,p,d=0)=>rows.find(r=>r.model===m&&r.pumpM3H===p&&r.delayS===d);
const pairs=[];
for(const model of Object.keys(models)) for(const [pump,delay] of [[12.5,0],[25,0],[50,0],[25,1800]]){
  const n=find(model,0), w=find(model,pump,delay), red=k=>100*(1-w[k]/n[k]);
  pairs.push({model,pumpM3H:pump,delayS:delay,releaseReductionPct:red('leakedKg'),fanReductionPct:red('fanNm3H'),
    mainHeatReductionPct:red('mainPeakReactionHeatKW')});
}
const vsConstant=rows.filter(r=>r.model!=='constant').map(r=>{const c=find('constant',r.pumpM3H,r.delayS),ch=k=>100*(r[k]/c[k]-1);
  return {model:r.model,pumpM3H:r.pumpM3H,delayS:r.delayS,leakedChangePct:ch('leakedKg'),
    liquidPlusResidualChangePct:ch('liquidPlusResidualKg'),fanChangePct:ch('fanNm3H'),
    mainHeatChangePct:ch('mainPeakReactionHeatKW'),solutionChangePct:ch('mainInitialSolutionKgPerTank')};});
const stepCheck=[20,10,5].flatMap(dt=>[0,25].map(p=>{const r=evaluate('closedWithWall',p,0,dt);delete r.history;return r;}));

await fs.writeFile(new URL('tank_pressure_comparison.json',out),JSON.stringify({createdAt:new Date().toISOString(),rows,pairs,vsConstant,stepCheck},null,2));

const f=(x,n=1)=>Number(x).toFixed(n);
let md='# 储罐压力假设对照（恒压 vs 封闭饱和罐）\n\n';
md+='封闭罐：纯氯饱和、无外部传热；每步守恒罐内质量、内能与容积，物性取自 CoolProp 8.0.0（Thol et al., 2021）。源项闪蒸温度沿用原稿 Antoine 关系（储罐衡算与闪蒸关系的物性依据不同，非全流程统一物性）。比较“不计罐壁热容”与“21 t 钢材、434 J/(kg·K) 与液体完全热耦合”两种指定情景。泄漏量为液体泄漏阶段累计值；液体排空时罐内残余量（恒压模型按初始饱和蒸气密度充满罐体计）单列，其后续泄放不在计算范围内。\n\n';
md+='|模型|倒槽 m³/h|延迟 s|液相泄漏 kg|排空时罐内残余 kg|泄漏时长 s|末期表压 kPa|温降 K|末期泄漏率 kg/s|末期Fv|风量 Nm³/h|主塔反应热 kW|\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n';
for(const r of rows)md+=`|${r.model}|${r.pumpM3H}|${r.delayS}|${f(r.leakedKg,0)}|${f(r.tankInventoryAtDrainageKg,0)}|${f(r.leakDurationS,0)}|${f(r.endGaugePressureKPa)}|${f(r.temperatureDropK,2)}|${f(r.leakEndLeakRateKgS,3)}|${f(r.endFlashFraction,4)}|${f(r.fanNm3H,0)}|${f(r.mainPeakReactionHeatKW,0)}|\n`;
md+='\n## 相对恒压的变化 (%)\n\n|模型|倒槽|延迟 s|液相泄漏|液相泄漏+罐内残余|风量|主塔反应热|主槽初始碱液|\n|---|---:|---:|---:|---:|---:|---:|---:|\n';
for(const r of vsConstant)md+=`|${r.model}|${r.pumpM3H}|${r.delayS}|${f(r.leakedChangePct,2)}|${f(r.liquidPlusResidualChangePct,2)}|${f(r.fanChangePct,2)}|${f(r.mainHeatChangePct,2)}|${f(r.solutionChangePct,2)}|\n`;
md+='\n## 倒槽削减（各模型自身无倒槽为基准，%）\n\n|模型|倒槽|延迟 s|泄漏|风量|主塔反应热|\n|---|---:|---:|---:|---:|---:|\n';
for(const p of pairs)md+=`|${p.model}|${p.pumpM3H}|${p.delayS}|${f(p.releaseReductionPct)}|${f(p.fanReductionPct)}|${f(p.mainHeatReductionPct)}|\n`;
md+='\n## 时间步长（封闭绝热）\n\n|步长 s|倒槽|泄漏 kg|温降 K|风量|主塔反应热|\n|---:|---:|---:|---:|---:|---:|\n';
for(const r of stepCheck)md+=`|${r.timeStepS}|${r.pumpM3H}|${f(r.leakedKg,1)}|${f(r.temperatureDropK,3)}|${f(r.fanNm3H,1)}|${f(r.mainPeakReactionHeatKW,1)}|\n`;
md+='\n复现：`node src/research_tank_pressure.mjs`。\n';
await fs.writeFile(new URL('储罐压力假设对照.md',out),md);
console.log(md);
