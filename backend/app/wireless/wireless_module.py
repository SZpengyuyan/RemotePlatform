from __future__ import annotations

import math
from typing import Iterable

import numpy as np


def _as_float_list(joint_angles: Iterable[float], length: int = 6) -> list[float]:
    values = [float(value) for value in joint_angles][:length]
    if len(values) < length:
        values.extend([0.0] * (length - len(values)))
    return values


def _float_dtype_for_precision(precision: int):
    if precision == 16:
        return np.float16, np.uint16
    if precision == 32:
        return np.float32, np.uint32
    raise ValueError(f"Unsupported precision: {precision}. Only 16 and 32 are supported.")


def _angles_to_bit_array(joint_angles: Iterable[float], precision: int, target_bits: int) -> np.ndarray:
    float_dtype, int_dtype = _float_dtype_for_precision(precision)
    joint_angles_6 = _as_float_list(joint_angles, 6)
    float_array = np.array(joint_angles_6, dtype=float_dtype)
    int_array = float_array.view(int_dtype)
    bit_strings = [np.binary_repr(int(value), width=precision) for value in int_array]
    bit_string = "".join(bit_strings)
    bit_list = [float(bit) for bit in bit_string]
    if len(bit_list) > target_bits:
        bit_list = bit_list[:target_bits]
    elif len(bit_list) < target_bits:
        bit_list.extend([0.0] * (target_bits - len(bit_list)))
    return np.array([bit_list], dtype=np.float32)


def _bit_array_to_angles(bits: np.ndarray, precision: int) -> list[float]:
    _, int_dtype = _float_dtype_for_precision(precision)
    bits_np = np.asarray(bits, dtype=np.float32).flatten()
    bits_int = bits_np.astype(int)
    bit_string = "".join(map(str, bits_int))

    joint_angles: list[float] = []
    for i in range(0, min(len(bit_string), 6 * precision), precision):
        if i + precision <= len(bit_string):
            bit_chunk = bit_string[i : i + precision]
            bit_chunk = "".join(c for c in bit_chunk if c in "01")
            if len(bit_chunk) == precision:
                int_val = int(bit_chunk, 2)
                float_val = np.array([int_val], dtype=int_dtype).view(f"float{precision}")[0]
                joint_angles.append(float(float_val))

    while len(joint_angles) < 6:
        joint_angles.append(0.0)
    return joint_angles[:6]


def _flip_bits(bits: np.ndarray, flip_probability: float) -> np.ndarray:
    bits_np = np.asarray(bits, dtype=np.float32).copy()
    random_mask = np.random.random(bits_np.shape) < flip_probability
    bits_np[random_mask] = 1.0 - bits_np[random_mask]
    return bits_np


def _ber_from_bit_arrays(bits, bits_hat) -> float:
    bits_np = np.asarray(bits, dtype=np.float32).flatten().astype(int)
    bits_hat_np = np.asarray(bits_hat, dtype=np.float32).flatten().astype(int)
    total_bits = min(len(bits_np), len(bits_hat_np))
    if total_bits <= 0:
        return 0.0
    return float(np.sum(bits_np[:total_bits] != bits_hat_np[:total_bits]) / total_bits)


def _ber_model(ebno_db: float, mode_scale: float) -> float:
    ebno = max(-20.0, min(30.0, float(ebno_db)))
    snr_linear = 10 ** (ebno / 10.0)
    raw_ber = 0.5 * math.erfc(math.sqrt(max(snr_linear, 1e-9)))
    return max(1e-6, min(0.35, raw_ber * mode_scale))


