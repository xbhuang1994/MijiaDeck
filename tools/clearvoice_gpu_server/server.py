# SPDX-License-Identifier: GPL-3.0-or-later
# MijiaDeck: ClearVoice (MossFormer2_SS_16K BSS + MossFormer2_SE_48K SE) GPU Inference Service
# Copyright (C) 2026 MiHome-Windows contributors

"""
本地 ClearVoice GPU 推理服务（多轨盲源分离 BSS + 分轨降噪/去背景音 SE）：

- 盲源分离（BSS）：在 NVIDIA CUDA GPU 上加载并运行 ClearerVoice-Studio MossFormer2_SS_16K ONNX 模型，
  将原始音频分离为独立的多轨说话人音频（长音频按滑动重叠窗 + PIT 相关性置换对齐拼接，绝不串轨混杂）；
- 分轨降噪与剔除背景音（SE）：对每条分离出的音轨独立执行 MossFormer2_SE_48K（Kaldi 60-Mel Fbank +
  Delta + Delta-Delta + 48kHz Hamming STFT/ISTFT），彻底消除环境噪音与背景伴奏；
- 提供低延迟本地回环 HTTP 接口：
  - GET  /health, /status : 返回 SE + SS 双模型与 GPU 运行状态；
  - POST /denoise         : 单轨准实时降噪（向后兼容原接口）；
  - POST /separate        : 原始音频 -> 盲源分离 -> 能量守恒缩放 -> 分轨独立降噪去背景音 -> 多轨二进制直出。
"""

from __future__ import annotations

import argparse
import json
import math
import os
import site
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import numpy as np
from scipy.fft import irfft, rfft
from scipy.signal import resample_poly


def _register_bundled_cuda_dll_dirs() -> list[str]:
    """将 venv 中通过 pip 安装的 nvidia/* CUDA/cuDNN DLL 目录注册到 Windows DLL 搜索路径。"""
    added: list[str] = []
    if sys.platform != "win32":
        return added
    roots: list[Path] = []
    try:
        for sp in site.getsitepackages():
            roots.append(Path(sp) / "nvidia")
    except Exception:
        pass
    venv_site = Path(sys.executable).resolve().parent.parent / "Lib" / "site-packages" / "nvidia"
    if venv_site not in roots:
        roots.append(venv_site)

    seen: set[str] = set()
    for nvidia_root in roots:
        if not nvidia_root.is_dir():
            continue
        for sub in nvidia_root.iterdir():
            for rel in ("bin", "lib"):
                candidate = sub / rel
                if candidate.is_dir():
                    c_str = str(candidate.resolve())
                    if c_str in seen:
                        continue
                    seen.add(c_str)
                    try:
                        os.add_dll_directory(c_str)
                    except Exception:
                        pass
                    added.append(c_str)
    if added:
        os.environ["PATH"] = os.pathsep.join(added) + os.pathsep + os.environ.get("PATH", "")
    return added


_DLL_DIRS = _register_bundled_cuda_dll_dirs()

import onnxruntime as ort  # noqa: E402


MAX_WAV_VALUE = 32768.0
MODEL_SR = 48000
WIN_LEN = 1920  # 40ms @ 48kHz
WIN_INC = 384  # 8ms @ 48kHz
FBANK_FFT_LEN = 2048  # Kaldi round_to_power_of_two(1920)
NUM_MEL_BINS = 60


def _build_symmetric_hamming(win_len: int) -> np.ndarray:
    """torch.hamming_window(win_len, periodic=False) 对称汉明窗。"""
    n = np.arange(win_len, dtype=np.float64)
    return (0.54 - 0.46 * np.cos(2.0 * math.pi * n / (win_len - 1))).astype(np.float32)


def _build_kaldi_mel_filterbank(
    sample_rate: int = MODEL_SR,
    fft_len: int = FBANK_FFT_LEN,
    num_mel_bins: int = NUM_MEL_BINS,
    low_freq: float = 20.0,
    high_freq: float = 0.0,
) -> np.ndarray:
    """精确复现 torchaudio.compliance.kaldi.get_mel_banks 60 维梅尔滤波器组。"""
    nyquist = 0.5 * sample_rate
    hi = nyquist if high_freq <= 0.0 else high_freq
    mel_low = 1127.0 * math.log(1.0 + low_freq / 700.0)
    mel_high = 1127.0 * math.log(1.0 + hi / 700.0)
    mel_delta = (mel_high - mel_low) / (num_mel_bins + 1)

    num_fft_bins = fft_len // 2
    fft_bin_width = sample_rate / float(fft_len)
    freqs = np.arange(num_fft_bins, dtype=np.float64) * fft_bin_width
    mels = 1127.0 * np.log(1.0 + freqs / 700.0)

    bins = np.zeros((num_mel_bins, num_fft_bins + 1), dtype=np.float32)
    for b in range(num_mel_bins):
        left_mel = mel_low + b * mel_delta
        center_mel = mel_low + (b + 1) * mel_delta
        right_mel = mel_low + (b + 2) * mel_delta
        up = (mels - left_mel) / (center_mel - left_mel)
        down = (right_mel - mels) / (right_mel - center_mel)
        bins[b, :num_fft_bins] = np.maximum(0.0, np.minimum(up, down)).astype(np.float32)
    return bins


def _compute_deltas(feats: np.ndarray, win_length: int = 5) -> np.ndarray:
    """精确复现 torchaudio.functional.compute_deltas(win_length=5, mode='replicate')。
    feats: [F, C] -> [F, C]
    """
    n = (win_length - 1) // 2
    denom = 2.0 * sum(i * i for i in range(1, n + 1))
    padded = np.pad(feats, ((n, n), (0, 0)), mode="edge")
    out = np.zeros_like(feats, dtype=np.float32)
    for k in range(1, n + 1):
        out += k * (padded[n + k : n + k + feats.shape[0]] - padded[n - k : n - k + feats.shape[0]])
    out /= float(denom)
    return out


def _extract_strided_frames(x: np.ndarray, win_len: int = WIN_LEN, win_inc: int = WIN_INC) -> np.ndarray:
    num_frames = 1 + (x.shape[0] - win_len) // win_inc
    stride = x.strides[0]
    return np.lib.stride_tricks.as_strided(
        x,
        shape=(num_frames, win_len),
        strides=(win_inc * stride, stride),
    )


