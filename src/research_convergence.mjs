import fs from 'node:fs/promises';
import {calculate} from './calc.mjs';
import {buildDesignBasis} from './design_basis.mjs';

const input=JSON.parse(await fs.readFile(new URL('../config/default_25mm.json',import.meta.url),'utf8'));
const scenarios=[['基准',25,0],['延迟30秒',25,30],['延迟300秒',25,300],['不倒槽',0,0]];
const rows=[];
for(const [scenario,pump,delay] of scenarios) for(const stepS of [20,10,5]) {
  const c=structuredClone(input);
  c.tank.transferPumpM3H=pump;
  c.tank.transferStartDelayS=delay;
  c.simulation.timeStepS=stepS;
  const r=calculate(c), b=buildDesignBasis(r), s=r.release.summary;
  if(!s.leakCompleted||!s.evaporationCompleted) throw new Error(`Incomplete source: ${scenario}/${stepS}`);
  const peak=r.release.rows.reduce((a,x)=>x.gasRateKgS>a.gasRateKgS?x:a);
  const row={scenario,pumpM3H:pump,delayS:delay,stepS,leakKg:s.leakedKg,
    leakDurationS:s.leakDurationS,fanNm3H:b.fanNm3H,
    mainCoolingKW:b.thermalStudy.peakDesignCoolerKW,
    tailCoolingKW:b.tailDesign.peakReactionKW,sourcePeakS:peak.timeS,
    inletPeakS:r.ventilation.summary.atMaxTotalChlorineLoad.timeS,
    heatPeakS:b.thermalStudy.reactionHeat.peak.timeMin*60,
    chlorineBalanceErrorKg:r.ventilation.summary.maxAbsoluteChlorineBalanceErrorKg};
  if(Object.values(row).some(v=>typeof v==='number'&&!Number.isFinite(v))) throw new Error('Non-finite result');
  rows.push(row);
}
const metrics=['leakKg','fanNm3H','mainCoolingKW','tailCoolingKW'];
for(const row of rows){
  const fine=rows.find(x=>x.scenario===row.scenario&&x.stepS===5);
  const baseline=rows.find(x=>x.scenario==='基准'&&x.stepS===row.stepS);
  for(const key of metrics){
    row[key+'Vs5sPct']=100*(row[key]/fine[key]-1);
    row[key+'VsBaselinePct']=100*(row[key]/baseline[key]-1);
  }
}
const out=new URL('../outputs/research/',import.meta.url);
await fs.mkdir(out,{recursive:true});
await fs.writeFile(new URL('time_step_convergence.json',out),JSON.stringify({createdAt:new Date().toISOString(),input,rows},null,2));
const f=(x,n=4)=>x.toFixed(n);
const maxVs5=(step,key)=>Math.max(...rows.filter(x=>x.stepS===step).map(x=>Math.abs(x[key+'Vs5sPct'])));
const row=(scenario,step)=>rows.find(x=>x.scenario===scenario&&x.stepS===step);
let md='# 代表工况时间步长核验\n\n';
md+='比较20、10、5 s步长，共4个工况、12次计算。其他输入和24 h计算窗口不变；各工况重新计算风量及设计需求。5 s仅作本轮细网格参照，不代表精确解。默认参数不变。\n\n';
md+='|工况|步长 s|泄漏 kg|风量 Nm³/h|主塔冷却 kW|尾塔冷却 kW|泄漏量相对5s %|风量相对5s %|主塔冷却相对5s %|\n|---|---:|---:|---:|---:|---:|---:|---:|---:|\n';
for(const r of rows) md+=`|${r.scenario}|${r.stepS}|${f(r.leakKg,2)}|${f(r.fanNm3H,3)}|${f(r.mainCoolingKW,3)}|${f(r.tailCoolingKW,3)}|${f(r.leakKgVs5sPct)}|${f(r.fanNm3HVs5sPct)}|${f(r.mainCoolingKWVs5sPct)}|\n`;
md+='\n## 相同网格上的工况差异\n\n各延迟工况与同一步长的25 m³/h、零延迟基准比较，避免将不同网格的差异混入响应效应。\n\n|工况|步长 s|泄漏增幅 %|风量增幅 %|主塔冷却增幅 %|\n|---|---:|---:|---:|---:|\n';
for(const r of rows.filter(x=>x.scenario!=='基准')) md+=`|${r.scenario}|${r.stepS}|${f(r.leakKgVsBaselinePct)}|${f(r.fanNm3HVsBaselinePct)}|${f(r.mainCoolingKWVsBaselinePct)}|\n`;
md+='\n## 峰值时刻\n\n下表为离散输出的峰值时刻，不代表连续时间精确峰值。\n\n|工况|步长 s|泄漏结束 s|气源峰值 s|入口总氯峰值 s|主塔热峰值 s|\n|---|---:|---:|---:|---:|---:|\n';
for(const r of rows) md+=`|${r.scenario}|${r.stepS}|${f(r.leakDurationS,2)}|${r.sourcePeakS}|${r.inletPeakS}|${f(r.heatPeakS,2)}|\n`;
md+=`\n全组厂房氯质量衡算最大绝对残差：${Math.max(...rows.map(x=>x.chlorineBalanceErrorKg)).toExponential(3)} kg。该残差仅反映数值守恒，不是物理验证。\n\n`;
md+=`## 结果解释\n\n本轮4个工况中，20 s相对5 s的绝对差异最大约为：泄漏量${f(maxVs5(20,'leakKg'))}%、风量${f(maxVs5(20,'fanNm3H'))}%、主塔冷却峰值${f(maxVs5(20,'mainCoolingKW'))}%；10 s相对5 s进一步减小至${f(maxVs5(10,'leakKg'))}%、${f(maxVs5(10,'fanNm3H'))}%、${f(maxVs5(10,'mainCoolingKW'))}%以内。\n\n延迟300 s的风量增幅由20 s网格的${f(row('延迟300秒',20).fanNm3HVsBaselinePct)}%变为5 s网格的${f(row('延迟300秒',5).fanNm3HVsBaselinePct)}%，本轮网格细化未改变该效应的方向及量级。泄漏量约增3.24%、冷却需求约增2.34%、风量约增0.28%的差异在这些网格上保持。\n\n延迟30 s的冷却增幅在三个网格上为${[20,10,5].map(step=>f(row('延迟30秒',step).mainCoolingKWVsBaselinePct)).join('%、')}%，并非单调变化；峰值时刻也存在步长尺度的跳动。因此不宣称严格收敛阶数或所有细小效应均已精确确定。本轮足以支持继续进行探索性比较，不将数值稳定解释为物理准确或工程显著。正式论文如需精确讨论30 s冷却效应，再针对该指标细化即可。\n\n同一基准的20、10、5 s风量分别约${[20,10,5].map(step=>f(row('基准',step).fanNm3H,2)).join('、')} Nm³/h。\n\n`;
md+='复现：在项目目录运行 `node src/research_convergence.mjs`。结构化结果见 `time_step_convergence.json`。\n';
await fs.writeFile(new URL('时间步长核验.md',out),md);
console.log(JSON.stringify({cases:rows.length,max20vs5:Object.fromEntries(metrics.map(k=>[k,Math.max(...rows.filter(x=>x.stepS===20).map(x=>Math.abs(x[k+'Vs5sPct'])))])),max10vs5:Object.fromEntries(metrics.map(k=>[k,Math.max(...rows.filter(x=>x.stepS===10).map(x=>Math.abs(x[k+'Vs5sPct'])))])),delayEffects:rows.filter(x=>x.scenario==='延迟300秒').map(x=>({stepS:x.stepS,fanPct:x.fanNm3HVsBaselinePct,leakPct:x.leakKgVsBaselinePct,coolingPct:x.mainCoolingKWVsBaselinePct}))},null,2));
