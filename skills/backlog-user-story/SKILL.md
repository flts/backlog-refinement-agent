---
name: backlog-user-story
description: "Instructions and Markdown template (assets/template.md) for User Story backlog items: small, independently valuable and testable behaviour from the perspective of a user or stakeholder. Use when creating, refining or assessing a User Story, or when proposing User Stories as children of a Feature."
metadata:
  version: "1.0.0"
---

# User Story Instructions

Describe a small, independently valuable and testable behaviour from the perspective of a specific user or stakeholder.

Make clear:

- who needs the behaviour;
- what they need to accomplish;
- why it matters;
- what observable conditions demonstrate success.

Use "As a, I want, so that" only when it improves clarity. Do not force the format.

Prefer a vertical slice of usable behaviour over separate frontend, backend, database or integration stories.

Avoid technical User Stories such as:

- Create database table
- Implement REST endpoint
- Configure message broker
- Refactor service

Represent such work as tasks or Enablers unless the technology itself is the required product behaviour.

Apply INVEST pragmatically. If the story is not small, valuable, estimable or testable, explain why and suggest a better split.