def _resample_audio(samples: np.ndarray, from_sr: int, to_sr: int) -> np.ndarray:
    if from_sr == to_sr or samples.size == 0:
        return samples.astype(np.float32, copy=False)
    g = math.gcd(int(from_sr), int(to_sr))
    up = int(to_sr) // g
    down = int(from_sr) // g
    resampled = resample_poly(samples.astype(np.float64, copy=False), up, down)
    return resampled.astype(np.float32, copy=False)


def _query_nvidia_gpu_info() -> dict[str, Any]:
    try:
        out = subprocess.check_output(
            [
                "nvidia-smi",
                "--query-gpu=name,memory.total,memory.used,memory.free",
                "--format=csv,noheader,nounits",
            ],
            stderr=subprocess.DEVNULL,
            timeout=3,
            text=True,
        ).strip()
        first = next((line.strip() for line in out.splitlines() if line.strip()), "")
        if first:
            parts = [p.strip() for p in first.split(",")]
            return {
                "gpuName": parts[0] if len(parts) > 0 else None,
                "vramTotalMb": int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else None,
                "vramUsedMb": int(parts[2]) if len(parts) > 2 and parts[2].isdigit() else None,
                "vramFreeMb": int(parts[3]) if len(parts) > 3 and parts[3].isdigit() else None,
            }
    except Exception:
        pass
    return {"gpuName": None, "vramTotalMb": None, "vramUsedMb": None, "vramFreeMb": None}


def _resolve_optimized_cache_paths(model_path: Path) -> tuple[Path, Path]:
    cache_onnx = model_path.with_name(f"{model_path.stem}.ort_basic_cache.onnx")
    cache_meta = model_path.with_name(f"{model_path.stem}.ort_basic_cache.meta.json")
    return cache_onnx, cache_meta


def _is_optimized_cache_valid(model_path: Path, cache_onnx: Path, cache_meta: Path) -> bool:
    try:
        if not cache_onnx.is_file() or not cache_meta.is_file():
            return False
        if cache_onnx.stat().st_size < 10_000_000:
            return False
        src_stat = model_path.stat()
        meta = json.loads(cache_meta.read_text(encoding="utf-8"))
        return (
            meta.get("srcSize") == src_stat.st_size
            and meta.get("srcMtimeNs") == src_stat.st_mtime_ns
            and meta.get("ortVersion") == getattr(ort, "__version__", "")
            and meta.get("optLevel") == "ORT_ENABLE_BASIC"
        )
    except Exception:
        return False


