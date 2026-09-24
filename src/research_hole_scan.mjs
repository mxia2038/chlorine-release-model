import fs from 'node:fs/promises';
import {calculate} from './calc.mjs';
import {buildDesignBasis} from './design_basis.mjs';

const base=JSON.parse(await fs.readFile(new URL('../config/default_25mm.json',import.meta.url),'utf8'));
const out=new URL('../outputs/research/',import.meta.url);
await fs.mkdir(out,{recursive:true});

const holeDiametersMm=[15,25,35];
const scenarios=[[0,0],...[12.5,25,37.5,50].flatMap(p=>[0,30,60,120,300].map(d=>[p,d]))];
const rows=[];

for(const holeDiameterMm of holeDiametersMm){
  const noTransferInput=structuredClone(base);
  noTransferInput.tank.holeDiameterM=holeDiameterMm/1000;
  noTransferInput.tank.transferPumpM3H=0;
  noTransferInput.tank.transferStartDelayS=0;
  const noTransferResult=calculate(noTransferInput);
  const initialLeakKgS=noTransferResult.release.summary.initialLeakRateKgS;
  const initialLeakM3H=initialLeakKgS/base.tank.liquidDensityKgM3*3600;
  const noTransferDurationS=noTransferResult.release.summary.leakDurationS;

  for(const [pumpM3H,delayS] of scenarios){
    const input=structuredClone(base);
    input.tank.holeDiameterM=holeDiameterMm/1000;
    input.tank.transferPumpM3H=pumpM3H;
    input.tank.transferStartDelayS=delayS;
    const result=calculate(input);
    const design=buildDesignBasis(result);
    const release=result.release.summary;
    if(!release.leakCompleted || !release.evaporationCompleted)
      throw new Error(`Incomplete source for ${holeDiameterMm} mm, ${pumpM3H} m3/h, ${delayS} s`);
    const mainInitial=design.stageCapacity.mainInitialSolutionKgPerTank;
    rows.push({
      holeDiameterMm,pumpM3H,delayS,
      initialLeakKgS,initialLeakM3H,noTransferDurationS,
      pumpToInitialLeakRatio:pumpM3H/initialLeakM3H,
      delayToNoTransferDuration:delayS/noTransferDurationS,
      leakDurationS:release.leakDurationS,leakKg:release.leakedKg,
      fanNm3H:design.fanNm3H,
      mainCoolingKW:design.thermalStudy.peakDesignCoolerKW,
      mainTankM3:(mainInitial+design.stageCapacity.mainChlorineKg/2)/input.absorption.solutionDensityKgM3/input.absorption.tankWorkingVolumeFraction,
      maxBalanceErrorKg:result.ventilation.summary.maxAbsoluteChlorineBalanceErrorKg
    });
  }
}

for(const holeDiameterMm of holeDiametersMm){
  const group=rows.filter(r=>r.holeDiameterMm===holeDiameterMm);
  const noTransfer=group.find(r=>r.pumpM3H===0);
  const projectBaseline=group.find(r=>r.pumpM3H===25&&r.delayS===0);
  for(const r of group){
    r.leakFractionNoTransfer=r.leakKg/noTransfer.leakKg;
    r.fanRatioNoTransfer=r.fanNm3H/noTransfer.fanNm3H;
    r.coolingRatioNoTransfer=r.mainCoolingKW/noTransfer.mainCoolingKW;
    r.tankRatioNoTransfer=r.mainTankM3/noTransfer.mainTankM3;
    r.leakChangeVsProjectBaselinePct=100*(r.leakKg/projectBaseline.leakKg-1);
    r.fanChangeVsProjectBaselinePct=100*(r.fanNm3H/projectBaseline.fanNm3H-1);
    r.coolingChangeVsProjectBaselinePct=100*(r.mainCoolingKW/projectBaseline.mainCoolingKW-1);
  }
}

