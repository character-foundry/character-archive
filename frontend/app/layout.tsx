import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Character Archive",
  description: "Character Archive keeps your Chub.ai and Character Tavern cards searchable, synced, and ready to share.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