class MossFormer2GpuEngine:
    def __init__(self, model_path: str, device_pref: str = "gpu", device_id: int = 0) -> None:
        self.model_path = str(Path(model_path).resolve())
        self.device_pref = device_pref
        self.device_id = device_id
        self.lock = threading.Lock()
        self.hamming = _build_symmetric_hamming(WIN_LEN)
        self.hamming_sq = self.hamming.astype(np.float64) ** 2
        self.mel_fb = _build_kaldi_mel_filterbank()
        self.warmed_up = False
        self.request_count = 0
        self.last_infer_ms = 0.0
        self.last_total_ms = 0.0

        available = ort.get_available_providers()
        sess_opts = ort.SessionOptions()
        sess_opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_BASIC

        src_path = Path(self.model_path)
        cache_onnx, cache_meta = _resolve_optimized_cache_paths(src_path)
        load_target = self.model_path
        tmp_cache_path: Path | None = None
        self.used_opt_cache = False
        if _is_optimized_cache_valid(src_path, cache_onnx, cache_meta):
            load_target = str(cache_onnx)
            self.used_opt_cache = True
        else:
            try:
                tmp_cache_path = cache_onnx.with_name(f"{cache_onnx.name}.{os.getpid()}.tmp")
                sess_opts.optimized_model_filepath = str(tmp_cache_path)
            except Exception:
                tmp_cache_path = None

        providers: list[Any] = []
        if device_pref != "cpu" and "CUDAExecutionProvider" in available:
            providers.append(
                (
                    "CUDAExecutionProvider",
                    {
                        "device_id": device_id,
                        "arena_extend_strategy": "kSameAsRequested",
                        "cudnn_conv_algo_search": "DEFAULT",
                        "cudnn_conv1d_pad_to_nc1d": 1,
                        "do_copy_in_default_stream": True,
                    },
                )
            )
        providers.append("CPUExecutionProvider")

        t0 = time.perf_counter()
        self.session = ort.InferenceSession(load_target, sess_options=sess_opts, providers=providers)
        self.load_ms = round((time.perf_counter() - t0) * 1000.0, 1)

        if tmp_cache_path is not None and tmp_cache_path.is_file():
            try:
                if tmp_cache_path.stat().st_size > 10_000_000:
                    os.replace(tmp_cache_path, cache_onnx)
                    src_stat = src_path.stat()
                    cache_meta.write_text(
                        json.dumps(
                            {
                                "srcSize": src_stat.st_size,
                                "srcMtimeNs": src_stat.st_mtime_ns,
                                "ortVersion": getattr(ort, "__version__", ""),
                                "optLevel": "ORT_ENABLE_BASIC",
                            },
                            ensure_ascii=False,
                        ),
                        encoding="utf-8",
                    )
                else:
                    tmp_cache_path.unlink(missing_ok=True)
            except Exception:
                try:
                    tmp_cache_path.unlink(missing_ok=True)
                except Exception:
                    pass

        self.active_providers = list(self.session.get_providers())
        self.active_provider = self.active_providers[0] if self.active_providers else "CPUExecutionProvider"
        self.using_gpu = self.active_provider == "CUDAExecutionProvider"
        self.input_name = self.session.get_inputs()[0].name
        self.output_name = self.session.get_outputs()[0].name
        self.gpu_info = _query_nvidia_gpu_info()

    def warmup(self) -> float:
        """执行一次 1.0s 哑推理以提前完成 CUDA kernel / cuDNN 初始化。"""
        dummy = np.zeros(MODEL_SR, dtype=np.float32)
        t0 = time.perf_counter()
        self.enhance(dummy, MODEL_SR, MODEL_SR)
        self.warmed_up = True
        self.gpu_info = _query_nvidia_gpu_info()
        return round((time.perf_counter() - t0) * 1000.0, 1)

    def _compute_fbank_180(self, x_scaled: np.ndarray) -> np.ndarray:
        frames = _extract_strided_frames(x_scaled).astype(np.float32, copy=True)
        # 1. Kaldi remove_dc_offset
        frames -= frames.mean(axis=1, keepdims=True)
        # 2. Kaldi preemphasis (0.97, replicate left edge)
        prev = np.empty_like(frames)
        prev[:, 0] = frames[:, 0]
        prev[:, 1:] = frames[:, :-1]
        frames -= 0.97 * prev
        # 3. Hamming window & 2048-pt RFFT power spectrum
        frames *= self.hamming[None, :]
        spec = rfft(frames, n=FBANK_FFT_LEN, axis=1)
        power = (spec.real * spec.real + spec.imag * spec.imag).astype(np.float32)
        # 4. 60-bin Kaldi Mel filterbank + log
        mel = np.matmul(power, self.mel_fb.T)
        np.maximum(mel, np.finfo(np.float32).eps, out=mel)
        fbank = np.log(mel, out=mel)
        # 5. Delta + Delta-Delta -> [1, F, 180]
        d1 = _compute_deltas(fbank, 5)
        d2 = _compute_deltas(d1, 5)
        feats = np.concatenate([fbank, d1, d2], axis=1)
        return np.ascontiguousarray(feats[None, :, :], dtype=np.float32)

    def enhance(
        self,
        samples: np.ndarray,
        input_sr: int = 16000,
        output_sr: int = 16000,
    ) -> tuple[np.ndarray, dict[str, Any]]:
        t_start = time.perf_counter()
        orig_len = int(samples.size)
        if orig_len == 0:
            return np.zeros(0, dtype=np.float32), {"inferMs": 0.0, "totalMs": 0.0, "frames": 0}

        expected_out_len = (
            orig_len if input_sr == output_sr else max(1, int(round(orig_len * (output_sr / float(input_sr)))))
        )

        # Stage 1: 重采样至 48kHz 单声道
        audio_48k = _resample_audio(samples, input_sr, MODEL_SR)
        len_48k = int(audio_48k.size)

        # 尾部补齐到完整 STFT 帧边界，防止末帧（<=8ms）被丢弃或边界能量衰减
        min_len = max(WIN_LEN, len_48k)
        rem = (min_len - WIN_LEN) % WIN_INC
        padded_len = min_len if rem == 0 else min_len + (WIN_INC - rem)
        # 再增加 1 帧 (384 samples) 尾部保护缓冲以确保真实末尾样本完整落在满重叠区
        padded_len += WIN_INC
        if padded_len > len_48k:
            work_48k = np.pad(audio_48k, (0, padded_len - len_48k), mode="constant")
        else:
            work_48k = audio_48k

        x_scaled = (work_48k * MAX_WAV_VALUE).astype(np.float32, copy=False)
        feats = self._compute_fbank_180(x_scaled)
        num_frames = int(feats.shape[1])

        # Stage 2: GPU MossFormer2_SE_48K 掩码推理
        t_inf0 = time.perf_counter()
        with self.lock:
            mask = self.session.run([self.output_name], {self.input_name: feats})[0]
        infer_ms = (time.perf_counter() - t_inf0) * 1000.0
        mask_2d = mask[0]  # [F, 961]

        # Stage 3: STFT -> 实值频谱掩码 -> ISTFT 重建 48kHz 纯净语音
        raw_frames = _extract_strided_frames(x_scaled) * self.hamming[None, :]
        spec = rfft(raw_frames, n=WIN_LEN, axis=1)  # [F, 961] complex
        masked_spec = spec * mask_2d
        time_frames = irfft(masked_spec, n=WIN_LEN, axis=1)  # [F, 1920] real

        out_buf_len = (num_frames - 1) * WIN_INC + WIN_LEN
        y = np.zeros(out_buf_len, dtype=np.float64)
        w_sum = np.zeros(out_buf_len, dtype=np.float64)
        win64 = self.hamming.astype(np.float64)
        for f_idx in range(num_frames):
            s = f_idx * WIN_INC
            y[s : s + WIN_LEN] += time_frames[f_idx] * win64
            w_sum[s : s + WIN_LEN] += self.hamming_sq

        valid = w_sum > 1e-8
        y[valid] /= w_sum[valid]
        clean_48k = np.clip(y[:len_48k] / MAX_WAV_VALUE, -1.0, 1.0).astype(np.float32)

        # Stage 4: 重采样回目标输出采样率（16kHz 供 Qwen3-ASR 识别）
        clean_out = _resample_audio(clean_48k, MODEL_SR, output_sr)
        if clean_out.size > expected_out_len:
            clean_out = clean_out[:expected_out_len]
        elif clean_out.size < expected_out_len:
            clean_out = np.pad(clean_out, (0, expected_out_len - clean_out.size), mode="constant")
        clean_out = np.ascontiguousarray(clean_out, dtype=np.float32)

        total_ms = (time.perf_counter() - t_start) * 1000.0
        self.request_count += 1
        self.last_infer_ms = round(infer_ms, 2)
        self.last_total_ms = round(total_ms, 2)
        return clean_out, {
            "inferMs": round(infer_ms, 2),
            "totalMs": round(total_ms, 2),
            "frames": num_frames,
            "provider": self.active_provider,
            "device": "gpu" if self.using_gpu else "cpu",
            "gpuName": self.gpu_info.get("gpuName"),
        }

    def status_dict(self) -> dict[str, Any]:
        return {
            "ok": True,
            "model": "MossFormer2_SE_48K",
            "modelPath": self.model_path,
            "sampleRate": MODEL_SR,
            "provider": self.active_provider,
            "providers": self.active_providers,
            "device": "gpu" if self.using_gpu else "cpu",
            "gpuName": self.gpu_info.get("gpuName"),
            "vramTotalMb": self.gpu_info.get("vramTotalMb"),
            "vramUsedMb": self.gpu_info.get("vramUsedMb"),
            "vramFreeMb": self.gpu_info.get("vramFreeMb"),
            "loadMs": self.load_ms,
            "warmedUp": self.warmed_up,
            "requestCount": self.request_count,
            "lastInferMs": self.last_infer_ms,
            "lastTotalMs": self.last_total_ms,
        }