const summary=holeDiametersMm.map(holeDiameterMm=>{
  const group=rows.filter(r=>r.holeDiameterMm===holeDiameterMm);
  const baseline=group.find(r=>r.pumpM3H===25&&r.delayS===0);
  const delayed=group.find(r=>r.pumpM3H===25&&r.delayS===300);
  const noTransfer=group.find(r=>r.pumpM3H===0);
  return {
    holeDiameterMm,
    initialLeakM3H:baseline.initialLeakM3H,
    pumpToInitialLeakRatio:baseline.pumpToInitialLeakRatio,
    noTransferDurationS:baseline.noTransferDurationS,
    baselineLeakKg:baseline.leakKg,
    baselineFanNm3H:baseline.fanNm3H,
    baselineCoolingKW:baseline.mainCoolingKW,
    delay300LeakChangePct:100*(delayed.leakKg/baseline.leakKg-1),
    delay300FanChangePct:100*(delayed.fanNm3H/baseline.fanNm3H-1),
    delay300CoolingChangePct:100*(delayed.mainCoolingKW/baseline.mainCoolingKW-1),
    noTransferLeakChangePct:100*(noTransfer.leakKg/baseline.leakKg-1),
    noTransferFanChangePct:100*(noTransfer.fanNm3H/baseline.fanNm3H-1),
    noTransferCoolingChangePct:100*(noTransfer.mainCoolingKW/baseline.mainCoolingKW-1)
  };
});

await fs.writeFile(new URL('hole_size_scan.json',out),JSON.stringify({
  createdAt:new Date().toISOString(),stepS:base.simulation.timeStepS,
  holeDiametersMm,scenarios,summary,rows
},null,2));

const f=(x,n=2)=>x.toFixed(n);
let md='# 泄漏孔径扩展扫描与无量纲整理\n\n';
md+='采用15、25、35 mm三组泄漏孔径。每组均计算相同的21个倒槽能力—响应时间场景，合计63个工况；其他输入与25 mm基准模型一致。计算步长20 s、窗口24 h。\n\n';
md+='无量纲倒槽能力定义为 `ΠQ=倒槽体积流量/初始泄漏体积流量`，无量纲响应时间定义为 `Θd=响应时间/同孔径无倒槽泄漏持续时间`。泄漏量、风量、主塔冷却负荷和主槽容积分别除以同孔径无倒槽结果。这样可以区分孔径变化与倒槽相对能力变化。\n\n';
md+='## 25 m³/h倒槽能力的孔径对比\n\n';
md+='|孔径 mm|初始泄漏 m³/h|ΠQ|无倒槽持续时间 s|零延迟泄漏 kg|零延迟风量 Nm³/h|零延迟主塔冷却 kW|延迟300 s泄漏变化 %|风量变化 %|冷却变化 %|不倒槽泄漏变化 %|风量变化 %|冷却变化 %|\n';
md+='|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n';
for(const r of summary) md+=`|${r.holeDiameterMm}|${f(r.initialLeakM3H)}|${f(r.pumpToInitialLeakRatio,3)}|${f(r.noTransferDurationS,0)}|${f(r.baselineLeakKg)}|${f(r.baselineFanNm3H)}|${f(r.baselineCoolingKW)}|${f(r.delay300LeakChangePct,3)}|${f(r.delay300FanChangePct,3)}|${f(r.delay300CoolingChangePct,3)}|${f(r.noTransferLeakChangePct,2)}|${f(r.noTransferFanChangePct,2)}|${f(r.noTransferCoolingChangePct,2)}|\n`;
md+='\n表中延迟和不倒槽的变化均相对于相同孔径、25 m³/h、零延迟工况。\n\n';
md+='## 解释原则\n\n';
md+='相同的25 m³/h泵对不同孔径并不是相同的相对倒槽能力：孔径越小，`ΠQ`越大。因此，不能只按泵的绝对流量比较不同泄漏孔径。无量纲图用于检查累计泄漏比例是否主要受`ΠQ`和`Θd`控制；风量与冷却负荷仍受闪蒸、液池铺展和厂房排风过程影响，不预设完全归一。\n\n';
md+='本轮仍沿用恒罐压、液滴不蒸发不沉降、厂房完全混合、主塔固定90%吸收等假设。孔径扩展只能检验数值趋势是否跨场景保持，不能替代这些环节的物理验证。\n\n';
md+='结构化数据见 `hole_size_scan.json`。复现：`node src/research_hole_scan.mjs`。\n';
await fs.writeFile(new URL('泄漏孔径扩展扫描.md',out),md);

console.log(JSON.stringify({cases:rows.length,summary,
  maxBalanceErrorKg:Math.max(...rows.map(r=>r.maxBalanceErrorKg))},null,2));
