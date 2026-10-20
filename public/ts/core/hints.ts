// What an operator can do about an error or an alert, in plain words. Pure
// lookups on the text the server already sends, so there is no API field for it
// and an unknown message simply gets no hint.

const ERROR_HINTS: Array<[RegExp, string]> = [
    // First: a write that stayed blocked until ffmpeg gave up (OUTPUT_IO_TIMEOUT_US
    // in src/utils/ffmpeg.ts). RTMPS words it as an I/O error, which the generic
    // rule below would blame on the stream key.
    [
        /error closing file/i,
        'The destination stopped accepting data and FFmpeg gave up on it. Check the destination’s status and the network; the output reconnects by itself.',
    ],
    [
        /connection refused/i,
        'The destination refused the connection. Check the host and port in the URL and that the platform’s ingest is up.',
    ],
    [
        /timed out|etimedout/i,
        'The destination did not answer. Check the URL and that this server can reach the host (firewall, routing), then try again.',
    ],
    [
        /name or service not known|could not resolve|failed to resolve|getaddrinfo/i,
        'The destination host name could not be resolved. Check the spelling of the URL and this server’s DNS.',
    ],
    [
        /server returned 40[13]|unauthorized|forbidden/i,
        'The destination rejected the login. Check the stream key or credentials in the URL.',
    ],
    [
        /connection setup failure|connection rejected|econnreject|passphrase/i,
        'The SRT destination rejected the connection. Check the stream id and the passphrase.',
    ],
    [
        /input\/output error|broken pipe|connection reset by peer|end of file/i,
        'The connection closed while sending. Usually the destination rejected the stream: check the stream key (wrong, expired, or live elsewhere) and the platform’s status.',
    ],
    [
        /not (?:currently )?supported in container|incompatible with (?:output )?codec|not compatible with flv/i,
        'The destination format cannot carry this codec. RTMP carries H.264/H.265 video with AAC audio; use an SRT destination or re-encode the audio.',
    ],
    [
        /falling behind/i,
        'The output cannot keep up with live. Check that the destination and the network are healthy and the server has CPU headroom; the input itself may also be delivering slowly.',
    ],
];

export function errorHint(message: string | null | undefined): string | null {
    if (!message) return null;
    for (const [pattern, hint] of ERROR_HINTS) {
        if (pattern.test(message)) return hint;
    }
    return null;
}

// Alerts whose message does not already say what to do. Keyed by alert code.
const ALERT_HINTS: Record<string, string> = {
    'srt-packets-dropped':
        'The link cannot keep up: raise the SRT latency on the encoder or lower its bitrate.',
    'srt-packet-loss':
        'Packets are being lost on the link: check the uplink, or raise the encoder’s SRT latency to give retransmissions time.',
    'srt-retransmissions':
        'Many retransmissions mean a lossy link: raise the encoder’s SRT latency or lower its bitrate.',
    'srt-belated-packets':
        'Packets arrive too late for the latency window: raise the encoder’s SRT latency.',
    'srt-latency-spike': 'Latency is rising: check the network path to this server.',
    'input-bitrate-collapse':
        'The encoder’s bitrate dropped sharply: check the encoder and its uplink.',
    'input-low-framerate': 'The encoder is dropping frames: check its CPU load and its uplink.',
    'input-high-framerate':
        'The input is arriving faster than its nominal rate: check the encoder’s frame rate setting and clock.',
    'input-flapping':
        'Check the encoder (power, crashes, cabling) and its uplink; the pipeline log lists each disconnect.',
    'relay-forwarding-stalled':
        'The relay is receiving but not forwarding to SRS: see the relay and SRS logs under Server logs.',
};

export function alertHint(code: string): string | null {
    return ALERT_HINTS[code] ?? null;
}
