"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useStudioStore } from "@/store/studioStore";
import {
  renderAudioJob,
  downloadJobOutput,
  renderVideoFull,
  downloadBlob,
  triggerVideoDownload,
  analyzeLoop,
  getJobProgress,
  getJobStatus,
  cancelJob,
  getJobHistory,
  formatFileSize,
  formatTimeRemaining,
} from "@/lib/api";
import {
  Download,
  Film,
  ImageIcon,
  Loader2,
  X,
  AlertCircle,
  Clock,
  HardDrive,
  RefreshCw,
} from "lucide-react";
import { JobHistoryItem } from "@/types";
import { VideoPreview } from "./VideoPreview";

// ... (Toast and RecentRendersPanel omitted for brevity)

export function ExportPanel({ engine }: { engine: any }) {
  const {
    tracks,
    masterGain,
    eqGains,
    exportDuration,
    exportName,
    setExportDuration,
    setExportName,
    setIsExporting,
    setExportProgress,
    setExportLabel,
    addLog,
    isExporting,
    exportProgress,
    exportLabel,
    currentJobId,
    setCurrentJobId,
    updateJobProgress,
    resetJobState,
    jobStatus,
    queuePosition,
    elapsedSeconds,
    remainingSeconds,
    jobError,
    showToast,
    setJobHistory,
    showVisualizer,
    setShowVisualizer,
    useGpuEncoding,
    setUseGpuEncoding,
    loopAnalysis,
    setLoopAnalysis,
    isAnalyzingLoop,
    setIsAnalyzingLoop,
    loopAnalysisError,
    setLoopAnalysisError,
    setIsPlaying,
  } = useStudioStore();

  const [backgroundImage, setBackgroundImage] = useState<File | null>(null);
  const pollIntervalRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const exportKindRef = useRef<"audio" | "video">("video");

  const loadedTracks = tracks.filter((t) => t.loaded);

  // Validation state
  const noTracksLoaded = loadedTracks.length === 0;
  const invalidDuration = exportDuration <= 0;
  const noBackgroundImage = !backgroundImage;

  const activeTracksForAnalysis = tracks.filter((t) => !t.muted && t.file);

  const handleAnalyzeLoop = async () => {
    if (activeTracksForAnalysis.length === 0) return;

    setIsAnalyzingLoop(true);
    setLoopAnalysisError(null);
    setLoopAnalysis(null);

    try {
      // NOTE: Temporary simplification — first active track file only.
      // Future task: client-side mixdown blob to match backend mix.wav.
      const fileToAnalyze = activeTracksForAnalysis[0].file!;

      const result = await analyzeLoop(fileToAnalyze);

      setLoopAnalysis({
        loopStartMs: result.loop_start_ms,
        loopEndMs: result.loop_end_ms,
        score: result.score,
        rawAnalyzerScore: result.raw_analyzer_score,
        crossfadeMs: result.crossfade_ms,
        durationMs: result.duration_ms,
        candidates: result.candidates ?? [],
        alternatives: result.alternatives ?? [],
      });
      addLog("Loop analysis complete", "ok");
      showToast("Loop analysis complete", "success");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Loop analysis failed";
      setLoopAnalysisError(message);
      setLoopAnalysis(null);
      addLog(`✗ ${message}`, "err");
      showToast(message, "error");
    } finally {
      setIsAnalyzingLoop(false);
    }
  };

  const handlePreviewSeam = () => {
    if (!loopAnalysis) {
      addLog("No loop analysis available. Analyze a track first.", "err");
      showToast("No loop points found. Analyze a track first.", "error");
      return;
    }
    
    addLog(`Previewing loop seam...`, "info");
    engine.playLoopSeam(
      loopAnalysis.loopStartMs,
      loopAnalysis.loopEndMs,
      loopAnalysis.crossfadeMs
    );
    setIsPlaying(true);
  };

  // Clear polling on unmount
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, []);

  // Poll for job progress
  const startPolling = useCallback(
    (jobId: string) => {
      let hasShownCompletionToast = false; // Track if we've shown the completion toast
      let hasLoggedCompletion = false; // Track if we've logged completion
      let lastLogCount = 0; // Track how many logs we've already displayed
      let hasDownloadedOutput = false; // Prevent repeated downloads on "completed"

      pollIntervalRef.current = window.setInterval(async () => {
        try {
          const progress = await getJobProgress(jobId);
          updateJobProgress(progress);

          // Add new logs from backend
          if (progress.logs && progress.logs.length > lastLogCount) {
            const newLogs = progress.logs.slice(lastLogCount);
            newLogs.forEach(log => addLog(log, "info"));
            lastLogCount = progress.logs.length;
          }

          // Update label based on status
          if (progress.status === "queued") {
            setExportLabel(`Queued (position: ${progress.queue_position})`);
          } else if (progress.status === "processing") {
            const remaining = progress.remaining_seconds
              ? ` ~${formatTimeRemaining(progress.remaining_seconds)}`
              : "";
            setExportLabel(`Rendering...${remaining}`);
          } else if (progress.status === "completed") {
            setExportProgress(100);
            setExportLabel("Done!");
            
            // Only log completion once
            if (!hasLoggedCompletion) {
              addLog(
                exportKindRef.current === "audio"
                  ? `✅ Audio rendered successfully`
                  : `✅ Video saved successfully`,
                "ok",
              );
              hasLoggedCompletion = true;
            }
            
            // Only show toast once
            if (!hasShownCompletionToast) {
              showToast(
                exportKindRef.current === "audio"
                  ? "Audio render completed!"
                  : "Video render completed!",
                "success",
              );
              hasShownCompletionToast = true;
            }

            // Refresh job history
            const history = await getJobHistory();
            setJobHistory(history.jobs);

            // Stop polling ASAP to avoid re-triggering completion logic
            stopPolling();

            if (exportKindRef.current === "audio" && !hasDownloadedOutput) {
              hasDownloadedOutput = true;
              try {
                const blob = await downloadJobOutput(jobId);
                downloadBlob(blob, `${exportName}.wav`);
              } catch (e) {
                addLog(`✗ Failed to download audio: ${e}`, "err");
                showToast(`Download failed: ${e}`, "error");
              }
            } else if (
              exportKindRef.current === "video" &&
              !hasDownloadedOutput
            ) {
              hasDownloadedOutput = true;
              showToast("Render finished — download starting…", "success");
              try {
                const status = await getJobStatus(jobId);
                triggerVideoDownload(
                  progress.job_id,
                  status.filename ?? undefined,
                );
              } catch (e) {
                addLog(`✗ Failed to download video: ${e}`, "err");
                showToast(`Download failed: ${e}`, "error");
              }
            }

            setIsExporting(false);
            resetJobState();
          } else if (progress.status === "failed") {
            addLog(`✗ Render failed: ${progress.error}`, "err");
            showToast(`Render failed: ${progress.error}`, "error");
            stopPolling();
            setIsExporting(false);
            resetJobState();
          } else if (progress.status === "cancelled") {
            addLog("Render cancelled", "info");
            showToast("Render cancelled", "warning");
            stopPolling();
            setIsExporting(false);
            resetJobState();
          }
        } catch (error) {
          // Job not found - it may have completed/failed before we could poll
          console.error("Failed to poll progress:", error);
          // Stop polling after a few failed attempts
          stopPolling();
          setIsExporting(false);
          resetJobState();
        }
      }, 2000); // Poll every 2 seconds
    },
    [
      updateJobProgress,
      setExportLabel,
      setExportProgress,
      addLog,
      showToast,
      setJobHistory,
      setIsExporting,
      resetJobState,
    ],
  );

  const stopPolling = useCallback(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  }, []);

  const handleExportWav = async () => {
    if (noTracksLoaded) {
      showToast(
        "No tracks loaded. Please load at least one audio track.",
        "error",
      );
      addLog("No tracks loaded", "err");
      return;
    }

    setIsExporting(true);
    setExportProgress(0);
    setExportLabel("Rendering audio...");
    exportKindRef.current = "audio";

    try {
      const durationSeconds = exportDuration * 60;
      const files = tracks.filter((t) => t.file).map((t) => t.file!);
      const volumes = tracks.map((t) => t.volume / 100);
      const pans = tracks.map((t) => t.pan / 100);
      const muted = tracks.map((t) => t.muted);
      const solo = tracks.map((t) => t.solo);

      const response = await renderAudioJob({
        duration: durationSeconds,
        files,
        volumes,
        pans,
        muted,
        solo,
        masterGain,
        eqGains,
        loopStart:
          loopAnalysis && loopAnalysis.loopEndMs > loopAnalysis.loopStartMs
            ? loopAnalysis.loopStartMs / 1000
            : undefined,
        loopEnd:
          loopAnalysis && loopAnalysis.loopEndMs > loopAnalysis.loopStartMs
            ? loopAnalysis.loopEndMs / 1000
            : undefined,
      });

      setCurrentJobId(response.job_id);
      setExportLabel(
        response.queue_position > 0
          ? `Queued (position: ${response.queue_position})`
          : "Processing...",
      );
      addLog("🎵 Audio render started", "info");
      startPolling(response.job_id);
    } catch (error) {
      addLog(`Export failed: ${error}`, "err");
      showToast(`Export failed: ${error}`, "error");
      setIsExporting(false);
      resetJobState();
    }
  };

  const handleExportVideo = async () => {
    if (noTracksLoaded) {
      showToast(
        "No tracks loaded. Please load at least one audio track.",
        "error",
      );
      addLog("No tracks loaded", "err");
      return;
    }

    if (invalidDuration) {
      showToast("Invalid duration. Please set a valid duration.", "error");
      addLog("Invalid duration", "err");
      return;
    }

    const durationSeconds = exportDuration * 60;
    const files = tracks.filter((t) => t.file).map((t) => t.file!);
    const volumes = tracks.map((t) => t.volume / 100);
    const pans = tracks.map((t) => t.pan / 100);
    const muted = tracks.map((t) => t.muted);
    const solo = tracks.map((t) => t.solo);

    setIsExporting(true);
    setExportProgress(0);
    setExportLabel("Starting render...");
    exportKindRef.current = "video";
    addLog("🎬 Video render started", "info");

    try {
      const response = await renderVideoFull({
        duration: durationSeconds,
        files,
        volumes,
        pans,
        muted,
        solo,
        masterGain,
        eqGains,
        backgroundImage: backgroundImage || undefined,
        showVisualizer,
        useGpuEncoding,
        loopStart:
          loopAnalysis && loopAnalysis.loopEndMs > loopAnalysis.loopStartMs
            ? loopAnalysis.loopStartMs / 1000
            : undefined,
        loopEnd:
          loopAnalysis && loopAnalysis.loopEndMs > loopAnalysis.loopStartMs
            ? loopAnalysis.loopEndMs / 1000
            : undefined,
      });

      setCurrentJobId(response.job_id);
      setExportLabel(
        response.queue_position > 0
          ? `Queued (position: ${response.queue_position})`
          : "Processing...",
      );

      // Start polling for progress
      startPolling(response.job_id);
    } catch (error) {
      addLog(`✗ Video render failed: ${error}`, "err");
      showToast(`Render failed: ${error}`, "error");
      setIsExporting(false);
      resetJobState();
    }
  };

  const handleCancel = async () => {
    if (!currentJobId) return;

    try {
      await cancelJob(currentJobId);
      stopPolling();
      setIsExporting(false);
      setExportProgress(0);
      setExportLabel("");
      resetJobState();
      addLog("Render cancelled", "info");
      showToast("Render cancelled", "warning");
    } catch (error) {
      addLog(`Failed to cancel: ${error}`, "err");
      showToast(`Failed to cancel: ${error}`, "error");
    }
  };

  const handleBackgroundSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (!file.type.startsWith("image/")) {
        addLog("Invalid image file", "err");
        showToast("Please select a valid image file", "error");
        return;
      }
      setBackgroundImage(file);
      addLog(`Background set: ${file.name}`, "info");
    }
  };

  // Get button tooltip based on validation
  const getButtonTooltip = (): string => {
    if (noTracksLoaded) return "Load at least one audio track to export";
    if (invalidDuration) return "Set a valid duration to export";
    if (isExporting) return "A render is already in progress";
    return "";
  };

  const tooltip = getButtonTooltip();
  const buttonsDisabled = noTracksLoaded || invalidDuration || isExporting;

  return (
    <>
      <div className="relative z-10 border-t border-[var(--border)] bg-[var(--surface)]/80 backdrop-blur-sm p-4">
        {/* Validation Warnings */}
        {(noTracksLoaded || invalidDuration) && (
          <div className="mb-4 p-3 bg-[var(--warn)]/10 border border-[var(--warn)]/30 rounded text-sm">
            <div className="flex items-center gap-2 text-[var(--warn)]">
              <AlertCircle className="w-4 h-4" />
              <span className="font-medium">Cannot render:</span>
            </div>
            <ul className="mt-1 ml-6 list-disc text-[var(--text-dim)]">
              {noTracksLoaded && <li>No tracks loaded</li>}
              {invalidDuration && <li>Invalid duration</li>}
            </ul>
          </div>
        )}

        {/* Soft warning for no background */}
        {noBackgroundImage && !noTracksLoaded && (
          <div className="mb-4 p-2 bg-[var(--surface2)] border border-[var(--border)] rounded text-xs text-[var(--text-dim)] flex items-center gap-2">
            <AlertCircle className="w-3 h-3 text-[var(--warn)]" />
            No custom background image set. Server default will be used.
          </div>
        )}

        <div className="flex items-end gap-6">
          {/* Duration */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-[var(--text-dim)] font-mono">
              DURATION (min)
            </label>
            <input
              type="number"
              min="1"
              max="480"
              value={exportDuration}
              onChange={(e) =>
                setExportDuration(
                  Math.max(1, Math.min(480, parseInt(e.target.value) || 1)),
                )
              }
              className={`w-20 px-3 py-2 bg-[var(--surface2)] border rounded text-[var(--text)] font-mono focus:outline-none ${
                invalidDuration
                  ? "border-[var(--warn)]"
                  : "border-[var(--border)] focus:border-[var(--accent)]"
              }`}
            />
          </div>

          {/* File Name */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-[var(--text-dim)] font-mono">
              FILE NAME
            </label>
            <input
              type="text"
              value={exportName}
              onChange={(e) => setExportName(e.target.value)}
              className="w-40 px-3 py-2 bg-[var(--surface2)] border border-[var(--border)] rounded text-[var(--text)] focus:outline-none focus:border-[var(--accent)]"
            />
          </div>

          {/* Background Image */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-[var(--text-dim)] font-mono">
              BACKGROUND (optional)
            </label>
            <button
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-2 px-3 py-2 bg-[var(--surface2)] border border-[var(--border)] rounded hover:border-[var(--accent)] transition-colors text-sm"
            >
              <ImageIcon className="w-4 h-4 text-[var(--text-dim)]" />
              <span className="text-[var(--text-dim)] truncate max-w-[120px]">
                {backgroundImage ? backgroundImage.name : "Choose image..."}
              </span>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleBackgroundSelect}
              className="hidden"
            />
          </div>

          {/* Video Preview */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-[var(--text-dim)] font-mono">
              PREVIEW
            </label>
            <VideoPreview backgroundImage={backgroundImage} />
          </div>

          {/* Visualizer Toggle */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-[var(--text-dim)] font-mono">
              VISUALIZER
            </label>
            <button
              onClick={() => setShowVisualizer(!showVisualizer)}
              className={`flex items-center gap-2 px-3 py-2 rounded border transition-all text-sm ${
                showVisualizer
                  ? "border-[var(--accent)] bg-[var(--accent)]/20 text-[var(--accent)]"
                  : "border-[var(--border)] text-[var(--text-dim)] hover:border-[var(--accent2)]"
              }`}
              title="Include audio visualizer in rendered video"
            >
              <div className="flex gap-0.5">
                <div className="w-1 h-4 bg-current opacity-60"></div>
                <div className="w-1 h-4 bg-current opacity-80"></div>
                <div className="w-1 h-4 bg-current"></div>
                <div className="w-1 h-4 bg-current opacity-80"></div>
                <div className="w-1 h-4 bg-current opacity-60"></div>
              </div>
              {showVisualizer ? "ON" : "OFF"}
            </button>
          </div>

          {/* GPU Encoding Toggle */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-[var(--text-dim)] font-mono">
              GPU ENCODE
            </label>
            <button
              onClick={() => setUseGpuEncoding(!useGpuEncoding)}
              className={`flex items-center gap-2 px-3 py-2 rounded border transition-all text-sm ${
                useGpuEncoding
                  ? "border-[var(--accent3)] bg-[var(--accent3)]/20 text-[var(--accent3)]"
                  : "border-[var(--border)] text-[var(--text-dim)] hover:border-[var(--warn)]"
              }`}
              title={useGpuEncoding ? "Using GPU (NVENC) - Faster" : "Using CPU (libx264) - Slower"}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
              </svg>
              {useGpuEncoding ? "GPU" : "CPU"}
            </button>
          </div>

          {/* Loop analysis + export buttons */}
          <div className="flex flex-col gap-2 ml-auto items-end">
            <div className="flex flex-col items-end gap-1 min-w-[220px]">
              <button
                onClick={handleAnalyzeLoop}
                disabled={
                  isAnalyzingLoop || activeTracksForAnalysis.length === 0
                }
                className={`
                  flex items-center gap-2 px-4 py-2 rounded font-medium transition-all text-sm border
                  ${
                    isAnalyzingLoop || activeTracksForAnalysis.length === 0
                      ? "bg-[var(--surface2)] text-[var(--text-dim)] cursor-not-allowed border-[var(--border)]"
                      : "bg-[var(--surface2)] text-[var(--text-dim)] hover:border-[var(--accent)] border-[var(--border)]"
                  }
                `}
              >
                {isAnalyzingLoop ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Analyzing…
                  </>
                ) : (
                  "Analyze Loop"
                )}
              </button>

              {loopAnalysisError && (
                <p className="text-sm text-[var(--warn)] mt-1">
                  {loopAnalysisError}
                </p>
              )}

              {loopAnalysis && (
                <div className="rounded-md border border-[var(--border)] p-3 mt-2 space-y-1 text-sm w-full">
                  <p className="font-medium text-[var(--text)]">
                    Loop Analysis Result
                  </p>

                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[var(--text-dim)]">
                    <span>Loop start</span>
                    <span>
                      {(loopAnalysis.loopStartMs / 1000).toFixed(3)}s
                    </span>

                    <span>Loop end</span>
                    <span>{(loopAnalysis.loopEndMs / 1000).toFixed(3)}s</span>

                    <span>Duration</span>
                    <span>
                      {(
                        (loopAnalysis.loopEndMs - loopAnalysis.loopStartMs) /
                        1000
                      ).toFixed(2)}
                      s
                    </span>

                    <span>Crossfade</span>
                    <span>{loopAnalysis.crossfadeMs}ms</span>

                    <span>Score</span>
                    <span
                      className={
                        loopAnalysis.score < 0.7
                          ? "text-[var(--warn)] font-medium"
                          : "text-[var(--accent3)] font-medium"
                      }
                    >
                      {(loopAnalysis.score * 100).toFixed(1)}%
                    </span>
                  </div>

                  {loopAnalysis.score < 0.7 && (
                    <p className="text-[var(--warn)] text-xs mt-1">
                      ⚠ Loop seam may be audible. Consider using an alternative
                      candidate.
                    </p>
                  )}

                  {(loopAnalysis.candidates?.length ?? 0) > 0 ||
                  (loopAnalysis.alternatives?.length ?? 0) > 0 ? (
                    <p className="text-[var(--text-dim)] text-xs mt-1">
                      {loopAnalysis.candidates?.length ?? 0} candidate(s) ·{" "}
                      {loopAnalysis.alternatives?.length ?? 0} alternative(s)
                      detected
                    </p>
                  ) : null}
                </div>
              )}
            </div>

            <div className="flex gap-3">
            {loopAnalysis && (
              <button
                onClick={handlePreviewSeam}
                disabled={isExporting}
                className={`
                  flex items-center gap-2 px-4 py-2 rounded font-medium transition-all
                  ${
                    isExporting
                      ? "bg-[var(--surface2)] text-[var(--text-dim)] cursor-not-allowed"
                      : "bg-[var(--accent3)]/20 text-[var(--accent3)] hover:bg-[var(--accent3)]/30 border border-[var(--accent3)]"
                  }
                `}
                title="Listen to the seamless loop transition"
              >
                <RefreshCw className="w-4 h-4" />
                Preview Seam
              </button>
            )}

            <button
              onClick={handleExportWav}
              disabled={buttonsDisabled}
              title={tooltip}
              className={`
                flex items-center gap-2 px-4 py-2 rounded font-medium transition-all
                ${
                  buttonsDisabled
                    ? "bg-[var(--surface2)] text-[var(--text-dim)] cursor-not-allowed"
                    : "bg-[var(--accent)]/20 text-[var(--accent)] hover:bg-[var(--accent)]/30 border border-[var(--accent)]"
                }
              `}
            >
              {isExporting && jobStatus !== "queued" ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Download className="w-4 h-4" />
              )}
              Export WAV
            </button>

            <button
              onClick={handleExportVideo}
              disabled={buttonsDisabled}
              title={tooltip}
              className={`
                flex items-center gap-2 px-4 py-2 rounded font-medium transition-all
                ${
                  buttonsDisabled
                    ? "bg-[var(--surface2)] text-[var(--text-dim)] cursor-not-allowed"
                    : "bg-[var(--accent2)]/20 text-[var(--accent2)] hover:bg-[var(--accent2)]/30 border border-[var(--accent2)]"
                }
              `}
            >
              {isExporting && jobStatus !== "queued" ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Film className="w-4 h-4" />
              )}
              Render Video
            </button>

            {/* Cancel Button */}
            {isExporting && (
              <button
                onClick={handleCancel}
                className="flex items-center gap-2 px-4 py-2 rounded font-medium transition-all bg-[var(--warn)]/20 text-[var(--warn)] hover:bg-[var(--warn)]/30 border border-[var(--warn)]"
              >
                <X className="w-4 h-4" />
                Cancel
              </button>
            )}
            </div>
          </div>
        </div>

        {/* Progress Bar */}
        {isExporting && (
          <div className="mt-4">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-[var(--text-dim)]">
                {exportLabel}
              </span>
              <div className="flex items-center gap-3">
                {queuePosition > 0 && (
                  <span className="text-xs text-[var(--warn)]">
                    Queue: #{queuePosition}
                  </span>
                )}
                {elapsedSeconds && (
                  <span className="text-xs text-[var(--text-dim)]">
                    Elapsed: {formatTimeRemaining(elapsedSeconds)}
                  </span>
                )}
                {remainingSeconds && remainingSeconds > 0 && (
                  <span className="text-xs text-[var(--text-dim)]">
                    Remaining: ~{formatTimeRemaining(remainingSeconds)}
                  </span>
                )}
                <span className="text-xs text-[var(--accent)] font-mono">
                  {exportProgress}%
                </span>
              </div>
            </div>
            <div className="h-1.5 bg-[var(--surface2)] rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-[var(--accent)] to-[var(--accent2)] transition-all duration-300"
                style={{ width: `${exportProgress}%` }}
              />
            </div>
          </div>
        )}

        {/* Error Display */}
        {jobError && (
          <div className="mt-3 p-2 bg-red-500/10 border border-red-500/30 rounded text-xs text-red-400">
            Error: {jobError}
          </div>
        )}
      </div>
    </>
  );
}
