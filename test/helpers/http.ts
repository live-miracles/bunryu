// An in-memory request and response to drive an Express app without a socket: the API
// integration tests call `dispatch(app, 'POST', '/api/x', body)` and read the status,
// headers and parsed JSON body of what the route sent.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable, Writable } from 'node:stream';

export interface MockResult {
    status: number;
    headers: Record<string, unknown>;
    /** The raw response text; `body` is its JSON parse (undefined when empty). */
    text: string;
    // `any` on purpose: each test knows the shape of the one route it calls, and
    // asserting on `res.body.pipelines[0].name` would otherwise need a cast per line.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    body: any;
}

export class MockRequest extends Readable {
    method: string;
    url: string;
    headers: Record<string, string>;
    socket: { remoteAddress: string };
    connection: { remoteAddress: string };
    body: unknown;

    constructor(
        method: string,
        url: string,
        body?: unknown,
        ip = '127.0.0.1',
        cookie?: string,
        extraHeaders: Record<string, string> = {},
    ) {
        super();
        this.method = method;
        this.url = url;
        this.headers = { ...(cookie ? { cookie } : {}), ...extraHeaders };
        this.socket = { remoteAddress: ip };
        this.connection = this.socket;
        this.body = body;
    }

    _read(): void {
        this.push(null);
    }
}

// Express swaps the response's prototype when it handles a request (so res.json and
// friends exist), which drops every method defined on this class. The methods the
// routes call are therefore own properties, set in the constructor.
export class MockResponse extends Writable {
    statusCode = 200;
    headers: Record<string, unknown> = {};
    chunks: Buffer[] = [];
    resolve: (result: MockResult) => void;
    setHeader: (name: string, value: unknown) => this;
    getHeader: (name: string) => unknown;
    removeHeader: (name: string) => void;
    writeHead: (statusCode: number, headers?: Record<string, unknown>) => this;

    constructor(resolve: (result: MockResult) => void) {
        super();
        this.resolve = resolve;
        this.setHeader = (name, value) => {
            this.headers[String(name).toLowerCase()] = value;
            return this;
        };
        this.getHeader = (name) => this.headers[String(name).toLowerCase()];
        this.removeHeader = (name) => {
            delete this.headers[String(name).toLowerCase()];
        };
        this.writeHead = (statusCode, headers = {}) => {
            this.statusCode = statusCode;
            for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
            return this;
        };
        // Express ends a response with end(chunk, encoding) or end(chunk); Writable.end has
        // other overloads, so it is assigned through a loose type.
        (this as { end: unknown }).end = (
            chunk?: string | Buffer,
            encoding?: BufferEncoding,
            callback?: () => void,
        ) => {
            if (chunk)
                this.chunks.push(
                    typeof chunk === 'string' ? Buffer.from(chunk, encoding) : Buffer.from(chunk),
                );
            const text = Buffer.concat(this.chunks).toString('utf8');
            this.resolve({
                status: this.statusCode,
                headers: this.headers,
                text,
                body: text ? JSON.parse(text) : undefined,
            });
            if (callback) callback();
            return this;
        };
    }

    _write(
        chunk: Buffer,
        _encoding: BufferEncoding,
        callback: (error?: Error | null) => void,
    ): void {
        this.chunks.push(Buffer.from(chunk));
        callback();
    }
}

interface Handler {
    handle(req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void): void;
}

/** Sends one request through the app and resolves with what the route answered. */
export function dispatch(
    app: object,
    method: string,
    route: string,
    body?: unknown,
    ip?: string,
    cookie?: string,
    extraHeaders?: Record<string, string>,
): Promise<MockResult> {
    return new Promise((resolve, reject) => {
        const req = new MockRequest(method, route, body, ip, cookie, extraHeaders);
        const res = new MockResponse(resolve);
        // express's types do not declare handle(), though every app and router has it.
        (app as Handler).handle(
            req as unknown as IncomingMessage,
            res as unknown as ServerResponse,
            reject,
        );
    });
}
