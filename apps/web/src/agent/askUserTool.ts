import type { Tool } from '@ag-ui/core';
import askUserArgsSchema from '../../../../contracts/schemas/ask-user.args.schema.json';
import { ASK_USER_TOOL_NAME } from '../contracts';

export const ASK_USER_TOOL_DESCRIPTION =
  'Ask the user 1-3 clarifying questions with 1-4 suggested answers each. The UI always offers a free-text answer.';

const { $schema: _schema, $id: _id, title: _title, description: _description, 'x-tool': _xTool, ...parameters } = askUserArgsSchema;

/** The client tool declared in `RunAgentInput.tools`; its parameters are the shared JSON Schema (single source). */
export const askUserTool: Tool = {
  name: ASK_USER_TOOL_NAME,
  description: ASK_USER_TOOL_DESCRIPTION,
  parameters,
};
