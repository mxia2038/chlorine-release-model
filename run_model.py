#!/usr/bin/env python3
"""液氯泄漏与吸收系统模型的本地命令行入口。"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")


def find_node() -> str:
    node = shutil.which("node")
    if node:
        return node
    raise SystemExit("未找到 Node.js。请安装 Node.js 20 或更高版本后重试。")


def run_node(node: str, script: str, config: Path) -> None:
    subprocess.run(
        [node, str(ROOT / script), str(config)],
        cwd=ROOT,
        check=True,
        stdout=subprocess.DEVNULL,
    )


def print_summary(result_path: Path) -> None:
    data = json.loads(result_path.read_text(encoding="utf-8"))
    release = data["release"]
    ventilation = data["ventilation"]
    derived = release["derived"]
    summary = release["summary"]
    print("\n计算完成")
    print(f"总泄漏时间：{summary['leakDurationS']:.2f} s")
    print(f"初算标准风量：{derived['preliminaryFanNm3H']:.2f} Nm3/h")
    print(f"厂房有效通流截面积：{derived['effectiveFlowAreaM2']:.2f} m2")
    print(f"液池表面等效空气流速：{derived['equivalentSurfaceWindMS']:.6f} m/s")
    print(f"最终标准风量：{ventilation['derived']['fanNm3H']:.2f} Nm3/h")
    print(f"结果文件：{result_path}")


def main() -> int:
    parser = argparse.ArgumentParser(description="运行液氯泄漏与吸收系统计算模型")
    parser.add_argument(
        "config",
        nargs="?",
        default="config/default_25mm.json",
        help="输入JSON文件，默认 config/default_25mm.json",
    )
    args = parser.parse_args()
    config = (ROOT / args.config).resolve() if not Path(args.config).is_absolute() else Path(args.config)
    if not config.exists():
        raise SystemExit(f"输入文件不存在：{config}")

    node = find_node()
    run_node(node, "src/calc.mjs", config)
    run_node(node, "src/design_basis.mjs", config)

    result_path = ROOT / "outputs/data" / f"{config.stem}_results.json"
    print_summary(result_path)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except subprocess.CalledProcessError as exc:
        print(f"计算失败，退出码：{exc.returncode}", file=sys.stderr)
        raise SystemExit(exc.returncode)
