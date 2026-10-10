import { z } from 'zod';

/** Browsing and automation ingestion must accept the same canonical vendor issue links. */
export const linearIssueUrlSchema = z.url().refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'linear.app'
      && !url.username && !url.password && !url.port && url.pathname.includes('/issue/');
  } catch { return false; }
});
