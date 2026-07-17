import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// vi.mock calls are hoisted above these imports, so pipelineMock has to be created via
// vi.hoisted rather than a plain `const` above the mock — otherwise the factory would
// run before pipelineMock is initialized.
const { pipelineMock } = vi.hoisted(() => ({ pipelineMock: vi.fn() }));
vi.mock('@huggingface/transformers', () => ({ pipeline: pipelineMock }));

describe('embeddings', () => {
  const originalEnv = process.env.ENABLE_LOCAL_EMBEDDINGS;

  beforeEach(() => {
    pipelineMock.mockReset();
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.ENABLE_LOCAL_EMBEDDINGS;
    else process.env.ENABLE_LOCAL_EMBEDDINGS = originalEnv;
    vi.resetModules();
  });

  describe('embeddingsEnabled', () => {
    it.each([undefined, 'false', 'FALSE', 'True', '1', ''])(
      'is false unless ENABLE_LOCAL_EMBEDDINGS is exactly "true" (got %s)',
      async (value) => {
        if (value === undefined) delete process.env.ENABLE_LOCAL_EMBEDDINGS;
        else process.env.ENABLE_LOCAL_EMBEDDINGS = value;
        vi.resetModules();
        const { embeddingsEnabled } = await import('./embeddings');
        expect(embeddingsEnabled()).toBe(false);
      },
    );

    it('is true when ENABLE_LOCAL_EMBEDDINGS is exactly "true"', async () => {
      process.env.ENABLE_LOCAL_EMBEDDINGS = 'true';
      vi.resetModules();
      const { embeddingsEnabled } = await import('./embeddings');
      expect(embeddingsEnabled()).toBe(true);
    });
  });

  describe('when embeddings are disabled (production default on Render)', () => {
    it('embedTexts resolves one null per input and never invokes the embedding provider', async () => {
      delete process.env.ENABLE_LOCAL_EMBEDDINGS;
      vi.resetModules();
      const { embedTexts } = await import('./embeddings');

      const result = await embedTexts(['a', 'b', 'c']);

      expect(result).toEqual([null, null, null]);
      expect(pipelineMock).not.toHaveBeenCalled();
    });

    it('embedText resolves null and never invokes the embedding provider', async () => {
      process.env.ENABLE_LOCAL_EMBEDDINGS = 'false';
      vi.resetModules();
      const { embedText } = await import('./embeddings');

      const result = await embedText('where is auth handled');

      expect(result).toBeNull();
      expect(pipelineMock).not.toHaveBeenCalled();
    });

    it('an empty input array never invokes the embedding provider either', async () => {
      delete process.env.ENABLE_LOCAL_EMBEDDINGS;
      vi.resetModules();
      const { embedTexts } = await import('./embeddings');

      expect(await embedTexts([])).toEqual([]);
      expect(pipelineMock).not.toHaveBeenCalled();
    });
  });

  describe('when embeddings are enabled', () => {
    it('embedTexts invokes the embedding provider and returns real vectors', async () => {
      process.env.ENABLE_LOCAL_EMBEDDINGS = 'true';
      vi.resetModules();
      const extractor = vi.fn().mockResolvedValue({ tolist: () => [[1, 0, 0]] });
      pipelineMock.mockResolvedValue(extractor);

      const { embedTexts } = await import('./embeddings');
      const result = await embedTexts(['hello']);

      expect(pipelineMock).toHaveBeenCalledWith(
        'feature-extraction',
        'Xenova/all-MiniLM-L6-v2',
        expect.objectContaining({ dtype: 'q8' }),
      );
      expect(extractor).toHaveBeenCalledWith(['hello'], { pooling: 'mean', normalize: true });
      expect(result).toEqual([new Float32Array([1, 0, 0])]);
    });

    it('embedText returns a single real vector', async () => {
      process.env.ENABLE_LOCAL_EMBEDDINGS = 'true';
      vi.resetModules();
      const extractor = vi.fn().mockResolvedValue({ tolist: () => [[0.5, 0.5]] });
      pipelineMock.mockResolvedValue(extractor);

      const { embedText } = await import('./embeddings');
      const result = await embedText('hello');

      expect(result).toEqual(new Float32Array([0.5, 0.5]));
    });
  });
});
