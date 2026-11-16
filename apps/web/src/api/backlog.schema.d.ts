/**
 * This file was generated from contracts/openapi/backlog-api.json by `pnpm api:types`. Do not edit.
 */

export interface paths {
    "/healthz": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Liveness probe */
        get: operations["healthz"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/readyz": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Readiness probe (database reachable) */
        get: operations["readyz"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/me": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The signed-in user */
        get: operations["get_me"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/projects": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Projects you are a member of */
        get: operations["list_projects"];
        put?: never;
        /** Create a project (you become its owner) */
        post: operations["create_project"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/projects/{project_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a project */
        get: operations["get_project"];
        put?: never;
        post?: never;
        /** Delete a project and everything in it (owners) */
        delete: operations["delete_project"];
        options?: never;
        head?: never;
        /** Rename a project (owners; requires If-Match) */
        patch: operations["update_project"];
        trace?: never;
    };
    "/projects/{project_id}/members": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Members of a project */
        get: operations["list_members"];
        put?: never;
        /** Add a member by email address (owners; access is immediate) */
        post: operations["add_member"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/projects/{project_id}/members/{email}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Remove a member (owners) or leave the project (yourself) */
        delete: operations["remove_member"];
        options?: never;
        head?: never;
        /** Change a member's role (owners) */
        patch: operations["update_member"];
        trace?: never;
    };
    "/projects/{project_id}/guidance": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Effective guidance of a project (members) */
        get: operations["get_guidance"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/projects/{project_id}/guidance/defaults": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Skill defaults to compare an override with (members) */
        get: operations["get_guidance_defaults"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/projects/{project_id}/guidance/principles": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** Override the agent principles (owners) */
        put: operations["put_principles"];
        post?: never;
        /** Restore the default agent principles (owners) */
        delete: operations["delete_principles"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/projects/{project_id}/guidance/{kind}/{item_type}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** Override type instructions or a template (owners) */
        put: operations["put_type_guidance"];
        post?: never;
        /** Restore the default type instructions or template (owners) */
        delete: operations["delete_type_guidance"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/projects/{project_id}/guidance/export": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Export the project's guidance as format v5 (members)
         * @description Contains only the project's overrides with their base skill versions. With `includeDefaults=true` the effective text of every entry is included (defaults carry the current skill version).
         */
        get: operations["export_guidance"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/projects/{project_id}/guidance/import": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Replace the project's guidance overrides from an export (owners)
         * @description Accepts format `backlog-guidance` version 5, or a version 4 configuration export of the single-user app (principles, type instructions and templates; the free-text `instructions` field is ignored). Everything is validated first; all overrides are then replaced in one transaction. Entries identical to the current skill default are not stored, and entries missing from the document fall back to the default.
         */
        post: operations["import_guidance"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/projects/{project_id}/sources": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List the sources of a project */
        get: operations["list_sources"];
        put?: never;
        /**
         * Add a source (file upload, URL or pasted text)
         * @description Multipart (`file`, optional `name`, `mode`) or JSON (`{url, pastedText?, name?, mode?}` or `{text, name, mode?}`). Files: PDF (page and size limits from settings) or UTF-8 text, checked by content. A URL is fetched by the server (https, public addresses only); if that fails the response is 422 `url-fetch-failed` and the client can resend the URL with `pastedText`.
         */
        post: operations["create_source"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/projects/{project_id}/sources/{source_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a source (metadata and extracted text) */
        get: operations["get_source"];
        put?: never;
        post?: never;
        /** Delete a source */
        delete: operations["delete_source"];
        options?: never;
        head?: never;
        /** Rename a source or change its mode (requires If-Match) */
        patch: operations["update_source"];
        trace?: never;
    };
    "/projects/{project_id}/sources/{source_id}/file": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Download the original file of a source */
        get: operations["download_source_file"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/projects/{project_id}/items": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List the items of a project (flat, tree-friendly) */
        get: operations["list_items"];
        put?: never;
        /** Create an item from the project's template */
        post: operations["create_item"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/projects/{project_id}/items/{item_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get an item with its document (ETag = version) */
        get: operations["get_item"];
        put?: never;
        post?: never;
        /** Delete an item (its relationships go with it; related items are kept) */
        delete: operations["delete_item"];
        options?: never;
        head?: never;
        /**
         * Change title, document and/or status (requires If-Match)
         * @description Send `If-Match: <version>`. A stale version returns 409 `version-conflict` with `currentVersion`, `changedSections` (sections changed since the version you based the edit on) and the current `item`. Status changes are validated against the allowed transitions (422 `invalid-status-transition`).
         */
        patch: operations["update_item"];
        trace?: never;
    };
    "/projects/{project_id}/items/{item_id}/quality": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Store a quality assessment for the current document
         * @description `documentHash` must equal the item's current `documentHash`, otherwise 409 `stale-assessment`.
         */
        put: operations["set_item_quality"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/projects/{project_id}/items/{item_id}/revisions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Revision history of an item (newest first, without documents) */
        get: operations["list_item_revisions"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/projects/{project_id}/items/{item_id}/revisions/{revision_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** A revision with its document */
        get: operations["get_item_revision"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/projects/{project_id}/items/{item_id}/revisions/{revision_id}/restore": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Restore a revision as a new version (origin restore)
         * @description Optionally send `If-Match: <version>` to fail with 409 when the item changed in the meantime.
         */
        post: operations["restore_item_revision"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/projects/{project_id}/relationships": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** All relationships of a project */
        get: operations["list_relationships"];
        put?: never;
        /**
         * Link two items
         * @description Rules: no self-links (422), both items in the project (404), no duplicates (409; `related-to` is symmetric), one parent per item (409), no parent cycles (409) and only capability → feature/enabler and feature → user-story/enabler as `parent-child` (422).
         */
        post: operations["create_relationship"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/projects/{project_id}/relationships/{relationship_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Remove a relationship */
        delete: operations["delete_relationship"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        /** DefaultEntryOut */
        DefaultEntryOut: {
            /** Content */
            content: string;
            /** Skill */
            skill: string;
            /** Version */
            version: string;
        };
        /** DefaultGuidanceOut */
        DefaultGuidanceOut: {
            principles: components["schemas"]["DefaultEntryOut"];
            /** Typeinstructions */
            typeInstructions: {
                [key: string]: components["schemas"]["DefaultEntryOut"];
            };
            /** Templates */
            templates: {
                [key: string]: components["schemas"]["DefaultEntryOut"];
            };
            /** Documentformat */
            documentFormat: string;
            /** Skills */
            skills: {
                [key: string]: string;
            };
        };
        /** EffectiveGuidanceOut */
        EffectiveGuidanceOut: {
            principles: components["schemas"]["GuidanceEntryOut"];
            /**
             * Typeinstructions
             * @description Keyed by item type.
             */
            typeInstructions: {
                [key: string]: components["schemas"]["GuidanceEntryOut"];
            };
            /**
             * Templates
             * @description Keyed by item type.
             */
            templates: {
                [key: string]: components["schemas"]["GuidanceEntryOut"];
            };
            /**
             * Documentformat
             * @description Read-only document format rules of the core skill.
             */
            documentFormat: string;
            /**
             * Skills
             * @description Skill name to current version.
             */
            skills: {
                [key: string]: string;
            };
        };
        /** ExportEntry */
        ExportEntry: {
            /** Content */
            content: string;
            /** Baseskillversion */
            baseSkillVersion?: string | null;
        };
        /** ExportGuidance */
        ExportGuidance: {
            principles?: components["schemas"]["ExportEntry"] | null;
            /** Typeinstructions */
            typeInstructions?: {
                [key: string]: components["schemas"]["ExportEntry"];
            };
            /** Templates */
            templates?: {
                [key: string]: components["schemas"]["ExportEntry"];
            };
        };
        /** ExportProject */
        ExportProject: {
            /** Id */
            id: string;
            /** Name */
            name: string;
        };
        /** GuidanceEntryOut */
        GuidanceEntryOut: {
            /**
             * Kind
             * @enum {string}
             */
            kind: "principles" | "type-instructions" | "template";
            /**
             * Itemtype
             * @description Backlog item type; null for the agent principles.
             */
            itemType: ("capability" | "feature" | "user-story" | "enabler") | null;
            /**
             * Content
             * @description The effective text.
             */
            content: string;
            /**
             * Source
             * @description Whether the skill default or a project override applies.
             * @enum {string}
             */
            source: "default" | "project";
            /**
             * Defaultskill
             * @description Name of the skill that provides the default.
             */
            defaultSkill: string;
            /**
             * Defaultversion
             * @description Current version of that skill.
             */
            defaultVersion: string;
            /**
             * Baseskillversion
             * @description Skill version the override was edited from.
             */
            baseSkillVersion: string | null;
            /**
             * Differsfromdefault
             * @description The override's text differs from the current skill default.
             */
            differsFromDefault: boolean;
            /**
             * Outdated
             * @description The override is based on an older skill version than the current default.
             */
            outdated: boolean;
            /**
             * Version
             * @description Override version, the ETag for writes; 0 while the default applies.
             */
            version: number;
            /** Updatedby */
            updatedBy: string | null;
            /** Updatedat */
            updatedAt: string | null;
        };
        /** GuidanceExport */
        GuidanceExport: {
            /**
             * Format
             * @default backlog-guidance
             * @constant
             */
            format: "backlog-guidance";
            /**
             * Formatversion
             * @default 5
             * @constant
             */
            formatVersion: 5;
            /**
             * Exportedat
             * Format: date-time
             */
            exportedAt: string;
            project: components["schemas"]["ExportProject"];
            /**
             * Skills
             * @description Skill name to its current version at export time.
             */
            skills: {
                [key: string]: string;
            };
            guidance: components["schemas"]["ExportGuidance"];
        };
        /** GuidanceWrite */
        GuidanceWrite: {
            /**
             * Content
             * @description The new text; templates must be placeholder-free Markdown.
             */
            content: string;
            /**
             * Baseskillversion
             * @description Skill version this text was edited from; defaults to the existing base or the current version.
             */
            baseSkillVersion?: string | null;
        };
        /** ItemCreate */
        ItemCreate: {
            /**
             * Type
             * @enum {string}
             */
            type: "capability" | "feature" | "user-story" | "enabler";
            /**
             * Title
             * @description Defaults to 'Untitled <Type>'.
             */
            title?: string | null;
            /**
             * Document
             * @description Markdown; conformed to the type's template. Empty template structure by default.
             */
            document?: string | null;
            /**
             * Parentid
             * @description Creates a parent-child relationship.
             */
            parentId?: string | null;
        };
        /** ItemList */
        ItemList: {
            /** Items */
            items: components["schemas"]["ItemSummary"][];
        };
        /** ItemOut */
        ItemOut: {
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /**
             * Projectid
             * Format: uuid
             */
            projectId: string;
            /** Parentid */
            parentId: string | null;
            /**
             * Type
             * @enum {string}
             */
            type: "capability" | "feature" | "user-story" | "enabler";
            /** Title */
            title: string;
            /** Document */
            document: string;
            /**
             * Status
             * @enum {string}
             */
            status: "draft" | "refining" | "ready" | "ready-with-open-questions" | "complete";
            /** Version */
            version: number;
            /**
             * Documenthash
             * @description SHA-256 of the normalised document.
             */
            documentHash: string;
            quality: components["schemas"]["QualityOut"] | null;
            /** Createdby */
            createdBy: string;
            /** Updatedby */
            updatedBy: string;
            /**
             * Createdat
             * Format: date-time
             */
            createdAt: string;
            /**
             * Updatedat
             * Format: date-time
             */
            updatedAt: string;
        };
        /** ItemSummary */
        ItemSummary: {
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Parentid */
            parentId: string | null;
            /**
             * Type
             * @enum {string}
             */
            type: "capability" | "feature" | "user-story" | "enabler";
            /** Title */
            title: string;
            /**
             * Status
             * @enum {string}
             */
            status: "draft" | "refining" | "ready" | "ready-with-open-questions" | "complete";
            /** Version */
            version: number;
            quality: components["schemas"]["QualitySummary"] | null;
            /**
             * Updatedat
             * Format: date-time
             */
            updatedAt: string;
            /** Updatedby */
            updatedBy: string;
        };
        /** ItemUpdate */
        ItemUpdate: {
            /** Title */
            title?: string | null;
            /** Document */
            document?: string | null;
            /** Status */
            status?: ("draft" | "refining" | "ready" | "ready-with-open-questions" | "complete") | null;
        };
        /** Me */
        Me: {
            /** Email */
            email: string;
            /** Name */
            name: string | null;
            /** Sub */
            sub: string | null;
        };
        /** MemberAdd */
        MemberAdd: {
            /** Email */
            email: string;
            /**
             * Role
             * @default contributor
             * @enum {string}
             */
            role: "owner" | "contributor";
        };
        /** MemberList */
        MemberList: {
            /** Items */
            items: components["schemas"]["MemberOut"][];
        };
        /** MemberOut */
        MemberOut: {
            /** Email */
            email: string;
            /**
             * Role
             * @enum {string}
             */
            role: "owner" | "contributor";
            /**
             * Name
             * @description Display name once the member has signed in; otherwise null.
             */
            name: string | null;
            /**
             * Signedin
             * @description Whether this email address has signed in at least once.
             */
            signedIn: boolean;
            /** Addedby */
            addedBy: string;
            /**
             * Addedat
             * Format: date-time
             */
            addedAt: string;
        };
        /** MemberUpdate */
        MemberUpdate: {
            /**
             * Role
             * @enum {string}
             */
            role: "owner" | "contributor";
        };
        /** PinnedBudgetOut */
        PinnedBudgetOut: {
            /**
             * Used
             * @description Characters of all pinned sources.
             */
            used: number;
            /**
             * Limit
             * @description Maximum characters of pinned sources per project.
             */
            limit: number;
        };
        /** ProjectCreate */
        ProjectCreate: {
            /**
             * Name
             * @description Display name of the project.
             */
            name: string;
        };
        /** ProjectList */
        ProjectList: {
            /** Items */
            items: components["schemas"]["ProjectOut"][];
        };
        /** ProjectOut */
        ProjectOut: {
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Name */
            name: string;
            /** Version */
            version: number;
            /**
             * Role
             * @description The caller's role in this project.
             * @enum {string}
             */
            role: "owner" | "contributor";
            /** Createdby */
            createdBy: string;
            /**
             * Createdat
             * Format: date-time
             */
            createdAt: string;
            /**
             * Updatedat
             * Format: date-time
             */
            updatedAt: string;
        };
        /** ProjectUpdate */
        ProjectUpdate: {
            /**
             * Name
             * @description Display name of the project.
             */
            name: string;
        };
        /** QualityArea */
        QualityArea: {
            /**
             * Area
             * @enum {string}
             */
            area: "problem" | "objective" | "outcome" | "beneficiary" | "value" | "scope" | "acceptance-criteria" | "dependencies" | "contradictions" | "assumptions" | "implementation-detail" | "testability" | "solution-independence" | "abstraction" | "lean-scope" | "vertical-slicing";
            /**
             * Level
             * @enum {string}
             */
            level: "clear" | "unclear" | "missing" | "not-applicable";
            /** Note */
            note?: string | null;
        };
        /**
         * QualityAssessment
         * @description A quality assessment of an item's document (mirrors the SPA's ``QualityAssessmentSchema``).
         */
        QualityAssessment: {
            /** Areas */
            areas?: components["schemas"]["QualityArea"][];
            /**
             * Overall
             * @enum {string}
             */
            overall: "needs-clarification" | "ready" | "ready-with-open-questions";
            /** Excessivetechnicaldetail */
            excessiveTechnicalDetail?: boolean | null;
            /** Speculativescope */
            speculativeScope?: boolean | null;
            /** Unnecessaryconfigurability */
            unnecessaryConfigurability?: boolean | null;
            /** Mixedoutcomes */
            mixedOutcomes?: boolean | null;
            /** Suggesteditemtype */
            suggestedItemType?: ("capability" | "feature" | "user-story" | "enabler") | null;
            /** Suggestedsplit */
            suggestedSplit?: string[] | null;
            /** Excludedfollowupcandidates */
            excludedFollowUpCandidates?: string[] | null;
            /** Summary */
            summary?: string | null;
        };
        /** QualityOut */
        QualityOut: {
            /**
             * Assessment
             * @description The stored assessment (see QualityAssessment).
             */
            assessment: {
                [key: string]: unknown;
            };
            /** Assessedat */
            assessedAt: string | null;
            /**
             * Documenthash
             * @description Hash of the document that was assessed.
             */
            documentHash: string | null;
            /**
             * Stale
             * @description True when the document changed after the assessment.
             */
            stale: boolean;
        };
        /** QualitySummary */
        QualitySummary: {
            /** Overall */
            overall: ("needs-clarification" | "ready" | "ready-with-open-questions") | null;
            /** Assessedat */
            assessedAt: string | null;
            /** Stale */
            stale: boolean;
        };
        /** QualityUpdate */
        QualityUpdate: {
            quality: components["schemas"]["QualityAssessment"];
            /**
             * Documenthash
             * @description Hash of the document that was assessed (from the item).
             */
            documentHash: string;
        };
        /** RelationshipCreate */
        RelationshipCreate: {
            /**
             * Sourceid
             * Format: uuid
             */
            sourceId: string;
            /**
             * Targetid
             * Format: uuid
             */
            targetId: string;
            /**
             * Type
             * @enum {string}
             */
            type: "parent-child" | "supports" | "depends-on" | "related-to";
        };
        /** RelationshipList */
        RelationshipList: {
            /** Items */
            items: components["schemas"]["RelationshipOut"][];
        };
        /** RelationshipOut */
        RelationshipOut: {
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /**
             * Projectid
             * Format: uuid
             */
            projectId: string;
            /**
             * Sourceid
             * Format: uuid
             */
            sourceId: string;
            /**
             * Targetid
             * Format: uuid
             */
            targetId: string;
            /**
             * Type
             * @enum {string}
             */
            type: "parent-child" | "supports" | "depends-on" | "related-to";
        };
        /** RevisionList */
        RevisionList: {
            /** Items */
            items: components["schemas"]["RevisionSummary"][];
        };
        /** RevisionOut */
        RevisionOut: {
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /**
             * Itemid
             * Format: uuid
             */
            itemId: string;
            /** Version */
            version: number;
            /** Title */
            title: string;
            /**
             * Origin
             * @enum {string}
             */
            origin: "manual" | "agent" | "restore";
            /** Label */
            label: string | null;
            /** Actor */
            actor: string;
            /** Runid */
            runId: string | null;
            /**
             * Createdat
             * Format: date-time
             */
            createdAt: string;
            /** Document */
            document: string;
        };
        /** RevisionSummary */
        RevisionSummary: {
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /**
             * Itemid
             * Format: uuid
             */
            itemId: string;
            /** Version */
            version: number;
            /** Title */
            title: string;
            /**
             * Origin
             * @enum {string}
             */
            origin: "manual" | "agent" | "restore";
            /** Label */
            label: string | null;
            /** Actor */
            actor: string;
            /** Runid */
            runId: string | null;
            /**
             * Createdat
             * Format: date-time
             */
            createdAt: string;
        };
        /** SourceDetail */
        SourceDetail: {
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /**
             * Projectid
             * Format: uuid
             */
            projectId: string;
            /** Name */
            name: string;
            /**
             * Kind
             * @enum {string}
             */
            kind: "file" | "url" | "text";
            /**
             * Mode
             * @enum {string}
             */
            mode: "pinned" | "searchable" | "excluded";
            /** Url */
            url: string | null;
            /** Charcount */
            charCount: number;
            /**
             * Pagecount
             * @description Number of PDF pages; null for other sources.
             */
            pageCount: number | null;
            /** Mediatype */
            mediaType: string | null;
            /**
             * Hasfile
             * @description Whether the original can be downloaded from `/file`.
             */
            hasFile: boolean;
            /**
             * Indexstatus
             * @enum {string}
             */
            indexStatus: "pending" | "indexing" | "indexed" | "failed" | "skipped";
            /** Indexerror */
            indexError: string | null;
            /** Version */
            version: number;
            /** Addedby */
            addedBy: string;
            /**
             * Createdat
             * Format: date-time
             */
            createdAt: string;
            /**
             * Updatedat
             * Format: date-time
             */
            updatedAt: string;
            /**
             * Text
             * @description Extracted text; PDF pages are separated by a form feed (U+000C).
             */
            text: string | null;
        };
        /** SourceList */
        SourceList: {
            /** Items */
            items: components["schemas"]["SourceOut"][];
            pinnedBudget: components["schemas"]["PinnedBudgetOut"];
        };
        /** SourceOut */
        SourceOut: {
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /**
             * Projectid
             * Format: uuid
             */
            projectId: string;
            /** Name */
            name: string;
            /**
             * Kind
             * @enum {string}
             */
            kind: "file" | "url" | "text";
            /**
             * Mode
             * @enum {string}
             */
            mode: "pinned" | "searchable" | "excluded";
            /** Url */
            url: string | null;
            /** Charcount */
            charCount: number;
            /**
             * Pagecount
             * @description Number of PDF pages; null for other sources.
             */
            pageCount: number | null;
            /** Mediatype */
            mediaType: string | null;
            /**
             * Hasfile
             * @description Whether the original can be downloaded from `/file`.
             */
            hasFile: boolean;
            /**
             * Indexstatus
             * @enum {string}
             */
            indexStatus: "pending" | "indexing" | "indexed" | "failed" | "skipped";
            /** Indexerror */
            indexError: string | null;
            /** Version */
            version: number;
            /** Addedby */
            addedBy: string;
            /**
             * Createdat
             * Format: date-time
             */
            createdAt: string;
            /**
             * Updatedat
             * Format: date-time
             */
            updatedAt: string;
        };
        /** SourceUpdate */
        SourceUpdate: {
            /** Name */
            name?: string | null;
            /** Mode */
            mode?: ("pinned" | "searchable" | "excluded") | null;
        };
        /**
         * Problem
         * @description RFC 9457 problem document; extension members are allowed.
         */
        Problem: {
            /**
             * Type
             * @default about:blank
             * @example /problems/not-found
             */
            type: string;
            /** Title */
            title: string;
            /** Status */
            status: number;
            /**
             * Detail
             * @default null
             */
            detail: string | null;
            /**
             * Instance
             * @default null
             */
            instance: string | null;
        } & {
            [key: string]: unknown;
        };
        SourceCreateJson: {
            name?: string | null;
            url?: string | null;
            pastedText?: string | null;
            text?: string | null;
            /** @enum {string} */
            mode?: "pinned" | "searchable" | "excluded";
        };
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    healthz: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: string;
                    };
                };
            };
        };
    };
    readyz: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Service Unavailable */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    get_me: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Me"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    list_projects: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProjectList"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    create_project: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ProjectCreate"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProjectOut"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unprocessable Content */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    get_project: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Project id. */
                project_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProjectOut"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not Found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unprocessable Content */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    delete_project: {
        parameters: {
            query?: never;
            header?: {
                /** @description The project version (ETag) this change is based on. */
                "If-Match"?: string | null;
            };
            path: {
                /** @description Project id. */
                project_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Bad Request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not Found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unprocessable Content */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    update_project: {
        parameters: {
            query?: never;
            header?: {
                /** @description The project version (ETag) this change is based on. */
                "If-Match"?: string | null;
            };
            path: {
                /** @description Project id. */
                project_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ProjectUpdate"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProjectOut"];
                };
            };
            /** @description Bad Request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not Found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unprocessable Content */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Precondition Required */
            428: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    list_members: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Project id. */
                project_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MemberList"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not Found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unprocessable Content */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    add_member: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Project id. */
                project_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MemberAdd"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MemberOut"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not Found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unprocessable Content */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    remove_member: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Project id. */
                project_id: string;
                /** @description Member email address (case-insensitive). */
                email: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not Found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unprocessable Content */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    update_member: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Project id. */
                project_id: string;
                /** @description Member email address (case-insensitive). */
                email: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MemberUpdate"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MemberOut"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not Found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unprocessable Content */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    get_guidance: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Project id. */
                project_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EffectiveGuidanceOut"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not Found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    get_guidance_defaults: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Project id. */
                project_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DefaultGuidanceOut"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not Found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    put_principles: {
        parameters: {
            query?: never;
            header?: {
                /** @description Version (ETag) of the override this change is based on; 0 for the default. */
                "If-Match"?: string | null;
            };
            path: {
                /** @description Project id. */
                project_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["GuidanceWrite"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GuidanceEntryOut"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not Found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unprocessable Content */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Precondition Required */
            428: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    delete_principles: {
        parameters: {
            query?: never;
            header?: {
                /** @description Version (ETag) of the override this change is based on; 0 for the default. */
                "If-Match"?: string | null;
            };
            path: {
                /** @description Project id. */
                project_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GuidanceEntryOut"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not Found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Precondition Required */
            428: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    put_type_guidance: {
        parameters: {
            query?: never;
            header?: {
                /** @description Version (ETag) of the override this change is based on; 0 for the default. */
                "If-Match"?: string | null;
            };
            path: {
                /** @description Project id. */
                project_id: string;
                /** @description Guidance kind: type-instructions or template. */
                kind: "type-instructions" | "template";
                /** @description Backlog item type. */
                item_type: "capability" | "feature" | "user-story" | "enabler";
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["GuidanceWrite"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GuidanceEntryOut"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not Found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unprocessable Content */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Precondition Required */
            428: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    delete_type_guidance: {
        parameters: {
            query?: never;
            header?: {
                /** @description Version (ETag) of the override this change is based on; 0 for the default. */
                "If-Match"?: string | null;
            };
            path: {
                /** @description Project id. */
                project_id: string;
                /** @description Guidance kind: type-instructions or template. */
                kind: "type-instructions" | "template";
                /** @description Backlog item type. */
                item_type: "capability" | "feature" | "user-story" | "enabler";
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GuidanceEntryOut"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not Found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    export_guidance: {
        parameters: {
            query?: {
                includeDefaults?: boolean;
            };
            header?: never;
            path: {
                /** @description Project id. */
                project_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GuidanceExport"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not Found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    import_guidance: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Project id. */
                project_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    [key: string]: unknown;
                };
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EffectiveGuidanceOut"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not Found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Content Too Large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unprocessable Content */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    list_sources: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Project id. */
                project_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SourceList"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not Found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unprocessable Content */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    create_source: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Project id. */
                project_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "multipart/form-data": {
                    /** Format: binary */
                    file: string;
                    name?: string;
                    /** @enum {string} */
                    mode?: "pinned" | "searchable" | "excluded";
                };
                "application/json": components["schemas"]["SourceCreateJson"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SourceOut"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not Found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Content Too Large */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unsupported Media Type */
            415: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unprocessable Content */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    get_source: {
        parameters: {
            query?: {
                /** @description Include the extracted text. */
                includeText?: boolean;
            };
            header?: never;
            path: {
                /** @description Project id. */
                project_id: string;
                source_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SourceDetail"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not Found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unprocessable Content */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    delete_source: {
        parameters: {
            query?: never;
            header?: {
                /** @description The source version (ETag) this change is based on. */
                "If-Match"?: string | null;
            };
            path: {
                /** @description Project id. */
                project_id: string;
                source_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Bad Request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not Found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unprocessable Content */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    update_source: {
        parameters: {
            query?: never;
            header?: {
                /** @description The source version (ETag) this change is based on. */
                "If-Match"?: string | null;
            };
            path: {
                /** @description Project id. */
                project_id: string;
                source_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SourceUpdate"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SourceOut"];
                };
            };
            /** @description Bad Request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not Found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unprocessable Content */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Precondition Required */
            428: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    download_source_file: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Project id. */
                project_id: string;
                source_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The original bytes. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/octet-stream": unknown;
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not Found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unprocessable Content */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    list_items: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Project id. */
                project_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ItemList"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not Found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unprocessable Content */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    create_item: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Project id. */
                project_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ItemCreate"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ItemOut"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not Found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unprocessable Content */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    get_item: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Project id. */
                project_id: string;
                /** @description Item id. */
                item_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ItemOut"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not Found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unprocessable Content */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    delete_item: {
        parameters: {
            query?: never;
            header?: {
                /** @description The item version (ETag) this change is based on. */
                "If-Match"?: string | null;
            };
            path: {
                /** @description Project id. */
                project_id: string;
                /** @description Item id. */
                item_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Bad Request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not Found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unprocessable Content */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    update_item: {
        parameters: {
            query?: never;
            header?: {
                /** @description The item version (ETag) this change is based on. */
                "If-Match"?: string | null;
            };
            path: {
                /** @description Project id. */
                project_id: string;
                /** @description Item id. */
                item_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ItemUpdate"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ItemOut"];
                };
            };
            /** @description Bad Request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not Found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unprocessable Content */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Precondition Required */
            428: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    set_item_quality: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Project id. */
                project_id: string;
                /** @description Item id. */
                item_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["QualityUpdate"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ItemOut"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not Found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unprocessable Content */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    list_item_revisions: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Project id. */
                project_id: string;
                /** @description Item id. */
                item_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RevisionList"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not Found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unprocessable Content */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    get_item_revision: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Project id. */
                project_id: string;
                /** @description Item id. */
                item_id: string;
                /** @description Revision id. */
                revision_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RevisionOut"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not Found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unprocessable Content */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    restore_item_revision: {
        parameters: {
            query?: never;
            header?: {
                /** @description The item version (ETag) this change is based on. */
                "If-Match"?: string | null;
            };
            path: {
                /** @description Project id. */
                project_id: string;
                /** @description Item id. */
                item_id: string;
                /** @description Revision id. */
                revision_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ItemOut"];
                };
            };
            /** @description Bad Request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not Found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unprocessable Content */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    list_relationships: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Project id. */
                project_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RelationshipList"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not Found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unprocessable Content */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    create_relationship: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Project id. */
                project_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RelationshipCreate"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RelationshipOut"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not Found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unprocessable Content */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    delete_relationship: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Project id. */
                project_id: string;
                /** @description Relationship id. */
                relationship_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not Found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unprocessable Content */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
}
