export function DataDisclosure({ agentEndpoint }: { agentEndpoint?: string }) {
  return <details className="sources-disclosure">
    <summary>What can be sent, and where</summary>
    <ul>
      <li><strong>Pinned</strong>: the full text goes with every agent request to the agent-service{agentEndpoint ? <> (<code>{agentEndpoint}</code>)</> : null} and on to the LLM gateway, within the pinned budget.</li>
      <li><strong>Searchable</strong>: only the passages found for the current question are sent, to the same two services. Indexing sends text chunks to the gateway to create embeddings.</li>
      <li><strong>Excluded</strong>: never sent to the agent-service or the gateway.</li>
      <li>Uploaded files are stored on the backlog server. Every member of this project can download the originals.</li>
    </ul>
  </details>;
}