def _rms(samples: np.ndarray) -> float:
    if samples.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(samples.astype(np.float64, copy=False) ** 2)))


def _norm_corr(a: np.ndarray, b: np.ndarray) -> float:
    n = min(a.size, b.size)
    if n < 16:
        return 0.0
    x = a[:n].astype(np.float64, copy=False)
    y = b[:n].astype(np.float64, copy=False)
    nx = float(np.linalg.norm(x))
    ny = float(np.linalg.norm(y))
    if nx < 1e-8 or ny < 1e-8:
        return 0.0
    return float(np.dot(x, y) / (nx * ny))


def _envelope_corr(a: np.ndarray, b: np.ndarray, win: int = 320) -> float:
    n_frames = min(a.size, b.size) // win
    if n_frames < 2:
        return 0.0
    ea = np.sqrt(np.mean(a[: n_frames * win].astype(np.float64).reshape(n_frames, win) ** 2, axis=1))
    eb = np.sqrt(np.mean(b[: n_frames * win].astype(np.float64).reshape(n_frames, win) ** 2, axis=1))
    ea = ea - ea.mean()
    eb = eb - eb.mean()
    na = float(np.linalg.norm(ea))
    nb = float(np.linalg.norm(eb))
    if na < 1e-8 or nb < 1e-8:
        return 0.0
    return float(np.dot(ea, eb) / (na * nb))


def _spectral_mag_corr(a: np.ndarray, b: np.ndarray, win: int = 512, hop: int = 256) -> float:
    """相位无关的 STFT 对数幅度谱相关性，用于精准区分单说话人镜像串音轨（>=0.62）与真实双说话人分离轨（<=0.40）。"""
    n = min(a.size, b.size)
    if n < win + hop:
        return 0.0
    n_frames = 1 + (n - win) // hop
    if n_frames < 2:
        return 0.0
    fa = _extract_strided_frames(np.ascontiguousarray(a[:n], dtype=np.float32), win_len=win, win_inc=hop)
    fb = _extract_strided_frames(np.ascontiguousarray(b[:n], dtype=np.float32), win_len=win, win_inc=hop)
    sa = np.log1p(np.abs(rfft(fa, n=win, axis=1)) * 10.0).astype(np.float64).ravel()
    sb = np.log1p(np.abs(rfft(fb, n=win, axis=1)) * 10.0).astype(np.float64).ravel()
    sa -= sa.mean()
    sb -= sb.mean()
    na = float(np.linalg.norm(sa))
    nb = float(np.linalg.norm(sb))
    if na < 1e-8 or nb < 1e-8:
        return 0.0
    return float(np.dot(sa, sb) / (na * nb))


def _scale_tracks_preserve_energy(tracks: list[np.ndarray], ref_mix: np.ndarray) -> list[np.ndarray]:
    """按输入混音能量守恒统一缩放全部分离音轨，既防止截幅削波又绝不放大静音残影轨。"""
    in_rms = _rms(ref_mix)
    if in_rms < 1e-7 or not tracks:
        return [np.zeros_like(t, dtype=np.float32) for t in tracks]
    sum_sq = sum(_rms(t) ** 2 for t in tracks)
    if sum_sq < 1e-12:
        return [np.zeros_like(t, dtype=np.float32) for t in tracks]
    gain = in_rms / math.sqrt(sum_sq)
    peak = max(float(np.max(np.abs(t))) if t.size > 0 else 0.0 for t in tracks)
    if peak * gain > 0.96:
        gain = 0.96 / peak
    return [np.clip(t.astype(np.float64) * gain, -1.0, 1.0).astype(np.float32) for t in tracks]


SS_MODEL_SR = 16000


