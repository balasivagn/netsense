import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse, type NextRequest } from "next/server";
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
});

function unconfiguredProxy(request: NextRequest) {
  if (isCoachPagePath(request.nextUrl.pathname)) {
    return NextResponse.redirect(new URL("/sign-in", request.url));
  }
  if (isCoachApiPath(request.nextUrl.pathname)) {
    return new NextResponse(null, { status: 503 });
  }
  return NextResponse.next();
}

export default hasClerkConfiguration ? configuredProxy : unconfiguredProxy;

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
  ],
};
