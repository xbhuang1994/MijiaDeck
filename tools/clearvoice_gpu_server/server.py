# SPDX-License-Identifier: GPL-3.0-or-later
# MijiaDeck: ClearVoice (MossFormer2_SE_48K) GPU Inference Service
# Copyright (C) 2026 MiHome-Windows contributors

"""
本地 ClearVoice (MossFormer2_SE_48K) GPU 推理服务：

- 优先在 NVIDIA CUDA GPU（CUDAExecutionProvider）上加载并运行阿里巴巴 ClearerVoice-Studio
  MossFormer2_SE_48K ONNX 模型（动态序列长度，支持任意准实时切片长度）；
- 完整复现官方 Kaldi 60-Mel Fbank + Delta + Delta-Delta (180 维特征) + 48kHz Hamming STFT/ISTFT
  前后端管线，支持 16kHz <-> 48kHz 高精度多相重采样（3:1 整数倍无混叠）；
- 提供低延迟本地回环 HTTP 接口（/health、/status、/denoise），供 MijiaDeck 准实时切片管线调用。
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


def make_handler(engine: MossFormer2GpuEngine):
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

        def do_GET(self) -> None:
            if self.path in ("/health", "/status", "/"):
                self._send_json(engine.status_dict(), 200)
                return
            self._send_json({"ok": False, "error": "not found"}, 404)

        def do_POST(self) -> None:
            if self.path != "/denoise":
                self._send_json({"ok": False, "error": "not found"}, 404)
                return
            try:
                content_len = int(self.headers.get("Content-Length", "0"))
                if content_len <= 0 or content_len > 64 * 1024 * 1024:
                    self._send_json({"ok": False, "error": "invalid payload length"}, 400)
                    return
                raw = self.rfile.read(content_len)
                in_sr = max(8000, min(96000, int(self.headers.get("X-Sample-Rate", "16000"))))
                out_sr = max(8000, min(96000, int(self.headers.get("X-Output-Sample-Rate", str(in_sr)))))
                fmt = (self.headers.get("X-Audio-Format", "f32le") or "f32le").strip().lower()

                if fmt == "s16le":
                    samples = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
                else:
                    usable = (len(raw) // 4) * 4
                    samples = np.frombuffer(raw[:usable], dtype="<f4").copy()

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
            except Exception as exc:
                self._send_json({"ok": False, "error": str(exc)}, 500)

    return ClearVoiceRequestHandler


def main() -> None:
    parser = argparse.ArgumentParser(description="MijiaDeck ClearVoice MossFormer2 GPU Server")
    parser.add_argument("--model", required=True, help="Path to MossFormer2_SE_48K ONNX model")
    parser.add_argument("--host", default="127.0.0.1", help="Bind host")
    parser.add_argument("--port", type=int, required=True, help="Bind port")
    parser.add_argument("--device", default="gpu", choices=["gpu", "cpu", "auto"], help="Device preference")
    parser.add_argument("--device-id", type=int, default=0, help="CUDA device ID")
    parser.add_argument("--no-warmup", action="store_true", help="Skip startup CUDA warmup")
    args = parser.parse_args()

    engine = MossFormer2GpuEngine(args.model, device_pref=args.device, device_id=args.device_id)
    if not args.no_warmup:
        warm_ms = engine.warmup()
        print(
            f"[clearvoice-gpu] ready provider={engine.active_provider} load={engine.load_ms}ms warmup={warm_ms}ms gpu={engine.gpu_info.get('gpuName')}",
            file=sys.stderr,
            flush=True,
        )
    else:
        print(
            f"[clearvoice-gpu] ready provider={engine.active_provider} load={engine.load_ms}ms (no-warmup)",
            file=sys.stderr,
            flush=True,
        )

    server = ThreadingHTTPServer((args.host, args.port), make_handler(engine))
    server.daemon_threads = True
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
