import { z } from 'zod';
export declare const entityRefSchema: z.ZodObject<{
    kind: z.ZodString;
    id: z.ZodString;
    version: z.ZodNumber;
}, z.core.$strict>;
export type EntityRef = z.infer<typeof entityRefSchema>;
export declare const changeReceiptSchema: z.ZodObject<{
    receiptId: z.ZodString;
    actionId: z.ZodString;
    revision: z.ZodNumber;
    summary: z.ZodString;
    changed: z.ZodArray<z.ZodObject<{
        kind: z.ZodString;
        id: z.ZodString;
        version: z.ZodNumber;
    }, z.core.$strict>>;
    undoable: z.ZodBoolean;
}, z.core.$strict>;
export type ChangeReceipt = z.infer<typeof changeReceiptSchema>;
export declare const messagePartSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    type: z.ZodLiteral<"text">;
    text: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    type: z.ZodLiteral<"entity_ref">;
    entity: z.ZodObject<{
        kind: z.ZodString;
        id: z.ZodString;
        version: z.ZodNumber;
    }, z.core.$strict>;
    label: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    type: z.ZodLiteral<"activity">;
    status: z.ZodEnum<{
        queued: "queued";
        running: "running";
        waiting: "waiting";
        done: "done";
        failed: "failed";
    }>;
    text: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    type: z.ZodLiteral<"change_receipt">;
    receipt: z.ZodObject<{
        receiptId: z.ZodString;
        actionId: z.ZodString;
        revision: z.ZodNumber;
        summary: z.ZodString;
        changed: z.ZodArray<z.ZodObject<{
            kind: z.ZodString;
            id: z.ZodString;
            version: z.ZodNumber;
        }, z.core.$strict>>;
        undoable: z.ZodBoolean;
    }, z.core.$strict>;
}, z.core.$strict>, z.ZodObject<{
    type: z.ZodLiteral<"warning">;
    text: z.ZodString;
}, z.core.$strict>], "type">;
export type MessagePart = z.infer<typeof messagePartSchema>;
export declare const interactionMessageSchema: z.ZodObject<{
    id: z.ZodString;
    role: z.ZodEnum<{
        user: "user";
        assistant: "assistant";
        system: "system";
    }>;
    parts: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
        type: z.ZodLiteral<"text">;
        text: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        type: z.ZodLiteral<"entity_ref">;
        entity: z.ZodObject<{
            kind: z.ZodString;
            id: z.ZodString;
            version: z.ZodNumber;
        }, z.core.$strict>;
        label: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        type: z.ZodLiteral<"activity">;
        status: z.ZodEnum<{
            queued: "queued";
            running: "running";
            waiting: "waiting";
            done: "done";
            failed: "failed";
        }>;
        text: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        type: z.ZodLiteral<"change_receipt">;
        receipt: z.ZodObject<{
            receiptId: z.ZodString;
            actionId: z.ZodString;
            revision: z.ZodNumber;
            summary: z.ZodString;
            changed: z.ZodArray<z.ZodObject<{
                kind: z.ZodString;
                id: z.ZodString;
                version: z.ZodNumber;
            }, z.core.$strict>>;
            undoable: z.ZodBoolean;
        }, z.core.$strict>;
    }, z.core.$strict>, z.ZodObject<{
        type: z.ZodLiteral<"warning">;
        text: z.ZodString;
    }, z.core.$strict>], "type">>;
    sequence: z.ZodNumber;
    runId: z.ZodNullable<z.ZodString>;
}, z.core.$strict>;
export type InteractionMessage = z.infer<typeof interactionMessageSchema>;
export declare const interactionEventSchema: z.ZodObject<{
    protocolVersion: z.ZodLiteral<1>;
    eventId: z.ZodString;
    workspaceId: z.ZodString;
    sequence: z.ZodNumber;
    type: z.ZodEnum<{
        "message.accepted": "message.accepted";
        "message.updated": "message.updated";
        "workspace.committed": "workspace.committed";
        "run.changed": "run.changed";
        "job.changed": "job.changed";
        "proposal.created": "proposal.created";
        "proposal.resolved": "proposal.resolved";
    }>;
    revision: z.ZodOptional<z.ZodNumber>;
    payload: z.ZodUnknown;
}, z.core.$strict>;
export type InteractionEvent = z.infer<typeof interactionEventSchema>;
export declare const actionEnvelopeSchema: z.ZodObject<{
    actionId: z.ZodString;
    workspaceId: z.ZodString;
    expectedRevision: z.ZodNumber;
    entityVersions: z.ZodArray<z.ZodObject<{
        kind: z.ZodString;
        id: z.ZodString;
        version: z.ZodNumber;
    }, z.core.$strict>>;
    action: z.ZodUnknown;
}, z.core.$strict>;
export type ActionEnvelope = z.infer<typeof actionEnvelopeSchema>;
export interface RuntimeSchema<T> {
    parse(input: unknown): T;
    safeParse(input: unknown): {
        success: true;
        data: T;
    } | {
        success: false;
        error: unknown;
    };
}
export interface DomainActionPlan<State> {
    nextState: State;
    changed: EntityRef[];
    invalidated: string[];
    summary: string;
    undoable: boolean;
}
//# sourceMappingURL=contracts.d.ts.map