class MossFormer2SeparatorEngine:
    """ClearVoice MossFormer2_SS_16K 双说话人盲源分离推理引擎（支持 GPU/CPU 自动兜底与长音频 PIT 滑窗拼接）。"""

    def __init__(
        self,
        model_path: str,
        device_pref: str = "gpu",
        device_id: int = 0,
        max_window_sec: float = 4.0,
    ) -> None:
        self.model_path = str(Path(model_path).resolve())
        self.device_pref = device_pref
        self.device_id = device_id
        self.max_window_sec = max(2.0, min(10.0, float(max_window_sec)))
        self.lock = threading.Lock()
        self.warmed_up = False
        self.request_count = 0
        self.last_infer_ms = 0.0

        src_path = Path(self.model_path)
        cache_onnx, cache_meta = _resolve_optimized_cache_paths(src_path)
        load_target = self.model_path
        tmp_cache_path: Path | None = None
        self.used_opt_cache = False
        if _is_optimized_cache_valid(src_path, cache_onnx, cache_meta):
            load_target = str(cache_onnx)
            self.used_opt_cache = True
        else:
            try:
                tmp_cache_path = cache_onnx.with_name(f"{cache_onnx.name}.{os.getpid()}.tmp")
            except Exception:
                tmp_cache_path = None

        self.session, self.load_ms = self._create_session(
            load_target, device_pref=device_pref, tmp_cache_path=tmp_cache_path
        )

        if tmp_cache_path is not None and tmp_cache_path.is_file():
            try:
                if tmp_cache_path.stat().st_size > 10_000_000:
                    os.replace(tmp_cache_path, cache_onnx)
                    src_stat = src_path.stat()
                    cache_meta.write_text(
                        json.dumps(
                            {
                                "srcSize": src_stat.st_size,
                                "srcMtimeNs": src_stat.st_mtime_ns,
                                "ortVersion": getattr(ort, "__version__", ""),
                                "optLevel": "ORT_ENABLE_BASIC",
                            },
                            ensure_ascii=False,
                        ),
                        encoding="utf-8",
                    )
                else:
                    tmp_cache_path.unlink(missing_ok=True)
            except Exception:
                try:
                    tmp_cache_path.unlink(missing_ok=True)
                except Exception:
                    pass

        self._refresh_session_meta()

    def _create_session(
        self,
        load_target: str,
        device_pref: str,
        tmp_cache_path: Path | None = None,
    ) -> tuple[ort.InferenceSession, float]:
        available = ort.get_available_providers()
        sess_opts = ort.SessionOptions()
        sess_opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_BASIC
        if tmp_cache_path is not None:
            try:
                sess_opts.optimized_model_filepath = str(tmp_cache_path)
            except Exception:
                pass

        providers: list[Any] = []
        if device_pref != "cpu" and "CUDAExecutionProvider" in available:
            providers.append(
                (
                    "CUDAExecutionProvider",
                    {
                        "device_id": self.device_id,
                        "arena_extend_strategy": "kSameAsRequested",
                        "cudnn_conv_algo_search": "HEURISTIC",
                        "cudnn_conv1d_pad_to_nc1d": 1,
                        "do_copy_in_default_stream": True,
                    },
                )
            )
        providers.append("CPUExecutionProvider")

        t0 = time.perf_counter()
        try:
            sess = ort.InferenceSession(load_target, sess_options=sess_opts, providers=providers)
        except Exception:
            if device_pref != "cpu":
                cpu_opts = ort.SessionOptions()
                cpu_opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_BASIC
                sess = ort.InferenceSession(
                    load_target, sess_options=cpu_opts, providers=["CPUExecutionProvider"]
                )
            else:
                raise
        return sess, round((time.perf_counter() - t0) * 1000.0, 1)

    def _refresh_session_meta(self) -> None:
        self.active_providers = list(self.session.get_providers())
        self.active_provider = self.active_providers[0] if self.active_providers else "CPUExecutionProvider"
        self.using_gpu = self.active_provider == "CUDAExecutionProvider"
        self.input_name = self.session.get_inputs()[0].name
        self.output_name = self.session.get_outputs()[0].name
        meta_map = {}
        try:
            meta_map = dict(self.session.get_modelmeta().custom_metadata_map or {})
        except Exception:
            meta_map = {}
        self.align = int(meta_map.get("align", "8") or "8")
        self.align_tail = int(meta_map.get("align_tail", "0") or "0")

    def _fallback_to_cpu(self) -> None:
        if not self.using_gpu:
            return
        cache_onnx, cache_meta = _resolve_optimized_cache_paths(Path(self.model_path))
        load_target = (
            str(cache_onnx)
            if _is_optimized_cache_valid(Path(self.model_path), cache_onnx, cache_meta)
            else self.model_path
        )
        self.session, _ = self._create_session(load_target, device_pref="cpu")
        self._refresh_session_meta()

    def _pad_length(self, n: int) -> int:
        if self.align > 1 and self.align_tail > 0:
            if n <= self.align_tail:
                return self.align_tail
            k = (n - self.align_tail + self.align - 1) // self.align
            return self.align * k + self.align_tail
        rem = n % max(1, self.align)
        return n if rem == 0 else n + (self.align - rem)

    def _run_raw_segment(self, seg_16k: np.ndarray) -> list[np.ndarray]:
        n = int(seg_16k.size)
        if n == 0:
            return [np.zeros(0, dtype=np.float32), np.zeros(0, dtype=np.float32)]
        pad_n = max(16, self._pad_length(n))
        inp = (
            np.pad(seg_16k, (0, pad_n - n), mode="constant").astype(np.float32, copy=False)
            if pad_n > n
            else seg_16k.astype(np.float32, copy=False)
        )
        feed = {self.input_name: np.ascontiguousarray(inp[None, :], dtype=np.float32)}
        try:
            raw = self.session.run([self.output_name], feed)[0]
        except Exception as exc:
            msg = str(exc).lower()
            if self.using_gpu and ("out of memory" in msg or "cuda" in msg or "alloc" in msg):
                self._fallback_to_cpu()
                raw = self.session.run([self.output_name], feed)[0]
            else:
                raise

        if raw.ndim == 3 and raw.shape[0] == 2:
            raw_tracks = [raw[0, 0], raw[1, 0]]
        elif raw.ndim == 3 and raw.shape[1] == 2:
            raw_tracks = [raw[0, 0], raw[0, 1]]
        elif raw.ndim == 2:
            raw_tracks = [raw[i] for i in range(raw.shape[0])]
        else:
            flat = np.reshape(raw, (-1, pad_n))
            raw_tracks = [flat[i] for i in range(flat.shape[0])]

        fitted: list[np.ndarray] = []
        for tr in raw_tracks:
            arr = np.asarray(tr, dtype=np.float32).reshape(-1)
            if arr.size >= n:
                fitted.append(arr[:n].copy())
            else:
                fitted.append(np.pad(arr, (0, n - arr.size), mode="constant"))
        return fitted

    def warmup(self) -> float:
        dummy = np.zeros(SS_MODEL_SR, dtype=np.float32)
        t0 = time.perf_counter()
        self.separate(dummy, SS_MODEL_SR)
        self.warmed_up = True
        return round((time.perf_counter() - t0) * 1000.0, 1)

    def separate(
        self,
        samples_16k: np.ndarray,
        sample_rate: int = SS_MODEL_SR,
    ) -> tuple[list[np.ndarray], dict[str, Any]]:
        t0 = time.perf_counter()
        audio_16k = _resample_audio(samples_16k, sample_rate, SS_MODEL_SR)
        n = int(audio_16k.size)
        if n < 320:
            return (
                [audio_16k.copy(), np.zeros_like(audio_16k)],
                {"ssMs": 0.0, "windows": 0, "swaps": 0, "provider": self.active_provider, "device": "gpu" if self.using_gpu else "cpu"},
            )

        win = int(round(self.max_window_sec * SS_MODEL_SR))
        ov = int(round(0.5 * SS_MODEL_SR))
        hop = max(SS_MODEL_SR, win - ov)
        swaps = 0
        windows = 0

        with self.lock:
            if n <= win:
                raw_tracks = self._run_raw_segment(audio_16k)
                scaled = _scale_tracks_preserve_energy(raw_tracks, audio_16k)
                windows = 1
            else:
                out0 = np.zeros(n, dtype=np.float64)
                out1 = np.zeros(n, dtype=np.float64)
                wsum = np.zeros(n, dtype=np.float64)
                pos = 0
                while pos < n:
                    end = min(n, pos + win)
                    seg = audio_16k[pos:end]
                    if seg.size < 1600 and windows > 0:
                        # 极短尾片并入前窗即可，避免短窗分离失真
                        break
                    raw_tracks = self._run_raw_segment(seg)
                    c0, c1 = _scale_tracks_preserve_energy(raw_tracks[:2], seg)
                    seg_len = int(seg.size)
                    if windows > 0 and ov > 0:
                        ov_len = min(ov, seg_len, pos)
                        p0 = out0[pos : pos + ov_len] / np.maximum(wsum[pos : pos + ov_len], 1e-8)
                        p1 = out1[pos : pos + ov_len] / np.maximum(wsum[pos : pos + ov_len], 1e-8)
                        s_same = _norm_corr(p0, c0[:ov_len]) + _norm_corr(p1, c1[:ov_len])
                        s_swap = _norm_corr(p0, c1[:ov_len]) + _norm_corr(p1, c0[:ov_len])
                        if s_swap > s_same + 1e-4:
                            c0, c1 = c1, c0
                            swaps += 1
                        w = np.ones(seg_len, dtype=np.float64)
                        w[:ov_len] = np.linspace(0.0, 1.0, ov_len, dtype=np.float64)
                        fade_out = 1.0 - w[:ov_len]
                        out0[pos : pos + ov_len] *= fade_out
                        out1[pos : pos + ov_len] *= fade_out
                        wsum[pos : pos + ov_len] *= fade_out
                    else:
                        w = np.ones(seg_len, dtype=np.float64)
                    out0[pos:end] += c0.astype(np.float64) * w
                    out1[pos:end] += c1.astype(np.float64) * w
                    wsum[pos:end] += w
                    windows += 1
                    if end >= n:
                        break
                    pos += hop
                valid = wsum > 1e-8
                out0[valid] /= wsum[valid]
                out1[valid] /= wsum[valid]
                scaled = [
                    np.clip(out0, -1.0, 1.0).astype(np.float32),
                    np.clip(out1, -1.0, 1.0).astype(np.float32),
                ]

        ss_ms = round((time.perf_counter() - t0) * 1000.0, 2)
        self.request_count += 1
        self.last_infer_ms = ss_ms
        return scaled, {
            "ssMs": ss_ms,
            "windows": windows,
            "swaps": swaps,
            "provider": self.active_provider,
            "device": "gpu" if self.using_gpu else "cpu",
        }


