import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "addon-sim",
  description: "Open-source simulator for voice assistants that host MCP add-ons. Not affiliated with Amazon.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="h-full overflow-x-hidden lg:overflow-hidden">{children}</body>
    </html>
  );
}
