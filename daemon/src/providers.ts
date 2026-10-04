/**
 * providers.ts — stock-video search behind one internal interface.
 * Pexels Videos API + Pixabay Videos API. Keys from env:
 *   PEXELS_API_KEY / PIXABAY_API_KEY
 * 429/5xx → exponential backoff (2 retries). No key → clear error, not a crash.
 */
export interface StockCandidate {
  ref: string; // opaque: "provider:id:fileIdx" — resolved against the last search cache
  provider: "pexels" | "pixabay";
  id: string;
  title: string;
  download_url: string;
  thumbnail: string;
  duration_sec: number;
  width: number;
  height: number;
  license: string;
  author: string;
}

export interface Provider {
  search(query: string, count: number): Promise<StockCandidate[]>;
}

async function fetchWithBackoff(url: string, init: RequestInit, tries = 3): Promise<Response> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < tries; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
    try {
      const res = await fetch(url, init);
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status} from ${new URL(url).host}`);
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e as Error;
    }
  }
  throw lastErr ?? new Error("fetch failed");
}

// ── Pexels ───────────────────────────────────────────────────────────────────
interface PexelsVideoFile { link: string; width: number | null; height: number | null; quality: string; file_type: string }
interface PexelsVideo { id: number; duration: number; width: number | null; height: number | null; image: string; user: { name: string }; video_files: PexelsVideoFile[] }

export const pexels: Provider = {
  async search(query, count) {
    const key = process.env.PEXELS_API_KEY;
    if (!key) throw new Error("PEXELS_API_KEY not set — get one at https://www.pexels.com/api/");
    // base override is a test seam (local stub servers); default is the real API
    const base = process.env.PEXELS_API_BASE ?? "https://api.pexels.com";
    const url = `${base}/videos/search?query=${encodeURIComponent(query)}&per_page=${count}&orientation=landscape`;
    const res = await fetchWithBackoff(url, { headers: { Authorization: key } });
    if (!res.ok) throw new Error(`Pexels search failed: HTTP ${res.status}`);
    const body = (await res.json()) as { videos?: PexelsVideo[] };
    return (body.videos ?? []).map((v): StockCandidate => {
      // pick the largest file ≤1080p, else the smallest file — keeps ingest cheap
      const mp4s = v.video_files.filter((f) => f.file_type === "video/mp4" && f.width && f.height);
      const sorted = mp4s.sort((a, b) => (b.width! * b.height!) - (a.width! * a.height!));
      const pick = sorted.find((f) => f.height! <= 1080) ?? sorted[sorted.length - 1] ?? { link: v.video_files[0]?.link ?? "", width: v.width, height: v.height };
      const idx = v.video_files.indexOf(pick as PexelsVideoFile);
      return {
        ref: `pexels:${v.id}:${idx}`,
        provider: "pexels",
        id: String(v.id),
        title: `Pexels #${v.id}`,
        download_url: pick.link,
        thumbnail: v.image,
        duration_sec: v.duration,
        width: pick.width ?? v.width ?? 0,
        height: pick.height ?? v.height ?? 0,
        license: "Pexels License (free to use)",
        author: v.user?.name ?? "unknown",
      };
    });
  },
};

// ── Pixabay ──────────────────────────────────────────────────────────────────
interface PixabayHit {
  id: number; duration: number; largeImage: string; user: string;
  videos: Record<string, { url: string; width: number; height: number }>;
}
export const pixabay: Provider = {
  async search(query, count) {
    const key = process.env.PIXABAY_API_KEY;
    if (!key) throw new Error("PIXABAY_API_KEY not set — get one at https://pixabay.com/api/docs/");
    const base = process.env.PIXABAY_API_BASE ?? "https://pixabay.com";
    const url = `${base}/api/videos/?key=${encodeURIComponent(key)}&q=${encodeURIComponent(query)}&per_page=${count}&safesearch=true`;
    const res = await fetchWithBackoff(url, {});
    if (!res.ok) throw new Error(`Pixabay search failed: HTTP ${res.status}`);
    const body = (await res.json()) as { hits?: PixabayHit[] };
    return (body.hits ?? []).map((h): StockCandidate => {
      const sizes = Object.entries(h.videos ?? {});
      // pick largest ≤1080p, else smallest
      const sorted = sizes.sort((a, b) => (b[1].width * b[1].height) - (a[1].width * a[1].height));
      const pick = sorted.find(([, f]) => f.height <= 1080) ?? sorted[sorted.length - 1];
      const idx = sizes.findIndex(([k]) => k === pick?.[0]);
      return {
        ref: `pixabay:${h.id}:${idx}`,
        provider: "pixabay",
        id: String(h.id),
        title: `Pixabay #${h.id}`,
        download_url: pick?.[1].url ?? "",
        thumbnail: h.largeImage,
        duration_sec: h.duration,
        width: pick?.[1].width ?? 0,
        height: pick?.[1].height ?? 0,
        license: "Pixabay Content License (free to use)",
        author: h.user ?? "unknown",
      };
    });
  },
};

export const providers: Record<string, Provider> = { pexels, pixabay };

export async function searchAll(query: string, count: number, provider?: string): Promise<StockCandidate[]> {
  if (provider && provider !== "all") {
    const p = providers[provider];
    if (!p) throw new Error(`unknown provider '${provider}' (use pexels | pixabay | all)`);
    return p.search(query, count);
  }
  const results = await Promise.allSettled([pexels.search(query, count), pixabay.search(query, count)]);
  const ok = results.filter((r) => r.status === "fulfilled") as unknown as PromiseFulfilledResult<StockCandidate[]>[];
  if (ok.length === 0) {
    const errs = results.map((r) => (r as PromiseRejectedResult).reason?.message ?? String(r)).join("; ");
    throw new Error(`all providers failed: ${errs}`);
  }
  return ok.flatMap((r) => r.value);
}
