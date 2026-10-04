/**
 * bench/lib/stats.mjs — distribution statistics. No fabricated thresholds.
 */

export function median(sorted) {
  const n = sorted.length;
  if (n === 0) return null;
  const mid = n >> 1;
  return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Linear-interpolated percentile of an unsorted numeric array. */
export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (p <= 0) return sorted[0];
  if (p >= 1) return sorted[sorted.length - 1];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export function summarize(values) {
  if (!values || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: values.length,
    median: median(sorted),
    p95: percentile(values, 0.95),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

/** Ordinary least-squares slope/intercept for y ~ x. */
export function linearFit(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  if (den === 0) return null;
  return { slope: num / den, intercept: my - (num / den) * mx };
}
