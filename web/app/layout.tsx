import type { Metadata, Viewport } from "next";

// Barlow is modeled on road and highway signage: the vernacular of the sites this watches.
// Self-hosted from npm so builds work offline and the app makes no third-party font requests.
import "@fontsource/barlow/400.css";
import "@fontsource/barlow/500.css";
import "@fontsource/barlow/600.css";
import "@fontsource/barlow-condensed/600.css";
import "@fontsource/barlow-condensed/700.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Linewatch",
  description: "Zone safety monitoring on Roboflow Inference: draw a zone, catch unsafe entries, review in one click.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#e6e7e3" },
    { media: "(prefers-color-scheme: dark)", color: "#16191d" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
