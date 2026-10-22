import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Amplience Intelligence Hub",
  description: "Cross-market content operations intelligence: detect, explain, prioritize and review fixes. Not affiliated with Amplience.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
