import { describe, expect, it } from 'vitest';
import { canonicalUrl } from '../src/pipeline/url.js';

describe('canonicalUrl', () => {
  it('drops tracking parameters, fragment and trailing slash', () => {
    expect(canonicalUrl('https://Boards.Greenhouse.io/acme/jobs/42/?gh_src=abc&utm_medium=x&keep=1#apply')).toBe(
      'https://boards.greenhouse.io/acme/jobs/42?keep=1',
    );
  });

  it('keeps meaningful parameters such as the Greenhouse job id', () => {
    expect(canonicalUrl('https://acme.com/careers?gh_jid=123')).toBe('https://acme.com/careers?gh_jid=123');
  });

  it('rewrites the Gupy portal link to the /jobs/<id> form other sources use', () => {
    const portal = 'https://fcamara.gupy.io/job/eyJqb2JJZCI6MTI5MTIzNzksInNvdXJjZSI6Imd1cHlfcG9ydGFsIn0=?jobBoardSource=gupy_portal';
    expect(canonicalUrl(portal)).toBe('https://fcamara.gupy.io/jobs/12912379');
    expect(canonicalUrl('https://fcamara.gupy.io/jobs/12912379')).toBe('https://fcamara.gupy.io/jobs/12912379');
    expect(canonicalUrl('https://fcamara.gupy.io/job/not-base64-json')).toBe('https://fcamara.gupy.io/job/not-base64-json');
    expect(canonicalUrl('https://acme.com/job/eyJqb2JJZCI6MTI5MTIzNzksInNvdXJjZSI6Imd1cHlfcG9ydGFsIn0=')).toBe(
      'https://acme.com/job/eyJqb2JJZCI6MTI5MTIzNzksInNvdXJjZSI6Imd1cHlfcG9ydGFsIn0=',
    );
  });

  it('rejects anything that is not an http(s) URL', () => {
    expect(canonicalUrl('not a url')).toBeUndefined();
    expect(canonicalUrl('javascript:alert(1)')).toBeUndefined();
    expect(canonicalUrl('ftp://example.com/job')).toBeUndefined();
  });
});
