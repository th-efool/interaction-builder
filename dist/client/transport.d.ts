import { type InteractionTransport } from './store';
export interface HttpTransportOptions {
    baseUrl?: string;
    workspaceId: string;
    fetch?: typeof globalThis.fetch;
}
export declare function parseSseStream(stream: ReadableStream<Uint8Array>, onEvent: (event: unknown) => void, onClose: () => void): void;
export declare function createHttpTransport<View>(opts: HttpTransportOptions): InteractionTransport<View>;
//# sourceMappingURL=transport.d.ts.map