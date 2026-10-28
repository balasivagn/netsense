/**
 * Proxy is only an early navigation/API filter. Every route handler must also
 * authenticate and authorize its request before accessing coach-owned data.
 */
export function isCoachPagePath(pathname: string): boolean {
  return pathname === "/sessions" || pathname.startsWith("/sessions/");
}

/** These endpoints accept coach browser requests; worker and student paths stay public. */
export function isCoachApiPath(pathname: string): boolean {
  return (
    pathname === "/api/uploads" ||
    pathname.startsWith("/api/uploads/") ||
    pathname === "/api/media/sign" ||
    pathname.startsWith("/api/media/sign/")
  );
}
