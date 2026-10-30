// A span for a log line or an alert: "12s", "2m 5s", "1h 0m 0s".
export function formatDuration(ms: number): string {
    const totalSec = Math.round(ms / 1000);
    if (totalSec < 60) return `${totalSec}s`;
    const minutes = Math.floor(totalSec / 60) % 60;
    const hours = Math.floor(totalSec / 3600);
    return `${hours > 0 ? `${hours}h ` : ''}${minutes}m ${totalSec % 60}s`;
}