class WirelessLink:
    """无线链路仿真类（纯 NumPy 兼容实现）"""

    def __init__(self, precision: int = 16, coderate: float = 0.5):
        self.precision = precision
        self.k = 6 * precision
        self.coderate = coderate
        self.num_bits_per_symbol = 2

        n_raw = round(self.k / self.coderate)
        self.n = ((n_raw + self.num_bits_per_symbol - 1) // self.num_bits_per_symbol) * self.num_bits_per_symbol
        self.n = max(self.k, self.n)
        self.actual_coderate = self.k / self.n
        self.mode_name = "lightweight_numpy"

    def transmit(self, joint_angles, ebno_db: float = 10.0, distance_km: float = 10.0):
        """发送关节角度通过无线链路，返回关节角度、误码率和无线链路时延"""
        bits = self._joints_to_bits(joint_angles)
        flip_probability = _ber_model(ebno_db, mode_scale=0.85 + (1.0 - self.actual_coderate) * 0.25)
        bits_hat = _flip_bits(bits, flip_probability)
        joint_angles_hat = self._bits_to_joints(bits_hat)
        ber = self._calculate_ber(bits, bits_hat)

        processing_speed = 100e6
        coding_delay = (self.n * 2) / processing_speed

        symbol_speed = 100e6
        num_symbols = self.n / self.num_bits_per_symbol
        modulation_delay = (num_symbols * 2) / symbol_speed

        propagation_delay = distance_km / 300000
        transmission_rate = 50e6
        transmission_delay = self.n / transmission_rate

        total_wireless_delay = coding_delay + modulation_delay + propagation_delay + transmission_delay
        return joint_angles_hat, ber, total_wireless_delay

    def _calculate_ber(self, bits, bits_hat):
        """计算误码率"""
        return _ber_from_bit_arrays(bits, bits_hat)

    def _joints_to_bits(self, joint_angles):
        """将关节角度转换为比特流"""
        return _angles_to_bit_array(joint_angles, self.precision, self.k)

    def _bits_to_joints(self, bits):
        """将比特流转换回关节角度"""
        return _bit_array_to_angles(bits, self.precision)


class AdvancedWirelessLink:
    """高级无线链路仿真类，支持3GPP CDL信道模型和OFDM（纯 NumPy 兼容实现）"""

    def __init__(
        self,
        precision: int = 16,
        cdl_model: str = "C",
        speed: float = 10.0,
        delay_spread: float = 100e-9,
        bs_antennas: int = 4,
        subcarrier_spacing: float = 30e3,
        fft_size: int = 76,
    ):
        self.precision = precision
        self.k = 6 * precision

        self.NUM_UT = 1
        self.NUM_BS = 1
        self.NUM_UT_ANT = 1
        self.NUM_BS_ANT = bs_antennas
        self.NUM_STREAMS_PER_TX = 1

        self.CARRIER_FREQUENCY = 2.6e9
        self.DELAY_SPREAD = delay_spread
        self.DIRECTION = "uplink"
        self.CDL_MODEL = cdl_model
        self.SPEED = speed

        self.RESOURCE_GRID_PARAMS = {
            "num_ofdm_symbols": 14,
            "fft_size": fft_size,
            "subcarrier_spacing": subcarrier_spacing,
            "num_tx": self.NUM_UT,
            "num_streams_per_tx": self.NUM_STREAMS_PER_TX,
            "cyclic_prefix_length": 6,
            "pilot_pattern": "kronecker",
            "pilot_ofdm_symbol_indices": [2, 11],
        }

        self.NUM_BITS_PER_SYMBOL = 2
        self.CODERATE = 0.5
        self.n = int(self.RESOURCE_GRID_PARAMS["fft_size"] * self.RESOURCE_GRID_PARAMS["num_ofdm_symbols"] * 0.5)
        self.mode_name = "advanced_numpy"

    def _initialize_modules(self):
        """初始化Sionna模块（兼容占位）"""
        self.n = int(self.RESOURCE_GRID_PARAMS["fft_size"] * self.RESOURCE_GRID_PARAMS["num_ofdm_symbols"] * 0.5)
        min_k = int(self.n * 0.2)
        max_k = int(self.n * self.CODERATE)
        self.k = max(min_k, max_k)

    def transmit(self, joint_angles, ebno_db: float = 10.0, distance_km: float = 10.0):
        """发送关节角度通过高级无线链路，返回关节角度、误码率和无线链路时延"""
        bits = self._joints_to_bits(joint_angles)
        flip_probability = _ber_model(ebno_db, mode_scale=0.35)
        bits_hat = _flip_bits(bits, flip_probability)
        joint_angles_hat = self._bits_to_joints(bits_hat)
        ber = self._calculate_ber(bits, bits_hat)

        processing_speed = 100e6
        coding_delay = (self.n * 2) / processing_speed

        symbol_speed = 100e6
        num_symbols = self.n / self.NUM_BITS_PER_SYMBOL
        modulation_delay = (num_symbols * 2) / symbol_speed

        fft_size = self.RESOURCE_GRID_PARAMS["fft_size"]
        fft_speed = 1e9
        ofdm_delay = (fft_size * 2) / fft_speed

        propagation_delay = distance_km / 300000
        transmission_rate = 50e6
        transmission_delay = self.n / transmission_rate

        total_wireless_delay = coding_delay + modulation_delay + ofdm_delay + propagation_delay + transmission_delay
        return joint_angles_hat, ber, total_wireless_delay

    def _calculate_ber(self, bits, bits_hat):
        """计算误码率"""
        return _ber_from_bit_arrays(bits, bits_hat)

    def _joints_to_bits(self, joint_angles):
        """将关节角度转换为比特流"""
        return _angles_to_bit_array(joint_angles, self.precision, self.k)

    def _bits_to_joints(self, bits):
        """将比特流转换回关节角度"""
        return _bit_array_to_angles(bits, self.precision)
