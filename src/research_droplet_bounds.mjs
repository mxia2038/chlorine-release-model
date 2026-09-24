import fs from 'node:fs/promises';
import {calculate} from './calc.mjs';
import {buildDesignBasis} from './design_basis.mjs';

const base=JSON.parse(await fs.readFile(new URL('../config/default_25mm.json',import.meta.url),'utf8'));
const out=new URL('../outputs/research/',import.meta.url);
await fs.mkdir(out,{recursive:true});

const cases=[
  {id:'suspended',name:'液滴全部悬浮并随排风进入塔',vapor:0,deposit:0},
  {id:'vaporized',name:'液滴立即全部汽化',vapor:1,deposit:0},
  {id:'deposited',name:'液滴立即全部沉降进入液池',vapor:0,deposit:1}
];
const rows=[];
for(const item of cases){
  const input=structuredClone(base);
  input.physical.dropletInstantVaporFraction=item.vapor;
  input.physical.dropletDepositToPoolFraction=item.deposit;
  const result=calculate(input);
  const design=buildDesignBasis(result);
  rows.push({
    id:item.id,name:item.name,
    fanNm3H:design.fanNm3H,
    maxGasMolFraction:result.ventilation.summary.maxMolFraction,
    maxGasChlorineKgH:result.ventilation.summary.maxChlorineLoadKgH,
    maxDropletsKgH:result.ventilation.summary.maxDropletsLoadKgH,
    maxTotalChlorineKgH:result.ventilation.summary.maxTotalChlorineLoadKgH,
    minRoomTemperatureC:result.ventilation.summary.minMixedTempC,
    mainCoolingKW:design.thermalStudy.peakDesignCoolerKW,
    tailCoolingKW:design.tailDesign.peakReactionKW,
    mainTankM3:design.stageCapacity.mainInitialGrossVolumeM3PerTank,
    tailTankM3:design.tailDesign.finalBasisGrossVolumeM3,
    poolDryS:result.release.summary.finalGasTimeS,
    rawDropletsKg:result.release.summary.rawDropletsKg,
    suspendedDropletsKg:result.release.summary.dropletsKg,
    instantVaporizedKg:result.release.summary.instantDropletVaporizedKg,
    depositedKg:result.release.summary.dropletDepositedKg,
    balanceErrorKg:result.ventilation.summary.maxAbsoluteChlorineBalanceErrorKg
  });
}

const ref=rows[0];
for(const r of rows)for(const key of ['fanNm3H','maxGasMolFraction','maxGasChlorineKgH','maxTotalChlorineKgH','mainCoolingKW','tailCoolingKW','poolDryS'])
  r[`${key}ChangePct`]=100*(r[key]/ref[key]-1);

await fs.writeFile(new URL('droplet_fate_bounds.json',out),JSON.stringify({createdAt:new Date().toISOString(),input:base,rows},null,2));

const f=(x,n=2)=>x.toFixed(n);
let md='# 液滴行为边界分析\n\n';
md+='采用25 mm孔径、25 m³/h同步倒槽基准工况，只改变闪蒸夹带液滴在厂房内的处理方式。三个工况分别表示：液滴保持液态并按完全混合方式随排风进入塔；液滴在释放后立即全部汽化；液滴立即全部沉降并加入地面液池，随后按液池蒸发模型释放。它们是用于判断敏感性的简化边界，不代表真实液滴粒径、沉降时间或蒸发历程。\n\n';
md+='|液滴边界|风机 Nm³/h|风量变化 %|气相Cl₂峰值 mol%|气相峰值变化 %|总氯峰值 kg/h|总氯峰值变化 %|主塔冷却 kW|冷却变化 %|液池排空 s|\n';
md+='|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n';
for(const r of rows)md+=`|${r.name}|${f(r.fanNm3H)}|${f(r.fanNm3HChangePct)}|${f(r.maxGasMolFraction*100,3)}|${f(r.maxGasMolFractionChangePct)}|${f(r.maxTotalChlorineKgH)}|${f(r.maxTotalChlorineKgHChangePct)}|${f(r.mainCoolingKW)}|${f(r.mainCoolingKWChangePct)}|${f(r.poolDryS,0)}|\n`;
md+='\n循环槽化学容量由累计泄漏氯量控制，三个边界的累计泄漏量相同，因此槽容不因液滴相态边界改变；变化主要体现在风机、气相组成、瞬时塔负荷和冷却峰值。\n\n';
md+='立即汽化边界把液滴计入气体体积源项和气态反应热；立即沉降边界把这部分质量转入液池，使释放过程延后。真实工况通常位于这些边界之间，但不能仅凭本分析确定具体位置。\n\n';
md+='结构化结果见 `droplet_fate_bounds.json`。复现：`node src/research_droplet_bounds.mjs`。\n';
await fs.writeFile(new URL('液滴行为边界分析.md',out),md);
console.log(JSON.stringify({rows,maxBalanceErrorKg:Math.max(...rows.map(r=>r.balanceErrorKg))},null,2));
