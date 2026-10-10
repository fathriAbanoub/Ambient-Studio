# L2 — what category C got wrong, and how G/I supersede it

Written for the record; nothing in C is re-run or patched in place.

1. **C's memory claim shipped half-true.** C stopped materializing the *chunked* output (streaming per-chunk compare + streaming hash), but the *single-pass reference buffer* used for comparison was fully materialized. Peak memory therefore still scaled with duration — ~450 MB at 6 min, ~2.9 GB at 1 h (measured on the user's hardware, bench/results/ on their machine). G replaces the comparison with streaming hashes and bounded windows; its G1 sweep shows RSS flat across a 96× duration span, and I1's only materializing step is the bounded Web Audio reference (disclosed per run).

2. **C's divergence finding is real and now explained.** Chunked output diverged from continuous output (max|Δ| 2.8e-1, not seam-localized). I1b re-creates both mechanisms inside the in-process design — exponential-automation re-anchoring and block-relative biquad coefficient quanta — and measures divergence return; I1a shows the healthy design has neither mechanism (hash-identical across partitions including single-block).

3. **C's priming overhead (70.6% at 60 s chunks) is the cost of approximating state hand-off the API cannot express.** The in-process design does not approximate: delay rings, filter states and automation state simply carry (G/I walls show no per-chunk overhead because there are no chunks).
