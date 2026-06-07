import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import { validateBody } from './validate';
import { analyzeSchema, explainFileSchema } from './schemas';

function mockReqRes(body: unknown) {
  const req = { body } as Request;
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const res = { status } as unknown as Response;
  const next = vi.fn();
  return { req, res, next, status, json };
}

describe('validateBody', () => {
  it('calls next() and passes through a valid, fully-specified body', () => {
    const { req, res, next } = mockReqRes({ repoOwner: 'owner', repoName: 'repo', filePath: 'a.ts', fileContent: 'x' });
    validateBody(explainFileSchema)(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.body).toEqual({ repoOwner: 'owner', repoName: 'repo', filePath: 'a.ts', fileContent: 'x' });
  });

  it('fills in schema defaults for optional fields', () => {
    const { req, res, next } = mockReqRes({ repoOwner: 'o', repoName: 'r', issueNumber: 1, issueTitle: 'Bug' });
    validateBody(analyzeSchema)(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.body).toMatchObject({ issueBody: '', issueComments: '' });
  });

  it('responds 400 and does not call next() when a required field is missing', () => {
    const { req, res, next, status, json } = mockReqRes({ repoOwner: 'owner' });
    validateBody(explainFileSchema)(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'Invalid request body',
        details: expect.arrayContaining([expect.objectContaining({ path: 'repoName' })]),
      }),
    );
  });

  it('rejects a non-positive issue number', () => {
    const { req, res, next } = mockReqRes({ repoOwner: 'o', repoName: 'r', issueNumber: -1, issueTitle: 'Bug' });
    validateBody(analyzeSchema)(req, res, next);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects an empty string for a required non-empty field', () => {
    const { req, res, next } = mockReqRes({ repoOwner: '', repoName: 'repo' });
    validateBody(explainFileSchema)(req, res, next);
    expect(next).not.toHaveBeenCalled();
  });
});
