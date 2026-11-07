/**
 * Why Google refused a request, as a short code ("API_KEY_ANDROID_APP_BLOCKED",
 * "SERVICE_DISABLED", "API_KEY_SERVICE_BLOCKED"...). Safe to log: it is a reason
 * code, never the key, the query or a location. Without it a 403 says nothing.
 */
export async function googleReason(res: Response): Promise<string> {
  try {
    const body = (await res.clone().json()) as {
      error?: { status?: string; details?: { reason?: string }[] };
    };
    const reason = body.error?.details?.find((d) => d.reason)?.reason;
    return reason ?? body.error?.status ?? 'no reason given';
  } catch {
    return 'no reason given';
  }
}
