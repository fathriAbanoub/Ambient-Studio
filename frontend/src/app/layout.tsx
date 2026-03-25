import type { Metadata } from "next";
import { Syne, Space_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const syne = Syne({
  variable: "--font-syne",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
});

const spaceMono = Space_Mono({
  variable: "--font-space-mono",
  subsets: ["latin"],
  weight: ["400", "700"],
});

export const metadata: Metadata = {
  title: "AMBIENT.STUDIO - Browser-based Ambient Music Mixer",
  description: "Create ambient soundscapes in your browser. Mix up to 8 audio tracks with volume, pan, EQ, and export to WAV or MP4 video.",
  keywords: ["ambient music", "audio mixer", "soundscape", "web audio", "ambient studio"],
  authors: [{ name: "AMBIENT.STUDIO" }],
  icons: {
    icon: "/logo.svg",
  },
  openGraph: {
    title: "AMBIENT.STUDIO",
    description: "Create ambient soundscapes in your browser",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "AMBIENT.STUDIO",
    description: "Create ambient soundscapes in your browser",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${syne.variable} ${spaceMono.variable} antialiased`}
        style={{
          fontFamily: "var(--font-syne), system-ui, sans-serif",
        }}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
