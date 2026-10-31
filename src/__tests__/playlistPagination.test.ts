import { afterEach, expect, it, vi } from 'vitest';
import { extractPlaylist } from '../playlistParser.js';

function video(id: string, index: number, playable = true) {
  return { playlistVideoRenderer: { videoId: id, index: { simpleText: String(index) }, title: { simpleText: `Song ${index}` }, isPlayable: playable } };
}
function next(token: string) { return { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token } } } }; }
function page(items: unknown[]) {
  const data = { contents: { twoColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { content: {
    sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: [{ playlistVideoListRenderer: { contents: items } }] } }] },
  } } }] } } };
  return `<script>ytcfg.set(${JSON.stringify({ INNERTUBE_CONTEXT: { client: { clientName: 'WEB', clientVersion: 'test' } } })});</script><script>var ytInitialData = ${JSON.stringify(data)};</script>`;
}
function continuation(items: unknown[]) {
  return { onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: items } }] };
}
afterEach(() => vi.unstubAllGlobals());

it('follows multiple pages, deduplicates overlapping positions and preserves intentional repeats', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(page([video('first', 1), next('PAGE_2')])))
    .mockResolvedValueOnce(Response.json(continuation([video('first', 1), video('second', 2), video('private', 3, false), next('PAGE_3')])))
    .mockResolvedValueOnce(Response.json({ continuationContents: { playlistVideoListContinuation: { contents: [video('first', 4)] } } }));
  vi.stubGlobal('fetch', fetcher);
  expect((await extractPlaylist('PLtest')).map(item => item.videoId)).toEqual(['first', 'second', 'first']);
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toMatchObject({ continuation: 'PAGE_2', context: { client: { clientVersion: 'test' } } });
  expect(JSON.parse(fetcher.mock.calls[2][1].body).continuation).toBe('PAGE_3');
});

it('fails explicitly when a continuation repeats instead of returning an incomplete playlist', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(page([video('first', 1), next('LOOP')])))
    .mockResolvedValueOnce(Response.json(continuation([next('LOOP')]))));
  await expect(extractPlaylist('PLtest')).rejects.toMatchObject({ status: 502 });
});

it('fails explicitly if YouTube refuses a continuation', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(page([video('first', 1), next('PAGE_2')])))
    .mockResolvedValueOnce(new Response('', { status: 429 })));
  await expect(extractPlaylist('PLtest')).rejects.toMatchObject({ status: 502 });
});

it('enforces the song limit without claiming a partial result is complete', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(page(Array.from({ length: 5001 }, (_, n) => video(`video${n}`, n))))));
  await expect(extractPlaylist('PLtest')).rejects.toMatchObject({ status: 413 });
});

it('keeps a single-page playlist to one fetch', async () => {
  const fetcher = vi.fn(async () => new Response(page([video('first', 1)])));
  vi.stubGlobal('fetch', fetcher);
  expect(await extractPlaylist('PLtest')).toHaveLength(1);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
