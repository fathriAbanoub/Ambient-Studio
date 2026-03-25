import { NextRequest } from "next/server";

export const maxDuration = 1800; // 30 minutes
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const formData = await request.formData();

  const response = await fetch("http://localhost:3001/render-video-full", {
    method: "POST",
    body: formData,
    signal: AbortSignal.timeout(1800000),
  });

  if (!response.ok) {
    const text = await response.text();
    return new Response(text, { status: response.status });
  }

  const blob = await response.blob();
  return new Response(blob, {
    headers: {
      "Content-Type": "video/mp4",
      "Content-Disposition": "attachment; filename=ambient_video.mp4",
    },
  });
}
