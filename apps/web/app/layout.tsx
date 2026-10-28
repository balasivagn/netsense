import "./globals.css";
import type { ReactNode } from "react";
export const metadata = { title: "NetSense", description: "Coaching workflow" };
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
