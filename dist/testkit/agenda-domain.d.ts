import { z } from 'zod';
import { type DomainActionPlan } from '../core/contracts';
import type { DomainDefinition } from '../runtime/handlers';
export declare const agendaItemSchema: z.ZodObject<{
    id: z.ZodString;
    version: z.ZodNumber;
    title: z.ZodString;
    durationMinutes: z.ZodNumber;
    presenter: z.ZodString;
    pinned: z.ZodBoolean;
}, "strict", z.ZodTypeAny, {
    id: string;
    version: number;
    title: string;
    durationMinutes: number;
    presenter: string;
    pinned: boolean;
}, {
    id: string;
    version: number;
    title: string;
    durationMinutes: number;
    presenter: string;
    pinned: boolean;
}>;
export type AgendaItem = z.infer<typeof agendaItemSchema>;
export declare const agendaWorkspaceSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    meetingTitle: z.ZodString;
    date: z.ZodString;
    items: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        version: z.ZodNumber;
        title: z.ZodString;
        durationMinutes: z.ZodNumber;
        presenter: z.ZodString;
        pinned: z.ZodBoolean;
    }, "strict", z.ZodTypeAny, {
        id: string;
        version: number;
        title: string;
        durationMinutes: number;
        presenter: string;
        pinned: boolean;
    }, {
        id: string;
        version: number;
        title: string;
        durationMinutes: number;
        presenter: string;
        pinned: boolean;
    }>, "many">;
}, "strict", z.ZodTypeAny, {
    date: string;
    schemaVersion: 1;
    meetingTitle: string;
    items: {
        id: string;
        version: number;
        title: string;
        durationMinutes: number;
        presenter: string;
        pinned: boolean;
    }[];
}, {
    date: string;
    schemaVersion: 1;
    meetingTitle: string;
    items: {
        id: string;
        version: number;
        title: string;
        durationMinutes: number;
        presenter: string;
        pinned: boolean;
    }[];
}>;
export type AgendaWorkspace = z.infer<typeof agendaWorkspaceSchema>;
export declare const agendaActionSchema: z.ZodDiscriminatedUnion<"type", [z.ZodObject<{
    type: z.ZodLiteral<"set_meeting_title">;
    title: z.ZodString;
}, "strict", z.ZodTypeAny, {
    type: "set_meeting_title";
    title: string;
}, {
    type: "set_meeting_title";
    title: string;
}>, z.ZodObject<{
    type: z.ZodLiteral<"edit_item">;
    itemId: z.ZodString;
    title: z.ZodOptional<z.ZodString>;
    durationMinutes: z.ZodOptional<z.ZodNumber>;
}, "strict", z.ZodTypeAny, {
    type: "edit_item";
    itemId: string;
    title?: string | undefined;
    durationMinutes?: number | undefined;
}, {
    type: "edit_item";
    itemId: string;
    title?: string | undefined;
    durationMinutes?: number | undefined;
}>, z.ZodObject<{
    type: z.ZodLiteral<"set_item_pin">;
    itemId: z.ZodString;
    pinned: z.ZodBoolean;
}, "strict", z.ZodTypeAny, {
    type: "set_item_pin";
    pinned: boolean;
    itemId: string;
}, {
    type: "set_item_pin";
    pinned: boolean;
    itemId: string;
}>, z.ZodObject<{
    type: z.ZodLiteral<"reorder_items">;
    itemIds: z.ZodArray<z.ZodString, "many">;
}, "strict", z.ZodTypeAny, {
    type: "reorder_items";
    itemIds: string[];
}, {
    type: "reorder_items";
    itemIds: string[];
}>]>;
export type AgendaAction = z.infer<typeof agendaActionSchema>;
export interface AgendaActionContext {
    actionId: string;
    workspaceId: string;
    expectedRevision: number;
    currentRevision: number;
    entityVersions: ReadonlyMap<string, number>;
}
export declare function planAgendaAction(state: AgendaWorkspace, actionInput: unknown, context: AgendaActionContext): DomainActionPlan<AgendaWorkspace>;
export declare const sampleAgenda: AgendaWorkspace;
export declare const agendaDomain: DomainDefinition<AgendaWorkspace>;
//# sourceMappingURL=agenda-domain.d.ts.map