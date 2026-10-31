import type { ActivityEvent } from '../types.js';

// The collapsed text of a long event message (an FFmpeg stderr tail can run to pages).
export const EVENT_SUMMARY_MAX = 160;

// The first non-empty line of a message, on one line and cut to EVENT_SUMMARY_MAX, and
// whether there is more to show when it is expanded.
export function summarizeEventMessage(message: string): { summary: string; expandable: boolean } {
    const lines = message
        .split(/\r?\n/)
        .map((line) => line.replace(/\s+/g, ' ').trim())
        .filter(Boolean);
    const first = lines[0] ?? '';
    const cut = first.length > EVENT_SUMMARY_MAX;
    return {
        summary: cut ? `${first.slice(0, EVENT_SUMMARY_MAX - 3)}...` : first,
        expandable: cut || lines.length > 1,
    };
}

// The events to list for a filter ('all', 'server', or 'p:<pipeline id>'). GET /api/events
// returns the newest first; the table reads like the other logs, oldest at the top.
export function eventsForDisplay(events: ActivityEvent[], filter: string): ActivityEvent[] {
    const shown = events.filter((e) =>
        filter === 'all'
            ? true
            : filter === 'server'
              ? e.source === 'server'
              : String(e.pipelineId) === filter.slice(2),
    );
    return shown.reverse();
}
