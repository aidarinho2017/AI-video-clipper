import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Clipper — Turn long videos into short clips",
  description: "AI finds the best moments in long videos and creates captioned vertical clips for Shorts, Reels, and TikTok.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
