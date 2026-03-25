"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useStudioStore } from "@/store/studioStore";
import { renderAudioMix } from "@/lib/audioRenderer";
import {
  renderVideoFull,
  downloadBlob,
  getJobProgress,
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
} from "lucide-react";
import { JobHistoryItem } from "@/types";

// Toast notification component
function Toast() {
  const { toastMessage, toastType, hideToast } = useStudioStore();

  if (!toastMessage) return null;

  const bgColor = {
    success: "bg-[var(--accent3)]",
    error: "bg-red-500",
    warning: "bg-[var(--warn)]",
    info: "bg-[var(--accent)]",
  }[toastType];

  return (
    <div className="fixed top-4 right-4 z-50 animate-slide-in">
      <div
        className={`${bgColor} text-white px-4 py-3 rounded-lg shadow-lg flex items-center gap-3 max-w-md`}
      >
        <span className="flex-1">{toastMessage}</span>
        <button
          onClick={hideToast}
          className="hover:opacity-70 transition-opacity"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

// Recent Renders panel component
function RecentRendersPanel() {
  const { jobHistory, setJobHistory, addLog } = useStudioStore();

  // Fetch job history on mount
  useEffect(() => {
    const fetchHistory = async () => {
      try {
        const data = await getJobHistory();
        setJobHistory(data.jobs);
      } catch (error) {
        console.error("Failed to fetch job history:", error);
      }
    };
    fetchHistory();
  }, [setJobHistory]);

  const copyToClipboard = async (filePath: string, filename: string) => {
    try {
      await navigator.clipboard.writeText(filePath);
      addLog(`Copied path: ${filePath}`, "ok");
    } catch {
      addLog("Failed to copy to clipboard", "err");
    }
  };

  if (jobHistory.length === 0) return null;

  return (
    <div className="border-t border-[var(--border)] bg-[var(--surface)]/50 p-4 mt-2">
      <h3 className="text-xs text-[var(--text-dim)] font-mono mb-3 flex items-center gap-2">
        <Clock className="w-3 h-3" />
        RECENT RENDERS
      </h3>
      <div className="space-y-2 max-h-40 overflow-y-auto">
        {jobHistory.slice(0, 10).map((job) => (
          <div
            key={job.job_id}
            className="flex items-center justify-between text-xs bg-[var(--surface2)] rounded px-3 py-2"
          >
            <div className="flex-1 min-w-0">
              <div className="text-[var(--text)] truncate">{job.filename}</div>
              <div className="text-[var(--text-dim)] flex items-center gap-3">
                <span>
                  {Math.floor(job.duration / 60)}:
                  {String(job.duration % 60).padStart(2, "0")}
                </span>
                <span>{formatFileSize(job.file_size)}</span>
                <span>{new Date(job.timestamp).toLocaleTimeString()}</span>
              </div>
            </div>
            <button
              onClick={() => copyToClipboard(job.file_path, job.filename)}
              className="ml-3 px-2 py-1 text-[var(--accent)] hover:bg-[var(--accent)]/20 rounded transition-colors"
              title="Copy file path"
            >
              <HardDrive className="w-3 h-3" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ExportPanel() {
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
  } = useStudioStore();

  const [backgroundImage, setBackgroundImage] = useState<File | null>(null);
  const [pollInterval, setPollInterval] = useState<NodeJS.Timeout | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadedTracks = tracks.filter((t) => t.loaded);

  // Validation state
  const noTracksLoaded = loadedTracks.length === 0;
  const invalidDuration = exportDuration <= 0;
  const noBackgroundImage = !backgroundImage;

  // Clear polling on unmount
  useEffect(() => {
    return () => {
      if (pollInterval) {
        clearInterval(pollInterval);
      }
    };
  }, [pollInterval]);

  // Poll for job progress
  const startPolling = useCallback(
    (jobId: string) => {
      const interval = setInterval(async () => {
        try {
          const progress = await getJobProgress(jobId);
          updateJobProgress(progress);

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
            addLog(`✅ Video saved successfully`, "ok");
            showToast("Video render completed!", "success");

            // Refresh job history
            const history = await getJobHistory();
            setJobHistory(history.jobs);

            stopPolling();
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
          console.error("Failed to poll progress:", error);
        }
      }, 2000); // Poll every 2 seconds

      setPollInterval(interval);
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
    if (pollInterval) {
      clearInterval(pollInterval);
      setPollInterval(null);
    }
  }, [pollInterval]);

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

    try {
      const durationSeconds = exportDuration * 60;

      const blob = await renderAudioMix(
        durationSeconds,
        tracks,
        masterGain,
        eqGains,
        (progress) => setExportProgress(progress),
      );

      downloadBlob(blob, `${exportName}.wav`);
      addLog(`Exported ${exportName}.wav (${exportDuration} min)`, "ok");
      showToast(`Exported ${exportName}.wav`, "success");
    } catch (error) {
      addLog(`Export failed: ${error}`, "err");
      showToast(`Export failed: ${error}`, "error");
    } finally {
      setIsExporting(false);
      setExportProgress(0);
      setExportLabel("");
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
      <Toast />
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

          {/* Export Buttons */}
          <div className="flex gap-3 ml-auto">
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

      {/* Recent Renders Panel */}
      <RecentRendersPanel />
    </>
  );
}
