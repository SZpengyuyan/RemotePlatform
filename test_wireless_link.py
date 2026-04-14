import argparse
import os
import random
import sys

import numpy as np
from backend.app.wireless.wireless_module import AdvancedWirelessLink, WirelessLink


def set_global_seed(seed: int) -> None:
    """Set deterministic seeds used in this test script."""
    os.environ["PYTHONHASHSEED"] = str(seed)
    random.seed(seed)
    np.random.seed(seed)
    # TensorFlow dependency removed


def run_trials(link, joint_angles, ebno_db: float, distance_km: float, trials: int):
    bers = []
    delays = []
    for _ in range(trials):
        joint_hat, ber, delay = link.transmit(
            joint_angles,
            ebno_db=ebno_db,
            distance_km=distance_km,
        )
        assert len(joint_hat) == 6, "output dimension must be 6"
        assert 0.0 <= float(ber) <= 1.0, "BER must be in [0, 1]"
        assert float(delay) > 0.0, "delay must be positive"
        bers.append(float(ber))
        delays.append(float(delay))
    return np.array(bers, dtype=np.float64), np.array(delays, dtype=np.float64)


def build_link(args):
    if args.link == "advanced":
        return AdvancedWirelessLink(
            cdl_model=args.cdl_model,
            speed=args.speed,
            delay_spread=args.delay_spread,
            bs_antennas=args.bs_antennas,
            subcarrier_spacing=args.subcarrier_spacing,
            fft_size=args.fft_size,
        )
    return WirelessLink(coderate=args.coderate)


def parse_args():
    parser = argparse.ArgumentParser(description="Deterministic wireless link acceptance test")
    parser.add_argument("--link", choices=["basic", "advanced"], default="basic")
    parser.add_argument("--seed", type=int, default=20260413)
    parser.add_argument("--trials", type=int, default=10)
    parser.add_argument("--distance-km", type=float, default=10.0)
    parser.add_argument("--low-ebno", type=float, default=0.0)
    parser.add_argument("--high-ebno", type=float, default=10.0)

    # Basic link options
    parser.add_argument("--coderate", type=float, default=0.5)

    # Advanced link options
    parser.add_argument("--cdl-model", type=str, default="C")
    parser.add_argument("--speed", type=float, default=10.0)
    parser.add_argument("--delay-spread", type=float, default=100e-9)
    parser.add_argument("--bs-antennas", type=int, default=4)
    parser.add_argument("--subcarrier-spacing", type=float, default=30e3)
    parser.add_argument("--fft-size", type=int, default=76)
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    joint_angles = np.array([-1.57, -1.34, 2.65, -1.30, 1.55, 0.0], dtype=np.float16)

    # Build once so both EbNo settings share exactly the same configuration.
    link = build_link(args)

    # Run low and high EbNo with the same random seed for fair comparison.
    set_global_seed(args.seed)
    low_bers, low_delays = run_trials(
        link,
        joint_angles,
        ebno_db=args.low_ebno,
        distance_km=args.distance_km,
        trials=args.trials,
    )

    set_global_seed(args.seed)
    high_bers, high_delays = run_trials(
        link,
        joint_angles,
        ebno_db=args.high_ebno,
        distance_km=args.distance_km,
        trials=args.trials,
    )

    low_mean = float(np.mean(low_bers))
    high_mean = float(np.mean(high_bers))

    print("=== Wireless Link Acceptance Test ===")
    print(f"link={args.link}, seed={args.seed}, trials={args.trials}")
    print(f"low_ebno={args.low_ebno} dB, mean_ber={low_mean:.6f}, mean_delay={np.mean(low_delays):.6e} s")
    print(f"high_ebno={args.high_ebno} dB, mean_ber={high_mean:.6f}, mean_delay={np.mean(high_delays):.6e} s")

    if high_mean >= low_mean:
        print("FAIL: expected BER at high EbNo to be lower than BER at low EbNo")
        return 1

    print("PASS: all acceptance checks succeeded")
    return 0


if __name__ == "__main__":
    sys.exit(main())
