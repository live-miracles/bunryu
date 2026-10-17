import type { RejectedPublish } from '../types.js';

const LOOPBACK_IP = /^(127\.|::1$|::ffff:127\.)/;

// Plain text (callers escape it): where the refused attempt came from. Direct SRT
// from loopback is Goryu forwarding its remote encoders.
export function rejectedVia(r: RejectedPublish): string {
    if (r.protocol === 'srt') {
        return r.ip && !LOOPBACK_IP.test(r.ip) ? `SRT from ${r.ip}` : 'SRT (via relay)';
    }
    return `RTMP${r.ip ? ` from ${r.ip}` : ''}`;
}

// Plain text (callers escape it): why SRS refused the attempt.
export function rejectedWhy(r: RejectedPublish): string {
    const keyWhy =
        r.reason === 'assigned'
            ? 'The key is assigned to a pipeline'
            : r.reason === 'unassigned'
              ? 'Key is valid but not assigned to a pipeline'
              : r.reason === 'unknown'
                ? 'Key not recognized (wrong secret or key was regenerated)'
                : 'Stream name is empty or not a stream key (e.g. a typo or a missing keyNN_ prefix)';
    return r.kind === 'play'
        ? `SRS treated this as a play request, and plays from outside are refused. If this is an encoder, its SRT stream id is probably missing m=publish (e.g. #!::r=live/keyNN_...,m=publish). ${keyWhy}`
        : keyWhy;
}
