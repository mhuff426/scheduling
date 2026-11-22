// Client half of the confirmation contract (ADR 0001). The server refuses a
// mutation that produces eligibility warnings with code `eligibility_warnings`
// and the warnings; we show one confirm dialog listing them all and resend
// with their kinds in `confirmedWarnings`. The server checks again on every
// resend, so new warnings are asked about again and a hard rule still refuses.
// The client never evaluates a rule itself.

export const CONFIRM_WARNINGS_CODE = 'eligibility_warnings';

interface Warning { kind: string; message: string }

// `send` makes the request, passing `confirmedWarnings` through to the body.
// Resolves to undefined when the person declines the dialog.
export async function withConfirmedWarnings<T>(
  send: (confirmedWarnings: string[] | undefined) => Promise<T>
): Promise<T | undefined> {
  let confirmed: string[] | undefined;
  for (;;) {
    try {
      return await send(confirmed);
    } catch (e) {
      const err = e as { code?: string; data?: { warnings?: Warning[] } };
      const warnings = err.code === CONFIRM_WARNINGS_CODE ? err.data?.warnings : undefined;
      if (!warnings?.length) throw e;
      const ok = confirm(
        `Please confirm:\n\n${warnings.map((w) => `• ${w.message}`).join('\n')}\n\nGo ahead anyway?`
      );
      if (!ok) return undefined;
      confirmed = warnings.map((w) => w.kind);
    }
  }
}
