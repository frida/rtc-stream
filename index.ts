import { Buffer } from "buffer";
import { Duplex } from "stream";

import { nextTick } from "process";

class RTCStream extends Duplex {
    readonly #handle: WebSocket | RTCDataChannel;

    readonly #bufferSize: number;
    readonly #bufferTimeout: number;
    readonly #openStateValue: number | string;
    readonly #closedStateValue: number | string;

    #pendingWriteBuffer: Buffer | null = null;
    #pendingWriteCallback: WriteCallback | null = null;

    constructor(handle: WebSocket | RTCDataChannel, options: RTCStreamOptions) {
        super();

        this.#handle = handle;

        this.#bufferSize = options.bufferSize ?? 1024 * 512;
        this.#bufferTimeout = options.bufferTimeout ?? 50;
        if ("OPEN" in handle) {
            this.#openStateValue = handle.OPEN;
            this.#closedStateValue = handle.CLOSED;
        } else {
            this.#openStateValue = "open";
            this.#closedStateValue = "closed";
        }

        handle.binaryType = "arraybuffer";

        handle.addEventListener("open", this._onOpen);
        handle.addEventListener("close", this._onClose);
        handle.addEventListener("error", this._onError);
        handle.addEventListener("message", this._onMessage as any);

        const readyState = this.#handle.readyState;
        if (readyState === this.#openStateValue) {
            nextTick(this._onOpen);
        } else if (readyState === this.#closedStateValue) {
            nextTick(this._onClose);
        }
    }

    private _onOpen = (): void => {
        this.emit("connect");
        this._maybeProcessPendingWrite();
    };

    private _onClose = (): void => {
        this._maybeProcessPendingWrite();
        this.destroy(new Error("connection closed"));
    };

    private _onError = (event: Event | ErrorEvent): void => {
        this._maybeProcessPendingWrite();
        this.destroy(new Error(("message" in event) ? event.message : "connection refused"));
    };

    private _onMessage = (event: MessageEvent): void => {
        const { data } = event;
        this.push((data instanceof ArrayBuffer) ? Buffer.from(data) : Buffer.from(data, "utf8"));
    };

    _destroy(error: Error | null, callback: (error: Error | null) => void): void {
        const handle = this.#handle;
        handle.removeEventListener("message", this._onMessage as any);
        handle.removeEventListener("error", this._onError);
        handle.removeEventListener("close", this._onClose);
        handle.removeEventListener("open", this._onOpen);

        this.#handle.close();

        callback(error);
    }

    _read(size: number): void {
    }

    _write(chunk: any, encoding: BufferEncoding, callback: WriteCallback): void {
        this._writev([{chunk, encoding}], callback);
    }

    _writev(chunks: { chunk: any, encoding: BufferEncoding }[], callback: WriteCallback): void {
        this.#pendingWriteBuffer = Buffer.concat(chunks.map(({ chunk }) => (typeof chunk === "string") ? Buffer.from(chunk, "utf8") : chunk));
        this.#pendingWriteCallback = callback;
        this._maybeProcessPendingWrite();
    }

    private _maybeProcessPendingWrite = (): void => {
        if (this.#pendingWriteCallback === null) {
            return;
        }

        const { readyState } = this.#handle;

        if (readyState === this.#closedStateValue) {
            this._finishPendingWrite(new Error("not connected"));
            return;
        }

        if (readyState !== this.#openStateValue) {
            return;
        }

        const bufferSpaceAvailable = this.#bufferSize - this.#handle.bufferedAmount;
        if (bufferSpaceAvailable === 0) {
            setTimeout(this._maybeProcessPendingWrite, this.#bufferTimeout);
            return;
        }

        const buffer = this.#pendingWriteBuffer!;

        let chunk: Buffer;
        let rest: Buffer | null;
        if (buffer.length > bufferSpaceAvailable) {
            chunk = buffer.slice(0, bufferSpaceAvailable);
            rest = buffer.slice(bufferSpaceAvailable);
        } else {
            chunk = buffer;
            rest = null;
        }

        try {
            this.#handle.send(chunk);
        } catch (e) {
            this._finishPendingWrite(e as Error);
            return;
        }

        if (rest !== null) {
            this.#pendingWriteBuffer = rest;
            setTimeout(this._maybeProcessPendingWrite, this.#bufferTimeout);
            return;
        }

        this._finishPendingWrite(null);
    };

    private _finishPendingWrite(error: Error | null) {
        const cb = this.#pendingWriteCallback!;
        this.#pendingWriteBuffer = null;
        this.#pendingWriteCallback = null;
        cb(error);
    }
}

export interface RTCStreamOptions {
    bufferSize?: number;
    bufferTimeout?: number;
}

type WriteCallback = (error?: Error | null) => void;

export default {
    from(handle: WebSocket | RTCDataChannel, options: RTCStreamOptions = {}): Duplex {
        return new RTCStream(handle, options);
    }
};