import { z } from 'zod';
export declare const entityRefSchema: z.ZodObject<{
    kind: z.ZodString;
    id: z.ZodString;
    version: z.ZodNumber;
}, "strict", z.ZodTypeAny, {
    kind: string;
    id: string;
    version: number;
}, {
    kind: string;
    id: string;
    version: number;
}>;
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
    }, "strict", z.ZodTypeAny, {
        kind: string;
        id: string;
        version: number;
    }, {
        kind: string;
        id: string;
        version: number;
    }>, "many">;
    undoable: z.ZodBoolean;
}, "strict", z.ZodTypeAny, {
    receiptId: string;
    actionId: string;
    revision: number;
    summary: string;
    changed: {
        kind: string;
        id: string;
        version: number;
    }[];
    undoable: boolean;
}, {
    receiptId: string;
    actionId: string;
    revision: number;
    summary: string;
    changed: {
        kind: string;
        id: string;
        version: number;
    }[];
    undoable: boolean;
}>;
export type ChangeReceipt = z.infer<typeof changeReceiptSchema>;
export declare const messagePartSchema: z.ZodDiscriminatedUnion<"type", [z.ZodObject<{
    type: z.ZodLiteral<"text">;
    text: z.ZodString;
}, "strict", z.ZodTypeAny, {
    type: "text";
    text: string;
}, {
    type: "text";
    text: string;
}>, z.ZodObject<{
    type: z.ZodLiteral<"entity_ref">;
    entity: z.ZodObject<{
        kind: z.ZodString;
        id: z.ZodString;
        version: z.ZodNumber;
    }, "strict", z.ZodTypeAny, {
        kind: string;
        id: string;
        version: number;
    }, {
        kind: string;
        id: string;
        version: number;
    }>;
    label: z.ZodString;
}, "strict", z.ZodTypeAny, {
    type: "entity_ref";
    entity: {
        kind: string;
        id: string;
        version: number;
    };
    label: string;
}, {
    type: "entity_ref";
    entity: {
        kind: string;
        id: string;
        version: number;
    };
    label: string;
}>, z.ZodObject<{
    type: z.ZodLiteral<"activity">;
    status: z.ZodEnum<["queued", "running", "waiting", "done", "failed"]>;
    text: z.ZodString;
}, "strict", z.ZodTypeAny, {
    type: "activity";
    status: "queued" | "running" | "waiting" | "done" | "failed";
    text: string;
}, {
    type: "activity";
    status: "queued" | "running" | "waiting" | "done" | "failed";
    text: string;
}>, z.ZodObject<{
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
        }, "strict", z.ZodTypeAny, {
            kind: string;
            id: string;
            version: number;
        }, {
            kind: string;
            id: string;
            version: number;
        }>, "many">;
        undoable: z.ZodBoolean;
    }, "strict", z.ZodTypeAny, {
        receiptId: string;
        actionId: string;
        revision: number;
        summary: string;
        changed: {
            kind: string;
            id: string;
            version: number;
        }[];
        undoable: boolean;
    }, {
        receiptId: string;
        actionId: string;
        revision: number;
        summary: string;
        changed: {
            kind: string;
            id: string;
            version: number;
        }[];
        undoable: boolean;
    }>;
}, "strict", z.ZodTypeAny, {
    type: "change_receipt";
    receipt: {
        receiptId: string;
        actionId: string;
        revision: number;
        summary: string;
        changed: {
            kind: string;
            id: string;
            version: number;
        }[];
        undoable: boolean;
    };
}, {
    type: "change_receipt";
    receipt: {
        receiptId: string;
        actionId: string;
        revision: number;
        summary: string;
        changed: {
            kind: string;
            id: string;
            version: number;
        }[];
        undoable: boolean;
    };
}>, z.ZodObject<{
    type: z.ZodLiteral<"warning">;
    text: z.ZodString;
}, "strict", z.ZodTypeAny, {
    type: "warning";
    text: string;
}, {
    type: "warning";
    text: string;
}>]>;
export type MessagePart = z.infer<typeof messagePartSchema>;
export declare const interactionMessageSchema: z.ZodObject<{
    id: z.ZodString;
    role: z.ZodEnum<["user", "assistant", "system"]>;
    parts: z.ZodArray<z.ZodDiscriminatedUnion<"type", [z.ZodObject<{
        type: z.ZodLiteral<"text">;
        text: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        type: "text";
        text: string;
    }, {
        type: "text";
        text: string;
    }>, z.ZodObject<{
        type: z.ZodLiteral<"entity_ref">;
        entity: z.ZodObject<{
            kind: z.ZodString;
            id: z.ZodString;
            version: z.ZodNumber;
        }, "strict", z.ZodTypeAny, {
            kind: string;
            id: string;
            version: number;
        }, {
            kind: string;
            id: string;
            version: number;
        }>;
        label: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        type: "entity_ref";
        entity: {
            kind: string;
            id: string;
            version: number;
        };
        label: string;
    }, {
        type: "entity_ref";
        entity: {
            kind: string;
            id: string;
            version: number;
        };
        label: string;
    }>, z.ZodObject<{
        type: z.ZodLiteral<"activity">;
        status: z.ZodEnum<["queued", "running", "waiting", "done", "failed"]>;
        text: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        type: "activity";
        status: "queued" | "running" | "waiting" | "done" | "failed";
        text: string;
    }, {
        type: "activity";
        status: "queued" | "running" | "waiting" | "done" | "failed";
        text: string;
    }>, z.ZodObject<{
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
            }, "strict", z.ZodTypeAny, {
                kind: string;
                id: string;
                version: number;
            }, {
                kind: string;
                id: string;
                version: number;
            }>, "many">;
            undoable: z.ZodBoolean;
        }, "strict", z.ZodTypeAny, {
            receiptId: string;
            actionId: string;
            revision: number;
            summary: string;
            changed: {
                kind: string;
                id: string;
                version: number;
            }[];
            undoable: boolean;
        }, {
            receiptId: string;
            actionId: string;
            revision: number;
            summary: string;
            changed: {
                kind: string;
                id: string;
                version: number;
            }[];
            undoable: boolean;
        }>;
    }, "strict", z.ZodTypeAny, {
        type: "change_receipt";
        receipt: {
            receiptId: string;
            actionId: string;
            revision: number;
            summary: string;
            changed: {
                kind: string;
                id: string;
                version: number;
            }[];
            undoable: boolean;
        };
    }, {
        type: "change_receipt";
        receipt: {
            receiptId: string;
            actionId: string;
            revision: number;
            summary: string;
            changed: {
                kind: string;
                id: string;
                version: number;
            }[];
            undoable: boolean;
        };
    }>, z.ZodObject<{
        type: z.ZodLiteral<"warning">;
        text: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        type: "warning";
        text: string;
    }, {
        type: "warning";
        text: string;
    }>]>, "many">;
    sequence: z.ZodNumber;
    runId: z.ZodNullable<z.ZodString>;
}, "strict", z.ZodTypeAny, {
    id: string;
    role: "user" | "assistant" | "system";
    parts: ({
        type: "text";
        text: string;
    } | {
        type: "entity_ref";
        entity: {
            kind: string;
            id: string;
            version: number;
        };
        label: string;
    } | {
        type: "activity";
        status: "queued" | "running" | "waiting" | "done" | "failed";
        text: string;
    } | {
        type: "change_receipt";
        receipt: {
            receiptId: string;
            actionId: string;
            revision: number;
            summary: string;
            changed: {
                kind: string;
                id: string;
                version: number;
            }[];
            undoable: boolean;
        };
    } | {
        type: "warning";
        text: string;
    })[];
    sequence: number;
    runId: string | null;
}, {
    id: string;
    role: "user" | "assistant" | "system";
    parts: ({
        type: "text";
        text: string;
    } | {
        type: "entity_ref";
        entity: {
            kind: string;
            id: string;
            version: number;
        };
        label: string;
    } | {
        type: "activity";
        status: "queued" | "running" | "waiting" | "done" | "failed";
        text: string;
    } | {
        type: "change_receipt";
        receipt: {
            receiptId: string;
            actionId: string;
            revision: number;
            summary: string;
            changed: {
                kind: string;
                id: string;
                version: number;
            }[];
            undoable: boolean;
        };
    } | {
        type: "warning";
        text: string;
    })[];
    sequence: number;
    runId: string | null;
}>;
export type InteractionMessage = z.infer<typeof interactionMessageSchema>;
export declare const interactionEventSchema: z.ZodObject<{
    protocolVersion: z.ZodLiteral<1>;
    eventId: z.ZodString;
    workspaceId: z.ZodString;
    sequence: z.ZodNumber;
    type: z.ZodEnum<["message.accepted", "message.updated", "workspace.committed", "run.changed", "job.changed", "proposal.created", "proposal.resolved"]>;
    revision: z.ZodOptional<z.ZodNumber>;
    payload: z.ZodUnknown;
}, "strict", z.ZodTypeAny, {
    type: "message.accepted" | "message.updated" | "workspace.committed" | "run.changed" | "job.changed" | "proposal.created" | "proposal.resolved";
    sequence: number;
    protocolVersion: 1;
    eventId: string;
    workspaceId: string;
    revision?: number | undefined;
    payload?: unknown;
}, {
    type: "message.accepted" | "message.updated" | "workspace.committed" | "run.changed" | "job.changed" | "proposal.created" | "proposal.resolved";
    sequence: number;
    protocolVersion: 1;
    eventId: string;
    workspaceId: string;
    revision?: number | undefined;
    payload?: unknown;
}>;
export type InteractionEvent = z.infer<typeof interactionEventSchema>;
export declare const actionEnvelopeSchema: z.ZodObject<{
    actionId: z.ZodString;
    workspaceId: z.ZodString;
    expectedRevision: z.ZodNumber;
    entityVersions: z.ZodArray<z.ZodObject<{
        kind: z.ZodString;
        id: z.ZodString;
        version: z.ZodNumber;
    }, "strict", z.ZodTypeAny, {
        kind: string;
        id: string;
        version: number;
    }, {
        kind: string;
        id: string;
        version: number;
    }>, "many">;
    action: z.ZodUnknown;
}, "strict", z.ZodTypeAny, {
    actionId: string;
    workspaceId: string;
    expectedRevision: number;
    entityVersions: {
        kind: string;
        id: string;
        version: number;
    }[];
    action?: unknown;
}, {
    actionId: string;
    workspaceId: string;
    expectedRevision: number;
    entityVersions: {
        kind: string;
        id: string;
        version: number;
    }[];
    action?: unknown;
}>;
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
export interface TypedActionDefinition<TType extends string, TInput> {
    type: TType;
    schema?: RuntimeSchema<TInput>;
    create(payload: TInput): {
        type: TType;
    } & TInput;
}
export declare function defineAction<TType extends string, TInput = Record<string, unknown>>(type: TType, schema?: RuntimeSchema<TInput>): TypedActionDefinition<TType, TInput>;
//# sourceMappingURL=contracts.d.ts.map