def separate_and_enhance_tracks(
    samples: np.ndarray,
    se_engine: MossFormer2GpuEngine,
    ss_engine: MossFormer2SeparatorEngine | None,
    input_sr: int = 16000,
    output_sr: int = 16000,
    apply_denoise: bool = True,
    prune_tracks: bool = True,
) -> tuple[list[np.ndarray], dict[str, Any]]:
    """
    ClearVoice 多轨盲源分离 + 分轨独立降噪去背景音管线（绝不混回单轨）：
    1. MossFormer2_SS_16K 盲源分离 -> 得到多条原始分离音轨；
    2. 对每条音轨独立运行 MossFormer2_SE_48K 降噪与剔除背景音；
    3. 可选剔除静音残影或高相关镜像串音轨（单人说话返回 1 轨，多人或人声+歌声返回多轨）。
    """
    t_start = time.perf_counter()
    orig_len = int(samples.size)
    if orig_len == 0:
        return [], {
            "ssMs": 0.0,
            "seMs": 0.0,
            "totalMs": 0.0,
            "ssUsed": False,
            "model": "MossFormer2_SE_48K",
            "provider": se_engine.active_provider,
            "device": "gpu" if se_engine.using_gpu else "cpu",
            "gpuName": se_engine.gpu_info.get("gpuName"),
            "trackMeta": [],
            "pairWcorr": 0.0,
            "pairEcorr": 0.0,
            "swaps": 0,
        }

    expected_out_len = (
        orig_len if input_sr == output_sr else max(1, int(round(orig_len * (output_sr / float(input_sr)))))
    )

    if ss_engine is None:
        clean, se_meta = se_engine.enhance(samples, input_sr=input_sr, output_sr=output_sr)
        tr_rms = _rms(clean)
        return [clean], {
            "ssMs": 0.0,
            "seMs": float(se_meta.get("inferMs", 0.0)),
            "totalMs": round((time.perf_counter() - t_start) * 1000.0, 2),
            "ssUsed": False,
            "model": "MossFormer2_SE_48K",
            "provider": se_engine.active_provider,
            "device": "gpu" if se_engine.using_gpu else "cpu",
            "gpuName": se_engine.gpu_info.get("gpuName"),
            "trackMeta": [{"index": 0, "rms": round(tr_rms, 5), "energyRatio": 1.0, "seApplied": True}],
            "pairWcorr": 0.0,
            "pairEcorr": 0.0,
            "swaps": 0,
        }

    # Stage 1: ClearVoice MossFormer2_SS_16K 盲源分离（得到独立音轨，绝不混叠）
    raw_tracks_16k, ss_meta = ss_engine.separate(samples, sample_rate=input_sr)
    raw_rms_list = [_rms(t) for t in raw_tracks_16k]
    max_raw_rms = max(raw_rms_list) if raw_rms_list else 0.0

    # Stage 2: 对每条音轨独立执行 ClearVoice MossFormer2_SE_48K 降噪与剔除背景音
    se_ms_total = 0.0
    processed_tracks: list[np.ndarray] = []
    se_applied_flags: list[bool] = []
    for idx, tr_16k in enumerate(raw_tracks_16k):
        tr_rms = raw_rms_list[idx]
        skip_se = (not apply_denoise) or (tr_rms < 0.0015) or (max_raw_rms > 0.01 and tr_rms < max_raw_rms * 0.04)
        if skip_se:
            out_tr = _resample_audio(tr_16k, SS_MODEL_SR, output_sr)
            se_applied_flags.append(False)
        else:
            out_tr, se_meta = se_engine.enhance(tr_16k, input_sr=SS_MODEL_SR, output_sr=output_sr)
            se_ms_total += float(se_meta.get("inferMs", 0.0))
            se_applied_flags.append(True)

        if out_tr.size > expected_out_len:
            out_tr = out_tr[:expected_out_len]
        elif out_tr.size < expected_out_len:
            out_tr = np.pad(out_tr, (0, expected_out_len - out_tr.size), mode="constant")
        processed_tracks.append(np.ascontiguousarray(out_tr, dtype=np.float32))

    pair_wcorr = 0.0
    pair_ecorr = 0.0
    if len(processed_tracks) >= 2:
        pair_wcorr = abs(_norm_corr(processed_tracks[0], processed_tracks[1]))
        pair_ecorr = _envelope_corr(processed_tracks[0], processed_tracks[1])

    rms_list = [_rms(t) for t in processed_tracks]
    keep_indices = list(range(len(processed_tracks)))

    if prune_tracks and len(processed_tracks) >= 2:
        max_rms = max(rms_list) if rms_list else 0.0
        strongest_idx = int(np.argmax(rms_list))
        filtered: list[int] = []
        for idx in keep_indices:
            r = rms_list[idx]
            if idx == strongest_idx:
                filtered.append(idx)
                continue
            # 静音/极低残余音轨剔除
            if r < 0.0045 or (max_rms > 1e-6 and r < max_rms * 0.12):
                continue
            # 单说话人镜像串音轨剔除（波形+包络高相关，或相位无关的对数幅度谱高度重合）
            w_c = abs(_norm_corr(processed_tracks[strongest_idx], processed_tracks[idx]))
            e_c = _envelope_corr(processed_tracks[strongest_idx], processed_tracks[idx])
            m_c = _spectral_mag_corr(processed_tracks[strongest_idx], processed_tracks[idx])
            ratio = (r / max_rms) if max_rms > 1e-6 else 0.0
            if (w_c >= 0.58 and e_c >= 0.75) or (m_c >= 0.62 and (w_c >= 0.22 or e_c >= 0.55 or ratio <= 0.55)):
                continue
            filtered.append(idx)
        keep_indices = filtered if filtered else [strongest_idx]

    final_tracks = [processed_tracks[i] for i in keep_indices]
    final_rms = [rms_list[i] for i in keep_indices]
    energy_sum = sum(r * r for r in final_rms)
    track_meta = []
    for out_idx, orig_idx in enumerate(keep_indices):
        r = rms_list[orig_idx]
        ratio = (r * r / energy_sum) if energy_sum > 1e-12 else (1.0 / max(1, len(keep_indices)))
        track_meta.append(
            {
                "index": out_idx,
                "sourceSlot": orig_idx,
                "rms": round(r, 5),
                "energyRatio": round(ratio, 4),
                "seApplied": se_applied_flags[orig_idx],
            }
        )

    total_ms = round((time.perf_counter() - t_start) * 1000.0, 2)
    return final_tracks, {
        "ssMs": round(float(ss_meta.get("ssMs", 0.0)), 2),
        "seMs": round(se_ms_total, 2),
        "totalMs": total_ms,
        "ssUsed": True,
        "model": "MossFormer2_SS_16K+MossFormer2_SE_48K",
        "provider": ss_engine.active_provider,
        "device": "gpu" if (ss_engine.using_gpu or se_engine.using_gpu) else "cpu",
        "gpuName": se_engine.gpu_info.get("gpuName"),
        "trackMeta": track_meta,
        "pairWcorr": round(pair_wcorr, 4),
        "pairEcorr": round(pair_ecorr, 4),
        "swaps": int(ss_meta.get("swaps", 0)),
    }


