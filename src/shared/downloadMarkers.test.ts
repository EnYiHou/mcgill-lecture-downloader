import { describe, expect, it } from 'vitest';
import {
  createDownloadMarker,
  createLegacyFilenameMarker,
  isDownloaded,
  migrateLegacyDownloadedItems
} from './downloadMarkers';

describe('downloadMarkers', () => {
  it('creates stable v2 markers from course and recording id', () => {
    expect(createDownloadMarker('81312', 'abc123')).toBe('v2::81312::abc123');
  });

  it('supports legacy filename markers', () => {
    expect(createLegacyFilenameMarker('COMP250_0')).toBe('legacy-filename::COMP250_0');
  });

  it('treats v2 and legacy entries as downloaded', () => {
    const marker = createDownloadMarker('81312', 'abc123');
    const legacy = createLegacyFilenameMarker('COMP250_0');

    expect(isDownloaded(new Set([marker]), marker, 'COMP250_0')).toBe(true);
    expect(isDownloaded(new Set([legacy]), marker, 'COMP250_0')).toBe(true);
    expect(isDownloaded(new Set(['COMP250_0']), marker, 'COMP250_0')).toBe(true);
    expect(isDownloaded(new Set<string>(), marker, 'COMP250_0')).toBe(false);
  });

  it('migrates raw legacy filenames by preserving and namespacing', () => {
    const migrated = migrateLegacyDownloadedItems(['COMP250_0']);
    expect(migrated.has('COMP250_0')).toBe(true);
    expect(migrated.has('legacy-filename::COMP250_0')).toBe(true);
  });
});
