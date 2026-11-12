import { z } from 'zod';

const id = z.string().trim().min(1);
const timestamp = z.string().datetime();

export const ProjectSchema = z.object({
  id,
  name: z.string().trim().min(1),
  createdAt: timestamp,
  updatedAt: timestamp,
});

export const ProjectSourceSchema = z.object({
  id,
  projectId: id,
  name: z.string().trim().min(1),
  kind: z.enum(['file', 'url']),
  mediaType: z.string(),
  text: z.string(),
  selected: z.boolean(),
  url: z.string().optional(),
  file: z.instanceof(Blob).optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
});

export type Project = z.infer<typeof ProjectSchema>;
export type ProjectSource = z.infer<typeof ProjectSourceSchema>;
