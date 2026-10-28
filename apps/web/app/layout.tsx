import "./globals.css";
import { ClerkProvider } from "@clerk/nextjs";
import type { ReactNode } from "react";
import { AppProviders } from "./providers";
export const metadata = { title: "NetSense", description: "Coaching workflow" };
export default function Layout({ children }: { children: ReactNode }) {
  const configured = Boolean(
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY &&
    process.env.NEXT_PUBLIC_CONVEX_URL,
  );
  return (
    <html lang="en">
      <body>
        {configured ? (
          <ClerkProvider>
            <AppProviders>{children}</AppProviders>
          </ClerkProvider>
        ) : (
          children
        )}
      </body>
    </html>
  );
}
