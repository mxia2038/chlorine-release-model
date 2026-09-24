import fs from 'node:fs/promises';
import {calculate} from './calc.mjs';
import {buildDesignBasis} from './design_basis.mjs';

const base=JSON.parse(await fs.readFile(new URL('../config/default_25mm.json',import.meta.url),'utf8'));
const out=new URL('../outputs/research/',import.meta.url);
await fs.mkdir(out,{recursive:true});

const cases=[
  {id:'baseline',group:'基准',label:'基准',apply:()=>{}},
  {id:'pressure_100',group:'储罐表压',label:'100 kPa',apply:c=>c.tank.pressureGaugePa=100000},
  {id:'pressure_300',group:'储罐表压',label:'300 kPa',apply:c=>c.tank.pressureGaugePa=300000},
  {id:'mixing_50',group:'有效混合体积',label:'厂房容积50%',apply:c=>c.ventilation.roomVolumeM3=base.ventilation.roomVolumeM3*.5},
  {id:'mixing_75',group:'有效混合体积',label:'厂房容积75%',apply:c=>c.ventilation.roomVolumeM3=base.ventilation.roomVolumeM3*.75},
  {id:'wind_50',group:'液面风速系数',label:'0.5',apply:c=>c.ventilation.surfaceWindFactor=.5},
  {id:'wind_200',group:'液面风速系数',label:'2.0',apply:c=>c.ventilation.surfaceWindFactor=2},
  {id:'capture_85',group:'主塔吸收比例',label:'85%',apply:c=>c.absorption.process.mainCaptureFraction=.85},
  {id:'capture_95',group:'主塔吸收比例',label:'95%',apply:c=>c.absorption.process.mainCaptureFraction=.95}
];

const rows=[];
for(const item of cases){
  const input=structuredClone(base);item.apply(input);
  const result=calculate(input),design=buildDesignBasis(result);
  rows.push({
    id:item.id,group:item.group,label:item.label,
    leakedKg:result.release.summary.leakedKg,
    leakDurationS:result.release.summary.leakDurationS,
    surfaceWindMS:result.release.derived.equivalentSurfaceWindMS,
    fanNm3H:design.fanNm3H,
    maxGasMolFraction:result.ventilation.summary.maxMolFraction,
    maxTotalChlorineKgH:result.ventilation.summary.maxTotalChlorineLoadKgH,
    mainCoolingKW:design.thermalStudy.peakDesignCoolerKW,
    tailCoolingKW:design.tailDesign.peakReactionKW,
    mainInitialSolutionKgPerTank:design.stageCapacity.mainInitialSolutionKgPerTank,
    tailInitialSolutionKg:design.tailDesign.initialSolutionKg,
    balanceErrorKg:result.ventilation.summary.maxAbsoluteChlorineBalanceErrorKg
  });
}
const ref=rows[0];
const metrics=['leakedKg','fanNm3H','maxGasMolFraction','maxTotalChlorineKgH','mainCoolingKW','tailCoolingKW','mainInitialSolutionKgPerTank','tailInitialSolutionKg'];
for(const r of rows)for(const key of metrics)r[`${key}ChangePct`]=100*(r[key]/ref[key]-1);

await fs.writeFile(new URL('assumption_sensitivity.json',out),JSON.stringify({createdAt:new Date().toISOString(),input:base,rows},null,2));

const f=(x,n=2)=>x.toFixed(n);
let md='# 关键模型假设敏感性分析\n\n';
md+='以25 mm孔径、25 m³/h同步倒槽工况为基准，采用单因素变化考察储罐恒压取值、厂房有效混合体积、液面等效风速和主塔固定吸收比例。该分析用于识别主要不确定性，不把变化范围解释为统计置信区间。\n\n';
md+='|因素|取值|累计泄漏变化 %|风量变化 %|气相Cl₂峰值变化 %|入口总氯峰值变化 %|主塔冷却变化 %|尾塔冷却变化 %|\n';
md+='|---|---:|---:|---:|---:|---:|---:|---:|\n';
for(const r of rows.slice(1))md+=`|${r.group}|${r.label}|${f(r.leakedKgChangePct)}|${f(r.fanNm3HChangePct)}|${f(r.maxGasMolFractionChangePct)}|${f(r.maxTotalChlorineKgHChangePct)}|${f(r.mainCoolingKWChangePct)}|${f(r.tailCoolingKWChangePct)}|\n`;
md+='\n## 解释\n\n';
md+='储罐表压变化同时影响泄漏持续时间和瞬时源强；有效混合体积只作为完全混合偏差的代理变量，不能代表真实分层浓度；液面风速系数只作用于GB/T 37243质量蒸发项；主塔吸收比例不改变上游泄漏和风量，只重新分配主塔与尾气塔的化学容量及热负荷。\n\n';
md+='只有当某一因素显著改变本文核心比较结论时，才需要在下一阶段提高相应模型复杂度。结构化结果见 `assumption_sensitivity.json`。复现：`node src/research_assumption_sensitivity.mjs`。\n';
await fs.writeFile(new URL('关键模型假设敏感性分析.md',out),md);
console.log(JSON.stringify({rows,maxBalanceErrorKg:Math.max(...rows.map(r=>r.balanceErrorKg))},null,2));
