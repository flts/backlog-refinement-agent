# Repository instructions

- Use `pnpm` for all package installation and package scripts. Do not use `npm` or `yarn`.
- Keep the LLM endpoint/model in `VITE_LLM_ENDPOINT` and `VITE_LLM_MODEL`. Only the local Vite development server may read `LOCAL_LLM_API_KEY`; production builds must not bundle an API key from the environment. Users may enter endpoint, model and API key in the settings screen; these overrides are stored only in `localStorage` (`llm-connection-overrides`), win over env values, can be removed, and must never be part of the configuration export or application settings in IndexedDB.
- Backlog templates are placeholder-free Markdown (no `{{…}}`); each item is one Markdown document. Default backlog templates live as Markdown files in `src/defaults/templates/`. Persist user-customized full templates in IndexedDB and keep environment secrets out of configuration exports.
- Default agent principles and per-type instructions live as Markdown in `src/defaults/instructions/`; user customizations are persisted in IndexedDB, are restorable, and are part of the configuration export.
