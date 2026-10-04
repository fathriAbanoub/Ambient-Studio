#!/usr/bin/env python3
"""round-2 analysis: compare WAV renders objectively.

Usage: python3 analyze.py <a.wav> <b.wav> [<c.wav> ...] --labels A B C
For each file: peak/clipping stats, RMS, spectral centroid, 95% rolloff,
per-band energy. Pairwise vs the FIRST file: max/mean sample deviation,
correlation, and a 1-second-window RMS-difference profile to localize
where the signals part ways.
"""
import sys
import wave
import numpy as np

SR = 44100
FFTN = 16384
BANDS = [(0, 200), (200, 800), (800, 2500), (2500, 4000), (4000, 8000), (8000, 22050)]


def load(path):
    with wave.open(path, "rb") as w:
        assert w.getnchannels() == 2 and w.getsampwidth() == 2 and w.getframerate() == SR, path
        n = w.getnframes()
        raw = w.readframes(n)
    s = np.frombuffer(raw, dtype="<i2").astype(np.float64) / 32768.0
    return s[0::2], s[1::2]


def stats(path, label):
    L, R = load(path)
    mono = (L + R) / 2.0
    peak = float(np.max(np.abs(np.concatenate([L, R]))))
    near_full = int(np.sum(np.abs(np.concatenate([L, R])) >= 0.999))
    clipped = int(np.sum((np.abs(np.concatenate([L, R])) >= 32766.5 / 32768.0)))
    rms = float(np.sqrt(np.mean(mono**2)))

    # average magnitude spectrum over 50% hop windows of the mono signal
    hops = (len(mono) - FFTN) // (FFTN // 2)
    win = np.hanning(FFTN)
    acc = np.zeros(FFTN // 2 + 1)
    for h in range(0, hops, 4):  # stride 4 windows: resolution vs time
        seg = mono[h * FFTN // 2 : h * FFTN // 2 + FFTN] * win
        acc += np.abs(np.fft.rfft(seg))
    spec = acc / max(1, len(range(0, hops, 4)))
    freqs = np.fft.rfftfreq(FFTN, 1.0 / SR)
    centroid = float(np.sum(freqs * spec) / np.sum(spec))
    cum = np.cumsum(spec)
    rolloff95 = float(freqs[int(np.searchsorted(cum, 0.95 * cum[-1]))])
    total = float(np.sum(spec))
    band_e = {f"{lo}-{hi}Hz": float(np.sum(spec[(freqs >= lo) & (freqs < hi)]) / total) for lo, hi in BANDS}

    print(f"[{label}] {path}")
    print(f"  frames={len(mono)} peak={peak:.4f} samples@>=0.999={near_full} rms={rms:.5f}")
    print(f"  spectral_centroid={centroid:.1f}Hz rolloff95={rolloff95:.0f}Hz")
    print(f"  band_energy: " + "  ".join(f"{k}={v*100:.2f}%" for k, v in band_e.items()))
    return {"L": L, "R": R, "mono": mono, "peak": peak, "rms": rms,
            "centroid": centroid, "rolloff95": rolloff95, "near_full": near_full}


def compare(base, other, label_base, label_other):
    n = min(len(base["mono"]), len(other["mono"]))
    d = base["mono"][:n] - other["mono"][:n]
    denom = np.sqrt(np.sum(base["mono"][:n] ** 2) * np.sum(other["mono"][:n] ** 2))
    corr = float(np.sum(base["mono"][:n] * other["mono"][:n]) / denom) if denom > 0 else 0.0
    print(f"\n  {label_base} vs {label_other}: max|delta|={np.max(np.abs(d)):.5f} "
          f"mean|delta|={np.mean(np.abs(d)):.6f} rms(delta)={np.sqrt(np.mean(d**2)):.5f} corr={corr:.6f}")
    # 1s windows — where do they part ways?
    win = SR
    nw = n // win
    prof = [float(np.sqrt(np.mean(d[i * win : (i + 1) * win] ** 2))) for i in range(nw)]
    print("  per-second rms(delta): " + " ".join(f"{v:.4f}" for v in prof))


if __name__ == "__main__":
    args = sys.argv[1:]
    labels_i = args.index("--labels") if "--labels" in args else -1
    labels = args[labels_i + 1 :] if labels_i >= 0 else [chr(65 + i) for i in range(len(args))]
    files = args[: labels_i] if labels_i >= 0 else args
    results = {lab: stats(f, lab) for f, lab in zip(files, labels)}
    base_lab = labels[0]
    for lab in labels[1:]:
        compare(results[base_lab], results[lab], base_lab, lab)
