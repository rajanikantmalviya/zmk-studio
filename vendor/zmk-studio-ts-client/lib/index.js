import { Request, Response, RequestResponse, Notification } from './studio';
import { get_encoder, get_decoder } from './framing';
import { Mutex } from 'async-mutex';
import { ErrorConditions } from './meta';
export { Request, RequestResponse, Response, Notification };
export function create_rpc_connection(transport, opts) {
    let { writable: request_writable, readable: byte_readable } = new TransformStream({
        transform(chunk, controller) {
            let bytes = Request.encode(chunk).finish();
            controller.enqueue(bytes);
        },
    });
    let reqPipelineClosed = byte_readable
        .pipeThrough(new TransformStream(get_encoder()), { signal: opts?.signal })
        .pipeTo(transport.writable, { signal: opts?.signal });
    reqPipelineClosed.catch((r) => { console.log("Closed error", r); return r; }).then(async (reason) => {
        await byte_readable.cancel();
        transport.abortController.abort(reason);
    });
    let response_readable = transport.readable
        .pipeThrough(new TransformStream(get_decoder()), { signal: opts?.signal })
        .pipeThrough(new TransformStream({
        transform(chunk, controller) {
            controller.enqueue(Response.decode(chunk));
        },
    }), { signal: opts?.signal });
    let [a, b] = response_readable.tee();
    let request_response_readable = a.pipeThrough(new TransformStream({
        transform(chunk, controller) {
            if (chunk.requestResponse) {
                controller.enqueue(chunk.requestResponse);
            }
        },
    }), { signal: opts?.signal });
    let notification_readable = b.pipeThrough(new TransformStream({
        transform(chunk, controller) {
            if (chunk.notification) {
                controller.enqueue(chunk.notification);
            }
        },
    }), { signal: opts?.signal });
    return {
        label: transport.label,
        request_response_readable,
        request_writable,
        notification_readable,
        current_request: 0,
    };
}
const rpcMutex = new Mutex();
export class NoResponseError extends Error {
    constructor() {
        super("No RPC response received");
        Object.setPrototypeOf(this, NoResponseError.prototype);
    }
}
export class MetaError extends Error {
    condition;
    constructor(condition) {
        super("Meta error: " + condition);
        this.condition = condition;
        Object.setPrototypeOf(this, MetaError.prototype);
    }
}
export async function call_rpc(conn, req) {
    return await rpcMutex.runExclusive(async () => {
        let request = { ...req, requestId: conn.current_request++ };
        let writer = conn.request_writable.getWriter();
        try {
            await writer.write(request);
        }
        finally {
            writer.releaseLock();
        }
        let reader = conn.request_response_readable.getReader();
        let result;
        try {
            result = await reader.read();
        }
        finally {
            reader.releaseLock();
        }
        let { done, value } = result;
        if (done || !value) {
            throw 'No response';
        }
        // Legacy firmware omits the request ID when rejecting an unknown subsystem.
        // Accept that reply only for read-only custom capability discovery.
        const legacyDiscoveryError = req.custom?.listCustomSubsystems !== undefined &&
            req.custom.call === undefined &&
            req.core === undefined && req.behaviors === undefined && req.keymap === undefined &&
            value.requestId === 0 &&
            value.meta?.simpleError === ErrorConditions.RPC_NOT_FOUND;
        if (value.requestId != request.requestId && !legacyDiscoveryError) {
            throw 'Mismatch request IDs';
        }
        if (value.meta?.noResponse) {
            throw new NoResponseError();
        }
        else if (value.meta?.simpleError !== undefined) {
            throw new MetaError(value.meta.simpleError);
        }
        return value;
    });
}
