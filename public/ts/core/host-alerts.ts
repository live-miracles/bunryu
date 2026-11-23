import type { HostAlert } from '../types.js';

// The host's CPU, memory and disk alerts as the server decides them (src/services/hostMonitor.ts:
// 70 % warning, 90 % error, the figures the top bar shows). The dashboard has no thresholds of
// its own: the banners and the top bar's colours read these, so they cannot disagree with
// the alerts or the Server events.

export type HostAlertKind = HostAlert['kind'];

// The severity of one resource, or null when it has no open alert.
export function hostAlertSeverity(
    alerts: readonly HostAlert[],
    kind: HostAlertKind,
): HostAlert['severity'] | null {
    return alerts.find((a) => a.kind === kind)?.severity ?? null;
}

// One banner per open alert, errors first.
export function hostAlertBanners(alerts: readonly HostAlert[]): HostAlert[] {
    return [...alerts].sort(
        (a, b) => Number(b.severity === 'error') - Number(a.severity === 'error'),
    );
}

// What beeps (see core/alert-sound.ts): an error, not a warning.
export function hostAlertKindsToBeep(alerts: readonly HostAlert[]): HostAlertKind[] {
    return alerts.filter((a) => a.severity === 'error').map((a) => a.kind);
}
