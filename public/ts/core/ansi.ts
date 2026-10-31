import { escapeHtml } from './utils.js';

// Maps ANSI SGR foreground codes to the same severity colors SRS itself
// uses (red for its ERROR lines, yellow for WARN), so the web terminal
// mirrors a real terminal instead of hand-matching level text.
const ANSI_FG_CLASS: Record<string, string> = {
    '31': 'text-error',
    '91': 'text-error',
    '33': 'text-warning',
    '93': 'text-warning',
    '32': 'text-success',
    '92': 'text-success',
    '34': 'text-info',
    '94': 'text-info',
    '36': 'text-info',
    '96': 'text-info',
    '35': 'text-secondary',
    '95': 'text-secondary',
};
// eslint-disable-next-line no-control-regex -- matches the ESC that starts an ANSI sequence
const ANSI_SGR_REGEX = /\x1b\[([0-9;]*)m/g;

export function ansiLineToHtml(line: string): string {
    let html = '';
    let lastIndex = 0;
    let openSpan = false;
    ANSI_SGR_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ANSI_SGR_REGEX.exec(line))) {
        html += escapeHtml(line.slice(lastIndex, match.index));
        lastIndex = ANSI_SGR_REGEX.lastIndex;
        if (openSpan) {
            html += '</span>';
            openSpan = false;
        }
        for (const code of match[1].split(';')) {
            const cls = ANSI_FG_CLASS[code];
            if (cls) {
                html += `<span class="${cls}">`;
                openSpan = true;
            }
        }
    }
    html += escapeHtml(line.slice(lastIndex));
    if (openSpan) html += '</span>';
    return html;
}
