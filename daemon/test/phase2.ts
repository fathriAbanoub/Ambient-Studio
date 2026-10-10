/**
 * test/phase2.ts — asset ingest/normalize pipeline checks against real clips:
 *   1. high-bitrate 1080p h264 → re-encoded DOWN to target bitrate, smaller file
 *   2. VP9/WebM → transcoded to h264-in-mp4
 *   3. 4:3 aspect mismatch → scale+crop
 *   4. already-compliant small h264/mp4 (bench loop.mp4) → cached as-is (no re-encode)
 *   5. content-hash dedup: re-ingesting returns the same asset_id
 *   6. registry list + evict
 * Run with AMBIENTD_DATA pointed at a scratch dir.
 */
import fs from "node:fs";
import path from "node:path";
import { ingestVideo, listAssets, evictAsset, getAsset } from "../src/assets";
import { ffprobeJson, videoStream } from "../src/ffmpeg";

const MEDIA = path.resolve(__dirname, "..", "test", "media");
let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name} — ${detail}`);
  if (!ok) failures++;
};

async function main() {
  // 1. high-bitrate 1080p
  const srcA = path.join(MEDIA, "hi_bitrate_1080.mp4");
  const srcABytes = fs.statSync(srcA).size;
  const a = await ingestVideo({ file: srcA, label: "hi bitrate" });
  const aProbe = await ffprobeJson(a.file);
  const aVs = videoStream(aProbe)!;
  const srcABitrate = Number((await ffprobeJson(srcA)).format.bit_rate ?? 0);
  check("A reencoded", a.reencoded === true, `reencoded=${a.reencoded}`);
  check("A codec h264", aVs.codec_name === "h264", aVs.codec_name!);
  check("A bitrate near target", Math.abs(a.bitrate - 2_500_000) < 2_500_000 * 0.2, `${(a.bitrate / 1e6).toFixed(2)} Mbps vs 2.5 target`);
  check("A resolution kept 1080p", a.height === 1080, `${a.width}x${a.height}`);
  check("A normalized smaller than source", a.bytes < srcABytes * 0.6, `${(a.bytes / 1e6).toFixed(1)} MB vs source ${(srcABytes / 1e6).toFixed(1)} MB (${((a.bytes / srcABytes) * 100).toFixed(0)}%)`);
  check("A audio stripped", !aProbe.streams.some((s) => s.codec_type === "audio"), "no audio stream in cached asset");
  check("A id = content hash", a.asset_id === `sha256:${path.basename(a.file, ".mp4")}`, a.asset_id.slice(0, 24) + "...");

  // 2. VP9 → h264
  const b = await ingestVideo({ file: path.join(MEDIA, "vp9_720.webm"), label: "vp9" });
  const bVs = videoStream(await ffprobeJson(b.file))!;
  check("B transcoded from vp9", b.reencoded === true && bVs.codec_name === "h264", `reencoded=${b.reencoded} codec=${bVs.codec_name}`);
  check("B bitrate within target band", b.bitrate <= 2_500_000 * 1.2, `${(b.bitrate / 1e6).toFixed(2)} Mbps`);

  // 3. aspect mismatch → scale+crop to 16:9
  const d = await ingestVideo({ file: path.join(MEDIA, "ar43_800x600.mp4"), label: "4:3" });
  const dVs = videoStream(await ffprobeJson(d.file))!;
  const ar = dVs.width! / dVs.height!;
  check("D cropped to 16:9", Math.abs(ar - 16 / 9) < 0.02, `${dVs.width}x${dVs.height} (AR ${ar.toFixed(3)})`);
  check("D reencoded", d.reencoded === true, "reencoded");

  // 4. already-compliant clip → cached as-is
  const c = await ingestVideo({ file: path.resolve(__dirname, "..", "test", "media", "loop.mp4"), label: "bench loop" });
  check("C not reencoded", c.reencoded === false, `reencoded=${c.reencoded} (${(c.bitrate / 1e3).toFixed(0)} kbps ${c.width}x${c.height})`);
  check("C bytes == source bytes", c.bytes === fs.statSync(path.join(MEDIA, "loop.mp4")).size, `${c.bytes} bytes`);

  // 5. dedup
  const c2 = await ingestVideo({ file: path.join(MEDIA, "loop.mp4"), label: "bench loop again" });
  check("C dedup by content hash", c2.asset_id === c.asset_id, c.asset_id.slice(0, 24) + "...");

  // 6. list + get + evict
  const list = listAssets();
  check("registry lists 4 assets", list.length === 4, `${list.length} assets`);
  check("getAsset roundtrip", getAsset(d.asset_id)?.asset_id === d.asset_id, d.asset_id.slice(0, 24) + "...");
  const evicted = evictAsset(b.asset_id);
  check("evict removes file+entry", evicted && !fs.existsSync(b.file) && !getAsset(b.asset_id), b.asset_id.slice(0, 24) + "...");
  check("list now 3", listAssets().length === 3, `${listAssets().length}`);

  console.log(failures === 0 ? "PHASE2 ALL PASS" : `${failures} PHASE2 FAILURES`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(String(e?.stack ?? e));
  process.exit(1);
});
