import { z } from 'zod';

const nonEmptyString = z.string().trim().min(1, 'must not be empty');

// Shared by every route — every request body includes which repo it's about.
export const repoIdentitySchema = z.object({
  repoOwner: nonEmptyString,
  repoName: nonEmptyString,
});

export const explainRepoSchema = repoIdentitySchema;

export const explainFileSchema = repoIdentitySchema.extend({
  filePath: nonEmptyString,
  // No length floor here — the frontend already decides what counts as "ready" before
  // calling this endpoint; the backend just needs a string to work with.
  fileContent: z.string(),
});

export const analyzeSchema = repoIdentitySchema.extend({
  issueNumber: z.number().int().positive(),
  issueTitle: nonEmptyString,
  issueBody: z.string().default(''),
  issueComments: z.string().default(''),
});

export const goodFirstIssuesSchema = repoIdentitySchema;

export const chatSchema = z.object({
  message: nonEmptyString,
  context: z.object({
    repoOwner: nonEmptyString,
    repoName: nonEmptyString,
    issueNumber: z.number().int().positive().optional(),
    issueTitle: z.string().optional(),
    filePath: z.string().optional(),
    resultContext: z.string().optional(),
  }),
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string(),
      }),
    )
    .optional(),
});
