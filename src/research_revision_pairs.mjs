// Paired transfer / no-transfer comparisons under
// building-retention, startup-delay, orifice-size, discharge-coefficient, pool-depth
// and ground-temperature scenarios. Each pair uses its own no-transfer case as reference.
// Values are scenario results, not statistical intervals or physical bounds.
import fs from 'node:fs/promises';
import {calculate} from './calc.mjs';
import {buildDesignBasis} from './design_basis.mjs';

const base=JSON.parse(await fs.readFile(new URL('../config/default_25mm.json',import.meta.url),'utf8'));
const out=new URL('../outputs/research/',import.meta.url);
await fs.mkdir(out,{recursive:true});
const PUMP=25;

function evaluate(mod){
  const c=structuredClone(base); mod(c);
  const r=calculate(c), d=buildDesignBasis(r), s=r.release.summary, v=r.ventilation.summary;
  return {
    leakedKg:s.leakedKg, leakDurationS:s.leakDurationS, leakCompleted:s.leakCompleted,
    evaporationCompleted:s.evaporationCompleted, initialLeakRateKgS:s.initialLeakRateKgS,
    peakGasSourceKgS:s.maxGasRateKgS, maxPoolAreaM2:Math.max(...r.release.rows.map(x=>x.poolAreaM2)),
    fanNm3H:d.fanNm3H, maxGasMolFraction:v.maxMolFraction, maxTotalChlorineKgH:v.maxTotalChlorineLoadKgH,
    mainPeakReactionHeatKW:d.thermalStudy.peakDesignCoolerKW, tailPeakReactionHeatKW:d.tailDesign.peakReactionKW,
    mainInitialSolutionKgPerTank:d.stageCapacity.mainInitialSolutionKgPerTank,
    timeStepS:c.simulation.timeStepS, windowS:c.simulation.maxTimeS,
    balanceErrorKg:v.maxAbsoluteChlorineBalanceErrorKg
  };
}
const reductionPct=(w,n,k)=>100*(1-w[k]/n[k]);
function pair(group,label,mod,{delayS=0}={}){
  const noTransfer=evaluate(c=>{mod(c);c.tank.transferPumpM3H=0;});
  const transfer=evaluate(c=>{mod(c);c.tank.transferPumpM3H=PUMP;c.tank.transferStartDelayS=delayS;});
  const pumpKgS=PUMP*base.tank.liquidDensityKgM3/3600;
  return {group,label,delayS,piQ:pumpKgS/transfer.initialLeakRateKgS,
    thetaD:delayS*transfer.initialLeakRateKgS/noTransfer.leakedKg,
    noTransfer,transfer,
    releaseReductionPct:reductionPct(transfer,noTransfer,'leakedKg'),
    fanReductionPct:reductionPct(transfer,noTransfer,'fanNm3H'),
    mainHeatReductionPct:reductionPct(transfer,noTransfer,'mainPeakReactionHeatKW'),
    inletLoadReductionPct:reductionPct(transfer,noTransfer,'maxTotalChlorineKgH')};
}

const V=base.ventilation.roomVolumeM3;
const rows=[
  ...[1,0.5,0.25,0.1,0.01].map(f=>pair('retention',`${f*100}% mixing volume`,c=>c.ventilation.roomVolumeM3=V*f)),
  ...[0,300,600,1200,1800,2400].map(t=>pair('delay',`${t} s delay`,()=>{}, {delayS:t})),
  // GB/T 37243-2019 §6.4.4 Table 3 representative holes 5/25/100 mm; 50 mm = medium/large boundary.
  // 5 mm no-transfer drains in ~85 h, so its window is extended to 120 h.
  pair('hole','5 mm',c=>{c.tank.holeDiameterM=0.005;c.simulation.maxTimeS=120*3600;}),
  pair('hole','25 mm',()=>{}),
  pair('hole','50 mm',c=>{c.tank.holeDiameterM=0.05;c.simulation.timeStepS=5;}),
  pair('hole','100 mm',c=>{c.tank.holeDiameterM=0.1;c.simulation.timeStepS=2;}),
  ...[0.62,0.8,1.0].map(cd=>pair('dischargeCoefficient',`Cd ${cd}`,c=>c.tank.dischargeCoefficient=cd)),
  ...[0.005,0.01,0.02].map(h=>pair('poolDepth',`${h*1000} mm pool`,c=>c.physical.poolThicknessM=h)),
  ...[15,25,35].map(t=>pair('groundTemperature',`${t} °C ground`,c=>c.physical.groundInitialTempC=t)),
];

// Time-step check for the enlarged-orifice cases (short events).
const stepCheck=[];
for(const [hole,steps] of [[0.05,[20,5,2]],[0.1,[20,5,2,1]]]) for(const dt of steps) for(const pump of [0,PUMP]){
  const r=evaluate(c=>{c.tank.holeDiameterM=hole;c.simulation.timeStepS=dt;c.tank.transferPumpM3H=pump;});
  stepCheck.push({holeMm:hole*1000,timeStepS:dt,pumpM3H:pump,leakedKg:r.leakedKg,fanNm3H:r.fanNm3H,mainPeakReactionHeatKW:r.mainPeakReactionHeatKW});
}

await fs.writeFile(new URL('revision_pairs.json',out),JSON.stringify({createdAt:new Date().toISOString(),pumpM3H:PUMP,rows,stepCheck},null,2));

const f=(x,n=1)=>x==null?'—':Number(x).toFixed(n);
let md='# 返修配对计算\n\n';
md+=`每组均比较 ${PUMP} m³/h 倒槽与同一假设下的无倒槽工况。数值为指定情景结果，不是统计区间，也不是物理上下界。\n\n`;
md+='|组|情景|Π_Q|无倒槽泄漏 kg|倒槽泄漏 kg|泄漏削减 %|无倒槽风量|倒槽风量|风量削减 %|无倒槽主塔反应热 kW|倒槽主塔反应热 kW|反应热削减 %|倒槽峰值摩尔分数|泄空完成|\n';
md+='|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|\n';
for(const r of rows)md+=`|${r.group}|${r.label}|${f(r.piQ,3)}|${f(r.noTransfer.leakedKg,0)}|${f(r.transfer.leakedKg,0)}|${f(r.releaseReductionPct)}|${f(r.noTransfer.fanNm3H,0)}|${f(r.transfer.fanNm3H,0)}|${f(r.fanReductionPct)}|${f(r.noTransfer.mainPeakReactionHeatKW,0)}|${f(r.transfer.mainPeakReactionHeatKW,0)}|${f(r.mainHeatReductionPct)}|${f(r.transfer.maxGasMolFraction,3)}|${r.noTransfer.leakCompleted&&r.transfer.leakCompleted?'是':'否'}|\n`;
md+='\n## 大孔径时间步长检查\n\n|孔径 mm|步长 s|倒槽 m³/h|泄漏 kg|风量 Nm³/h|主塔反应热 kW|\n|---:|---:|---:|---:|---:|---:|\n';
for(const s of stepCheck)md+=`|${s.holeMm}|${s.timeStepS}|${s.pumpM3H}|${f(s.leakedKg,0)}|${f(s.fanNm3H,0)}|${f(s.mainPeakReactionHeatKW,0)}|\n`;
md+='\n复现：`node src/research_revision_pairs.mjs`。\n';
await fs.writeFile(new URL('返修配对计算.md',out),md);
console.log(md);
console.log('max balance error kg', Math.max(...rows.flatMap(r=>[r.transfer.balanceErrorKg,r.noTransfer.balanceErrorKg])));
