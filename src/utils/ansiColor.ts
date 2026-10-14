// Same SGR color codes SRS's own console output uses, and that the dashboard's
// log viewer (public/ts/features/editor.ts, ANSI_FG_CLASS) already parses into
// color for every journal tail it renders — including our own
// bunryu.service tail. Applied unconditionally, not gated on isTTY: the
// two consumers are a human running `journalctl` in a real terminal and that
// web parser, neither of which cares that stdout here is a pipe to journald
// rather than a tty.
const RESET = '\x1b[0m';

export const red = (text: string): string => `\x1b[31m${text}${RESET}`;
export const yellow = (text: string): string => `\x1b[33m${text}${RESET}`;
export const green = (text: string): string => `\x1b[32m${text}${RESET}`;
export const cyan = (text: string): string => `\x1b[36m${text}${RESET}`;
