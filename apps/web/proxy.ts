import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse, type NextRequest, type NextFetchEvent } from "next/server";
import { isCoachApiPath, isCoachPagePath } from "./lib/auth-routes";

const hasClerkConfiguration = Boolean(
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY,
);

const configuredProxy = clerkMiddleware(async (auth, request) => {
  if (
    isCoachPagePath(request.nextUrl.pathname) ||
    isCoachApiPath(request.nextUrl.pathname)
  ) {
    await auth.protect();
  }
}, { signInUrl: "/sign-in" });

function unconfiguredProxy(request: NextRequest) {
  if (isCoachPagePath(request.nextUrl.pathname)) {
    return NextResponse.redirect(new URL("/sign-in", request.url));
  }
  if (isCoachApiPath(request.nextUrl.pathname)) {
    return new NextResponse(null, { status: 503 });
  }
  return NextResponse.next();
}

export default function proxy(request: NextRequest, event: NextFetchEvent) {
  // These handlers implement their own HMAC or student-link authorization.
  // Clerk must never interpret their bearer tokens as coach sessions.
  const pathname = request.nextUrl.pathname;
  if (pathname === "/api/worker/sign" || pathname.startsWith("/api/media/local/") ||
      pathname === "/api/l" || pathname.startsWith("/api/l/")) {
    return NextResponse.next();
  }
  return hasClerkConfiguration ? configuredProxy(request, event) : unconfiguredProxy(request);
}

export const config = {
  matcher: [
    "/api/:path*",
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
  ],
};