def make_handler(engine: MossFormer2GpuEngine, ss_engine: MossFormer2SeparatorEngine | None = None):
    class ClearVoiceRequestHandler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, format: str, *args: Any) -> None:
            # 保持 stdout/stderr 干净，仅在启动和异常时输出
            return

        def _send_json(self, payload: dict[str, Any], status: int = 200) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _status_payload(self) -> dict[str, Any]:
            base = engine.status_dict()
            base["ssReady"] = ss_engine is not None
            base["ssModel"] = "MossFormer2_SS_16K" if ss_engine is not None else None
            base["ssModelPath"] = ss_engine.model_path if ss_engine is not None else None
            base["ssProvider"] = ss_engine.active_provider if ss_engine is not None else None
            base["ssDevice"] = ("gpu" if ss_engine.using_gpu else "cpu") if ss_engine is not None else None
            base["ssLoadMs"] = ss_engine.load_ms if ss_engine is not None else None
            base["ssLastInferMs"] = ss_engine.last_infer_ms if ss_engine is not None else None
            base["capabilities"] = ["denoise", "separate"] if ss_engine is not None else ["denoise"]
            return base

        def _read_audio_body(self) -> tuple[np.ndarray, int, int] | None:
            content_len = int(self.headers.get("Content-Length", "0"))
            if content_len <= 0 or content_len > 64 * 1024 * 1024:
                self._send_json({"ok": False, "error": "invalid payload length"}, 400)
                return None
            raw = self.rfile.read(content_len)
            in_sr = max(8000, min(96000, int(self.headers.get("X-Sample-Rate", "16000"))))
            out_sr = max(8000, min(96000, int(self.headers.get("X-Output-Sample-Rate", str(in_sr)))))
            fmt = (self.headers.get("X-Audio-Format", "f32le") or "f32le").strip().lower()
            if fmt == "s16le":
                samples = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
            else:
                usable = (len(raw) // 4) * 4
                samples = np.frombuffer(raw[:usable], dtype="<f4").copy()
            return samples, in_sr, out_sr

        def do_GET(self) -> None:
            if self.path in ("/health", "/status", "/"):
                self._send_json(self._status_payload(), 200)
                return
            self._send_json({"ok": False, "error": "not found"}, 404)

        def do_POST(self) -> None:
            if self.path not in ("/denoise", "/separate"):
                self._send_json({"ok": False, "error": "not found"}, 404)
                return
            try:
                parsed = self._read_audio_body()
                if parsed is None:
                    return
                samples, in_sr, out_sr = parsed

                if self.path == "/denoise":
                    clean, meta = engine.enhance(samples, input_sr=in_sr, output_sr=out_sr)
                    out_bytes = clean.astype("<f4", copy=False).tobytes()

                    self.send_response(200)
                    self.send_header("Content-Type", "application/octet-stream")
                    self.send_header("Content-Length", str(len(out_bytes)))
                    self.send_header("X-Sample-Rate", str(out_sr))
                    self.send_header("X-ClearVoice-Model", "MossFormer2_SE_48K")
                    self.send_header("X-ClearVoice-Provider", str(meta["provider"]))
                    self.send_header("X-ClearVoice-Device", str(meta["device"]))
                    self.send_header("X-ClearVoice-Infer-Ms", str(meta["inferMs"]))
                    self.send_header("X-ClearVoice-Total-Ms", str(meta["totalMs"]))
                    if meta.get("gpuName"):
                        self.send_header("X-ClearVoice-Gpu-Name", str(meta["gpuName"]))
                    self.end_headers()
                    self.wfile.write(out_bytes)
                    return

                # POST /separate : 多轨盲源分离 + 分轨独立降噪去背景音（绝不混叠为单轨）
                prune_hdr = (self.headers.get("X-Prune-Tracks", "1") or "1").strip().lower()
                prune_tracks = prune_hdr not in ("0", "false", "no")
                denoise_hdr = (self.headers.get("X-Apply-Denoise", "1") or "1").strip().lower()
                apply_denoise = denoise_hdr not in ("0", "false", "no")

                tracks, meta = separate_and_enhance_tracks(
                    samples,
                    se_engine=engine,
                    ss_engine=ss_engine,
                    input_sr=in_sr,
                    output_sr=out_sr,
                    apply_denoise=apply_denoise,
                    prune_tracks=prune_tracks,
                )
                track_count = len(tracks)
                samples_per_track = int(tracks[0].size) if track_count > 0 else 0
                if track_count > 0 and samples_per_track > 0:
                    packed = np.concatenate([t.astype("<f4", copy=False) for t in tracks])
                    out_bytes = packed.tobytes()
                else:
                    out_bytes = b""

                self.send_response(200)
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Content-Length", str(len(out_bytes)))
                self.send_header("X-Sample-Rate", str(out_sr))
                self.send_header("X-ClearVoice-Track-Count", str(track_count))
                self.send_header("X-ClearVoice-Samples-Per-Track", str(samples_per_track))
                self.send_header("X-ClearVoice-SS-Available", "1" if meta.get("ssUsed") else "0")
                self.send_header("X-ClearVoice-Model", str(meta["model"]))
                self.send_header("X-ClearVoice-Provider", str(meta["provider"]))
                self.send_header("X-ClearVoice-Device", str(meta["device"]))
                self.send_header("X-ClearVoice-SS-Ms", str(meta["ssMs"]))
                self.send_header("X-ClearVoice-SE-Ms", str(meta["seMs"]))
                self.send_header("X-ClearVoice-Infer-Ms", str(round(float(meta["ssMs"]) + float(meta["seMs"]), 2)))
                self.send_header("X-ClearVoice-Total-Ms", str(meta["totalMs"]))
                self.send_header("X-ClearVoice-Swaps", str(meta.get("swaps", 0)))
                self.send_header("X-ClearVoice-Track-Meta", json.dumps(meta.get("trackMeta", []), ensure_ascii=True))
                self.send_header(
                    "X-ClearVoice-Pair-Corr",
                    json.dumps(
                        {"wcorr": meta.get("pairWcorr", 0.0), "ecorr": meta.get("pairEcorr", 0.0)},
                        ensure_ascii=True,
                    ),
                )
                if meta.get("gpuName"):
                    self.send_header("X-ClearVoice-Gpu-Name", str(meta["gpuName"]))
                self.end_headers()
                self.wfile.write(out_bytes)
            except Exception as exc:
                self._send_json({"ok": False, "error": str(exc)}, 500)

    return ClearVoiceRequestHandler


def main() -> None:
    parser = argparse.ArgumentParser(description="MijiaDeck ClearVoice MossFormer2 GPU Server (SE + BSS)")
    parser.add_argument("--model", required=True, help="Path to MossFormer2_SE_48K ONNX model")
    parser.add_argument("--ss-model", default="", help="Optional path to MossFormer2_SS_16K ONNX model")
    parser.add_argument("--ss-max-window-sec", type=float, default=4.0, help="Max single-pass BSS window seconds")
    parser.add_argument("--host", default="127.0.0.1", help="Bind host")
    parser.add_argument("--port", type=int, required=True, help="Bind port")
    parser.add_argument("--device", default="gpu", choices=["gpu", "cpu", "auto"], help="Device preference")
    parser.add_argument("--device-id", type=int, default=0, help="CUDA device ID")
    parser.add_argument("--no-warmup", action="store_true", help="Skip startup CUDA warmup")
    args = parser.parse_args()

    engine = MossFormer2GpuEngine(args.model, device_pref=args.device, device_id=args.device_id)
    ss_engine: MossFormer2SeparatorEngine | None = None
    ss_model_arg = (args.ss_model or "").strip()
    if ss_model_arg and Path(ss_model_arg).is_file():
        try:
            ss_engine = MossFormer2SeparatorEngine(
                ss_model_arg,
                device_pref=args.device,
                device_id=args.device_id,
                max_window_sec=args.ss_max_window_sec,
            )
        except Exception as exc:
            print(f"[clearvoice-gpu] warn: failed to load SS model ({exc}), continuing with SE only", file=sys.stderr, flush=True)
            ss_engine = None

    if not args.no_warmup:
        warm_ms = engine.warmup()
        ss_warm_ms = ss_engine.warmup() if ss_engine is not None else 0.0
        print(
            f"[clearvoice-gpu] ready se={engine.active_provider}({engine.load_ms}ms) ss={ss_engine.active_provider if ss_engine else 'none'}({ss_engine.load_ms if ss_engine else 0}ms) warmup={warm_ms}+{ss_warm_ms}ms gpu={engine.gpu_info.get('gpuName')}",
            file=sys.stderr,
            flush=True,
        )
    else:
        print(
            f"[clearvoice-gpu] ready se={engine.active_provider}({engine.load_ms}ms) ss={ss_engine.active_provider if ss_engine else 'none'} (no-warmup)",
            file=sys.stderr,
            flush=True,
        )

    server = ThreadingHTTPServer((args.host, args.port), make_handler(engine, ss_engine))
    server.daemon_threads = True
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
