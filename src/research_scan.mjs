import fs from 'node:fs/promises';
import {calculate} from './calc.mjs';
import {buildDesignBasis} from './design_basis.mjs';

const base=JSON.parse(await fs.readFile(new URL('../config/default_25mm.json',import.meta.url),'utf8'));
const out=new URL('../outputs/research/',import.meta.url);
await fs.mkdir(out,{recursive:true});
const rows=[];
const scenarios=[[0,0],...[12.5,25,37.5,50].flatMap(p=>[0,30,60,120,300].map(t=>[p,t]))];
for(const [pump,delay] of scenarios){
  const c=structuredClone(base); c.tank.transferPumpM3H=pump; c.tank.transferStartDelayS=delay;
  const r=calculate(c), b=buildDesignBasis(r), s=r.release.summary;
  if(!s.leakCompleted || !s.evaporationCompleted) throw new Error(`Incomplete source ${pump}/${delay}`);
  const peak=r.release.rows.reduce((a,x)=>x.gasRateKgS>a.gasRateKgS?x:a);
  const mainInitial=b.stageCapacity.mainInitialSolutionKgPerTank;
  rows.push({pumpM3H:pump,delayS:delay,leakKg:s.leakedKg,leakDurationS:s.leakDurationS,poolDryS:s.finalGasTimeS,
    fanNm3H:b.fanNm3H,actualM3H:b.tower.maxActualGasM3H,
    solutionKg:2*mainInitial+b.tailDesign.initialSolutionKg,
    mainTankM3:(mainInitial+b.stageCapacity.mainChlorineKg/2)/c.absorption.solutionDensityKgM3/c.absorption.tankWorkingVolumeFraction,
    tailTankM3:b.tailDesign.finalBasisGrossVolumeM3,
    mainDiameterMm:b.tower.selectedDiameterMm,tailDiameterMm:b.tailTower.selectedDiameterMm,
    mainCoolingKW:b.thermalStudy.peakDesignCoolerKW,tailCoolingKW:b.tailDesign.peakReactionKW,
    sourcePeakS:peak.timeS,inletPeakS:r.ventilation.summary.atMaxTotalChlorineLoad.timeS,
    heatPeakS:b.thermalStudy.reactionHeat.peak.timeMin*60,
    surfaceWindMS:r.release.derived.equivalentSurfaceWindMS,
    chlorineBalanceErrorKg:r.ventilation.summary.maxAbsoluteChlorineBalanceErrorKg});
}
const ref=rows.find(r=>r.pumpM3H===25&&r.delayS===0);
for(const row of rows) for(const key of ['leakKg','fanNm3H','solutionKg','mainTankM3','tailTankM3','mainCoolingKW','tailCoolingKW']) row[key+'ChangePct']=100*(row[key]/ref[key]-1);
await fs.writeFile(new URL('transfer_delay_scan.json',out),JSON.stringify({createdAt:new Date().toISOString(),input:base,stepS:base.simulation.timeStepS,rows},null,2));
const f=(x,n=2)=>x.toFixed(n);
let md='# 倒槽能力与响应时间：初步参数扫描\n\n';
md+='基准：25 m³/h、0 s响应时间。共21个独立工况；无倒槽只计算一次。所有取值均为探索范围，不代表行业典型值。\n\n';
md+='各工况重新计算所需风量、碱液、槽容和冷却负荷，属于设计需求比较，不是固定设备的安全能力验证。风机仍在泄漏开始启动。源项及厂房时序均采用20 s步长、24 h窗口；30 s启动在步内分段计量，不舍入为20或40 s。零延迟默认保持原结果。\n\n';
md+='初算风速沿用一次顺序方法，初算泄漏时间扩展为启动前仅泄漏、启动后泄漏与倒槽并行的恒初始速率近似；最终气源由动态液位计算。液滴、恒压、完全混合及固定吸收比例等假设沿用原模型。本扫描尚不是独立物理验证或正式论文结论。\n\n';
md+='|倒槽 m³/h|响应 s|泄漏 kg|泄漏增减 %|风量 Nm³/h|风量增减 %|初始碱液总量 kg|主槽每台 m³|尾槽 m³|主塔冷却 kW|尾塔冷却 kW|\n|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n';
for(const r of rows)md+=`|${r.pumpM3H}|${r.delayS}|${f(r.leakKg)}|${f(r.leakKgChangePct)}|${f(r.fanNm3H)}|${f(r.fanNm3HChangePct)}|${f(r.solutionKg)}|${f(r.mainTankM3)}|${f(r.tailTankM3)}|${f(r.mainCoolingKW)}|${f(r.tailCoolingKW)}|\n`;
md+='\n主槽共2台；槽容含吸氯增重并按85%有效装液率换算，尚未设备圆整。总碱液量为两主槽加一尾槽；尾槽按出口设计目标扣除计算残余气氯。\n\n';
md+='## 峰值时刻与塔径\n\n|倒槽 m³/h|响应 s|气源峰值 s|入口总氯峰值 s|主塔热峰值 s|主塔径 mm|尾塔径 mm|液池清空 s|\n|---:|---:|---:|---:|---:|---:|---:|---:|\n';
for(const r of rows)md+=`|${r.pumpM3H}|${r.delayS}|${r.sourcePeakS}|${r.inletPeakS}|${f(r.heatPeakS,0)}|${r.mainDiameterMm}|${r.tailDiameterMm}|${r.poolDryS}|\n`;
md+='\n本研究采用24 h计算窗口。复现：`node src/research_scan.mjs`；响应时间参数为 `tank.transferStartDelayS`。\n';
await fs.writeFile(new URL('倒槽响应参数扫描.md',out),md);
console.log(JSON.stringify({cases:rows.length,baseline:ref,delay300:rows.find(r=>r.pumpM3H===25&&r.delayS===300),noTransfer:rows[0],maxBalanceErrorKg:Math.max(...rows.map(r=>r.chlorineBalanceErrorKg))},null,2));
