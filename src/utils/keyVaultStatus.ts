// What the Key Vault reporter says about its own connection, for Settings > Key Vault. The
// operator can then tell a link that works from one that does not without reading the log.
// The wording is worked out here, like every other status, and the dashboard only shows it.

export interface KeyVaultStatus {
    // waiting: the settings are applied and no report has been answered yet.
    state: 'waiting' | 'ok' | 'failing';
    // When Key Vault last accepted a report (ms since the epoch); null if none has since the
    // settings were applied.
    lastReportAtMs: number | null;
    // The problem, in the operator's words, and when it began; null unless failing.
    problem: string | null;
    failingSinceMs: number | null;
    // How many entries Key Vault left out of the last report it accepted because it could not
    // use them; null when it did not say (an older Key Vault).
    skipped: number | null;
}

// An answer Key Vault gave (`httpStatus`), or a failure to get one (`httpStatus` null, `error`
// the text of what failed).
export function describeReportFailure(httpStatus: number | null, error: string): string {
    if (httpStatus === 401 || httpStatus === 403) {
        return `Key Vault refused the secret (HTTP ${httpStatus}). Check that the secret is the one Key Vault shows its owners.`;
    }
    if (httpStatus === 404) {
        return 'Key Vault answered HTTP 404. Check the link: it should end in /functions/v1/ingest.';
    }
    if (httpStatus !== null && httpStatus >= 500) {
        return `Key Vault had an error (HTTP ${httpStatus}). Reports continue every minute.`;
    }
    if (httpStatus !== null) {
        return `Key Vault refused the report (HTTP ${httpStatus}).`;
    }
    if (/ENOTFOUND|EAI_AGAIN/.test(error)) {
        return 'The host in the link was not found. Check the link for a typo.';
    }
    if (/timed out/.test(error)) return 'Key Vault did not answer in time.';
    return `Could not reach Key Vault (${error}).`;
}

export const BUILD_FAILURE_PROBLEM =
    'Bunryu could not build the report (a database error). See the server log.';
