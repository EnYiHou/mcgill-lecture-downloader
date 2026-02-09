import { describe, expect, it } from 'vitest';
import { extractHfCourseId, extractPayload } from './mcgillApi';

describe('extractPayload', () => {
  it('extracts hidden and submit inputs', () => {
    const html = `
      <form>
        <input type="hidden" name="context_title" value="COMP-250">
        <input type="submit" name="launch" value="Launch">
        <input type="text" name="ignored" value="x">
      </form>
    `;

    expect(extractPayload(html)).toEqual({
      context_title: 'COMP-250',
      launch: 'Launch'
    });
  });
});

describe('extractHfCourseId', () => {
  it('returns HF_CourseID when available', () => {
    const html = '<input type="hidden" name="HF_CourseID" id="HF_CourseID" value="81312" />';
    expect(extractHfCourseId(html)).toBe('81312');
  });

  it('returns null when HF_CourseID is missing', () => {
    expect(extractHfCourseId('<div>no id</div>')).toBeNull();
  });
});
