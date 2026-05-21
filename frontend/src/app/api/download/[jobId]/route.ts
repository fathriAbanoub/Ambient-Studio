import { NextRequest, NextResponse } from "next/server";

export async function GET(
  req: NextRequest,
  { params }: { params: { jobId: string } },
) {
  const backendUrl = process.env.BACKEND_API_URL ?? "http://localhost:3003";
  const jobId = params.jobId;
  const encodedJobId = encodeURIComponent(jobId);
  const safeJobId = jobId.replace(/[^\w.-]/g, "_");

  let upstream: Response;
  try {
    upstream = await fetch(`${backendUrl}/download/${encodedJobId}`);
    if (!upstream.ok) {
      return new NextResponse("Download failed", { status: upstream.status });
    }
  } catch (error) {
    console.error("Upstream fetch failed:", error);
    return new NextResponse("Upstream fetch failed", { status: 502 });
  }

  const contentDisposition =
    upstream.headers.get("content-disposition") ??
    `attachment; filename="ambient_video_${safeJobId}.mp4"`;
  const contentType = upstream.headers.get("content-type") ?? "video/mp4";

  return new NextResponse(upstream.body, {
    headers: {
      "Content-Disposition": contentDisposition,
      "Content-Type": contentType,
    },
  });
}
